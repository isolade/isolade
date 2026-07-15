import { PushQueue } from "@isolade/shared";
import type { Socket, TCPSocketListener } from "bun";

// Shared host↔guest byte-relay primitive, used by every isolade transport that
// carries a TCP-shaped stream over an exec stream instead of a network port:
// the server's dynamic port forwarder (port-forwarder.ts), the reverse sandbox
// forward (sandbox-forward.ts), and the in-VM PTY reach (vms.ts). It lives in
// the sandbox package, the lowest layer both the server and the VM manager
// depend on. That way all three share one implementation of the fiddly bits
// (backpressure, orderly close) rather than re-deriving them.
//
// INVARIANT: this module (exported as `@isolade/sandbox/relay`) is imported by
// the server at module scope, including on the external-sandbox path where the
// microsandbox SDK isn't installed. So it must never import microsandbox (or
// anything that transitively loads native code).
//
// Two pieces:
//   - SocketPump: couples one Bun socket to one exec stream (the per-connection
//     state machine).
//   - openLoopbackRelay: a host-loopback TCP listener that hands each accepted
//     connection to a SocketPump driving a guest relay process, which dials a
//     guest target (a loopback TCP port or a unix socket path) and pipes bytes.

const HOST = "127.0.0.1";

// ---------------------------------------------------------------------------
// The guest relay script.
// ---------------------------------------------------------------------------

/** Self-contained CJS relay run once per connection: dial a guest target and
 * pipe bytes to/from the exec stream's stdio. The target (argv[2]) is either a
 * TCP port (all-digits → dial guest loopback) or a unix socket path (dial the
 * path). The same script therefore backs both a loopback-TCP forward and the PTY
 * reach to ttyd's unix socket.
 *
 * A TCP target is dialed on 127.0.0.1 first, then ::1: a server bound to
 * "localhost" listens on whichever loopback family getaddrinfo ranks first
 * (Node 17+/Bun bind the first answer verbatim, and RFC 6724 usually ranks ::1
 * ahead of 127.0.0.1, so the Vite/Astro/Next default ends up IPv6-only), and no
 * scan can settle the question up front (/proc/net/tcp6 doesn't expose
 * IPV6_V6ONLY), so connect() per family is the only reliable oracle. Loopback
 * refusal is an immediate RST, making the fallback effectively free.
 *
 * `pipe()` carries backpressure both ways. Exhausting every dial exits
 * non-zero so the host closes the client socket. No deps beyond Node core
 * (present in the guest). */
export function buildRelayScript(): string {
  return `'use strict';
const net = require('net');
const target = process.argv[2];
// A unix path is a single dial. A TCP port tries both loopback families,
// IPv4 first (the common case, where wildcard and 127.0.0.1 binds stay
// zero-retry).
const dials = /^\\d+$/.test(target)
  ? ['127.0.0.1', '::1'].map((host) => () => net.connect(Number(target), host))
  : [() => net.connect(target)];
// Exit only after stdout's queue reaches the pipe: process.exit() discards
// writes still buffered inside Node, which would truncate the tail of a
// close-delimited response (server sends N bytes, closes) whenever the exec
// transport is applying backpressure. The empty write's callback runs after
// everything queued before it has been handed to the OS.
const flushExit = (code) => process.stdout.write('', () => process.exit(code));
let sock = null; // the established connection, null while still dialing
process.stdin.on('end', () => { try { if (sock) sock.end(); } catch (e) {} });
process.stdout.on('error', () => { try { if (sock) sock.destroy(); } catch (e) {} });
(function dial(i) {
  const s = dials[i]();
  s.once('connect', () => {
    sock = s;
    process.stdin.pipe(s);
    s.pipe(process.stdout);
  });
  // An error before 'connect' means no byte has moved, so the next family is
  // a safe retry. After 'connect', or with no dial left, it's terminal.
  s.on('error', () => { if (sock !== s && i + 1 < dials.length) dial(i + 1); else flushExit(1); });
  s.on('close', () => { if (sock === s) flushExit(0); });
})(0);
`;
}

// ---------------------------------------------------------------------------
// SocketPump: the per-connection byte-relay state machine.
// ---------------------------------------------------------------------------

/** Minimal surface the pump needs from a Bun socket (both `Socket<T>` and the
 * `Bun.connect` socket satisfy it). */
export interface PumpSocket {
  write(data: Buffer): number;
  end(): void;
}

/** What an orderly socket close should do to the exec stream:
 *   - "abort": the closing side was the READER. Nothing in flight can be lost,
 *     so end the guest's stdin and abort the exec stream immediately.
 *   - "drain": the closing side was the WRITER. Its final bytes may still be
 *     queued toward the guest, so end stdin but let the relay drain and exit on
 *     its own. Aborting would truncate the tail.
 * A socket ERROR is not governed by this. On error the bytes are already lost,
 * so both directions abort. */
export type ClosePolicy = "abort" | "drain";

export class SocketPump {
  /** Bytes read off the near socket, feeding the guest process's stdin. Pass
   * it as the exec stream's stdin (it is itself an `AsyncIterable<Buffer>`). */
  readonly stdin = new PushQueue<Buffer>();
  /** Aborts the exec stream. Pass `signal` to the exec stream. Callers may also
   * link it to a VM-teardown signal. */
  readonly ac = new AbortController();

