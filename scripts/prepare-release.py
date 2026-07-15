#!/usr/bin/env python3
"""Prepare a release: branch, bump the version, rotate the changelog, commit,
push, and open a draft PR.

This is the front door to the release flow. It produces the exact state the
release CI (.github/workflows/ci.yml, gated by
scripts/check-release-metadata.sh) validates:

    branch name          release/vX.Y.Z
    app/tauri.conf.json  "version": "X.Y.Z"   (the app version source of truth)
    CHANGELOG.md         top released section  "## [X.Y.Z] - <date>"

Opening and updating the release PR triggers the unified build workflow. The PR
is the review + merge gate that publishes the staged draft on merge.

Usage:
    scripts/prepare-release.py <version | major | minor | patch> [--dry-run]

    scripts/prepare-release.py patch            # 0.1.0 -> 0.1.1, push + draft PR
    scripts/prepare-release.py minor            # 0.1.x -> 0.2.0, push + draft PR
    scripts/prepare-release.py 0.1.0            # explicit version (first release)
    scripts/prepare-release.py patch --dry-run  # show what would change, touch nothing

Options:
    --dry-run      print the plan and the changelog rotation; change nothing

Only the standard library is used, so this runs with a bare python3.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONF = REPO_ROOT / "app" / "tauri.conf.json"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
VALIDATOR = REPO_ROOT / "scripts" / "check-release-metadata.sh"

# Regenerated at the top of CHANGELOG.md after each rotation. Kept byte-identical
# to the seed in CHANGELOG.md so a rotated file reads the same as a fresh one,
# and so rotation can recognize (and drop) the placeholder rather than promoting
# it into a release section.
UNRELEASED_PLACEHOLDER = (
    "_Changes landed on `main` that haven't shipped in a release yet._"
)

_UNRELEASED_HEADING = re.compile(r"^##\s+\[?Unreleased\]?", re.IGNORECASE)
_ANY_H2 = re.compile(r"^##\s")
_EXPLICIT_VERSION = re.compile(r"^\d+\.\d+\.\d+$")


# --- small output helpers ----------------------------------------------------

_TTY = sys.stdout.isatty()


def _c(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m" if _TTY else s


def info(msg: str) -> None:
    print(_c("36", "==>") + " " + msg)


def note(msg: str) -> None:
    print("    " + msg)


def die(msg: str) -> None:
    print(_c("31", "error:") + " " + msg, file=sys.stderr)
    sys.exit(1)


# --- git plumbing ------------------------------------------------------------


def git(*args: str, check: bool = True, capture: bool = False) -> str:
    """Run a git command from the repo root. Returns stripped stdout when
    `capture` is set; raises CalledProcessError on failure when `check`."""
    res = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        check=check,
        text=True,
        capture_output=capture,
    )
    return (res.stdout or "").strip() if capture else ""


def current_branch() -> str:
    return git("rev-parse", "--abbrev-ref", "HEAD", capture=True)


def path_dirty(relpath: str) -> bool:
    """True if `relpath` has staged or unstaged uncommitted changes. Scoped to a
    single path, so unrelated working-tree changes don't count."""
    return bool(git("status", "--porcelain", "--", relpath, capture=True))


def branch_exists(name: str) -> bool:
    return (
        subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", f"refs/heads/{name}"],
            cwd=REPO_ROOT,
            capture_output=True,
        ).returncode
        == 0
    )


def behind_origin_main() -> bool | None:
    """True/False if we could determine it, None if origin/main is unavailable
    (offline, no remote) so the caller can treat it as "unknown"."""
    if subprocess.run(
        ["git", "fetch", "--quiet", "origin", "main"],
        cwd=REPO_ROOT,
        capture_output=True,
    ).returncode != 0:
        return None
    count = git("rev-list", "--count", "HEAD..origin/main", check=False, capture=True)
    return count not in ("", "0")


# --- version -----------------------------------------------------------------


def read_conf_version() -> str:
    data = json.loads(CONF.read_text())
    v = data.get("version")
    if not isinstance(v, str):
        die(f"{CONF} has no string \"version\" field")
    return v


def core(version: str) -> tuple[int, int, int]:
    """The numeric X.Y.Z core, ignoring any -prerelease/+build suffix."""
    nums = re.split(r"[-+]", version)[0].split(".")
    if len(nums) != 3 or not all(n.isdigit() for n in nums):
        die(f"version {version!r} is not X.Y.Z")
    x, y, z = (int(n) for n in nums)
    return x, y, z


def compute_target(spec: str, current: str) -> str:
    x, y, z = core(current)
    if spec == "major":
        return f"{x + 1}.0.0"
    if spec == "minor":
        return f"{x}.{y + 1}.0"
    if spec == "patch":
        return f"{x}.{y}.{z + 1}"
    if _EXPLICIT_VERSION.match(spec):
        return spec
    die(f"'{spec}' is not a version or one of: major, minor, patch")


def set_conf_version(new_version: str) -> None:
    """Surgically replace just the version value so the file's formatting and
    key order are preserved (a json round-trip would reflow the whole file)."""
    text = CONF.read_text()
    new_text, n = re.subn(
        r'("version"\s*:\s*")[^"]+(")',
        lambda m: m.group(1) + new_version + m.group(2),
        text,
        count=1,
    )
    if n != 1:
        die(f"could not find a \"version\" line to update in {CONF}")
    CONF.write_text(new_text)


# --- changelog ---------------------------------------------------------------


