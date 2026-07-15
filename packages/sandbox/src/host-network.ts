import { execSync } from "child_process";

let cached: string | null = null;
let boundRegistryPort: number | null = null;
let bridgeListenerBinder: ((ip: string) => void) | null = null;

// Registered by the registry owner (createSandboxRuntime / startSandboxServer).
// Invoked with the host bridge IP the first time it resolves. The registry
// binds loopback at startup, before the bridge interface exists. This lets it
// add a guest-reachable listener without ever exposing itself on the LAN. The
// binder must be idempotent. If the IP already resolved, it fires immediately.
export function setRegistryBridgeBinder(fn: (ip: string) => void): void {
  bridgeListenerBinder = fn;
  if (cached) fn(cached);
}

// Set by the sandbox entry point once the in-process registry has bound to a
// real port (which may be OS-assigned when the configured port is 0). Read by
// builder.ts, vms.ts, and the host-bridge endpoint helper below. Throws on
// access before set. Every code path that needs the port runs after the
// registry has booted, so an unset read is a programming error worth flagging
// loudly rather than silently falling back to a stale env value.
export function setBoundRegistryPort(port: number): void {
  boundRegistryPort = port;
}

// Returns the host IP reachable from inside microsandbox VMs (the libkrun
// bridge gateway). Used both for the sandbox-callback URL and for the local
// OCI registry address that the builder VM pushes to.
//
// Resolution order:
//   1. $SANDBOX_HOST: explicit override
//   2. Linux: default gateway from `ip route show`
//   3. macOS: `bridge100` inet address from `/sbin/ifconfig`
//
// Cached after first successful resolution. Returns null if none of the above
// produce an answer (callers decide whether to fall back or fail). A null
// result is *not* cached. On macOS bridge100 only appears once the first VM
// boots, so a pre-VM caller must be free to retry and succeed later.
export function detectHostIp(): string | null {
  if (cached) return cached;
  const ip = resolveHostIp();
  if (ip) {
    cached = ip;
    // First resolution: bring the registry's guest-facing listener up on this
    // bridge IP. Idempotent on the registry side.
    bridgeListenerBinder?.(ip);
  }
  return ip;
}

// Port the in-process registry is actually listening on. Resolved at runtime
// by setBoundRegistryPort() rather than from env, because the registry binds
// on 0 (OS-assigned). See packages/sandbox/src/registry/index.ts. The env
// var $ISOLADE_REGISTRY is no longer consulted for the port: image refs and
// the per-VM insecure-registry carve-out both derive from the live bound
// value.
export function getLocalRegistryPort(): string {
  if (boundRegistryPort == null) {
    throw new Error(
      "getLocalRegistryPort() called before the in-process registry bound to a port. " +
        "startRegistry() must run before any code that builds registry-pointing refs.",
    );
  }
  return String(boundRegistryPort);
}

// host:port for the local registry as reachable from inside microsandbox VMs.
// Uses the bridge IP rather than `localhost`, since the guest's loopback is
// its own. Returns null when either the host bridge IP can't be detected OR
// the registry hasn't bound a port yet. Both are "we don't know the
// endpoint yet" states, and callers handle them the same way.
export function getLocalRegistryEndpoint(): string | null {
  if (boundRegistryPort == null) return null;
  const ip = detectHostIp();
  return ip ? `${ip}:${boundRegistryPort}` : null;
}

// host:port for the local registry as reachable from host processes (e.g. the
// `microsandbox pull` we run after a build to seed the image cache). Must use
// loopback rather than the bridge IP because macOS doesn't reliably loop
// connect(2)s back when the destination is one of the host's own non-loopback
// interface IPs. Packets get routed out the bridge and the pull hangs/fails
// with a connect error. The in-process registry binds 127.0.0.1 at startup so
// loopback always reaches it. The repo path is host:port-independent, so an
// image pushed under a bridge-IP ref (the deferred guest listener) can be
// pulled under a loopback ref and vice versa against this same registry. Throws
// on access before the registry has bound a port (same contract as
// getLocalRegistryPort).
export function getLocalRegistryLoopbackEndpoint(): string {
  return `127.0.0.1:${getLocalRegistryPort()}`;
}

function resolveHostIp(): string | null {
  if (process.env.SANDBOX_HOST) return process.env.SANDBOX_HOST;

  if (process.platform === "linux") {
    try {
      const routes = execSync("ip route show", {
        encoding: "utf-8",
        timeout: 3000,
      });
      const match = routes.match(/default via (\S+)/);
      if (match) return match[1] ?? null;
    } catch {}
  }

  try {
    const out = execSync("/sbin/ifconfig bridge100 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
      shell: "/bin/sh",
    });
    const match = out.match(/inet (\d+\.\d+\.\d+\.\d+)/);
    if (match) return match[1] ?? null;
  } catch {}

  return null;
}
