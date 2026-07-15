import { parseSse } from "@isolade/shared";
import {
  errorResponseSchema,
  type NetworkConfig,
  type PortForward,
  type SandboxSecret,
  type SandboxVolume,
  sandboxExecResponseSchema,
  sandboxExecStreamMessageSchema,
  sandboxVmCreateRequestSchema,
  sandboxVmCreateResponseSchema,
} from "./contracts";

export type PortForwardBinding = PortForward;
export type SandboxVolumeBinding = SandboxVolume;
export type SandboxSecretBinding = SandboxSecret;

export interface CreateVmOpts {
  image: string;
  env?: Record<string, string>;
  hostPorts?: number[];
  ports?: { remote: number }[];
  volumes?: SandboxVolumeBinding[];
  secrets?: SandboxSecretBinding[];
  network?: NetworkConfig;
}

export interface ExecStreamOpts {
  stdin: AsyncIterable<Buffer>;
  stdout: (chunk: Buffer) => void;
  stderr?: (chunk: Buffer) => void;
  signal?: AbortSignal;
}

export interface ExecInteractiveOpts {
  stdin: AsyncIterable<Buffer>;
  stdout: (chunk: Buffer) => void;
  rows: number;
  cols: number;
  resize: AsyncIterable<[number, number]>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface VmHandle {
  vmId: string;
  ports: PortForwardBinding[];
}

// The contract the server uses to drive the sandbox. Implemented by the HTTP
// `SandboxClient` (external sandbox via ISOLADE_SANDBOX_URL) and by
// `InProcessSandboxClient` (the sandbox runtime running inside this process,
// the default). Every consumer (InstanceManager, AuthLoginManager, the chat
// backends, …) depends on this interface, not the concrete class.
export interface SandboxApi {
  createVm(opts: CreateVmOpts): Promise<VmHandle>;
  destroyVm(vmId: string): Promise<void>;
  // Stop a VM but keep its persisted record so restartVm/ensureVm can resume
  // it later. Used when archiving a chat.
  stopVm(vmId: string): Promise<void>;
  restartVm(vmId: string): Promise<VmHandle>;
  ensureVm(vmId: string): Promise<VmHandle>;
  exec(
    vmId: string,
    command: string,
    opts?: { workingDir?: string; timeoutMs?: number },
  ): Promise<ExecResult>;
  writeFile(vmId: string, path: string, content: Buffer): Promise<void>;
  execStream(vmId: string, command: string, opts: ExecStreamOpts): Promise<{ exitCode: number }>;
  execInteractive(
    vmId: string,
    shell: string,
    opts: ExecInteractiveOpts,
  ): Promise<{ exitCode: number }>;
  build(tarStream: ReadableStream | null, onLog: (line: string) => void): Promise<string>;
  getStats(): Promise<unknown>;
  waitUntilReady(timeoutMs?: number): Promise<boolean>;
  garbageCollect(keep: string[], onLog?: (line: string) => void): Promise<void>;
}

async function getErrorMessage(resp: Response): Promise<string> {
  try {
    return errorResponseSchema.parse(await resp.json()).error;
  } catch {
    return resp.statusText;
  }
}

export class SandboxClient implements SandboxApi {
  private wsBase: string;

  constructor(private baseUrl: string) {
    this.wsBase = baseUrl.replace(/^http/, "ws");
  }

  async createVm(opts: CreateVmOpts): Promise<{ vmId: string; ports: PortForwardBinding[] }> {
    const body = sandboxVmCreateRequestSchema.parse(opts);
    const resp = await fetch(`${this.baseUrl}/vms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(await getErrorMessage(resp));
    }
    const { id, ports } = sandboxVmCreateResponseSchema.parse(await resp.json());
    return { vmId: id, ports };
  }

  async destroyVm(vmId: string): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/vms/${vmId}`, {
      method: "DELETE",
    });
    if (!resp.ok) {
      throw new Error(`destroyVm ${vmId}: ${await getErrorMessage(resp)}`);
    }
  }

