#!/usr/bin/env bun
// Generate THIRD-PARTY-LICENSES.txt — the attribution + license-text notice that
// ships *inside* every Isolade artifact (bundled into the web frontend, so it
// lands in the .app/.deb and is viewable from Settings → About).
//
// This satisfies the "preserve copyright notices / include the license text"
// obligation of the permissive licenses (MIT/BSD/ISC/Apache-2.0, …) our JS and
// Rust dependencies carry, and reproduces the GPL-2.0 / LGPL-2.1 texts for the
// bundled microsandbox runtime (libkrun + libkrunfw + its embedded Linux kernel).
// The *corresponding source* for those copyleft components is a separate release
// asset — see scripts/lib/collect-corresponding-source.sh — which this file
// points to.
//
// Coverage:
//   * JS/TS — the runtime ("dependencies", not devDependencies) closure of the
//     shipping workspace packages (server, sandbox, shared, web), walked here.
//   * Rust  — every non-workspace crate resolved for the Tauri app and the msb
//     supervisor, via `cargo metadata`. Skipped with a warning if cargo is
//     absent, unless --require-rust is passed (the release build passes it).
//   * Copyleft/runtime — a curated block with the exact texts + source pointer.
//
// Usage: bun run scripts/lib/generate-third-party-licenses.ts [OUT] [--require-rust]
//   OUT defaults to packages/web/public/THIRD-PARTY-LICENSES.txt
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const args = process.argv.slice(2);
const requireRust = args.includes("--require-rust");
const outArg = args.find((a) => !a.startsWith("--"));
const OUT = outArg
  ? resolve(outArg)
  : join(REPO_ROOT, "packages/web/public/THIRD-PARTY-LICENSES.txt");

// Workspace packages whose runtime deps actually ship (the compiled sidecar +
// the web bundle). Their own code is first-party (Apache-2.0) and isn't listed.
const SHIPPING_PACKAGES = ["server", "sandbox", "shared", "web"];
const MAX_LICENSE_BYTES = 64 * 1024; // licenses are small; cap to stay sane on junk.

// --- helpers -----------------------------------------------------------------

function readJSON(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The GitHub owner/repo slug (from the git remote), for the source-pointer URL. */
function repoSlug(): string {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (m) return m[1];
  } catch {
    /* no git / no remote — fall through */
  }
  return "isolade/isolade";
}

/** Normalize a package.json "license"/"licenses" field to an SPDX-ish string. */
function licenseId(pkg: any): string {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license === "object" && pkg.license.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses
      .map((l: any) => l?.type ?? l)
      .filter(Boolean)
      .join(" OR ");
  }
  return "UNKNOWN";
}

function authorLine(pkg: any): string {
  const a = pkg.author;
  if (typeof a === "string") return a;
  if (a && typeof a === "object" && a.name) return a.email ? `${a.name} <${a.email}>` : a.name;
  return "";
}

/** Collect the text of LICENSE/COPYING/NOTICE files in a package directory. */
function licenseTextsFromDir(dir: string): string {
  if (!existsSync(dir)) return "";
  let out = "";
  const entries = readdirSync(dir)
    .filter((f) => /^(licen[sc]e|copying|copyright|notice)/i.test(f))
    .toSorted();
  for (const f of entries) {
    const p = join(dir, f);
    try {
      if (statSync(p).isDirectory()) continue;
      let text = readFileSync(p, "utf8");
      if (text.length > MAX_LICENSE_BYTES)
        text = `${text.slice(0, MAX_LICENSE_BYTES)}\n…[truncated]`;
      out += `\n--- ${f} ---\n${text.trimEnd()}\n`;
    } catch {
      /* unreadable — skip */
    }
  }
  return out;
}

// Canonical fallback texts for the common permissive licenses, used only when a
// package ships no license file of its own. Apache-2.0 is too long to inline and
// reuses Isolade's own top-level copy instead — see canonicalFor.
const CANONICAL: Record<string, () => string> = {
  MIT: () =>
    'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
  ISC: () =>
    'Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.',
  "BSD-2-Clause": () =>
    'Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n\n1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.\n2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE.',
  "BSD-3-Clause": () =>
    'Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n\n1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.\n2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.\n3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE.',
  Zlib: () =>
    "This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held liable for any damages arising from the use of this software.\n\nPermission is granted to anyone to use this software for any purpose, including commercial applications, and to alter it and redistribute it freely, subject to the following restrictions:\n\n1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.\n2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.\n3. This notice may not be removed or altered from any source distribution.",
};

