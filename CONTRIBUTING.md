# Contributing

Isolade is young and the shape of the code is still moving under us, so the most useful
thing you can contribute right now is an issue. Bugs, rough edges, confusing behaviour and
platforms we do not cover yet are all worth reporting.

## Pull requests

We are not taking pull requests for the time being. The internals change too quickly for us
to hold an outside branch up against them fairly, and a PR left waiting for weeks is worse
than one that was never opened. When that changes, this file will say so.

## Filing a good issue

Tell us what you expected, what happened instead, and enough to try it ourselves. For
anything involving a VM or a build, these are usually the details that matter:

- Isolade's version, from **Settings → About**, and whether you installed it with
  `install.sh` or built from source.
- Your platform. On Linux, the distribution and whether `/dev/kvm` is present.
- Which agent and model the chat was on, if a chat was involved.
- The relevant part of the log. Each launch writes one to
  `~/.local/state/isolade/logs/isolade.log`, and the previous nine are kept beside it as
  `isolade.log.1` and so on. For a build that went wrong, the build's own output in the
  app is usually more useful.

Redact as you go. Logs can name your repositories and file paths, and we do not need
either to reproduce most things.

## Security

Please do not open a public issue for a vulnerability. Use GitHub's
[private vulnerability reporting](https://github.com/isolade/isolade/security/advisories/new)
instead, and we will take it from there. The
[threat model](https://isolade.com/docs/threat-model) describes what the sandbox boundary
is meant to cover, which is a good place to check first, since some behaviour that looks
alarming is deliberate and documented.

## Building from source

`bun install` then `bun run app` gets you a local build. `bun run check` runs the
formatter, the linter, the typechecker and the tests, which is what CI does. The
[architecture docs](https://isolade.com/docs/architecture) explain how the packages fit
together.
