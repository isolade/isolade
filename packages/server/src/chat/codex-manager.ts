import { PushQueue } from "@isolade/shared";
import { jsonRpcMessageSchema } from "../contracts";
import type { SandboxApi } from "../sandbox-client";

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

type NotificationHandler = (params: unknown) => void;
type Unsubscribe = () => void;

export class CodexConnection {
  private reqId = 0;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers = new Map<string, NotificationHandler[]>();
  private anyHandlers: ((method: string, params: unknown) => void)[] = [];
  private stdoutBuf = "";

  // Stdin queue: push messages here to send them to the process
  private readonly stdin = new PushQueue<Buffer>();

  /** Settles when the app-server process exits or the stream drops. */
  readonly exitPromise: Promise<{ exitCode: number }>;
  // Aborts the underlying exec-stream so close() actually terminates the
  // app-server process instead of leaking it until the VM stops.
  private readonly abort = new AbortController();

  constructor(vmId: string, sandboxClient: SandboxApi) {
    this.exitPromise = sandboxClient.execStream(
      vmId,
      "codex app-server --listen stdio:// --disable apps -c features.memories=false -c approval_policy=never -c sandbox_mode=danger-full-access",
      {
        stdin: this.stdin,
        stdout: (chunk) => this._handleStdout(chunk),
        stderr: () => {}, // ignore stderr
        signal: this.abort.signal,
      },
    );
    // Reject every pending request the moment the process is gone, whether the
    // stream resolved (clean exit) or rejected (crash / dropped connection).
    // Using a single settled-either-way handler also consumes the rejection so
    // it doesn't surface as an unhandled promise rejection.
    const onExit = () => this._rejectAll("codex app-server exited");
    this.exitPromise.then(onExit, onExit);
  }

  private _push(line: string) {
    this.stdin.push(Buffer.from(line + "\n"));
  }

  private _handleStdout(chunk: Buffer) {
    this.stdoutBuf += chunk.toString("utf8");
    const lines = this.stdoutBuf.split("\n");
    this.stdoutBuf = lines.pop()!;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: ReturnType<typeof jsonRpcMessageSchema.parse>;
      try {
        msg = jsonRpcMessageSchema.parse(JSON.parse(trimmed));
      } catch {
        continue;
      }
      this._dispatch(msg);
    }
  }

  private _dispatch(msg: ReturnType<typeof jsonRpcMessageSchema.parse>) {
    if ("id" in msg) {
      // Response to a request
      const id = msg.id;
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        if (msg.error) {
          const errMsg = msg.error.message || "JSON-RPC error";
          pending.reject(new Error(errMsg));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else {
      // Notification
      const handlers = this.notificationHandlers.get(msg.method) ?? [];
      const wasHandled = handlers.length > 0;
      for (const h of handlers) h(msg.params);
      if (!wasHandled) {
        for (const h of this.anyHandlers) h(msg.method, msg.params);
      }
    }
  }

  private _rejectAll(reason: string) {
    for (const [, { reject }] of this.pending) {
      reject(new Error(reason));
    }
    this.pending.clear();
  }

  send(method: string, params: unknown): Promise<unknown> {
    const id = ++this.reqId;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._push(msg);
    });
  }

  on(method: string, handler: NotificationHandler): Unsubscribe {
    const existing = this.notificationHandlers.get(method) ?? [];
    this.notificationHandlers.set(method, [...existing, handler]);
    return () => {
      const current = this.notificationHandlers.get(method) ?? [];
      this.notificationHandlers.set(
        method,
        current.filter((h) => h !== handler),
      );
    };
  }

  // Receives every notification that doesn't have a registered method-specific
  // handler. Used to surface "unhandled" events for debugging in the UI.
  onAny(handler: (method: string, params: unknown) => void): Unsubscribe {
    this.anyHandlers.push(handler);
    return () => {
      const i = this.anyHandlers.indexOf(handler);
      if (i >= 0) this.anyHandlers.splice(i, 1);
    };
  }

  close() {
    this.stdin.end();
    // Kill the app-server process, not just stop feeding it stdin. Otherwise
    // it lingers in the VM. Safe to call unconditionally, since abort is idempotent.
    this.abort.abort();
    this._rejectAll("connection closed");
  }
}

export class CodexManager {
  private connections = new Map<string, { conn: CodexConnection; ready: Promise<void> }>();

  constructor(private sandboxClient: SandboxApi) {}

  async getOrCreate(vmId: string): Promise<CodexConnection> {
    let entry = this.connections.get(vmId);
    if (!entry) {
      const conn = new CodexConnection(vmId, this.sandboxClient);
      const ready = (
        conn.send("initialize", {
          clientInfo: { name: "isolade", version: "1.0" },
          capabilities: { experimentalApi: true },
        }) as Promise<unknown>
      ).then(() => {});
      entry = { conn, ready };
      this.connections.set(vmId, entry);
      const evict = () => {
        if (this.connections.get(vmId)?.conn === conn) {
          this.connections.delete(vmId);
        }
      };
      // Evict the cached entry when the process exits OR the stream drops, so
      // the next call reconnects instead of awaiting a dead connection. (The
      // stream now rejects on a premature close, so a resolve-only handler
      // would leave a dead entry cached forever.)
      conn.exitPromise.then(evict, evict);
      // A failed initialize would otherwise poison the cache: the rejected
      // `ready` stays in the map and every later call re-awaits the same
      // rejection. Drop it so the next call gets a fresh connection.
      ready.catch(evict);
    }
    await entry.ready;
    return entry.conn;
  }

  async refreshAuth(vmId: string): Promise<void> {
    const conn = await this.getOrCreate(vmId);
    await conn.send("account/read", { refreshToken: true });
  }

  close(vmId: string) {
    const entry = this.connections.get(vmId);
    if (entry) {
      entry.conn.close();
      this.connections.delete(vmId);
    }
  }

  closeAll() {
    for (const entry of this.connections.values()) {
      entry.conn.close();
    }
    this.connections.clear();
  }
}
