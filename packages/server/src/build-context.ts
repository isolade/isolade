import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASSEMBLED_LAYER_STAGE,
  ASSEMBLED_USER_STAGE,
  type ResolvedProfileConfig,
  type ResolvedRepo,
} from "./profile-config";
import { shellQuote } from "./shell";

// Guest user the agent layer creates and runs as. Matches the layer fragment
// below. If the user's base image already has a user named differently, the
// agent fragment fails. That is out of scope.
const AGENT_USER = "agent";
const AGENT_HOME = "/home/agent";

// Apt + node + agent-CLI fragment appended to every workspace image after the
// user's last stage. Cache mounts (--mount=type=cache) live on the builder's
// virtio-blk ext4 disk and survive across builds. The agent user must exist
// in the base image, and the fragment chowns /workspace to them.
//
// `skills` lists packages to install via `npx skills add` for both codex and
// claude-code (workspace config's `skills = [...]`). Empty array → no skills step.
function buildAgentLayerFragment(skills: readonly string[] = []): string {
  const skillsStep =
    skills.length === 0
      ? ""
      : `\nRUN ${skills
          .map(
            (pkg) =>
              `npx -y skills@latest add ${shellQuote(pkg)} ` +
              `--global --agent codex --agent claude-code --skill '*' --yes`,
          )
          .join(" \\\n && ")}\n`;
  return `
ENV PATH="${AGENT_HOME}/.local/bin:$PATH"

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    --mount=type=cache,target=/var/lib/apt,sharing=locked \\
    rm -f /etc/apt/apt.conf.d/docker-clean \\
    && apt-get update \\
    && apt-get install -y --no-install-recommends \\
        ca-certificates curl git gh fd-find ripgrep \\
    && curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \\
    && apt-get install -y --no-install-recommends nodejs \\
    && case "$(dpkg --print-architecture)" in \\
        amd64) ttyd_arch=x86_64 ;; \\
        arm64) ttyd_arch=aarch64 ;; \\
        *) echo "ttyd: unsupported arch $(dpkg --print-architecture)" >&2; exit 1 ;; \\
       esac \\
    && curl -fsSL -o /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.\${ttyd_arch}" \\
    && chmod +x /usr/local/bin/ttyd \\
    && mkdir -p /workspace \\
    && chown ${AGENT_USER} /workspace

RUN --mount=type=cache,target=/root/.npm \\
    npm install -g @openai/codex

USER ${AGENT_USER}
RUN HOME=${AGENT_HOME} curl -fsSL https://claude.ai/install.sh | bash
${skillsStep}
WORKDIR /workspace
`;
}

// Build the final Dockerfile shipped to buildctl: user file → renamed last
// stage → agent tooling layer. Each workspace repo is exposed to the user's
// Dockerfile as a buildkit named context `<name>` (wired up by the builder from
// the tar's `repos/<name>/` directories). Placement, checkout-vs-tree, and any
// prewarm steps are the user Dockerfile's responsibility, so nothing is spliced
// in per repo here.
export function assembleDockerfile(
  userDockerfile: string,
  layerFragment: string = buildAgentLayerFragment(),
): Buffer {
  const { dockerfile, stageName } = ensureLastStageNamed(userDockerfile, ASSEMBLED_USER_STAGE);

  const assembled =
    dockerfile.replace(/\s*$/, "\n") +
    `\nFROM ${stageName} AS ${ASSEMBLED_LAYER_STAGE}\n` +
    `USER root\n` +
    layerFragment;

  return Buffer.from(assembled, "utf8");
}

export interface BuildContextTarOpts {
  /** Final Dockerfile bytes shipped at the tar root. */
  dockerfileBytes: Buffer;
  /**
   * Each repo's working tree *and* `.git` are tarred under `repos/<name>/`,
   * which the builder registers as the named context `<name>`.
   */
  repos: readonly ResolvedRepo[];
  /**
   * Optional build-context directory (the profile dir). Its contents are tarred
   * under `context/`, which the builder wires up as buildkit's *main* context,
   * so the user Dockerfile can `COPY` sidecar files that live beside the profile
   * definition with ordinary relative paths (no `--from=`). The whole dir ships,
   * a `.dockerignore` at its root is honored by buildkit at build time.
   */
  contextDir?: string;
  log?: (msg: string) => void;
}