  async stopVm(vmId: string): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/vms/${vmId}/stop`, {
      method: "POST",
    });
    if (!resp.ok) {
      throw new Error(`stopVm ${vmId}: ${await getErrorMessage(resp)}`);
    }
  }

  async restartVm(vmId: string): Promise<{ vmId: string; ports: PortForwardBinding[] }> {
    const resp = await fetch(`${this.baseUrl}/vms/${vmId}/restart`, {
      method: "POST",
    });
    if (!resp.ok) {
      throw new Error(await getErrorMessage(resp));
    }
    const { id, ports } = sandboxVmCreateResponseSchema.parse(await resp.json());
    return { vmId: id, ports };
  }

  // Re-attach without forcing a stop/start. Used at server boot to
  // repopulate in-memory port-forward state without disturbing alive VMs.
  async ensureVm(vmId: string): Promise<{ vmId: string; ports: PortForwardBinding[] }> {
    const resp = await fetch(`${this.baseUrl}/vms/${vmId}/ensure`, {
      method: "POST",
    });
    if (!resp.ok) {
      throw new Error(await getErrorMessage(resp));
    }
    const { id, ports } = sandboxVmCreateResponseSchema.parse(await resp.json());
    return { vmId: id, ports };
  }

  async exec(
    vmId: string,
    command: string,
    opts: { workingDir?: string; timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const resp = await fetch(`${this.baseUrl}/vms/${vmId}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, ...opts }),
    });
    if (!resp.ok) {
      throw new Error(await getErrorMessage(resp));
    }
    return sandboxExecResponseSchema.parse(await resp.json());
  }

  async writeFile(vmId: string, path: string, content: Buffer): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/vms/${vmId}/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, content: content.toString("base64") }),
    });
    if (!resp.ok) {
      throw new Error(await getErrorMessage(resp));
    }
  }

  async execStream(
    vmId: string,
    command: string,
    opts: {
      stdin: AsyncIterable<Buffer>;
      stdout: (chunk: Buffer) => void;
      stderr?: (chunk: Buffer) => void;
      signal?: AbortSignal;
    },
  ): Promise<{ exitCode: number }> {
    const url = new URL(`${this.wsBase}/vms/${vmId}/exec-stream`);
    url.searchParams.set("command", encodeURIComponent(command));

    const ws = new WebSocket(url.toString());
    ws.binaryType = "arraybuffer";

    return new Promise((resolve, reject) => {
      let resolved = false;

      // Closing the websocket signals the sandbox to kill the subprocess
      // (see exec-stream onClose in packages/sandbox/src/index.ts), so an
      // AbortSignal on this call propagates all the way down to the
      // running CLI process.
      const settle = (fn: () => void) => {
        if (resolved) return;
        resolved = true;
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        try {
          ws.close(1000, "aborted");
        } catch {}
        settle(() => reject(new DOMException("aborted", "AbortError")));
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      ws.onopen = () => {
        (async () => {
          for await (const chunk of opts.stdin) {
            if (ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array(chunk));
          }
          // Signal EOF so the server's stdin iterable completes
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "stdin_eof" }));
          }
        })().catch(() => {});
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          opts.stdout(Buffer.from(event.data));
        } else if (typeof event.data === "string") {
          try {
            const msg = sandboxExecStreamMessageSchema.parse(JSON.parse(event.data));
            if (msg.type === "stderr" && opts.stderr) {
              opts.stderr(Buffer.from(msg.data));
            } else if (msg.type === "exit") {
              settle(() => resolve({ exitCode: msg.exitCode }));
            } else if (msg.type === "error") {
              settle(() => reject(new Error(msg.message)));
            }
          } catch {}
        }
      };

      ws.onclose = (event) => {
        // The sandbox always delivers an `exit` (or `error`) message before
        // closing, and the abort path settles before closing too, so if we
        // reach onclose still unsettled, the socket dropped mid-command
        // (sandbox crash, network blip). Resolving exitCode 0 here would make
        // the caller treat a truncated stream as a clean success, e.g. the
        // claude backend persists the partial turn as if complete. Surface it
        // as the failure it is.
        settle(() =>
          reject(
            new Error(
              `sandbox exec-stream closed before the command finished (code ${event.code})`,
            ),
          ),
        );
      };

      ws.onerror = () => {
        settle(() => reject(new Error("WebSocket connection to sandbox exec-stream failed")));
      };
    });
  }

  async execInteractive(
    vmId: string,
    shell: string,
    opts: {
      stdin: AsyncIterable<Buffer>;
      stdout: (chunk: Buffer) => void;
      rows: number;
      cols: number;
      resize: AsyncIterable<[number, number]>;
    },
  ): Promise<{ exitCode: number }> {
    const url = new URL(`${this.wsBase}/vms/${vmId}/pty`);
    url.searchParams.set("shell", encodeURIComponent(shell));
    url.searchParams.set("rows", String(opts.rows));
    url.searchParams.set("cols", String(opts.cols));

    const ws = new WebSocket(url.toString());
    ws.binaryType = "arraybuffer";

    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        // Drive stdin iterable → WS binary frames
        (async () => {
          for await (const chunk of opts.stdin) {
            if (ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array(chunk));
          }
          if (ws.readyState === WebSocket.OPEN) ws.close(1000);
        })().catch(() => {});

        // Drive resize iterable → WS text frames
        (async () => {
          for await (const [rows, cols] of opts.resize) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "resize", rows, cols }));
            }
          }
        })().catch(() => {});
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          opts.stdout(Buffer.from(event.data));
        }
      };

      ws.onclose = (event) => {
        // 1011 is the sandbox route reporting the session never ran (or
        // died), so surface its reason instead of pretending the shell exited.
        if (event.code === 1011) {
          reject(new Error(event.reason || "sandbox terminal error"));
        } else {
          resolve({ exitCode: event.code === 1000 ? 0 : 1 });
        }
      };

      ws.onerror = () => {
        reject(new Error("WebSocket connection to sandbox PTY failed"));
      };
    });
  }

  async build(tarStream: ReadableStream | null, onLog: (line: string) => void): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/builds`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
      },
      body: tarStream,
      // @ts-ignore: Bun supports streaming request bodies
      duplex: "half",
      // Bun's default fetch timeout (5min) fires on idle reads. Buildkit's
      // export-layers phase pushes gigabytes to the local registry silently
      // and can sit without emitting progress for longer than that, which
      // would surface as "TimeoutError: The operation timed out." even
      // though the build is healthy. Builds are bounded by their own logic.
      // @ts-ignore: Bun-specific option
      timeout: false,
    });
    if (!resp.ok) throw new Error(`Build request failed: ${resp.status} ${resp.statusText}`);
    if (!resp.body) throw new Error("No response body from build endpoint");

    let imageId: string | undefined;
    // idleTimeoutMs: 0 because builds legitimately sit silent (see the fetch
    // timeout note above), so no idle watchdog here.
    for await (const ev of parseSse(resp.body, { idleTimeoutMs: 0 })) {
      if (ev.event === "log") {
        onLog(ev.data);
      } else if (ev.event === "done") {
        imageId = (JSON.parse(ev.data) as { imageId: string }).imageId;
      } else if (ev.event === "error") {
        throw new Error(`Build error: ${ev.data}`);
      }
    }

    if (!imageId) throw new Error("Build completed but no imageId received");
    return imageId;
  }

  async getStats(): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}/stats`);
    if (!resp.ok) throw new Error(await getErrorMessage(resp));
    return resp.json();
  }

  // Poll /stats until it answers or the timeout elapses. Used by boot-time
  // VM resync so we don't fire restart() at a sandbox-service that isn't
  // listening yet (dev.sh launches us in parallel, not strictly after).
  async waitUntilReady(timeoutMs = 30_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`${this.baseUrl}/stats`);
        if (resp.ok) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  // Asks the sandbox to keep only the given image refs (and the implicit
  // base-pass refs the builder pairs with them) and reclaim everything else
  // from the local registry. Streams progress lines via `onLog`. Throws on
  // an SSE `error` event. Otherwise it resolves once `done` is received.
  async garbageCollect(keep: string[], onLog: (line: string) => void = () => {}): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/registry/gc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keep }),
      // Manifest+blob deletion across a large registry can sit silent for
      // long stretches, so bypass Bun's default fetch timeout the same way the
      // build endpoint does.
      // @ts-ignore: Bun-specific option
      timeout: false,
    });
    if (!resp.ok) throw new Error(`registry gc request failed: ${resp.status} ${resp.statusText}`);
    if (!resp.body) throw new Error("registry gc returned no body");

    // idleTimeoutMs: 0 because deletion sweeps sit silent like builds do.
    for await (const ev of parseSse(resp.body, { idleTimeoutMs: 0 })) {
      if (ev.event === "log") onLog(ev.data);
      else if (ev.event === "error") throw new Error(`registry gc error: ${ev.data}`);
    }
  }
}
