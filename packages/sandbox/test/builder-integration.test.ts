/**
 * Integration tests for BuilderManager. Boots a real microsandbox VM running
 * buildkitd and exercises the end-to-end build pipeline against an in-process
 * test registry, no external services required.
 *
 * Slow: cold boot + first image pull is ~15-30s. Each build is ~10-30s. Gated
 * behind ISOLADE_BUILDER_E2E=1 so the default sandbox test suite stays fast.
 *
 * Prereqs: microsandbox installed (msb on PATH or NAPI native available).
 *
 * Run:
 *   ISOLADE_BUILDER_E2E=1 bun test --cwd packages/sandbox \
 *       test/builder-integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BuilderManager } from "../src/builder";
import { parseImageRef } from "../src/builds";
import { type IsolatedHome, setupIsolatedHome } from "./isolated-home";
import { startTestRegistry, type TestRegistryHandle } from "./test-registry";

const ENABLED = process.env.ISOLADE_BUILDER_E2E === "1";
const ctx = ENABLED ? describe : describe.skip;

const BOOT_TIMEOUT_MS = 180_000;
const BUILD_TIMEOUT_MS = 300_000;

// Build a tar archive in memory from a {path: contents} map. Mirrors what the
// real /builds endpoint receives from the server.
async function makeTar(
  files: Record<string, string | Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  const dir = await mkdtemp(join(tmpdir(), "isolade-test-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    const proc = Bun.spawn(["tar", "-cf", "-", "-C", dir, "."], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    const exit = await proc.exited;
    if (exit !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`tar failed (${exit}): ${err}`);
    }
    return new ReadableStream({
      start(c) {
        c.enqueue(buf);
        c.close();
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function drain<T, R>(gen: AsyncGenerator<T, R>): Promise<{ logs: T[]; result: R }> {
  const logs: T[] = [];
  try {
    while (true) {
      const r = await gen.next();
      if (r.done) return { logs, result: r.value };
      logs.push(r.value);
    }
  } catch (err) {
    // Re-throw with the collected logs attached so failing tests get context.
    const wrapped =
      err instanceof Error ? Object.assign(err, { logs }) : new Error(String(err), { cause: err });
    throw wrapped;
  }
}

ctx("BuilderManager integration", () => {
  let builder: BuilderManager;
  let registry: TestRegistryHandle;
  let home: IsolatedHome | null = null;
  let originalRegistryEnv: string | undefined;

  beforeAll(async () => {
    // Re-root HOME first so microsandbox uses a fresh sqlite db and image
    // cache, isolated from any concurrent ./dev.sh run on the same machine.
    home = setupIsolatedHome();

    registry = await startTestRegistry();
    // Builder uses ISOLADE_REGISTRY's port and substitutes the bridge IP for
    // the host part. We want it to push to our test registry's port.
    originalRegistryEnv = process.env.ISOLADE_REGISTRY;
    process.env.ISOLADE_REGISTRY = `localhost:${registry.port}`;

    // The builder no longer assembles the Dockerfile. Tests ship a final
    // Dockerfile in the tar. Each runBuild boots its own VM, no warmup.
    builder = new BuilderManager();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    if (builder) await builder.shutdown();
    if (registry) await registry.shutdown();
    if (originalRegistryEnv === undefined) delete process.env.ISOLADE_REGISTRY;
    else process.env.ISOLADE_REGISTRY = originalRegistryEnv;
    if (home) home.cleanup();
  }, 120_000);

  it("registryEndpoint returns a host:port string", () => {
    expect(builder.registryEndpoint()).toMatch(/^[\w.-]+:\d+$/);
  });

  it(
    "builds a trivial Dockerfile end-to-end and pushes it to the registry",
    async () => {
      const tar = await makeTar({
        Dockerfile: "FROM alpine:3.19\nRUN echo hello > /hello.txt\n",
      });
      const { logs, result } = await drain(builder.runBuild(tar, "host"));

      expect(result).toMatch(/^[\w.-]+:\d+\/isolade\/[\w.-]+:latest$/);
      const joined = logs.join("\n");
      expect(joined).toContain("=== Building image ===");
      expect(joined).toContain("=== Build complete ===");

      const parsed = parseImageRef(result);
      expect(parsed).not.toBeNull();
      expect(registry.manifests.has(`${parsed!.name}:${parsed!.tag}`)).toBe(true);
      expect(registry.blobs.size).toBeGreaterThan(0);
      expect([...registry.manifests.keys()].some((k) => k.startsWith("isolade-base/"))).toBe(false);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "exposes context/ as the buildctl main context and repos/<name> as named contexts",
    async () => {
      // The server's wire format: Dockerfile at root, optional context/, one
      // repos/<name>/ per workspace repo. Builder must wire each into buildctl
      // as `--local <name>=...` plus `--opt context:<name>=local:<name>`.
      const tar = await makeTar({
        Dockerfile:
          "FROM alpine:3.19\n" +
          "COPY hello.txt /from-context/hello.txt\n" +
          "COPY --from=test payload.txt /from-repo/payload.txt\n",
        "context/hello.txt": "hi from context\n",
        "repos/test/payload.txt": "hi from repo\n",
      });
      const { result } = await drain(builder.runBuild(tar, "host"));
      expect(result).toMatch(/\/isolade\//);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "propagates build failures from buildctl",
    async () => {
      const tar = await makeTar({
        Dockerfile: "FROM alpine:3.19\nRUN exit 17\n",
      });
      await expect(drain(builder.runBuild(tar, "host"))).rejects.toThrow();
    },
    BUILD_TIMEOUT_MS,
  );

  // Regression: microsandbox caps each exec stdin frame at 4 MiB. A real
  // workspace tar can be tens or hundreds of MB, so the pump has to chunk
  // before writing. Otherwise the first frame is rejected with "frame too
  // large". We use 8 MiB of incompressible random bytes to stay above the
  // limit even after tar's own buffering.
  it(
    "streams a build context larger than the microsandbox stdin frame limit",
    async () => {
      const blob = new Uint8Array(8 * 1024 * 1024);
      crypto.getRandomValues(blob);
      const tar = await makeTar({
        Dockerfile: "FROM alpine:3.19\nCOPY blob.bin /blob.bin\n",
        "context/blob.bin": blob,
      });
      try {
        const { result } = await drain(builder.runBuild(tar, "host"));
        expect(result).toMatch(/\/isolade\/[\w.-]+:latest$/);
      } catch (err) {
        const logs = (err as { logs?: string[] }).logs ?? [];
        console.error("[regression test] logs:\n" + logs.join("\n"));
        throw err;
      }
    },
    BUILD_TIMEOUT_MS,
  );
});
