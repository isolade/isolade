import type { PortForwardBinding } from "./sandbox-client";

// In-VM agent control for port forwards. A small `isolade` CLI runs inside the
// guest and talks to the host over the generic request broker (request-broker.ts),
// so the agent (or a human at a shell) can inspect and change forwards with:
//
//   isolade ports                # list forwards (host -> guest, one per line)
//   isolade ports add 5173       # expose guest 5173 on an ephemeral host port
//   isolade ports add 8080:5173  # pin host 8080 -> guest 5173 (docker publish
//                                # order; expose_sandbox instances only)
//   isolade ports rm 5173 ...    # stop forwarding (also accepts HOST:GUEST)
//   isolade ports rm --all
//
// The CLI can't reach the host loopback URL itself (it's in the VM). The point
// is to make a server it started visible in the human's Ports panel / preview.

/** VM-local unix socket the control broker listens on and the CLI connects to. */
export const CTL_SOCK = "/tmp/isolade-ctl.sock";
/** Where the control broker script is written inside the VM. */
export const CTL_BROKER_PATH = "/tmp/isolade-ctl-broker.cjs";

// Operations the host exposes to the in-VM CLI. Implemented by InstanceManager,
// bound to a specific instance id.
export interface PortControlOps {
  list(): PortForwardBinding[];
  /** Open a forward. `hostPort` pins the host loopback port (the CLI's
   * `ports add 1455:1455`); omitted, the kernel picks one. `ephemeral: true` skips the
   * persisted row, so the forward dies with the VM/server instead of being
   * reopened on every restart — the lifetime automated flows want (a nested
   * isolade pins its OAuth callback this way, see auth-login.ts). User-typed
   * forwards persist. */
  forward(remotePort: number, hostPort?: number, ephemeral?: boolean): Promise<PortForwardBinding>;
  unforward(remotePort: number): void;
}

function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** Handle one CLI request (a JSON command) and produce the JSON response bytes.
 * Pure w.r.t. `ops`, so it's unit-testable with a fake. Never throws. Errors
 * come back as `{ ok: false, error }`. */