  // Guest→socket bytes the kernel send buffer couldn't take, flushed on drain.
  private backlog: Buffer = Buffer.alloc(0);
  // The exec stream (guest relay) has exited.
  private relayDone = false;
  // The near socket is gone, so stop writing to it.
  private closed = false;
  private socket: PumpSocket | null = null;

  constructor(private readonly closePolicy: ClosePolicy) {}

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  /** Bind the near socket. In the listener case call this in `open`. In the
   * connect case call it once `Bun.connect` resolves. Feeding stdin before the
   * socket is attached is fine (it only queues), and writes are guarded until
   * then. */
  attach(socket: PumpSocket): void {
    this.socket = socket;
  }

  /** Guest→near: a chunk off the exec stream's stdout. Writes to the socket,
   * buffering the remainder when the kernel send buffer is full. */
  writeToSocket(chunk: Buffer): void {
    if (this.closed || !this.socket) return;
    if (this.backlog.length > 0) {
      this.backlog = Buffer.concat([this.backlog, chunk]);
      return;
    }
    const wrote = this.socket.write(chunk);
    if (wrote < chunk.length) this.backlog = chunk.subarray(Math.max(wrote, 0));
  }

  /** Near→guest: a chunk off the near socket. */
  onSocketData(chunk: Buffer): void {
    this.stdin.push(chunk);
  }

  /** The near socket drained: flush the backlog, and honor a close deferred
   * because bytes were still buffered when the relay exited. */
  onDrain(): void {
    if (this.backlog.length > 0 && this.socket) {
      const wrote = this.socket.write(this.backlog);
      this.backlog = this.backlog.subarray(Math.max(wrote, 0));
    }
    if (this.backlog.length === 0 && this.relayDone) this.endSocket();
  }

  /** The exec stream (guest relay) exited: close the near socket once every
   * buffered guest byte is out (ending with a backlog would truncate it). */
  onRelayDone(): void {
    this.relayDone = true;
    if (this.backlog.length === 0) this.endSocket();
  }

  /** The near socket closed orderly: end stdin (half-closes the guest side) and
   * abort or drain per the policy. */
  onSocketClose(): void {
    this.closed = true;
    this.stdin.end();
    if (this.closePolicy === "abort") this.ac.abort();
  }

  /** The near socket errored: bytes are lost, so always tear down. */
  onSocketError(): void {
    this.closed = true;
    this.stdin.end();
    this.ac.abort();
  }

  private endSocket(): void {
    try {
      this.socket?.end();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// openLoopbackRelay: a host-loopback listener fronting a guest target.
// ---------------------------------------------------------------------------

/** The exec-stream capability the relay needs. Both the server's `SandboxApi`
 * and the VM manager satisfy it structurally, so the same primitive serves
 * host-layer forwards and the sandbox-layer PTY reach. */
export interface RelayTransport {
  execStream(
    vmId: string,
    command: string,
    opts: {
      stdin: AsyncIterable<Buffer>;
      stdout: (chunk: Buffer) => void;
      stderr?: (chunk: Buffer) => void;
      signal?: AbortSignal;
    },
  ): Promise<{ exitCode: number }>;
}

/** Open a host loopback listener on an ephemeral port. Each accepted connection
 * runs a guest relay process (`node <relayPath> <target>`) over its own exec
 * stream and is bridged to it by a SocketPump, so the connection terminates on
 * the guest target (a loopback TCP port or a unix socket path). The caller must
 * have written `buildRelayScript()` to `relayPath` first. Returns the listener.
 * Read `.port` for the host port and call `.stop(true)` to tear it down. */
export function openLoopbackRelay(opts: {
  transport: RelayTransport;
  vmId: string;
  relayPath: string;
  target: number | string;
}): TCPSocketListener<SocketPump> {
  const { transport, vmId, relayPath, target } = opts;
  const command = `node ${relayPath} ${target}`;
  return Bun.listen<SocketPump>({
    hostname: HOST,
    port: 0, // ephemeral, the kernel hands us a free port, no collision race
    socket: {
      open: (client: Socket<SocketPump>) => {
        // The host listener accepted a client (e.g. a browser, or the ttyd WS
        // proxy): it is the reader, so an orderly close aborts. Nothing in
        // flight can be lost.
        const pump = new SocketPump("abort");
        pump.attach(client);
        client.data = pump;
        void transport
          .execStream(vmId, command, {
            stdin: pump.stdin,
            stdout: (chunk) => pump.writeToSocket(chunk),
            stderr: () => {},
            signal: pump.signal,
          })
          .catch(() => {})
          // Guest relay exited (connection closed, or the target refused) →
          // close the host side once every guest byte is out.
          .finally(() => pump.onRelayDone());
      },
      data: (client, chunk) => client.data.onSocketData(Buffer.from(chunk)),
      drain: (client) => client.data.onDrain(),
      close: (client) => client.data.onSocketClose(),
      error: (client) => client.data.onSocketError(),
    },
  });
}