/** Canonical text for a single SPDX license id, or "" if we don't carry one. */
function canonicalFor(id: string): string {
  if (CANONICAL[id]) return CANONICAL[id]();
  // Apache-2.0 is first-party here, so reuse our own top-level copy. The prefix
  // match also covers any stray "Apache-2.0 …" that slipped past tokenization.
  if (id.startsWith("Apache-2.0")) {
    const p = join(REPO_ROOT, "LICENSE");
    if (existsSync(p)) return readFileSync(p, "utf8").trimEnd();
  }
  return "";
}

/**
 * Reproduce canonical license text for an SPDX license *expression* (used only
 * when a package ships no license file of its own).
 *
 * The expression is split into disjuncts ("A OR B", or the legacy npm/crates
 * "A/B"), each of which may itself be a conjunction ("A AND B"). A disjunction
 * only obliges us to honor one alternative, so we reproduce the shortest
 * alternative whose parts we all recognize — this keeps the notice compact
 * (e.g. "MIT OR Apache-2.0" yields the one-paragraph MIT text, not the Apache
 * boilerplate). If no single alternative is fully recognized, we reproduce every
 * id we do know. Unknown ids (GPL/LGPL, "WITH" exceptions) are dropped; the
 * copyleft runtime block carries those texts separately.
 */
function canonicalText(license: string): string {
  const disjuncts = license
    .replaceAll("/", " OR ")
    .split(/\s+OR\s+/i)
    .map((term) =>
      term
        .replace(/[()]/g, " ")
        .split(/\s+AND\s+/i)
        .map((id) =>
          id
            .replace(/\s+WITH\s+.*/i, "")
            .trim()
            .replace(/\+$/, ""),
        )
        .filter(Boolean),
    )
    .filter((conj) => conj.length > 0);

  const block = (id: string, text: string) => `--- ${id} ---\n${text}`;
  const render = (ids: string[]): string | null => {
    const parts = ids.map((id) => ({ id, text: canonicalFor(id) }));
    if (parts.some((p) => !p.text)) return null;
    return parts.map((p) => block(p.id, p.text)).join("\n\n");
  };

  // Prefer the most compact fully-recognized alternative of the disjunction.
  const [best] = disjuncts
    .map(render)
    .filter((t): t is string => t !== null)
    .toSorted((a, b) => a.length - b.length);
  if (best) return best;

  // Otherwise reproduce whatever ids we recognize anywhere in the expression.
  const known = [...new Set(disjuncts.flat())]
    .map((id) => ({ id, text: canonicalFor(id) }))
    .filter((p) => p.text);
  return known.map((p) => block(p.id, p.text)).join("\n\n");
}

/** Best-effort license text for a package: its own files, else a canonical copy. */
function resolveLicenseText(dir: string, license: string): string {
  const own = licenseTextsFromDir(dir);
  if (own.trim()) return own;
  const canon = canonicalText(license);
  if (canon) return `\n[No license file in package; canonical license text follows.]\n${canon}\n`;
  return `\n[No license text found in package. Declared license: ${license}.]\n`;
}

// --- JavaScript / TypeScript dependency closure ------------------------------

interface Dep {
  name: string;
  version: string;
  license: string;
  author: string;
  dir: string;
}

/** Map every workspace package name -> its directory, to skip first-party deps. */
function workspaceNames(): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of SHIPPING_PACKAGES) {
    const dir = join(REPO_ROOT, "packages", p);
    const pj = join(dir, "package.json");
    if (existsSync(pj)) m.set(readJSON(pj).name, dir);
  }
  return m;
}

/** The node_modules directory that *contains* a package dir (handles @scope). */
function containingNm(pkgDir: string): string {
  const parent = dirname(pkgDir);
  return basename(parent).startsWith("@") ? dirname(parent) : parent;
}

/** A package dir inside a given node_modules, if it exists there. */
function pkgDirIn(nm: string, name: string): string | null {
  const d = join(nm, ...name.split("/"));
  return existsSync(join(d, "package.json")) ? d : null;
}

