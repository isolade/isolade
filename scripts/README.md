# scripts

Repo automation. Most day-to-day tasks are reachable through `bun run <task>`
(see the root `package.json`); the entries below are the underlying scripts plus
the release/signing helpers that live only here.

Everything is run from the repo root. `scripts/lib/` holds internal helpers that
other scripts call or `source` — you don't invoke those directly.

## Entry points

| Script | `bun run` | What it does |
|---|---|---|
| `dev.sh` | `dev` | Browser dev: API server + in-process sandbox + Vite, one terminal. |
| `app.sh` | `app` | Native dev: the Tauri desktop app with frontend HMR + Rust rebuild. |
| `build.sh` | `build` | Production build: typecheck → compile the sidecar → assemble the msb runtime → `tauri build` (+ macOS signing). |
| `bootstrap-microsandbox.sh` | `bootstrap:microsandbox` | Build & assemble the pinned microsandbox runtime into `app/binaries/msb-runtime`. Run once after cloning. |
| `seed-usage.ts` | `seed-usage` | Fill the DB with a year of fake usage so the Usage page has something to show. |
| `refresh-catalog.ts` | `refresh-catalog` | Regenerate the static model catalog from [models.dev](https://models.dev): the Claude half (name, context, effort menu, pricing for the `ANTHROPIC_ALLOWLIST` ids) and the Codex half (model list from `codex app-server`, pricing from models.dev). Pass `anthropic` or `codex` to do one half; `--check` reports drift and exits non-zero. The Codex half needs `codex` installed + network; the Claude half needs network only. |
| `ci-macos.sh` / `ci-linux.sh` | — | Full release pipeline for one OS (build → package a tarball / `.deb`). Run by CI and locally. |
| `prepare-release.py` | — | Open a `release/vX.Y.Z` PR: branch, bump the version, rotate the changelog, commit, push. |
| `check-release-metadata.sh` | — | CI gate: verify the release branch, `tauri.conf.json`, and `CHANGELOG.md` agree; emit the release notes. |
| `create-signing-cert.sh` | — | One-time: mint the stable self-signed code-signing identity used for macOS release builds. |

## Internal helpers (`scripts/lib/`)

| Script | Called by |
|---|---|
| `common.sh` | Sourced by `dev.sh` / `app.sh` — first-run config, env loading, sandbox prep. |
| `build-msb-native.sh` | `bootstrap-microsandbox.sh` and CI — builds the fork's NAPI `.node` binding. |
| `build-msb.sh` | `assemble-msb-runtime.sh` and CI — builds the fork's `msb` supervisor. |
| `assemble-msb-runtime.sh` | `build.sh`, `common.sh`, `bootstrap-microsandbox.sh` — lays out `.node` + `msb` + libkrunfw into a runtime dir. |
| `setup-signing-keychain.sh` | `build.sh`, `create-signing-cert.sh` — makes the signing identity available to `codesign`. |

CI shares the microsandbox build with local dev through `build-msb-native.sh` +
`build-msb.sh`; the caching around them lives in the composite action at
`.github/actions/microsandbox`.