def rotate_changelog(new_version: str, date: str) -> tuple[str, list[str]]:
    """Promote the Unreleased section into a dated release section and return
    (new_changelog_text, entry_lines). Empty release notes are allowed."""
    if not CHANGELOG.exists():
        die(f"{CHANGELOG} not found")
    lines = CHANGELOG.read_text().split("\n")

    unrel = next((i for i, l in enumerate(lines) if _UNRELEASED_HEADING.match(l)), None)
    if unrel is None:
        die(f'{CHANGELOG} has no "## [Unreleased]" heading to rotate')

    # The Unreleased body runs from just after its heading to the next H2.
    nxt = next((i for i in range(unrel + 1, len(lines)) if _ANY_H2.match(lines[i])), len(lines))
    body = lines[unrel + 1 : nxt]

    # Drop the placeholder, then trim surrounding blanks — internal blank lines
    # (between "### Added" groups, say) are preserved.
    body = [l for l in body if l.strip() != UNRELEASED_PLACEHOLDER]
    while body and not body[0].strip():
        body.pop(0)
    while body and not body[-1].strip():
        body.pop()

    head = lines[: unrel + 1]  # through the "## [Unreleased]" heading itself
    fresh = ["", UNRELEASED_PLACEHOLDER, ""]
    section = [f"## [{new_version}] - {date}", ""] + body
    tail = lines[nxt:]

    out = "\n".join(head + fresh + [""] + section + [""] + tail)
    out = re.sub(r"\n{3,}", "\n\n", out)  # never more than one blank line in a row
    out = out.rstrip("\n") + "\n"
    return out, body


# --- main --------------------------------------------------------------------


def build_pr_body(version: str, entries: list[str]) -> str:
    notes = "\n".join(entries).strip() or "_No changelog entries._"
    return (
        f"Release **v{version}**.\n\n"
        f"{notes}\n\n"
        "---\n\n"
        "CI builds the release artifacts from this PR's head commit and stages "
        "them on a draft release. Merging this PR publishes them as-is — nothing "
        "is rebuilt.\n"
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="prepare-release.py",
        description="Prepare a release branch: bump version, rotate changelog, commit, push, and open a draft PR.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("version", help="target version X.Y.Z, or one of: major, minor, patch")
    p.add_argument("--dry-run", action="store_true", help="print the plan; change nothing")
    return p.parse_args(argv)


def main(argv: list[str]) -> None:
    args = parse_args(argv)

    # --- preflight (read-only) ----------------------------------------------
    # We don't care if the tree is dirty in general: the script only ever stages
    # the two files it writes (tauri.conf.json + CHANGELOG.md), so unrelated WIP
    # is never swept into the release commit — it just rides along on the new
    # branch, uncommitted. The one file that must be clean is tauri.conf.json:
    # its current version seeds the bump and it gets committed wholesale, so a
    # stray edit there would mis-seed the bump and leak into the release commit.
    # (A dirty CHANGELOG.md is fine and usual — those are the notes we rotate.)
    conf_rel = str(CONF.relative_to(REPO_ROOT))
    if path_dirty(conf_rel):
        die(f"{conf_rel} has uncommitted changes — commit or stash it first.")

    branch = current_branch()
    if branch != "main":
        die(f"not on main (on '{branch}'). Switch to main first.")

    behind = behind_origin_main()
    if behind is True:
        die("main is behind origin/main — pull first.")
    if behind is None:
        note("could not check origin/main (offline?) — skipping the up-to-date check.")

    current = read_conf_version()
    target = compute_target(args.version, current)
    rel_branch = f"release/v{target}"

    if core(target) < core(current):
        die(f"target v{target} is older than the current v{current}.")
    if core(target) == core(current):
        note(f"target v{target} equals the current version (expected only for the first release).")

    if branch_exists(rel_branch):
        die(f"branch {rel_branch} already exists — delete it or pick another version.")

    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    new_changelog, entries = rotate_changelog(target, date)

    # --- plan ---------------------------------------------------------------
    info(f"Release plan: v{current} -> v{target}")
    note(f"branch:    {rel_branch}")
    note(f"tauri.conf.json version -> {target}")
    note(f"CHANGELOG: new section '## [{target}] - {date}' with {len(entries)} line(s)")
    note("outward:   push branch and open draft PR")
    print()
    print(_c("2", f"--- ## [{target}] - {date} " + "-" * 30))
    print("\n".join(entries) if entries else _c("2", "(no entries)"))
    print(_c("2", "-" * 50))
    print()

    if args.dry_run:
        info("dry run — nothing was changed.")
        note(f"to apply: scripts/prepare-release.py {args.version}")
        return

    # --- apply --------------------------------------------------------------
    try:
        info(f"Creating branch {rel_branch}")
        git("switch", "-c", rel_branch)

        info("Writing version bump and changelog")
        set_conf_version(target)
        CHANGELOG.write_text(new_changelog)

        info("Validating release metadata")
        subprocess.run([str(VALIDATOR), rel_branch], cwd=REPO_ROOT, check=True)

        info("Committing")
        git("add", str(CONF.relative_to(REPO_ROOT)), str(CHANGELOG.relative_to(REPO_ROOT)))
        git("commit", "-m", f"Prepare release of v{target}")
    except (subprocess.CalledProcessError, SystemExit) as err:
        print(
            _c("31", "\nfailed after creating the branch.") + " To undo:\n"
            f"    git switch main && git branch -D {rel_branch}",
            file=sys.stderr,
        )
        raise SystemExit(getattr(err, "returncode", 1) or 1)

    info(f"Pushing {rel_branch}")
    git("push", "-u", "origin", rel_branch)

    info("Opening draft PR")
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write(build_pr_body(target, entries))
        body_file = f.name
    cmd = [
        "gh", "pr", "create",
        "--base", "main",
        "--head", rel_branch,
        "--title", f"Release v{target}",
        "--body-file", body_file,
        "--draft",
    ]
    subprocess.run(cmd, cwd=REPO_ROOT, check=True)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        die("interrupted")
