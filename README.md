<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://isolade.com/logo_dark.svg">
    <img src="https://isolade.com/logo_light.svg" alt="Isolade" height="300">
  </picture>
  <br>
  <strong>Run Claude Code and Codex in sealed, throwaway microVMs on your own machine.</strong>
  <br>
  Hand an agent the whole task and walk away.
  <br><br>
  <a href="https://isolade.com">isolade.com</a> &nbsp;·&nbsp;
  <a href="https://isolade.com/docs">Docs</a> &nbsp;·&nbsp;
  <a href="CHANGELOG.md">Changelog</a>
  <br><br>
  <img src="https://isolade.com/demo.webp" alt="Isolade demo" width="100%">
</div>

An agent earns its keep once you stop approving every command it runs. What stops you is
that a free-roaming agent on your laptop can read your SSH keys and every repository in
your home directory. Isolade hands each agent a microVM of its own instead: a sealed
machine with none of your files and no real secrets inside it, built from a profile you
define and thrown away when you are finished with it. So the agent works with no approval
prompts at all, and the worst that can come of it is a VM you were going to delete anyway.

You sign in with the Claude or Codex plan you already pay for. Isolade runs the CLI's own
login flow inside a throwaway VM, the way signing in on a second device would, so there
are no API keys to mint and the `claude` and `codex` logins on your host are left alone.

Both providers sit behind the same interface, and a chat can change its mind about which
one it is talking to. A thread that started on Opus can be handed to GPT-5.6 without
losing its history, summarized on the way across when the new model's context window is
smaller. As it works, each chat shows what it has cost so far, itemized down to cache
writes and the sub-agents a turn spawned.

Around the chat sits the rest of a workbench: a tab per agent, terminals into any VM, the
diff of everything an agent touched, a preview of what it built, and the pull request it
opened.

## Why Isolade

<img src="https://isolade.com/icons/shield.svg" width="18" align="absmiddle">&nbsp; <strong>Isolation</strong>: Each agent gets its own microVM, so what holds it in is the hardware rather than a syscall filter you have to trust. An escape has to beat the CPU. There is also nothing of yours inside to take, no keys and no unrelated repositories.

<img src="https://isolade.com/icons/check.svg" width="18" align="absmiddle">&nbsp; <strong>Autonomous</strong>: No permission prompts. The agent reads, writes, installs and runs whatever the task needs while you are somewhere else, and the worst it can manage is wrecking a VM that was disposable to begin with.

<img src="https://isolade.com/icons/lock.svg" width="18" align="absmiddle">&nbsp; <strong>Secretless</strong>: The VM only ever sees a placeholder. The real value stays on the host and is spliced into outgoing requests by the proxy, only towards hosts you named, so an agent can `git push` without your token ever being within reach. One that goes looking through its environment finds a worthless string.

<img src="https://isolade.com/icons/key.svg" width="18" align="absmiddle">&nbsp; <strong>Your own plan</strong>: Sign in with the Claude or Codex subscription you already have, through the provider's own login flow in a throwaway VM. The credential lands in Isolade's own store rather than your keychain, and a token refresh in one VM propagates to every other by itself.

<img src="https://isolade.com/icons/bot.svg" width="18" align="absmiddle">&nbsp; <strong>Agent-agnostic</strong>: Claude Code and Codex run behind one interface, with the same chat and the same tooling whichever is driving. A chat can switch provider in place, carrying its conversation over rather than starting again, and pick the reasoning effort or fast mode it should run at. Local models are coming.

<img src="https://isolade.com/icons/dashboard.svg" width="18" align="absmiddle">&nbsp; <strong>Many agents at once</strong>: Steer as many as your machine will hold from a single window, rather than a terminal for each. Tabs, splits, drafts and reading positions are all where you left them when you come back to one.

<img src="https://isolade.com/icons/layers.svg" width="18" align="absmiddle">&nbsp; <strong>Multi-repo</strong>: A profile can bundle every repository a task touches, so an agent works across a whole project rather than inside a single worktree. They all reach the same VM, checked out wherever your Dockerfile puts them.

<img src="https://isolade.com/icons/copy.svg" width="18" align="absmiddle">&nbsp; <strong>Shareable</strong>: A profile is a directory of plain config, so tracking it takes a `git init` in your config directory. Commit it and a teammate gets the same environment, down to the build cache.

<img src="https://isolade.com/icons/zap.svg" width="18" align="absmiddle">&nbsp; <strong>Fast builds</strong>: BuildKit runs inside a VM, with a layer cache that outlives any one build and is shared between profiles. Prewarmed images mean a fresh VM is ready in under a second.

<img src="https://isolade.com/icons/house.svg" width="18" align="absmiddle">&nbsp; <strong>Local</strong>: Everything runs on your own hardware. Your code and your credentials stay on the machine, and the only thing that goes anywhere is what the agent sends its model provider.

The docs go deeper. [How it works](https://isolade.com/docs/how-it-works) traces the path
from a config file to a running agent, and [architecture](https://isolade.com/docs/architecture)
covers the builder VM and the HTTP API.

## Install

```bash
curl -fsSL https://isolade.com/install.sh | sh
```

macOS on Apple Silicon, or Linux. Running it again updates an install you already have.
The [installation docs](https://isolade.com/docs/installation) cover what each platform
needs, along with pinning a release or unpacking one by hand.

## What Isolade does not do

A microVM is a strong boundary, and it is worth being just as clear about what sits
outside it.

- Sealing an agent in does not make it trustworthy. Whatever it can reach legitimately, a prompt injection can reach as well, including the source you handed it and the hosts you allowlisted.
- Secret substitution puts the real value into the upstream request, so only allowlist hosts you trust not to pass your `Authorization` header along to somewhere else.
- A profile's Dockerfile is yours, and Isolade builds what it says. Review it the way you would review any other dependency.
- Your model provider still receives the prompts and the task context the agent sends.

The [threat model](https://isolade.com/docs/threat-model) covers all of this properly.

## Early days

Isolade is young and moving quickly. Releases land often, the interface still shifts
between them, and anything you run into is worth an
[issue](https://github.com/isolade/isolade/issues).

## Contributing

Issues are very welcome, whether that is a bug or a platform we do not cover yet. We are
not taking pull requests for the time being. [CONTRIBUTING.md](CONTRIBUTING.md) has the
details.
