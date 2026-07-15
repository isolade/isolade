import { runRequestBroker } from "./request-broker";
import type { SandboxApi } from "./sandbox-client";

// Exec-stream commit-signing transport: the generic request/response broker
// (request-broker.ts) specialized for git commit signing. Instead of the VM
// reaching out to the host over the network (which the locked-down network
// policy forbids), the HOST holds a persistent exec stream into the VM and
// signs on demand. No host port, no bind mount, no network-policy change.
//
//   VM:   git → shim (sign-shim.ts) ──unix socket──▶ broker (request-broker.ts)
//   pipe: broker.stdout ──[len][payload]──▶ host        (over execStream)
//         broker.stdin  ◀──[status][len][sig]── host
//   host: signs via GitConfigManager.signPayload, frames the SSHSIG back
//
// The shim↔broker hop needs no framing, since each request is its own short-lived
// connection, delimited by the shim half-closing after it writes the payload.

/** VM-local unix socket the broker listens on and the shim connects to. */
export const SIGN_SOCK = "/tmp/isolade-sign.sock";
/** Where the broker script is written inside the VM. */
const BROKER_PATH = "/tmp/isolade-sign-broker.cjs";

/** Hold a persistent exec stream to the in-VM signing broker, signing each
 * forwarded request via `sign`. Auto-reconnects (the broker dies on VM reboot,
 * the stream drops on a sandbox blip) until `signal` aborts. A `sign` that
 * throws is relayed to the shim as an error (status 1) rather than killing the
 * stream. */
export function runSignerStream(opts: {
  sandboxClient: SandboxApi;
  vmId: string;
  sign: (payload: Buffer) => Buffer;
  signal: AbortSignal;
}): Promise<void> {
  return runRequestBroker({
    sandboxClient: opts.sandboxClient,
    vmId: opts.vmId,
    socketPath: SIGN_SOCK,
    brokerPath: BROKER_PATH,
    handle: async (payload) => opts.sign(payload),
    signal: opts.signal,
    label: "git-signer",
  });
}
