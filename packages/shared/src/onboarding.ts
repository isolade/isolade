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

/** The families the offer is grouped into, in the order the wizard shows them.
 *  A list this long is a wall to read flat. Grouped, someone here for a
 *  database stops reading at the headings that are not it. */
export const TOOL_CATEGORIES = [
  { id: "language", label: "Languages and runtimes" },
  { id: "build", label: "Building and testing" },
  { id: "data", label: "Databases" },
  { id: "media", label: "Documents and media" },
  { id: "cli", label: "Command line" },
] as const;

export type ToolCategoryId = (typeof TOOL_CATEGORIES)[number]["id"];

export interface Toolchain {
  id: string;
  label: string;
  category: ToolCategoryId;
  /** Shown beside the label, for choosing without knowing the packages. */
  blurb: string;
  /** apt packages, folded into one install step with every other choice. */
  packages?: readonly string[];
  /** Anything that is not an apt package, appended as its own step. */
  extra?: string;
  /** A comment under the install step, for a choice whose packages are only
   *  half the story and the rest is the agent's to do inside the VM. */
  note?: string;
}

/**
 * What the wizard offers, grouped by `TOOL_CATEGORIES` and in that order, so the
 * file it composes reads in the same order as the questions that produced it.
 *
 * Two rules decide what can be here at all:
 *
 * Every apt package is spelled the same on both bases, so choosing Debian never
 * silently changes what a checkbox installs. That rules out things people do ask
 * for: Ubuntu 24.04 has no real `chromium` (a snap stub) and dropped `awscli`,
 * and neither base packages kubectl or terraform. Those stay a Dockerfile edit
 * rather than a checkbox that works on one base and fails on the other.
 *
 * Nothing may depend on Node, npm or the agent CLIs. This file is the base stage
 * and the layer carrying those is appended after it, so an `npx` here would run
 * before there is a Node to run it. Node is not on offer either: every image gets
 * Node LTS regardless, so a checkbox for it would suggest a choice that does not
 * exist.
 */
