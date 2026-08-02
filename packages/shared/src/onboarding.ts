// Composing the first Dockerfile for the onboarding wizard.
//
// Writing that file is where a newcomer stalls, so the wizard writes one. It
// used to guess the base image from files in the checkout, which was a poor
// trade: the guess decided exactly one line, the agent layer installs Node into
// every image regardless of base, and the cases we were most confident about
// (adopting a repository's own Dockerfile, or a devcontainer's image) could
// silently pick an Alpine or distroless base that the agent layer then fails to
// apt-get into.
//
// So nothing is inferred. The user says which toolchains they want, which they
// know and we cannot, and the answer composes from snippets we own and can test.
//
// This lives in shared because both the wizard and its tests want it, and it is
// string manipulation with no filesystem behind it, so there is no route.

/** The bases a scaffold can start from. Debian-family is not a preference: the
 *  agent layer Isolade stacks on top runs `apt-get`, so a base without it fails
 *  the build. Every toolchain below is packaged under the same name in both. */
export const BASES = [
  { id: "ubuntu", label: "Ubuntu 24.04", image: "ubuntu:24.04" },
  { id: "debian", label: "Debian 13", image: "debian:13" },
] as const;

export type BaseId = (typeof BASES)[number]["id"];

export const DEFAULT_BASE: BaseId = "ubuntu";

function imageFor(base: BaseId): string {
  return (BASES.find((b) => b.id === base) ?? BASES[0]).image;
}

export interface Toolchain {
  id: string;
  label: string;
  /** Shown beside the label, for choosing without knowing the packages. */
  blurb: string;
  /** apt packages, folded into one install step with every other choice. */
  packages?: readonly string[];
  /** Anything that is not an apt package, appended as its own step. */
  extra?: string;
}

/**
 * What the wizard offers. Node is deliberately absent: the agent layer installs
 * Node LTS into every image already, so offering it would suggest a choice that
 * does not exist.
 */
export const TOOLCHAINS: readonly Toolchain[] = [
  {
    id: "python",
    label: "Python",
    blurb: "python3, pip and venv",
    packages: ["python3", "python3-pip", "python3-venv"],
  },
  {
    id: "go",
    label: "Go",
    blurb: "the Go toolchain from Ubuntu",
    packages: ["golang-go"],
  },
  {
    id: "java",
    label: "Java",
    blurb: "the default JDK",
    packages: ["default-jdk"],
  },
  {
    id: "rust",
    label: "Rust",
    blurb: "rustup, with the stable toolchain",
    // curl and ca-certificates because rustup is fetched over HTTPS and neither
    // base ships them, so the step below would fail on a bare image.
    packages: ["build-essential", "ca-certificates", "curl"],
    extra: [
      "# rustup rather than the distribution's package, which lags a long way",
      "# behind. It installs to a shared location rather than a home directory,",
      "# and stays writable, because cargo writes to CARGO_HOME as it builds and",
      "# the agent is not the user that ran the install.",
      "ENV RUSTUP_HOME=/usr/local/rustup \\",
      "    CARGO_HOME=/usr/local/cargo \\",
      '    PATH="/usr/local/cargo/bin:$PATH"',
      "RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal \\",
      '    && chmod -R a+w "$RUSTUP_HOME" "$CARGO_HOME"',
    ].join("\n"),
  },
  {
    id: "build",
    label: "Build tools",
    blurb: "gcc, make and pkg-config, for native extensions",
    packages: ["build-essential", "pkg-config"],
  },
];

/**
 * A build-context name for a repository source, valid against `repoFormSchema`.
 * Takes the last meaningful segment of a path or URL, so
 * `https://github.com/owner/repo.git` and `/home/you/code/repo` both yield
 * `repo`.
 */
export function repoNameFor(source: string): string {
  const trimmed = source
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const last = trimmed.split(/[/\\]/).filter(Boolean).pop() ?? "";
  const slug = last
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "repo";
}

/**
 * Names for several sources at once, with collisions resolved rather than left
 * to fail the build: two directories called `api` become `api` and `api-2`.
 */
export function repoNamesFor(sources: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return sources.map((source) => {
    const base = repoNameFor(source);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  });
}

/**
 * The starting Dockerfile: a base, the toolchains asked for, and one COPY per
 * repository. Repositories are optional, since a profile with none is valid: the
 * agent clones what it needs into an empty workspace.
 *
 * Dependencies are still not installed, because how to install them is the
 * project's business and a failed install is a failed first build. The agent can
 * run it and say what it needed.
 */
export function composeDockerfile(
  repoNames: readonly string[],
  toolchainIds: readonly string[],
  base: BaseId = DEFAULT_BASE,
): string {
  const chosen = TOOLCHAINS.filter((t) => toolchainIds.includes(t.id));
  const packages = [...new Set(chosen.flatMap((t) => t.packages ?? []))].toSorted();

  // The workspace directories are made here rather than left to COPY, which
  // creates a missing destination owned by root: the files inside would belong
  // to the agent while the directory holding them would not, so it could edit
  // what is there and create nothing new.
  const workspaceDirs = ["/workspace", ...repoNames.map((name) => `/workspace/${name}`)];
  const lines = [
    `FROM ${imageFor(base)}`,
    "",
    "# The user the agent runs as, owning the workspace it works in. Isolade's",
    "# own layer creates this user if a Dockerfile has not, but creating it here",
    "# is what lets the repositories below arrive belonging to it.",
    "RUN useradd --user-group --create-home --shell /bin/bash agent \\",
    `    && mkdir -p ${workspaceDirs.join(" ")} \\`,
    `    && chown agent:agent ${workspaceDirs.join(" ")}`,
    "",
  ];

  if (packages.length) {
    lines.push(
      "RUN apt-get update \\",
      "    && apt-get install -y --no-install-recommends \\",
      `        ${packages.join(" ")} \\`,
      "    && rm -rf /var/lib/apt/lists/*",
      "",
    );
  }
  for (const tool of chosen) {
    if (tool.extra) lines.push(tool.extra, "");
  }

  if (repoNames.length) {
    lines.push(
      "# Each repository arrives as a named build context. Nothing is installed",
      "# from them here: the agent can do that in the VM and tell you what it",
      "# needed, which is one line to add above once you know.",
    );
    for (const name of repoNames) {
      lines.push(`COPY --from=${name} --chown=agent:agent . /workspace/${name}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
