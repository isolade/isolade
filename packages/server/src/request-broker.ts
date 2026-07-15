import { PushQueue } from "@isolade/shared";
import type { SandboxApi } from "./sandbox-client";

// Generic guest→host request/response transport over a persistent exec stream.
// A guest process connects to a VM-local unix socket, writes a request, and
// half-closes, the host handles it, and the reply is written back. The
// locked-down network policy forbids the VM dialing the host, so instead the
// HOST holds an exec stream into the VM and answers on demand. No host port, no
// bind mount, no network-policy change. It rides the microsandbox agent
// channel that exec already uses.
//
//   guest: client → unix socket → broker (this script)
//   pipe:  broker.stdout ──[len][payload]──▶ host   (over execStream)
//          broker.stdin  ◀──[status][len][body]── host
//
// Two channels ride this today: commit signing (sign-broker.ts) and the in-VM
// `isolade` port-control CLI (port-control.ts). Single request in flight at a
// time over the shared pipe (no multiplexing), which is fine for the low-rate control
// traffic this carries. Callers layer their own request/response encoding on
// top of the opaque byte payloads.

// Reconnect backoff. A stopped or destroyed VM rejects every reconnect
// immediately (`sandbox ... is not running`), so a fixed short delay turns a
// persistent failure into a per-second log + exec-stream storm. Back off
// exponentially up to a cap: a genuine reboot reconnects on the first
// (still-short) retry, while a VM that's gone for good settles to one quiet
// attempt per RECONNECT_MAX_MS. Both persistent exec-stream loops (the
// broker below and sandbox-forward's acceptor) share this one policy via
// runPersistentGuestStream.
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// A stream that stayed up at least this long before dropping was healthy, so
// reset the backoff (and re-arm logging) so the next blip reconnects promptly
// instead of inheriting a stale long delay from an earlier outage.
const HEALTHY_STREAM_MS = 10_000;

/** setTimeout that also resolves the moment `signal` aborts, so teardown isn't
 * stuck behind a long backoff sleep. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Self-contained CJS broker injected into the VM and run under a persistent
 * exec stream. Relays one request at a time between the client's unix socket
 * and the host (its own stdio). No deps beyond Node core. */
export function buildRequestBrokerScript(socketPath: string): string {
  return `'use strict';
const net = require('net');
const fs = require('fs');
const SOCK = ${JSON.stringify(socketPath)};
try { fs.unlinkSync(SOCK); } catch (e) {}

const queue = [];
let busy = null;          // connection whose request is out to the host
let inbuf = Buffer.alloc(0);

// Host → broker frames: [status:1][len:4 BE][body:len]. status 0 = ok.
process.stdin.on('data', (d) => {
  inbuf = Buffer.concat([inbuf, d]);
  for (;;) {
    if (inbuf.length < 5) break;
    const status = inbuf[0];
    const len = inbuf.readUInt32BE(1);
    if (inbuf.length < 5 + len) break;
    const body = Buffer.from(inbuf.subarray(5, 5 + len));
    inbuf = inbuf.subarray(5 + len);
    const conn = busy; busy = null;
    if (conn && !conn.destroyed) { if (status === 0) conn.end(body); else conn.destroy(); }
    next();
  }
});

function next() {
  if (busy || queue.length === 0) return;
  const conn = queue.shift();
  if (conn.destroyed) { next(); return; }
  busy = conn;
  let sent = false;
  const chunks = [];
  conn.on('data', (d) => chunks.push(d));
  conn.on('end', () => {
    if (busy !== conn) return;
    sent = true;
    const payload = Buffer.concat(chunks);
    const hdr = Buffer.alloc(4); hdr.writeUInt32BE(payload.length, 0);
    // broker → host frame: [len:4 BE][payload:len]
    process.stdout.write(Buffer.concat([hdr, payload]));
  });
  // A connection that dies before half-closing (killed client) never got its
  // request out, so release the pipe or every later request queues forever. But
  // once sent, busy must stay claimed until the response frame lands (the
  // stdin handler clears it): releasing early would deliver the in-flight
  // response to the NEXT request's connection and desync every reply after.
  const giveUp = () => { if (busy === conn && !sent) { busy = null; next(); } };
  conn.on('error', giveUp);
  conn.on('close', giveUp);
}

// allowHalfOpen: the client half-closes (FIN) after writing its request,
// without this the server socket would auto-end its write side too and we
// could never send the response back.
net.createServer({ allowHalfOpen: true }, (conn) => { queue.push(conn); next(); }).listen(SOCK, () => {
  try { fs.chmodSync(SOCK, 0o600); } catch (e) {}
});
`;
}

// ---------------------------------------------------------------------------
// Host-side framing helpers (unit-tested).
// ---------------------------------------------------------------------------

/** Accumulates `[len:4 BE][payload]` frames from the broker's stdout. */
export class FrameReader {
  private buf = Buffer.alloc(0);

