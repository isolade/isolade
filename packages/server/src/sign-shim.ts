// The in-VM commit-signing shim. Git is pointed at this script via
// `gpg.ssh.program`. git invokes it exactly like `ssh-keygen`:
//
//   <program> -Y sign  -n git -f <key> [-U] <bufferfile>   ← we handle this
//   <program> -Y verify / find-principals / check-novalidate ...  ← delegate
//
// For `sign`, the shim hands the buffer git wrote to the in-VM broker
// (sign-broker.ts) over a VM-local unix socket (connect, write the bytes,
// half-close, read the SSHSIG back) and writes it to "<bufferfile>.sig" where
// git looks. The broker relays to the host over the exec channel, with no network,
// no port. Every other `-Y` subcommand (verification) needs no private key, so
// the shim delegates it to the real ssh-keygen in the guest.

/** What the shim should do with a given git invocation. Pure so it's unit
 * tested. The generated script embeds the same rule. */
export type SignShimAction = { mode: "sign"; bufferFile: string } | { mode: "passthrough" };

export function classifySignShimArgs(args: string[]): SignShimAction {
  // git always calls the signing form as `-Y sign … <bufferfile>` with the
  // file to sign as the final positional argument.
  if (args[0] === "-Y" && args[1] === "sign" && args.length >= 3) {
    return { mode: "sign", bufferFile: args[args.length - 1]! };
  }
  return { mode: "passthrough" };
}

/** Build the self-contained Node CJS shim written into each opted-in VM and
 * pointed at by `gpg.ssh.program`. No deps beyond Node core. Carries a
 * `#!/usr/bin/env node` shebang so git (which exec()s it directly) runs it. */
export function buildSignShimScript(opts: { socketPath: string }): string {
  return `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const net = require('net');
const SOCK = ${JSON.stringify(opts.socketPath)};
const args = process.argv.slice(2);

function classify(a) {
  if (a[0] === '-Y' && a[1] === 'sign' && a.length >= 3) {
    return { mode: 'sign', bufferFile: a[a.length - 1] };
  }
  return { mode: 'passthrough' };
}

function fail(msg) {
  process.stderr.write('isolade sign helper: ' + msg + '\\n');
  process.exit(1);
}

const action = classify(args);

if (action.mode !== 'sign') {
  // Verification and friends need no private key, so run the real ssh-keygen.
  const { spawnSync } = require('child_process');
  const r = spawnSync('ssh-keygen', args, { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

let payload;
try {
  payload = fs.readFileSync(action.bufferFile);
} catch (e) {
  fail('cannot read buffer file ' + action.bufferFile + ': ' + (e && e.message || e));
}

const conn = net.connect(SOCK);
const chunks = [];
let settled = false;
const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  conn.destroy();
  fail('timed out waiting for the signer');
}, 30000);

conn.on('connect', () => conn.end(payload)); // write payload, then half-close
conn.on('data', (d) => chunks.push(d));
conn.on('close', () => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  const sig = Buffer.concat(chunks);
  if (!sig.length) fail('signer returned no signature (signing disabled or agent unavailable)');
  try {
    fs.writeFileSync(action.bufferFile + '.sig', sig);
  } catch (e) {
    fail('cannot write signature: ' + (e && e.message || e));
  }
  process.exit(0);
});
conn.on('error', (e) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  fail('cannot reach signer broker at ' + SOCK + ': ' + (e && e.message || e));
});
`;
}
