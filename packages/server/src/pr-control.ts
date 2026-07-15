import type { AttachedPr } from "./contracts";
import { type PrRef, type PrRefInput, resolvePrRef } from "./pr-attachments";

// Host handler for the `pr` family of in-VM `isolade` CLI commands. Rides the
// same control socket / request broker as the port-control CLI (port-control.ts):
// the broker forwards one JSON request at a time, this produces the JSON reply.
// Ref resolution (URL / number+remote → owner/repo/number) lives in
// pr-attachments so it's shared with any other caller and unit-tested once.

// Operations the host exposes to the in-VM CLI, bound to a specific instance id
// by InstanceManager. Kept thin: the handler resolves the wire payload into a
// concrete PrRef before calling in.
export interface PrControlOps {
  add(ref: PrRef): Promise<AttachedPr>;
  list(): AttachedPr[];
  remove(ref: PrRef): void;
}

/** Handle one `pr-*` control request and produce the JSON reply bytes. Pure
 * w.r.t. `ops`, so it's unit-testable with a fake. Never throws: errors come
 * back as `{ ok: false, error }`. */
export async function handlePrCommand(request: Buffer, ops: PrControlOps): Promise<Buffer> {
  const reply = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8");
  let msg: { cmd?: string } & PrRefInput;
  try {
    msg = JSON.parse(request.toString("utf8"));
  } catch {
    return reply({ ok: false, error: "malformed request" });
  }
  try {
    switch (msg.cmd) {
      case "pr-list":
        return reply({ ok: true, prs: ops.list() });
      case "pr-add": {
        const ref = resolvePrRef(msg);
        if ("error" in ref) return reply({ ok: false, error: ref.error });
        return reply({ ok: true, pr: await ops.add(ref) });
      }
      case "pr-remove": {
        const ref = resolvePrRef(msg);
        if ("error" in ref) return reply({ ok: false, error: ref.error });
        ops.remove(ref);
        return reply({ ok: true, removed: ref });
      }
      default:
        return reply({ ok: false, error: `unknown command: ${msg.cmd ?? "(none)"}` });
    }
  } catch (err) {
    return reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
