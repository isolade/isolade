// A controllable stand-in for `SandboxApi.execStream`, used to drive
// ClaudeSession / ClaudeBackend tests without a real VM. It captures the
// NDJSON the session pushes onto stdin, lets the test emit stdout events and
// decide when the process exits, and honors the force-kill abort signal.
export class FakeProc {
  command = "";
  stdout: ((b: Buffer) => void) | null = null;
  received: any[] = [];
  killed = false;
  private resolveExit: ((v: { exitCode: number }) => void) | null = null;
  private rejectExit: ((e: unknown) => void) | null = null;
  private exited = false;

  execStream = (
    _vmId: string,
    command: string,
    opts: {
      stdin: AsyncIterable<Buffer>;
      stdout: (b: Buffer) => void;
      stderr?: (b: Buffer) => void;
      signal?: AbortSignal;
    },
  ): Promise<{ exitCode: number }> => {
    this.command = command;
    this.stdout = opts.stdout;
    void (async () => {
      for await (const chunk of opts.stdin) {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (line.trim()) this.received.push(JSON.parse(line));
        }
      }
    })().catch(() => {});
    opts.signal?.addEventListener("abort", () => {
      this.killed = true;
      this.exit(137);
    });
    return new Promise<{ exitCode: number }>((res, rej) => {
      this.resolveExit = res;
      this.rejectExit = rej;
    });
  };

  // Emit one stream-json line on stdout.
  emit(obj: unknown): void {
    if (!this.stdout) throw new Error("process not started yet");
    this.stdout(Buffer.from(JSON.stringify(obj) + "\n"));
  }

  exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.resolveExit?.({ exitCode: code });
  }

  fail(err: unknown): void {
    if (this.exited) return;
    this.exited = true;
    this.rejectExit?.(err);
  }

  userMessages(): any[] {
    return this.received.filter((m) => m?.type === "user");
  }

  interrupts(): any[] {
    return this.received.filter(
      (m) => m?.type === "control_request" && m?.request?.subtype === "interrupt",
    );
  }
}

export const tick = () => new Promise<void>((r) => setTimeout(r, 0));
