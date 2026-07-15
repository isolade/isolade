import { buildRelayScript, SocketPump } from "@isolade/sandbox/relay";
import type { Socket } from "bun";
import { runPersistentGuestStream } from "./request-broker";
import type { SandboxApi } from "./sandbox-client";

// Expose the HOST's in-process sandbox API *into* a guest VM, the reverse of
// port-forwarder.ts. There, the host listens and a guest relay dials guest
// loopback. Here the GUEST listens and a per-connection relay pipes to the host,
// whose end dials the sandbox app served on a host UNIX SOCKET (see
// packages/sandbox/src/serveSandboxOnUnix). The upshot:
//
//   inner isolade → 127.0.0.1:GUEST_SANDBOX_PORT     (guest acceptor, this file)
//        │  per-connection exec stream (agent channel)
//        ▼
//   host: relay stdio ⇄ Bun.connect({unix}) ⇄ createSandboxApp on a unix socket
//
// No host TCP port, no network-policy egress rule, no `host.microsandbox.internal`.
// The powerful sandbox API never touches a routable interface. It rides the
// same exec channel exec already uses, and reuses port-forwarder's relay script
// verbatim: the acceptor hands each inbound connection to a fresh ephemeral
// guest-loopback listener, announces its port over the acceptor's stdout, and
// the host opens a relay that dials 127.0.0.1:<that port>.
//
// One exec stream per connection, like ExecRelayForwarder: simple, failure-
// isolated, natural end-to-end backpressure. It's opt-in per profile
// (`expose_sandbox`) and dev-only. A guest that can drive the host sandbox can
// drive the host's whole VM fleet, so it must never be on by default.

/** Guest-loopback port the acceptor listens on, the value injected into the VM
 * as `ISOLADE_SANDBOX_URL=http://127.0.0.1:<port>`. Fixed (not ephemeral) so it
 * can be baked into the guest env at VM-create, before the acceptor runs. Chosen
 * high and off the beaten path to avoid colliding with a nested isolade's own
 * dev ports (Vite 5173, server 3000). */
export const GUEST_SANDBOX_PORT = 47999;

/** Where the acceptor + relay scripts are written inside the guest (mirrors
 * sign-broker's BROKER_PATH / port-forwarder's RELAY_PATH). */
const ACCEPTOR_PATH = "/tmp/isolade-sbx-acceptor.cjs";
const RELAY_PATH = "/tmp/isolade-sbx-relay.cjs";

/** Self-contained CJS acceptor injected into the VM and run under a persistent
 * exec stream. Listens on guest loopback, and hands each inbound connection to a
 * fresh ephemeral loopback listener and announces its port over stdout for the
 * host to relay. No deps beyond Node core (present, see sign-broker). */
function buildSandboxAcceptorScript(guestPort: number): string {
  return `'use strict';
const net = require('net');
const GPORT = ${JSON.stringify(guestPort)};
const IDLE_MS = 30000;

const server = net.createServer({ allowHalfOpen: true }, (conn) => {
  conn.on('error', () => { try { conn.destroy(); } catch (e) {} });
  // Fresh ephemeral guest-loopback listener for exactly this connection. The
  // host opens a relay that dials it, and we then pipe the two together. Until the
  // relay attaches, \`conn\` has no consumer, so it stays paused (kernel-level
  // backpressure to the client), so no bytes are lost.
  const per = net.createServer({ allowHalfOpen: true }, (relay) => {
    per.close();          // one relay per connection
    clearTimeout(timer);
    conn.pipe(relay);
    relay.pipe(conn);
    const done = () => {
      try { conn.destroy(); } catch (e) {}
      try { relay.destroy(); } catch (e) {}
    };
    conn.on('error', done); relay.on('error', done);
    conn.on('close', done); relay.on('close', done);
  });
  let timer = null;
  per.on('error', () => { try { conn.destroy(); } catch (e) {} });
  // If the client vanishes before a relay attaches, tear down the pending listener.
  conn.on('close', () => { clearTimeout(timer); try { per.close(); } catch (e) {} });
  per.listen(0, '127.0.0.1', () => {
    const p = per.address().port;
    process.stdout.write('OPEN ' + p + '\\n');
    timer = setTimeout(() => {
      try { per.close(); } catch (e) {}
      try { conn.destroy(); } catch (e) {}
    }, IDLE_MS);
  });
});

server.on('error', (e) => {
  process.stderr.write('sbx-acceptor: ' + (e && e.message || e) + '\\n');
  process.exit(1);
});
server.listen(GPORT, '127.0.0.1');
`;
}

/** Opens/closes the reverse sandbox forward for VMs whose profile opted in.
 * Injectable so tests can swap the transport. The InstanceManager wires it into
 * the create/restart/attach/remove lifecycle exactly like the port-control broker. */
export class SandboxReverseForwarder {
  // Per-VM acceptor stream (with its reconnect loop). Aborting tears the
  // acceptor AND every relay spawned under it (relays link to this signal).
  private acceptors = new Map<string, AbortController>();