export async function handlePortCommand(request: Buffer, ops: PortControlOps): Promise<Buffer> {
  const reply = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8");
  let msg: { cmd?: string; port?: unknown; hostPort?: unknown; ephemeral?: unknown };
  try {
    msg = JSON.parse(request.toString("utf8"));
  } catch {
    return reply({ ok: false, error: "malformed request" });
  }
  try {
    switch (msg.cmd) {
      case "list": {
        const forwarded = ops
          .list()
          .map((b) => ({ remotePort: b.remotePort, localPort: b.localPort }));
        return reply({ ok: true, forwarded });
      }
      case "forward": {
        if (!isValidPort(msg.port)) return reply({ ok: false, error: "invalid port" });
        if (msg.hostPort !== undefined && !isValidPort(msg.hostPort)) {
          return reply({ ok: false, error: "invalid host port" });
        }
        if (msg.ephemeral !== undefined && typeof msg.ephemeral !== "boolean") {
          return reply({ ok: false, error: "invalid ephemeral flag" });
        }
        const b = await ops.forward(msg.port, msg.hostPort, msg.ephemeral);
        return reply({
          ok: true,
          remotePort: b.remotePort,
          localPort: b.localPort,
        });
      }
      case "unforward": {
        if (!isValidPort(msg.port)) return reply({ ok: false, error: "invalid port" });
        ops.unforward(msg.port);
        return reply({ ok: true });
      }
      default:
        return reply({
          ok: false,
          error: `unknown command: ${msg.cmd ?? "(none)"}`,
        });
    }
  } catch (err) {
    return reply({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The `isolade` guest CLI: connects to the control socket, sends one command,
 * prints the reply. Self-contained Node (present in the guest, see auth-sync /
 * sign-broker). Covers the port-control commands and the `pr` family (attach a
 * pull request to this chat, which surfaces as a live badge in the title bar).
 * A bare `pr add N` resolves the repo from the cwd's `origin` remote, which is
 * why it's run from inside the checkout. */
export function buildControlCli(socketPath: string): string {
  return `#!/usr/bin/env node
'use strict';
const net = require('net');
const { execFileSync } = require('child_process');
const SOCK = ${JSON.stringify(socketPath)};
const [, , cmd, ...rest] = process.argv;

function usage() {
  console.error('usage: isolade <ports [add [HOST:]PORT | rm PORT...|--all] | pr [add|list|rm] ...>');
  process.exit(2);
}

// One request → one reply. onOk renders the successful reply; errors are printed
// uniformly and exit non-zero.
function send(req, onOk) {
  const chunks = [];
  const conn = net.connect(SOCK);
  conn.on('error', (e) => {
    console.error('isolade: cannot reach host control socket (' + e.message + ')');
    process.exit(1);
  });
  conn.on('connect', () => conn.end(JSON.stringify(req)));
  conn.on('data', (d) => chunks.push(d));
  conn.on('end', () => {
    let res;
    try { res = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (e) { console.error('isolade: malformed response from host'); process.exit(1); }
    if (!res.ok) { console.error('isolade: ' + (res.error || 'request failed')); process.exit(1); }
    onOk(res);
  });
}

// The cwd repo's origin URL, so the host can turn a bare PR number into
// owner/repo. Undefined when there's no repo/remote (the host then explains).
function originUrl() {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim() || undefined;
  } catch (e) { return undefined; }
}

// A ref argument is either a full PR URL or a bare number. Build the wire fields
// for whichever it is (the host parses both).
function refFields(arg) {
  if (/:\\/\\/|\\/pulls?\\//.test(arg)) return { prUrl: arg };
  const number = Number(arg);
  if (!Number.isInteger(number) || number < 1) usage();
  return { number, remoteUrl: originUrl() };
}

function prLabel(pr) {
  const draft = pr.isDraft ? ' [draft]' : '';
  const head = pr.owner + '/' + pr.repo + '#' + pr.number;
  return head + '  (' + pr.state + ')' + draft + (pr.title ? '  ' + pr.title : '');
}

if (cmd === 'pr') {
  const sub = rest[0];
  if (sub === undefined || sub === 'list' || sub === 'ls') {
    send({ cmd: 'pr-list' }, (res) => {
      if (!res.prs.length) console.log('No pull requests attached to this chat.');
      else for (const pr of res.prs) console.log(prLabel(pr));
    });
  } else if (sub === 'add' || sub === 'attach') {
    if (rest[1] === undefined) usage();
    send({ cmd: 'pr-add', ...refFields(rest[1]) }, (res) => {
      console.log('Attached ' + prLabel(res.pr) + ' to this chat.');
    });
  } else if (sub === 'rm' || sub === 'remove' || sub === 'detach') {
    if (rest[1] === undefined) usage();
    send({ cmd: 'pr-remove', ...refFields(rest[1]) }, (res) => {
      console.log('Detached ' + res.removed.owner + '/' + res.removed.repo + '#' + res.removed.number + ' from this chat.');
    });
  } else usage();
} else if (cmd === 'ports') {
  const sub = rest[0];
  if (sub === undefined) {
    send({ cmd: 'list' }, (res) => {
      if (!res.forwarded.length) console.log('No ports forwarded.');
      else for (const f of res.forwarded) console.log('localhost:' + f.localPort + ' -> ' + f.remotePort);
    });
  } else if (sub === 'add') {
    // add [HOST:]PORT, docker publish order: the optional pinned host
    // loopback port first, the guest port last. Bare PORT gets an ephemeral
    // host port; pinning is an expose_sandbox privilege (the host refuses it
    // elsewhere).
    if (rest[1] === undefined || rest[2] !== undefined) usage();
    const parts = String(rest[1]).split(':');
    if (parts.length > 2) usage();
    const port = Number(parts[parts.length - 1]);
    const hostPort = parts.length === 2 ? Number(parts[0]) : undefined;
    if (!Number.isInteger(port) || port < 1) usage();
    if (hostPort !== undefined && (!Number.isInteger(hostPort) || hostPort < 1)) usage();
    send({ cmd: 'forward', port, ...(hostPort !== undefined ? { hostPort } : {}) }, (res) => {
      console.log('Forwarding localhost:' + res.localPort + ' -> guest ' + res.remotePort + ' (visible in the Ports panel).');
    });
  } else if (sub === 'rm' || sub === 'remove') {
    if (rest[1] === undefined) usage();
    if (rest[1] === '--all') {
      send({ cmd: 'list' }, (res) => {
        if (!res.forwarded.length) { console.log('No ports forwarded.'); return; }
        for (const f of res.forwarded) {
          send({ cmd: 'unforward', port: f.remotePort }, () => console.log('Stopped forwarding ' + f.remotePort + '.'));
        }
      });
    } else {
      // Each argument is a guest port; a pasted HOST:GUEST mapping is
      // accepted and keyed on its guest side.
      const ports = rest.slice(1).map((a) => Number(String(a).split(':').pop()));
      if (ports.some((p) => !Number.isInteger(p) || p < 1)) usage();
      for (const port of ports) {
        send({ cmd: 'unforward', port }, () => console.log('Stopped forwarding ' + port + '.'));
      }
    }
  } else usage();
} else usage();
`;
}

/** Shell command that installs the CLI on PATH inside the guest. Prefers
 * /usr/local/bin (on every user's PATH), falling back to ~/.local/bin when the
 * runtime user can't write there. Best-effort, so a failed install just means the
 * agent helper is unavailable, not a broken VM. */
export function buildInstallCliCommand(cliScript: string): string {
  const b64 = Buffer.from(cliScript, "utf8").toString("base64");
  return (
    `(echo ${b64} | base64 -d > /usr/local/bin/isolade && chmod +x /usr/local/bin/isolade) 2>/dev/null || ` +
    `(mkdir -p "$HOME/.local/bin" && echo ${b64} | base64 -d > "$HOME/.local/bin/isolade" && chmod +x "$HOME/.local/bin/isolade")`
  );
}
