import { buildRelayScript, openLoopbackRelay, SocketPump } from "@isolade/sandbox/relay";
import type { TCPSocketListener } from "bun";
import type { PortForwardBinding, SandboxApi } from "./sandbox-client";

// Dynamic, loopback-friendly port forwarding.
//
// The historical path published a guest port via microsandbox, whose forwarder
// dials the guest's *external* interface, so a server bound only to 127.0.0.1
// (the Vite/Next default) was unreachable, and the port set was fixed at VM
// create. This forwarder fixes both:
//
//   host browser → 127.0.0.1:localPort  (host listener)
//        │  per-connection exec stream
//        ▼
//   guest: node relay ──▶ loopback:remotePort  (the user's server)
//
// The relay runs *inside* the guest, so it dials guest loopback natively. The
// user's server can stay bound to localhost on either family (it tries
// 127.0.0.1, then ::1, see buildRelayScript for why both are needed). And
// because a forward is just a host listener plus on-demand exec streams, ports
// open/close at runtime with no VM restart and nothing pre-declared.
//
// The listener + per-connection byte plumbing (backpressure, orderly close)
// lives in the shared relay primitive (openLoopbackRelay / SocketPump in
// @isolade/sandbox/guest-relay), so this file is just the per-VM forward
// bookkeeping around it. Multiplexing every connection onto one shared stream
// is deliberately avoided. It would re-create the flow-control and
// head-of-line-blocking problems the per-connection model offloads, for
// efficiency the workload doesn't need.

/** Where the guest-side relay script is written (mirrors sign-broker's BROKER_PATH). */
const RELAY_PATH = "/tmp/isolade-tcp-relay.cjs";

// Host listeners bind loopback only. A forwarded VM port must never be
// reachable from off-box, only from the machine running the UI.
const HOST = "127.0.0.1";

/** Opens/closes host→guest TCP forwards for a running VM. Implementations own
 * the host listeners. The server (InstanceManager) owns which ports *should* be
 * forwarded and when. */
export interface GuestForwarder {
  /** Open (or return the existing) forward from a fresh host loopback port to
   * `remotePort` inside the VM. Idempotent per (vmId, remotePort). */
  open(vmId: string, remotePort: number): Promise<PortForwardBinding>;
  /** Close a single forward, tearing down its listener and live connections. */
  close(vmId: string, remotePort: number): void;
  /** Currently-open forwards for a VM, in insertion order. */
  list(vmId: string): PortForwardBinding[];
  /** Close every forward for a VM (on stop/remove). */
  closeAll(vmId: string): void;
}

interface Forward {
  binding: PortForwardBinding;
  server: TCPSocketListener<SocketPump>;
}

export class ExecRelayForwarder implements GuestForwarder {
  private forwards = new Map<string, Map<number, Forward>>();
  // In-flight open() per "vmId:remotePort". open() awaits before it commits to
  // the forwards map, so two concurrent opens (UI + in-VM CLI, say) would each
  // pass the existence check and leak a listener. The second caller joins the
  // first's promise instead.
  private opening = new Map<string, Promise<PortForwardBinding>>();
  // VMs whose relay script has been written this process lifetime. A VM reboot
  // wipes /tmp, but reopenForwards (on restart/re-attach) always writes before
  // opening, so this only elides redundant writes within one VM lifetime.
  private relayWritten = new Set<string>();

  constructor(private sandbox: SandboxApi) {}

  private forVm(vmId: string): Map<number, Forward> {
    let m = this.forwards.get(vmId);
    if (!m) {
      m = new Map();
      this.forwards.set(vmId, m);
    }
    return m;
  }

  private async ensureRelayScript(vmId: string): Promise<void> {
    if (this.relayWritten.has(vmId)) return;
    await this.sandbox.writeFile(vmId, RELAY_PATH, Buffer.from(buildRelayScript(), "utf8"));
    this.relayWritten.add(vmId);
  }

  open(vmId: string, remotePort: number): Promise<PortForwardBinding> {
    const existing = this.forVm(vmId).get(remotePort);
    if (existing) return Promise.resolve(existing.binding);
    const key = `${vmId}:${remotePort}`;
    let pending = this.opening.get(key);
    if (!pending) {
      pending = this.doOpen(vmId, remotePort).finally(() => this.opening.delete(key));
      this.opening.set(key, pending);
    }
    return pending;
  }

  private async doOpen(vmId: string, remotePort: number): Promise<PortForwardBinding> {
    await this.ensureRelayScript(vmId);
    const server = openLoopbackRelay({
      transport: this.sandbox,
      vmId,
      relayPath: RELAY_PATH,
      target: remotePort,
    });

    const binding: PortForwardBinding = {
      address: HOST,
      localPort: server.port,
      remotePort,
    };
    this.forVm(vmId).set(remotePort, { binding, server });
    return binding;
  }

  close(vmId: string, remotePort: number): void {
    const m = this.forwards.get(vmId);
    const fwd = m?.get(remotePort);
    if (!fwd || !m) return;
    // stop(true) closes active connections. Each socket's close handler then
    // ends its stdin queue and aborts its exec stream.
    try {
      fwd.server.stop(true);
    } catch {}
    m.delete(remotePort);
    if (m.size === 0) this.forwards.delete(vmId);
  }

  list(vmId: string): PortForwardBinding[] {
    const m = this.forwards.get(vmId);
    return m ? [...m.values()].map((f) => f.binding) : [];
  }

  closeAll(vmId: string): void {
    const m = this.forwards.get(vmId);
    if (!m) return;
    for (const remotePort of [...m.keys()]) this.close(vmId, remotePort);
    this.relayWritten.delete(vmId);
  }
}