// Single composite tar shipped to the sandbox builder. Layout:
//   ./Dockerfile             : server-assembled, ready for buildctl
//   ./context/...            : optional main build context (the profile dir)
//   ./repos/<name>/...       : one per repo: working tree + .git
//
// The tar shape IS the wire protocol: no manifest, no headers. The sandbox
// builder extracts, then registers `./context` (if present) as buildkit's main
// context and each `./repos/<name>` subdirectory as the named context `<name>`.
//
// Implementation: we never materialize a staging tree. Each section spawns
// `tar` against the user's source dir with a path-prefix transform applied,
// and the resulting tar streams are concatenated by stripping the trailing
// 1024-byte EOF blocks from every section except the last. Total disk I/O is
// 1× the source data, vs 2× for the previous stage-then-tar approach.
export function buildContextTar(opts: BuildContextTarOpts): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const tmpRoot = mkdtempSync(join(tmpdir(), "isolade-bcx-"));
      const dockerfilePath = join(tmpRoot, "Dockerfile");
      try {
        await writeFile(dockerfilePath, opts.dockerfileBytes);

        const sections: TarSection[] = [];

        // Section 1: the assembled Dockerfile, no prefix.
        sections.push({
          label: "Dockerfile",
          spawn: () => spawnTar(["tar", ...TAR_NOPAD, "-cf", "-", "-C", tmpRoot, "Dockerfile"]),
        });

        // Section 2 (optional): the profile dir, prefixed with `context/`. The
        // builder wires this up as buildkit's main context, so the user
        // Dockerfile can `COPY` sidecar files beside the profile definition with
        // ordinary relative paths.
        if (opts.contextDir) {
          sections.push(contextSection(opts.contextDir));
        }

        // Section 3+: each repo's working tree + `.git`, prefixed with
        // `repos/<name>/`. The builder turns each into the named context
        // `<name>` the user Dockerfile COPYs from.
        for (const repo of opts.repos) {
          const gitPath = join(repo.sourcePath, ".git");
          if (!existsSync(gitPath)) {
            throw new Error(`repo ${repo.name}: .git not found at ${gitPath}`);
          }
          sections.push(...repoSections(repo));
        }

        for (const [i, section] of sections.entries()) {
          const isLast = i === sections.length - 1;
          opts.log?.(`(packing ${section.label})`);
          await streamSection(section, isLast, controller, opts.log);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    },
  });
}

interface TarSection {
  /** Human-readable label, surfaced as a build-log line at section start. */
  label: string;
  spawn: () => SpawnedTar;
}
interface SpawnedTar {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  stderrText: Promise<string>;
  argv: string;
}