  constructor(
    private sandbox: SandboxApi,
    /** Host unix socket where createSandboxApp is served (serveSandboxOnUnix). */
    private hostSocketPath: string,
    /** Guest-loopback port the acceptor binds. This is the port in the injected
     * ISOLADE_SANDBOX_URL (InstanceManager reads it back from here so the two
     * can never disagree). Overridable so the forwarder's own tests can run
     * INSIDE an expose_sandbox guest (where the real acceptor already holds
     * GUEST_SANDBOX_PORT) without colliding with it. */
    readonly guestPort: number = GUEST_SANDBOX_PORT,
  ) {}

  /** Start (idempotently) exposing the host sandbox inside `vmId`. */
  setup(vmId: string): void {
    if (this.acceptors.has(vmId)) return;
    const ac = new AbortController();
    this.acceptors.set(vmId, ac);
    void this.runAcceptor(vmId, ac.signal)
      .catch((err) => console.warn(`[sandbox-forward ${vmId}] acceptor stopped:`, err))
      .finally(() => {
        if (this.acceptors.get(vmId) === ac) this.acceptors.delete(vmId);
      });
  }

  /** Stop exposing the host sandbox inside `vmId` (on stop/remove). */
  teardown(vmId: string): void {
    const ac = this.acceptors.get(vmId);
    if (ac) {
      ac.abort();
      this.acceptors.delete(vmId);
    }
  }

  // Hold the persistent acceptor exec stream, reconnecting until `signal`
  // aborts (the acceptor dies on VM reboot, the stream drops on a sandbox blip).
  // Its stdout is a line-oriented control channel: `OPEN <port>` per inbound
  // connection, each answered by opening a relay. The acceptor never reads
  // stdin, so the stdin queue the shared loop hands us goes unused.
  private runAcceptor(vmId: string, signal: AbortSignal): Promise<void> {
    return runPersistentGuestStream({
      sandboxClient: this.sandbox,
      vmId,
      signal,
      label: "sandbox-forward",
      scripts: [
        {
          path: ACCEPTOR_PATH,
          content: Buffer.from(buildSandboxAcceptorScript(this.guestPort), "utf8"),
        },
        { path: RELAY_PATH, content: Buffer.from(buildRelayScript(), "utf8") },
      ],
      // Clear any stale acceptor left by a previous run (a fresh boot wipes
      // /tmp, but a same-lifetime reconnect would collide on the port).
      cleanup: `sh -c 'pkill -f ${ACCEPTOR_PATH} 2>/dev/null; true'`,
      command: `node ${ACCEPTOR_PATH} ${this.guestPort}`,
      onConnect: () => {
        let buf = "";
        return (chunk) => {
          buf += chunk.toString("utf8");
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            const m = /^OPEN (\d+)$/.exec(line);
            if (m) void this.openRelay(vmId, Number(m[1]), signal);
          }
        };
      },
    });
  }

  // Bridge one guest connection to the host sandbox: dial the host unix socket,
  // then run a relay exec stream that dials the acceptor's ephemeral port. Data
  // flows guest→(relay stdout)→host socket for requests, and host socket→(relay
  // stdin)→guest for responses. Symmetric to ExecRelayForwarder's per-connection
  // handling, with the roles of "client socket" and "guest relay" swapped.
  private async openRelay(vmId: string, port: number, vmSignal: AbortSignal): Promise<void> {
    if (vmSignal.aborted) return;
    // Here the host sandbox app is the WRITER (it produces the response), so an
    // orderly close of the host socket must DRAIN rather than abort: its final
    // bytes may still be queued toward the guest, and aborting would truncate
    // the response tail. This is the one axis on which this relay differs from
    // ExecRelayForwarder's (where the client is the reader and close aborts),
    // captured by the "drain" policy. A socket ERROR still aborts (bytes are
    // already lost). The pump hardcodes that. A relay wedged past a drain-close
    // is still killed by VM teardown via vmSignal.
    const pump = new SocketPump("drain");
    // A VM teardown aborts every in-flight relay too.
    const onVmAbort = () => pump.ac.abort();
    vmSignal.addEventListener("abort", onVmAbort, { once: true });

    let hostSock: Socket<undefined>;
    try {
      hostSock = await Bun.connect({
        unix: this.hostSocketPath,
        socket: {
          data: (_s, chunk) => pump.onSocketData(Buffer.from(chunk)),
          drain: () => pump.onDrain(),
          close: () => pump.onSocketClose(),
          error: () => pump.onSocketError(),
        },
      });
    } catch (err) {
      // Host sandbox socket unreachable, so nothing to bridge to. The acceptor's
      // idle timer reaps the paused guest connection on its side.
      vmSignal.removeEventListener("abort", onVmAbort);
      console.warn(`[sandbox-forward ${vmId}] host socket connect failed:`, err);
      return;
    }
    pump.attach(hostSock);

    void this.sandbox
      .execStream(vmId, `node ${RELAY_PATH} ${port}`, {
        stdin: pump.stdin,
        // Guest→host: request bytes read off the guest socket by the relay.
        stdout: (chunk) => pump.writeToSocket(chunk),
        stderr: () => {},
        signal: pump.signal,
      })
      .catch(() => {})
      // Relay exited (client closed, or nothing dialed the ephemeral port) →
      // close the host side, but only once every buffered byte is out.
      .finally(() => {
        pump.onRelayDone();
        vmSignal.removeEventListener("abort", onVmAbort);
      });
  }
}