  constructor(private onFrame: (payload: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      const payload = Buffer.from(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
      this.onFrame(payload);
    }
  }
}

/** Frame a response for the broker's stdin: [status:1][len:4 BE][body]. status
 * 0 = ok (broker delivers body to the client), non-zero closes the client. */
export function frameResponse(status: number, body: Buffer): Buffer {
  const hdr = Buffer.alloc(5);
  hdr.writeUInt8(status, 0);
  hdr.writeUInt32BE(body.length, 1);
  return Buffer.concat([hdr, body]);
}

/** Hold a persistent exec stream to a long-lived guest process, reconnecting
 * until `signal` aborts (the process dies on VM reboot, the stream drops on a
 * sandbox blip). Each (re)connect writes `scripts`, runs `cleanup` to clear any
 * stale state a previous run left, then execs `command`. `onConnect` is called
 * once per attempt to build a fresh stdout handler and is handed that attempt's
 * stdin queue for writing back to the process. Backoff is exponential and
 * resets once a stream has stayed up for `HEALTHY_STREAM_MS`.
 *
 * The per-attempt stdin queue is ended on EVERY exit path (success, reject, or
 * abort) via try/finally: the transport's stdin pump loops until its iterable
 * completes, so leaving a queue open would strand one pump per reconnect for
 * the life of the stream. This is the shared home for both persistent guest
 * streams: the request/response broker below and the reverse-forward acceptor
 * (sandbox-forward.ts). */
export async function runPersistentGuestStream(opts: {
  sandboxClient: SandboxApi;
  vmId: string;
  signal: AbortSignal;
  /** Label for log lines (e.g. "port-control", "sandbox-forward"). */
  label: string;
  /** Written into the guest before each (re)connect. */
  scripts: { path: string; content: Buffer }[];
  /** Shell command run after writing `scripts` to clear a stale process/socket
   * from a previous run. Optional. */
  cleanup?: string;
  /** The command run under the persistent exec stream. */
  command: string;
  /** Builds a fresh stdout handler for each (re)connect. `stdin` feeds the
   * process (unused by streams whose guest side never reads stdin). */
  onConnect: (stdin: PushQueue<Buffer>) => (chunk: Buffer) => void;
}): Promise<void> {
  const { sandboxClient, vmId, signal, label, scripts, cleanup, command, onConnect } = opts;
  let delay = RECONNECT_BASE_MS;
  let lastErr: string | null = null;
  while (!signal.aborted) {
    const startedAt = performance.now();
    try {
      for (const s of scripts) await sandboxClient.writeFile(vmId, s.path, s.content);
      if (cleanup) await sandboxClient.exec(vmId, cleanup);

      const stdin = new PushQueue<Buffer>();
      const onStdout = onConnect(stdin);
      try {
        await sandboxClient.execStream(vmId, command, {
          stdin,
          stdout: onStdout,
          stderr: () => {},
          signal,
        });
      } finally {
        // Every exit path, including a mid-stream reject (the normal VM-reboot
        // reconnect): otherwise the transport's stdin pump is stranded.
        stdin.end();
      }
    } catch (err) {
      if (signal.aborted) return;
      // Log once per distinct failure, not once per reconnect: a VM that's
      // Stopped for good would otherwise spam the identical line forever.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== lastErr) {
        console.warn(`[${label} ${vmId}] guest stream ended (${msg}); reconnecting`);
        lastErr = msg;
      }
    }
    if (signal.aborted) return;
    if (performance.now() - startedAt >= HEALTHY_STREAM_MS) {
      delay = RECONNECT_BASE_MS;
      lastErr = null;
    }
    await abortableDelay(delay, signal);
    delay = Math.min(delay * 2, RECONNECT_MAX_MS);
  }
}

/** Hold a persistent exec stream to an in-VM request broker, answering each
 * forwarded request via `handle`. Auto-reconnects until `signal` aborts. A
 * `handle` that rejects is relayed to the client as an error (status 1, empty
 * body) rather than killing the stream. A thin adapter over
 * `runPersistentGuestStream`. */
export function runRequestBroker(opts: {
  sandboxClient: SandboxApi;
  vmId: string;
  socketPath: string;
  brokerPath: string;
  handle: (request: Buffer) => Promise<Buffer>;
  signal: AbortSignal;
  /** Label for log lines (e.g. "port-control"). */
  label: string;
}): Promise<void> {
  const { sandboxClient, vmId, socketPath, brokerPath, handle, signal, label } = opts;
  return runPersistentGuestStream({
    sandboxClient,
    vmId,
    signal,
    label,
    scripts: [
      {
        path: brokerPath,
        content: Buffer.from(buildRequestBrokerScript(socketPath), "utf8"),
      },
    ],
    cleanup: `sh -c 'pkill -f ${brokerPath} 2>/dev/null; rm -f ${socketPath}; true'`,
    command: `node ${brokerPath}`,
    onConnect: (stdin) => {
      const reader = new FrameReader((payload) => {
        // Single-flight on the guest side: the broker won't send the next
        // request until this response lands, so ordering is preserved without
        // correlation ids.
        void handle(payload)
          .then((body) => stdin.push(frameResponse(0, body)))
          .catch((err) => {
            console.warn(
              `[${label} ${vmId}] handler failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            stdin.push(frameResponse(1, Buffer.alloc(0)));
          });
      });
      return (chunk) => reader.push(chunk);
    },
  });
}