/**
 * Resolve a dependency by name. Bun's isolated store symlinks every package's
 * declared deps as siblings in the store dir that holds it, so node-style
 * resolution against the parent's node_modules (fromNms) finds them. The
 * node_modules/.bun/* scan is a last-resort fallback.
 */
function resolveDep(name: string, fromNms: string[]): string | null {
  for (const nm of fromNms) {
    const d = pkgDirIn(nm, name);
    if (d) return d;
  }
  const store = join(REPO_ROOT, "node_modules", ".bun");
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      const d = pkgDirIn(join(store, entry, "node_modules"), name);
      if (d) return d;
    }
  }
  return null;
}

function collectJsDeps(): Dep[] {
  const workspace = workspaceNames();
  const found = new Map<string, Dep>(); // key: name@version
  const visited = new Set<string>(); // resolved dirs, to break cycles
  const missing = new Set<string>();

  const rootNm = join(REPO_ROOT, "node_modules");
  const shippingNms = SHIPPING_PACKAGES.map((p) =>
    join(REPO_ROOT, "packages", p, "node_modules"),
  ).filter(existsSync);
  const rootSearch = [...shippingNms, rootNm];

  // Roots: the runtime deps declared by each shipping workspace package.
  const queue: { name: string; from: string[] }[] = [];
  for (const p of SHIPPING_PACKAGES) {
    const pj = join(REPO_ROOT, "packages", p, "package.json");
    if (existsSync(pj)) {
      for (const name of Object.keys(readJSON(pj).dependencies ?? {}))
        queue.push({ name, from: rootSearch });
    }
  }

  while (queue.length) {
    const { name, from } = queue.shift() as { name: string; from: string[] };

    // First-party workspace package: follow its runtime deps but don't list it.
    if (workspace.has(name)) {
      const wdir = workspace.get(name) as string;
      if (visited.has(wdir)) continue;
      visited.add(wdir);
      const nextFrom = [join(wdir, "node_modules"), ...rootSearch];
      for (const dep of Object.keys(readJSON(join(wdir, "package.json")).dependencies ?? {})) {
        queue.push({ name: dep, from: nextFrom });
      }
      continue;
    }

    const dir = resolveDep(name, from);
    if (!dir) {
      missing.add(name);
      continue;
    }
    if (visited.has(dir)) continue;
    visited.add(dir);

    const pkg = readJSON(join(dir, "package.json"));
    const key = `${pkg.name}@${pkg.version}`;
    if (!found.has(key)) {
      found.set(key, {
        name: pkg.name,
        version: pkg.version,
        license: licenseId(pkg),
        author: authorLine(pkg),
        dir,
      });
    }
    const nextFrom = [containingNm(dir), rootNm];
    for (const dep of Object.keys(pkg.dependencies ?? {}))
      queue.push({ name: dep, from: nextFrom });
  }

  if (missing.size) {
    console.warn(
      `warning: could not resolve ${missing.size} JS dep(s): ${[...missing].toSorted().join(", ")}`,
    );
  }
  return [...found.values()].toSorted(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

// --- Rust crate closure (via cargo metadata) ---------------------------------

function collectRustCrates(): Dep[] {
  const manifests = [
    join(REPO_ROOT, "app", "Cargo.toml"),
    join(REPO_ROOT, "third_party", "microsandbox", "Cargo.toml"),
  ].filter(existsSync);

  const found = new Map<string, Dep>();
  let cargoRan = false;
  for (const manifest of manifests) {
    let json: any;
    try {
      const raw = execFileSync(
        "cargo",
        ["metadata", "--format-version", "1", "--manifest-path", manifest],
        { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
      );
      json = JSON.parse(raw);
      cargoRan = true;
    } catch (e) {
      console.warn(
        `warning: cargo metadata failed for ${manifest}: ${(e as Error).message.split("\n")[0]}`,
      );
      continue;
    }
    for (const pkg of json.packages ?? []) {
      // source === null marks workspace/path members (our own crates); skip them.
      if (!pkg.source) continue;
      const key = `${pkg.name}@${pkg.version}`;
      if (found.has(key)) continue;
      found.set(key, {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license || (pkg.license_file ? `see ${pkg.license_file}` : "UNKNOWN"),
        author: (pkg.authors ?? []).join(", "),
        dir: pkg.manifest_path ? dirname(pkg.manifest_path) : "",
      });
    }
  }

  if (!cargoRan) {
    const msg = "cargo not available / no metadata — Rust crate attributions omitted";
    if (requireRust) throw new Error(`error: ${msg} (--require-rust set)`);
    console.warn(`warning: ${msg}`);
  }
  return [...found.values()].toSorted(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

// --- curated copyleft / bundled-runtime block --------------------------------

function copyleftBlock(version: string): string {
  const fw = join(REPO_ROOT, "third_party/microsandbox/vendor/libkrunfw");
  const msbLicense = join(REPO_ROOT, "third_party/microsandbox/LICENSE");
  const gpl = join(fw, "LICENSE-GPL-2.0-only");
  const lgpl = join(fw, "LICENSE-LGPL-2.1-only");
  const read = (p: string) =>
    existsSync(p) ? readFileSync(p, "utf8").trimEnd() : `[missing: ${p}]`;
  const releaseUrl = `https://github.com/${repoSlug()}/releases/tag/v${version}`;

  return [
    hr("Bundled runtime — microsandbox, libkrun, libkrunfw, Linux kernel"),
    "",
    "Isolade bundles the microsandbox runtime, which comprises:",
    "  • microsandbox           Apache-2.0",
    "  • libkrun (msb_krun)     LGPL-2.1",
    "  • libkrunfw              LGPL-2.1  (wraps an embedded Linux kernel)",
    "  • Linux kernel           GPL-2.0-only  (embedded in libkrunfw, patched)",
    "",
    "Source for the GPL-2.0 and LGPL-2.1 components above (the Linux kernel,",
    "libkrunfw, and libkrun) is provided with this release as the asset",
    `  isolade-v${version}-third-party-source.tar.gz`,
    `at ${releaseUrl}`,
    "",
    section("microsandbox — Apache-2.0"),
    read(msbLicense),
    "",
    section("libkrun / libkrunfw — LGPL-2.1"),
    read(lgpl),
    "",
    section("Embedded Linux kernel (via libkrunfw) — GPL-2.0-only"),
    read(gpl),
    "",
  ].join("\n");
}

// --- rendering ---------------------------------------------------------------

function hr(title: string): string {
  const bar = "=".repeat(78);
  return `${bar}\n${title}\n${bar}`;
}
function section(title: string): string {
  return `---- ${title} ${"-".repeat(Math.max(0, 72 - title.length))}`;
}

function renderDeps(title: string, deps: Dep[], withText: boolean): string {
  const lines = [hr(title), ""];
  if (deps.length === 0) {
    lines.push("(none resolved)", "");
    return lines.join("\n");
  }
  for (const d of deps) {
    lines.push(section(`${d.name} ${d.version}`));
    lines.push(`License: ${d.license}`);
    if (d.author) lines.push(`Author:  ${d.author}`);
    if (withText) lines.push(resolveLicenseText(d.dir, d.license).trimEnd());
    lines.push("");
  }
  return lines.join("\n");
}

function main() {
  const conf = readJSON(join(REPO_ROOT, "app/tauri.conf.json"));
  const version: string = conf.version;

  const js = collectJsDeps();
  const rust = collectRustCrates();

  const header = [
    hr(`Isolade v${version} — Third-Party Licenses`),
    "",
    `Generated ${new Date().toISOString().slice(0, 10)} by scripts/lib/generate-third-party-licenses.ts`,
    "",
    "Isolade itself is licensed under Apache-2.0 (see the LICENSE file). This",
    "notice reproduces the copyright and license terms of the third-party software",
    "distributed in the Isolade binaries. For the copyleft (GPL/LGPL) components,",
    "corresponding source is available with the release (see the bundled-runtime",
    "section below).",
    "",
    `JavaScript/TypeScript packages: ${js.length}    Rust crates: ${rust.length}`,
    "",
  ].join("\n");

  const body = [
    header,
    copyleftBlock(version),
    renderDeps("Rust crates", rust, true),
    renderDeps("JavaScript / TypeScript packages", js, true),
  ].join("\n");

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, body);
  console.log(
    `wrote ${OUT} (${js.length} JS packages, ${rust.length} Rust crates, ${body.length} bytes)`,
  );
}

main();