export const TOOLCHAINS: readonly Toolchain[] = [
  {
    id: "python",
    label: "Python",
    category: "language",
    blurb: "python3, pip, venv and headers",
    // The headers so that a pip install of something with a C extension can
    // compile, given the build tools below, rather than stopping on a missing
    // `Python.h` from inside a wheel nobody here wrote.
    packages: ["python3", "python3-dev", "python3-pip", "python3-venv"],
  },
  {
    id: "uv",
    label: "uv",
    category: "language",
    blurb: "Astral's Python package manager",
    packages: ["ca-certificates", "curl"],
    extra: [
      "# uv is a single binary, installed to a shared prefix rather than to the",
      "# home of the user that ran the build. It can fetch its own Python, so it",
      "# is useful with or without the Python above.",
      "RUN curl -fsSL https://astral.sh/uv/install.sh \\",
      "    | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh",
    ].join("\n"),
  },
  {
    id: "bun",
    label: "Bun",
    category: "language",
    blurb: "the Bun runtime, beside the Node every image has",
    // unzip because the installer unpacks a zip, and neither base ships it.
    packages: ["ca-certificates", "curl", "unzip"],
    extra: [
      "# Bun installs beside the Node the agent layer adds, for a project that",
      "# wants it. Its package cache lives under BUN_INSTALL, so that directory",
      "# has to stay writable by the agent, who is not the user installing here.",
      "ENV BUN_INSTALL=/usr/local/bun \\",
      '    PATH="/usr/local/bun/bin:$PATH"',
      "RUN curl -fsSL https://bun.sh/install | bash \\",
      '    && mkdir -p "$BUN_INSTALL/install/cache" \\',
      '    && chmod -R a+w "$BUN_INSTALL/install"',
    ].join("\n"),
  },
  {
    id: "go",
    label: "Go",
    category: "language",
    blurb: "the distribution's Go toolchain",
    packages: ["golang-go"],
  },
  {
    id: "rust",
    label: "Rust",
    category: "language",
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
    id: "java",
    label: "Java",
    category: "language",
    blurb: "the default JDK and Maven",
    packages: ["default-jdk", "maven"],
  },
  {
    id: "ruby",
    label: "Ruby",
    category: "language",
    blurb: "Ruby with Bundler and headers",
    packages: ["ruby-bundler", "ruby-full"],
  },
  {
    id: "php",
    label: "PHP",
    category: "language",
    blurb: "PHP's command line and Composer",
    packages: ["composer", "php-cli"],
  },
  {
    id: "build",
    label: "Build tools",
    category: "build",
    blurb: "gcc, make and pkg-config, for native extensions",
    packages: ["build-essential", "pkg-config"],
  },
  {
    id: "cmake",
    label: "CMake",
    category: "build",
    blurb: "cmake and ninja, for C and C++ projects",
    packages: ["build-essential", "cmake", "ninja-build"],
  },
  {
    id: "browser",
    label: "Browser testing",
    category: "build",
    blurb: "the libraries a headless Chromium needs",
    // The dependency set Playwright and Puppeteer both want. Spelled out rather
    // than left to `playwright install --with-deps`, which reads the release
    // name and refuses one it has not heard of.
    packages: [
      "fonts-liberation",
      "libasound2t64",
      "libatk-bridge2.0-0t64",
      "libatk1.0-0t64",
      "libatspi2.0-0t64",
      "libcups2t64",
      "libdbus-1-3",
      "libdrm2",
      "libgbm1",
      "libnspr4",
      "libnss3",
      "libpango-1.0-0",
      "libxcomposite1",
      "libxdamage1",
      "libxfixes3",
      "libxkbcommon0",
      "libxrandr2",
    ],
    note: [
      "# The browser itself is not baked in. Playwright and Puppeteer download",
      "# one into the agent's home in seconds, and only the shared libraries it",
      "# needs take root to install, which is why those are the part that is here.",
    ].join("\n"),
  },
  {
    id: "sqlite",
    label: "SQLite",
    category: "data",
    blurb: "the sqlite3 command line",
    packages: ["sqlite3"],
  },
  {
    id: "dbclients",
    label: "Database clients",
    category: "data",
    blurb: "psql, mysql and redis-cli",
    // Clients rather than servers. A server in the image is a service nothing
    // starts, since the agent is not root inside the VM, and a database is
    // usually somewhere else anyway.
    packages: ["default-mysql-client", "postgresql-client", "redis-tools"],
  },
  {
    id: "docs",
    label: "Docs and diagrams",
    category: "media",
    blurb: "Pandoc and Graphviz",
    packages: ["graphviz", "pandoc"],
  },
  {
    id: "media",
    label: "Media tools",
    category: "media",
    blurb: "ffmpeg and ImageMagick",
    packages: ["ffmpeg", "imagemagick"],
  },
  {
    id: "shell",
    label: "Shell utilities",
    category: "cli",
    blurb: "jq, tmux, vim and the basics a slim base leaves out",
    // A minimal base has no `ps`, no `less` and no `file`, which an agent finds
    // out one failed command at a time.
    packages: [
      "file",
      "htop",
      "iputils-ping",
      "jq",
      "less",
      "procps",
      "rsync",
      "tmux",
      "tree",
      "unzip",
      "vim",
      "wget",
      "zip",
    ],
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
 * Package names across as few lines as fit a narrow column. Two choices can add
 * up to thirty packages, and one line of thirty is a horizontal scrollbar in the
 * preview beside the questions.
 */
function wrapPackages(packages: readonly string[], width = 60): string[] {
  const lines: string[] = [];
  for (const name of packages) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 1 + name.length <= width) {
      lines[lines.length - 1] = `${last} ${name}`;
    } else {
      lines.push(name);
    }
  }
  return lines;
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
      ...wrapPackages(packages).map((line) => `        ${line} \\`),
      "    && rm -rf /var/lib/apt/lists/*",
      "",
    );
    for (const tool of chosen) {
      if (tool.note) lines.push(tool.note, "");
    }
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
