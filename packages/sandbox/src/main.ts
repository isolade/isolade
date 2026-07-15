// Unified entry for the local sandbox process (both `bun run src/main.ts` in
// dev and the `bun build --compile`d sidecar binary).
//
// Responsibilities, in order:
//   1. Pin isolade's isolated MSB_HOME / MSB_PATH (via ./msb-home).
//   2. Point microsandbox's NAPI loader at the runtime's `.node`. `bun build
//      --compile` doesn't embed napi-rs platform packages, so the `.node` ships
//      separately. NAPI_RS_NATIVE_LIBRARY_PATH preempts the normal resolution.
//      In release lib.rs sets it to the bundled runtime. Here we also fall back
//      to a sibling `.node`. In dev it stays unset and resolves via node_modules.
//   3. Verify the optional `microsandbox` SDK actually loads, with a helpful
//      message if not (lets users run without a local sandbox via
//      ISOLADE_SANDBOX_URL instead).
//   4. Import ./index and start the HTTP server.

// Pin MSB_HOME/MSB_PATH to isolade's isolated layout before anything touches
// microsandbox. This is pure env setup that imports no native code, so it is
// safe this early in the compiled-sidecar bootstrap.
import "./msb-home";
import { pinNapiLibraryPath } from "./napi-path";

// Set the NAPI library path BEFORE loading microsandbox so the binding resolves
// to the right `.node`.
pinNapiLibraryPath();

// Verify microsandbox is available (it's an optional dependency). A real import
// works whether the SDK lives in node_modules (dev) or is bundled into this
// compiled binary (release). `import.meta.resolve` cannot see packages embedded
// in the `bun build --compile` filesystem, but a real import can. The NAPI path
// is already set above, so loading the binding here uses the intended `.node`.
try {
  await import("microsandbox");
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(
    "[sandbox] microsandbox could not be loaded. The local sandbox process " +
      "cannot start without it.\n" +
      "  Either build microsandbox alongside this checkout (see README) and " +
      "re-run `bun install`,\n" +
      "  or skip running packages/sandbox locally and point the server at " +
      "an external sandbox service\n" +
      "  by setting ISOLADE_SANDBOX_URL.\n" +
      `  (loader: ${msg})`,
  );
  process.exit(1);
}

const mod = await import("./index");
Bun.serve(await mod.startSandboxServer());
