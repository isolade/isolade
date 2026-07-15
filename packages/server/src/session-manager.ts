import { PushQueue } from "@isolade/shared";
import type { WSContext } from "hono/ws";
import type { SandboxApi } from "./sandbox-client";

class RingBuffer {
  private chunks: Buffer[] = [];
  private totalSize = 0;
  private readonly maxSize: number;

  constructor(maxSizeBytes = 1 * 1024 * 1024) {
    this.maxSize = maxSizeBytes;
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.totalSize += chunk.length;
    while (this.totalSize > this.maxSize && this.chunks.length > 1) {
      this.totalSize -= this.chunks.shift()!.length;
    }
  }

  getAll(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

class PersistentSession {
  private buffer = new RingBuffer();
  private clients = new Map<WSContext, (chunk: Buffer) => void>();

  private closed = false;

  readonly stdinIterable = new PushQueue<Buffer>();
  readonly resizeIterable = new PushQueue<[number, number]>();

  onOutput(chunk: Buffer): void {
    this.buffer.push(chunk);
    for (const send of this.clients.values()) {
      send(chunk);
    }
  }

  attach(ws: WSContext): void {
    const buf = this.buffer.getAll();
    if (buf.length > 0) {
      try {
        ws.send(new Uint8Array(buf));
      } catch {}
    }
    const send = (chunk: Buffer) => {
      try {
        ws.send(new Uint8Array(chunk));
      } catch {}
    };
    this.clients.set(ws, send);
  }

  detach(ws: WSContext): void {
    this.clients.delete(ws);
  }

  pushInput(data: Buffer): void {
    this.stdinIterable.push(data);
  }

  pushResize(rows: number, cols: number): void {
    this.resizeIterable.push([rows, cols]);
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.stdinIterable.end();
    this.resizeIterable.end();
    // WS close reasons cap at 123 bytes, so keep the identifying prefix.
    const code = error ? 1011 : 1000;
    const reason = error ? `terminal failed: ${error.message}`.slice(0, 120) : "session ended";
    for (const ws of this.clients.keys()) {
      try {
        ws.close(code, reason);
      } catch {}
    }
    this.clients.clear();
  }
}

export class PersistentSessionManager {
  private sessions = new Map<string, PersistentSession>();

  constructor(private sandboxClient: SandboxApi) {}

  start(
    id: string,
    vmId: string,
    command: string,
    opts: { rows?: number; cols?: number } = {},
  ): void {
    if (this.sessions.has(id)) return;

    const session = new PersistentSession();
    this.sessions.set(id, session);

    this.sandboxClient
      .execInteractive(vmId, command, {
        stdin: session.stdinIterable,
        stdout: (chunk) => session.onOutput(chunk),
        rows: opts.rows ?? 24,
        cols: opts.cols ?? 80,
        resize: session.resizeIterable,
      })
      .then(
        () => session.close(),
        (err) => {
          console.error(`[terminal ${id}] interactive session on VM ${vmId} failed:`, err);
          session.close(err instanceof Error ? err : new Error(String(err)));
        },
      )
      .finally(() => {
        // Only delete if this session is still the active one (guards against restart races)
        if (this.sessions.get(id) === session) {
          this.sessions.delete(id);
        }
      });
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  attach(id: string, ws: WSContext): void {
    this.sessions.get(id)?.attach(ws);
  }

  detach(id: string, ws: WSContext): void {
    this.sessions.get(id)?.detach(ws);
  }

  sendInput(id: string, data: Buffer): void {
    this.sessions.get(id)?.pushInput(data);
  }

  sendResize(id: string, rows: number, cols: number): void {
    this.sessions.get(id)?.pushResize(rows, cols);
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.close();
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
  }
}