function spawnTar(argv: string[], stdin?: ReadableStream<Uint8Array>): SpawnedTar {
  const proc = Bun.spawn(argv, {
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    exited: proc.exited,
    stderrText: new Response(proc.stderr).text(),
    argv: argv.join(" "),
  };
}

// Tar one repo's working tree *and* `.git` under `repos/<name>/`, which the
// builder exposes as the named context `<name>`. Shipping both lets the user
// Dockerfile COPY individual files for surgical layer invalidation
// (`COPY --from=x flake.lock …`) and COPY `.` to land a real git repo.
//
// Managed git checkouts are pristine (reset --hard + clean -fdx on every
// sync), so we tar the whole tree: working tree, `.git`, `.git/modules`, and
// populated submodule worktrees. Local user repos are *not* pristine
// (node_modules, build output), so we honor `.gitignore` via `git ls-files`
// for the tree and ship `.git` as a second section.
//
// In both cases we deliberately DROP a repo-root `.dockerignore`: buildkit
// reads it at the named context's root and would filter every
// `COPY --from=<name> …` by the repo's *own* ignore rules (which exist
// for the repo's own image builds, not ours), silently breaking the
// dev-shell warm and the checkout. Stripping only the file leaves `.git`
// carrying the committed copy, so a `git checkout` in the user Dockerfile
// restores it and the working tree stays clean.
// Tar the profile dir's contents under `context/`, which the builder registers
// as buildkit's main context. We ship the directory wholesale (config.toml,
// the Dockerfile, and any sidecar files the user dropped beside the profile
// definition) and leave filtering to a `.dockerignore` at the context root,
// which buildkit honors natively at build time (unlike the repo contexts, whose
// own `.dockerignore` we strip because it's meant for the repo's own builds, the
// profile dir's `.dockerignore` is authored for exactly this context, so it's
// kept). The managed config.toml rides along harmlessly: it only enters the
// image if the Dockerfile explicitly COPYs it.
function contextSection(contextDir: string): TarSection {
  const prefix = "context/";
  return {
    label: "context (profile dir)",
    // `find … | tar --no-recursion -T -` archives each path find emits, with the
    // `stripLeadingDotSlash` transform rewriting `./foo` names to `context/foo`.
    spawn: () => {
      const find = Bun.spawn(["find", ".", "-mindepth", "1", "-print0"], {
        cwd: contextDir,
        stdout: "pipe",
        stderr: "inherit",
      });
      return spawnTar(
        [
          "tar",
          ...TAR_NOPAD,
          "--no-recursion",
          "-cf",
          "-",
          "-C",
          contextDir,
          "--null",
          "-T",
          "-",
          ...transformFlag(prefix, { stripLeadingDotSlash: true }),
        ],
        find.stdout as ReadableStream<Uint8Array>,
      );
    },
  };
}

function repoSections(repo: ResolvedRepo): TarSection[] {
  const prefix = `repos/${repo.name}/`;
  if (repo.source.kind === "git") {
    return [
      {
        label: `repo ${repo.name} (tree + .git)`,
        // `find … | tar --no-recursion -T -` archives exactly the paths find
        // emits (each once, since find already recurses), letting us exclude the
        // single repo-root `./.dockerignore` via `! -path` without touching
        // nested ones. The `stripLeadingDotSlash` transform rewrites the
        // `./foo` names to `repos/<name>/foo`.
        spawn: () => {
          const find = Bun.spawn(
            ["find", ".", "-mindepth", "1", "!", "-path", "./.dockerignore", "-print0"],
            { cwd: repo.sourcePath, stdout: "pipe", stderr: "inherit" },
          );
          return spawnTar(
            [
              "tar",
              ...TAR_NOPAD,
              "--no-recursion",
              "-cf",
              "-",
              "-C",
              repo.sourcePath,
              "--null",
              "-T",
              "-",
              ...transformFlag(prefix, { stripLeadingDotSlash: true }),
            ],
            find.stdout as ReadableStream<Uint8Array>,
          );
        },
      },
    ];
  }
  // Local user repo: tree via git ls-files (honors .gitignore), then `.git`.
  // The `:!.dockerignore` pathspec drops the repo-root ignore file (see above).
  return [
    {
      label: `repo ${repo.name} (tree)`,
      spawn: () => {
        const ls = Bun.spawn(
          [
            "git",
            "-C",
            repo.sourcePath,
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            ":!.dockerignore",
          ],
          { stdout: "pipe", stderr: "inherit" },
        );
        return spawnTar(
          [
            "tar",
            ...TAR_NOPAD,
            "-cf",
            "-",
            "-C",
            repo.sourcePath,
            "--null",
            "-T",
            "-",
            ...transformFlag(prefix),
          ],
          ls.stdout as ReadableStream<Uint8Array>,
        );
      },
    },
    {
      label: `repo ${repo.name} (.git)`,
      spawn: () =>
        spawnTar([
          "tar",
          ...TAR_NOPAD,
          "-cf",
          "-",
          "-C",
          repo.sourcePath,
          ...transformFlag(prefix),
          ".git",
        ]),
    },
  ];
}

// bsdtar (macOS default) takes `-s '/pat/repl/flags'`. GNU tar uses
// `--transform='s/pat/repl/flags'`. We detect once at module load by
// scanning `tar --version`. Both implementations interpret the substitution
// as a sed-style regex, so `.` needs to be escaped in patterns we care about.
type TarFlavor = "gnu" | "bsd";
const TAR_FLAVOR: TarFlavor = (() => {
  const out = spawnSync("tar", ["--version"], { encoding: "utf8" });
  const text = ((out.stdout ?? "") + (out.stderr ?? "")).toLowerCase();
  return text.includes("bsdtar") ? "bsd" : "gnu";
})();

// Block factor 1 = 512-byte blocks, no padding past the 1024-byte EOF marker.
// Default block factors (20 for both bsdtar and GNU tar) pad the tail with
// zeros up to BLOCKSIZE × 512 bytes, which means the EOF marker would sit in
// the middle of the trailing padding instead of at the very end. Our
// stream-concat then can't tell EOF from padding, and receivers would see
// only the first section. With `-b 1` the EOF marker is exactly the last
// 1024 bytes of each section's tar output, which we strip cleanly.
const TAR_NOPAD = ["-b", "1"];

function transformFlag(prefix: string, opts: { stripLeadingDotSlash?: boolean } = {}): string[] {
  // For `tar -C dir .`, entry names come out as `./foo`. We want them to
  // become `<prefix>foo`, so the pattern eats the leading `./`. For paths
  // listed via `-T -` (no leading `./`), we just prepend.
  const pattern = opts.stripLeadingDotSlash ? "^\\./" : "^";

  // Both bsdtar and GNU tar apply substitutions to symlink TARGETS by
  // default, which would rewrite a tracked `.claude/CLAUDE.md -> ../AGENTS.md`
  // to `-> context/../AGENTS.md`. The link would then resolve to the wrong
  // place (or be rejected outright by safe extractors). Suppress that with the
  // `S` flag ("do not apply to Symlink targets"), which both implementations
  // spell the same way. Hardlink targets are the opposite case: they name an
  // earlier archive member (which the transform renamed), so they MUST be
  // rewritten too, and both flavors do that by default, so no `h`/`H` flag.
  if (TAR_FLAVOR === "bsd") return ["-s", `|${pattern}|${prefix}|S`];
  return [`--transform=s|${pattern}|${prefix}|rS`];
}

// Pump a single tar section into the output controller. For all but the last
// section, strip the trailing 1024-byte EOF marker (two consecutive 512-byte
// zero blocks) by holding a rolling 1024-byte buffer and discarding it at
// section end. Tar implementations stop reading at the first EOF marker, so
// without this trick the receiver would only see section 1's entries.
//
// Emits a `(packed <section.label>: <N> MiB)` log line at most every
// PROGRESS_INTERVAL_MS while bytes flow, plus a final tally when the section
// completes. Keeps the UI from looking frozen on multi-GB `.git` payloads.
const PROGRESS_INTERVAL_MS = 1500;
const MIB = 1024 * 1024;

async function streamSection(
  section: TarSection,
  isLast: boolean,
  controller: ReadableStreamDefaultController<Uint8Array>,
  log: ((msg: string) => void) | undefined,
): Promise<void> {
  const EOF_SIZE = 1024;
  const spawned = section.spawn();
  const reader = spawned.stdout.getReader();
  let trailing: Uint8Array = new Uint8Array(0);
  let emittedBytes = 0;
  let lastProgressAt = Date.now();
  const reportProgress = (force: boolean) => {
    if (!log) return;
    const now = Date.now();
    if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    log(`  ${section.label}: ${(emittedBytes / MIB).toFixed(1)} MiB`);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (isLast) {
        emittedBytes += value.length;
        controller.enqueue(value);
        reportProgress(false);
        continue;
      }
      // Combine trailing + new chunk, then emit everything but the last EOF_SIZE
      // bytes, keep those buffered for the next iteration. At section end,
      // `trailing` is exactly the EOF marker, which we drop.
      if (trailing.length === 0 && value.length > EOF_SIZE) {
        const slice = value.subarray(0, value.length - EOF_SIZE);
        emittedBytes += slice.length;
        controller.enqueue(slice);
        trailing = value.subarray(value.length - EOF_SIZE);
        reportProgress(false);
        continue;
      }
      const combined = new Uint8Array(trailing.length + value.length);
      combined.set(trailing, 0);
      combined.set(value, trailing.length);
      if (combined.length > EOF_SIZE) {
        const emitLen = combined.length - EOF_SIZE;
        const slice = combined.subarray(0, emitLen);
        emittedBytes += slice.length;
        controller.enqueue(slice);
        trailing = combined.subarray(emitLen);
        reportProgress(false);
      } else {
        trailing = combined;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const [exit, errText] = await Promise.all([spawned.exited, spawned.stderrText]);
  if (exit !== 0) {
    throw new Error(`tar (${spawned.argv}) exited ${exit}: ${errText.trim() || "(no stderr)"}`);
  }
  reportProgress(true);
}

// Rewrites a user-supplied Dockerfile so its final stage carries the alias
// `<name>`, returning the rewritten source plus the resolved stage name. If
// the final stage already has an `AS <existing>` we leave the line untouched
// and return `<existing>` so callers FROM the user's chosen name. Throws if
// no `FROM` line is present at all.
//
// Comments and continuation lines are folded first so a `\\` followed by an
// `AS` token on the next line still parses correctly. Trailing comments
// after the FROM are preserved.
export function ensureLastStageNamed(
  dockerfile: string,
  name: string,
): { dockerfile: string; stageName: string } {
  const lines = dockerfile.split(/\r?\n/);
  const joined: { idx: number; text: string }[] = [];
  let pending: string | null = null;
  let pendingIdx = -1;
  for (const [i, raw] of lines.entries()) {
    const cont = /\\\s*$/.test(raw);
    const stripped = cont ? raw.replace(/\\\s*$/, "") : raw;
    if (pending === null) {
      pending = stripped;
      pendingIdx = i;
    } else {
      pending += " " + stripped.replace(/^\s+/, "");
    }
    if (!cont) {
      joined.push({ idx: pendingIdx, text: pending });
      pending = null;
    }
  }
  if (pending !== null) joined.push({ idx: pendingIdx, text: pending });

  let lastFrom: { idx: number; text: string } | null = null;
  for (const entry of joined) {
    const t = entry.text.replace(/^\s*#.*$/, "").trimStart();
    if (/^FROM(\s|$)/i.test(t)) lastFrom = entry;
  }
  if (lastFrom === null) {
    throw new Error("user Dockerfile contains no FROM instruction");
  }

  const asMatch = lastFrom.text.match(/\s+AS\s+([A-Za-z0-9_.-]+)/i);
  const existing = asMatch?.[1];
  if (existing) {
    return { dockerfile, stageName: existing };
  }

  let targetLine = lastFrom.idx;
  while (targetLine < lines.length - 1 && /\\\s*$/.test(lines[targetLine] ?? "")) {
    targetLine++;
  }
  lines[targetLine] = (lines[targetLine] ?? "").replace(
    /^(.*?)(\s*#.*)?$/,
    (_match, body, comment) => `${body.replace(/\s+$/, "")} AS ${name}${comment ?? ""}`,
  );
  return { dockerfile: lines.join("\n"), stageName: name };
}

// Convenience: assemble both Dockerfile and tar from a resolved profile config
// in one call. Reads the user Dockerfile from disk.
export async function buildEnvironmentTar(
  config: ResolvedProfileConfig,
  log?: (msg: string) => void,
  layerFragment: string = buildAgentLayerFragment(config.skills),
): Promise<ReadableStream<Uint8Array>> {
  const userDockerfile = await Bun.file(config.build.dockerfilePath).text();
  const bytes = assembleDockerfile(userDockerfile, layerFragment);
  return buildContextTar({
    dockerfileBytes: bytes,
    contextDir: config.build.contextDir,
    repos: config.repos,
    log,
  });
}
