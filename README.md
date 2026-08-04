<div align="center">
  <img src="packages/web/src/assets/wordmark.svg" alt="Isolade" width="240">
  <br>
  <strong>Local-first coding agent workbench with secretless microVMs</strong>
  <img src="https://isolade.com/demo.webp?v=2" alt="Demo" width="100%">
  <img src="packages/web/src/assets/tagline.svg" alt="You sip. They ship." width="150">
</div>

## Overview

Isolade is a local-first coding agent workbench powered by secretless microVMs. It solves three problems:

- **Manual approvals slow you down**, and approval fatigue means they don't provide real security either. But automatic approvals are too risky to use on your actual system. Additional issues, such as supply chain attacks, make software development an unnecessarily risky business, even without agents.
- **The official clients lock you in**, and agents deserve a richer interface than they offer. You want to be able to freely switch between models of different providers within one unified workbench, for example when your subscription usage gets exhausted. Opus should be able to call a Sol subagent for a review.
- **Working with multiple agents at once is cumbersome**, especially across several repositories. And worktrees are not the right solution for this. Why reinstall package dependencies? What about shared resources such as ports? You want to quickly spawn new sessions without thinking about it.

## Why Isolade

<img src="https://isolade.com/icons/shield.svg" width="18" align="absmiddle"> **Isolation** – Give each agent its own microVM. This not only keeps the host safe without any approval prompts, but also isolates the agents and their processes from each other.

<img src="https://isolade.com/icons/ticket.svg" width="18" align="absmiddle"> **Subscriptions** – Sign in with the subscription you already have instead of paying API prices. Unlike other coding agents, Isolade does not spoof headers, but goes through the official agent binaries.

<img src="https://isolade.com/icons/dashboard.svg" width="18" align="absmiddle"> **Multitasking** – Run as many agents in parallel as you want and effortlessly switch between them. The sidebar shows which agents are still working, which are done, and which need your attention.

<img src="https://isolade.com/icons/key.svg" width="18" align="absmiddle"> **Secretless** – The secrets you configure never enter the VM. When the agent invokes an authenticated API, the real values are substituted transparently, but only for specific headers and network destinations.

<img src="https://isolade.com/icons/bot.svg" width="18" align="absmiddle"> **Flexibility** – Manage all your agents across multiple providers within a single application. Subagents can cross the provider boundary, and you can switch models at any point.

<img src="https://isolade.com/icons/layers.svg" width="18" align="absmiddle"> **Repositories** – Work on as many repositories as you want within a single session. You are not stuck juggling worktrees. And by prewarming your repositories, you get instant builds across the entire project.

<img src="https://isolade.com/icons/copy.svg" width="18" align="absmiddle"> **Profiles** – Track the configuration of your whole setup in a Git repository and share it with your teammates. You can also have multiple profiles to keep projects strictly separate.

<img src="https://isolade.com/icons/house.svg" width="18" align="absmiddle"> **Local** – Make use of your own hardware. Spawning an agent in the cloud certainly has its uses, but you should have the option to run everything on-device instead of paying a cloud provider.

## Installation

The easiest way to install Isolade is to run:

```bash
curl -fsSL https://isolade.com/install.sh | sh
```

For other options, please visit the [installation docs](https://isolade.com/docs/installation).

## Contributing

We currently take contributions as issues rather than pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md) for more details.
