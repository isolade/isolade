# Changelog

We loosely follow [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

_Changes landed on `main` that haven't shipped in a release yet._

### Added

- A new install now offers to set itself up, rather than opening onto an empty
  profile with six unexplained steps between you and a working agent. It asks
  first whether you want the ready-made Excalidraw demo or your own code. Your own
  code means naming the profile, pointing it at the repositories the work touches
  (paths or URLs, as many as you like, or none at all), and saying which base and
  toolchains the image should carry. It writes the Dockerfile from your answers,
  which is the step people gave up on, and shows it beside the questions as you
  answer them. Then it builds, honestly slow and leaving the build running if you
  close the card, and signs you in at the end, which is where it has to be since
  signing in runs the provider's CLI inside a VM built from that image. It stops
  at a built profile rather than steering you further, and the same guided setup
  is available any time from Settings, Profiles, since setting up a second profile
  is the same work as the first.
- Profile seeding into nested instances can now be switched off with
  `ISOLADE_SEED=0`. Instances created with it set ignore their profile's
  `seed_profiles` and start with no profiles at all, which is what you want when
  working on the first-run experience inside Isolade.

### Changed

- The model picker now offers only models you can actually run.
- Agent messages are now set in a sans-serif face by default. If you had picked
  serif, that sticks, and Settings still offers serif and any font on your
  machine.
- A fresh install now has no profiles at all, where it used to be given an empty
  "Default" that existed in the list and could not do anything. Guided setup
  creates the first one. The last profile can also be deleted now, which the
  seeded one had made impossible, and the places you would meet an install with
  none say so: the workspace offers to set one up rather than showing a composer
  that cannot create anything, and a settings section that configures a profile
  tells you there is nothing to configure yet.
- A profile's instructions are now part of the system prompt rather than being
  prepended to a chat's first message, so they hold for the whole chat and
  outrank the rest of it. You can also pick the prompt they join: Isolade's own,
  written for a disposable VM and now the default; the one Claude Code or Codex
  ships, either as it comes or with the few corrections Isolade needs on top; or
  none at all.
- Agents are now told what the app around them can do, so a chat hands you a
  server it started when you ask to see it, attaches a pull request it works on
  to the title bar, and shows a screenshot or chart inline in its reply instead
  of leaving you a path to open.
- Chats now carry only the tools they can use, so every message costs less. A
  Claude chat sends about 18 KB before it says a word, down from 60 KB, and a Codex
  chat 2.8 KB, down from 10 KB.

### Fixed

- On macOS, the window can now be dragged from the title-bar area while Settings
  is open.
- Newly created chats now give `/tmp` up to one quarter of their memory, capped
  at 8 GiB, instead of limiting it to 512 MiB.
- Back-to-back profile builds no longer occasionally fail because the previous
  builder still holds the shared cache disk, including after a nested Isolade
  instance restarts during a build.
- Chats now recover more reliably when a running reply's connection drops,
  including replies started from queued messages. A failed Stop request no
  longer hides a turn that is still running.
- Sending a message into a running reply no longer scatters copies of the
  "Agent interrupted" divider through the rest of the reply. One interruption
  leaves one divider.

## [0.5.0] - 2026-08-02

### Added

- Agents can now show you images. A markdown image in a reply, like
  `![the chart](out/chart.png)`, renders in the chat.
- The composer now shows whether the agent is working and how long the turn has
  taken, in the corner next to the send button.
- Every message can now be copied. Hover one and a copy button appears beneath
  it. Your own messages copy what you wrote. An agent's copies its reply, as the
  Markdown it wrote, without the remarks it made along the way or the tool calls
  and reasoning between them.

### Changed

- The composer's bottom row is reorganized. On the left: the model, a bolt for
  fast mode, what the chat has cost, and a ring for how full the context is, with
  the tokens behind it (and, on Claude, what is holding them) on hover. Fast mode
  and the context figures used to be buried in the model picker, and the new-chat
  box gets the bolt too.
- A turn's thinking now stays collapsed until you open it, so a long stretch of
  reasoning no longer pushes the answer down the pane.
- A new chat appears in the sidebar as soon as you send, under the start of your
  message, and takes its generated title once that lands.

### Removed

- The estimated share of your subscription windows, from both the usage cards and
  the composer. The providers do not publish how a turn counts against a plan, so
  the figure was guesswork. The windows they do report are unaffected.

### Fixed

- Claude chats no longer pay for an extra Haiku call on their first message,
  spent on a session title Isolade never used.
- A terminal tab no longer comes back garbled after being off screen, where
  recalling a command with the up arrow used to paint over the prompt.
- A chat no longer runs out of disk part-way through a large checkout or build.
  Its writable disk was 4 GiB and is now 64 GiB, which the host still only
  fills as the chat writes to it. Chats created before this keep the size they
  were made with.
- Opening a chat that has been thinking while you were elsewhere now shows the
  thinking tokens it has already spent, instead of counting them up from zero as
  if the turn were starting.
- The model picker no longer ends up naming the raw model id with an empty menu
  behind it. It happened when the window opened before Isolade's server was
  answering, and lasted the rest of the session. The picker now reads the model
  catalog that ships inside the app, so it is right from the first frame.

## [0.4.0] - 2026-07-31

### Added

- A chat can now switch between Claude and Codex without losing its
  conversation. Pick a model from the other provider in the composer and your
  next message carries the conversation over. Very long conversations are
  summarized so the switch still fits the new model.
- Messages can now be queued while an agent is working. By default, they are
  sent when the current turn ends. They can also be sent after the current tool
  call or immediately.
- The composer now shows what the chat has cost so far, counting up as the agent
  works. The figure covers the whole conversation, including every agent it was
  switched between, so it no longer restarts at zero after a switch, and
  including turns you stopped part-way or that failed on their way through, since
  those were charged for too. The model picker moves to the left of the composer
  to make room for it, in both the new-chat box and open chats.
- Hovering that figure itemizes where the money went: tokens and dollars per
  bucket, each priced at the model that was billed for it, plus what a running
  turn has added and any searches billed per request. Cache writes are split by
  how long the entry lives, because an hour-long one costs Anthropic's input rate
  twice over where a five-minute one costs 1.25×, and on a first turn that is most
  of the bill. Claude reports a turn's cost as a single figure rather than a sum
  of token rates, so whatever the itemization still cannot account for is shown as
  its own line rather than hidden.
- Chats can now run in fast mode, from the model picker, on the models that
  offer it — Claude's fast mode and Codex's priority service tier. It is per
  chat, off by default, and the picker shows what the premium is (2× the usual
  rate on Opus 5 and on the GPT-5.6 models, 6× on Opus 4.6) because the speed is
  not free. Moving a chat to a model that doesn't offer it turns it back off
  rather than leaving it set where nothing shows it, so returning to a model that
  does never resumes paying a premium you didn't ask for again. Turns run this way
  are costed at those rates in the breakdown. Codex never reports which tier a
  turn actually ran on, so if a plan doesn't include priority service the turn
  quietly runs at standard speed; the server logs a warning when the account's
  model list says so.
- User messages now warn when delivery could not be confirmed.
- You can now edit a message or switch between its versions while the model is
  replying. Any partial reply remains on the original branch, and the
  replacement starts from the selected conversation point.

### Changed

- Tool calls in a chat no longer name what they did. A call reads as its icon
  followed by the file, command, or query it was given.
- Each chat in the sidebar now shows when it last did something ("just now",
  "46m ago", a date for older chats) under its title, next to the unpushed diff
  counts, which moved off the title line. Both read in a small, quiet type so a
  long list still scans as a list of titles.
- The thinking indicator no longer pulses and sways while an agent thinks. Its
  icon now sits still like every other icon in the chat, and the sweeping
  highlight on the "Thinking" label still marks the turn as active.
- While an agent is working, the composer has one button instead of two. With an
  empty composer it is the stop button, which interrupts the turn. As soon as
  you type something it becomes the send button, which queues the message.
- Codex effort menus no longer offer `ultra`. Despite its position at the top of
  the slider it is not more reasoning than `max` — it asks for the same thing and
  additionally lets Codex spawn sub-agents on its own initiative, which is
  isolade's job. Chats already set to it fall back to the model's default effort.
  The Codex model list, its display names, and its effort levels now come from
  the same source as Claude's rather than from a `codex` process, so refreshing
  the catalog no longer needs Codex installed and logged in.

### Fixed

- Codex's tool calls now carry the same icons as Claude's, and a Codex file
  change names the file it touched.
- A Codex shell call now shows the command it ran, not the login shell around it
  (`/bin/bash -lc 'sleep 2'`).
- Sending the first message of a new chat now lands in the full workspace, tab
  strip and all, instead of a bare chat that grew one once the VM was up. Chat
  and terminal tabs need the VM, so those two "+" entries wait for it.
- The app stays responsive with many chats open. Chats you are not looking at
  are kept alive so switching back to them is instant, but they no longer cost
  anything to keep around: opening a menu, typing in a new chat, or switching
  chats used to get slower with every long conversation left open, and now takes
  the same time whether one chat is open or twenty. Reading positions, drafts,
  terminals, and browser previews are still preserved exactly as before. On the
  macOS app, where the first version of this only helped a little, opening a
  menu over two dozen open chats went from around two seconds to a tenth of
  one.
- Settings sections now start at the top of the window, with no empty strip
  above them, and the About section no longer shifts as it loads.
- The chat composer now grows when its panel gets narrower and always leaves
  enough height for at least one line, so draft text is no longer clipped.
- Codex chats now show reconnect progress while Codex retries an interrupted
  OpenAI response stream, and terminal app-server errors settle immediately
  instead of leaving the chat waiting for a second failure notification.
- Restarting the app mid-conversation no longer drops the next Claude turn from
  the usage charts, or makes a chat's token totals dip before climbing again.
- Claude chats no longer overstate what they have cost. The figure the CLI
  reports covers everything its process has spent, not just the turn that
  finished, so counting each one as a turn's cost inflated a chat's total the
  longer it ran: a fourth turn roughly doubled it. Costs are now the difference
  between reports, and they count the sub-agents a turn spawned, whose tokens
  were previously missing from the usage charts entirely.

## [0.3.2] - 2026-07-26

### Changed

- Interactive controls, dialogs, menus, and popovers now respond immediately
  instead of fading, sliding, or easing between states.

### Fixed

- Chat messages scroll normally again in the macOS app. The panel keep-alive
  layer added in 0.3.1 could trigger a WebKit containment bug that made the
  visible chat's scroll area inert.

## [0.3.1] - 2026-07-24

### Added

- Claude Opus 5 is now available in the model picker and is the default Claude
  model for new chats.
- Isolade now writes a log file to `~/.local/state/isolade/logs/isolade.log` to
  help with troubleshooting. The last 10 launches are kept.

### Fixed

- Rearranging workspace panels no longer resets their contents. Splitting,
  moving, or reordering a panel used to reload it, losing a chat's draft and
  scroll position, dropping a terminal session, and reloading a running browser
  preview. Panels now keep their live state as the layout changes.

## [0.3.0] - 2026-07-22

### Added

- Added chat thinking indicators. Codex shows thinking updates, while Claude
  shows thinking token counts and summaries.
- Workspaces now use flexible, dockable panels. Drag tabs onto a panel edge to
  split the workspace, onto its centre to move them, or along a tab row to
  reorder them. Dividers resize adjacent panels, crowded tab rows scroll, and
  each row keeps its new-tab button beside the final tab. Layouts are saved per
  instance and restored across restarts.
- Chat messages can now carry file attachments. Use the paperclip on the
  bottom-left of the composer, or paste an image straight from the clipboard
  (Cmd+V), and it shows up as a preview before you send. Attachments are placed
  in the VM for the agent to open.

### Changed

- The chat composer's model picker and send button now sit on a row below the
  text instead of sharing its line.

### Fixed

- Bullet and numbered list markers in chat messages are no longer clipped on
  their left edge.
- Codex chats no longer unintentionally expose the built-in subagent tools.
  A custom subagents tool will replace this later.
- VMs now inherit the host's timezone instead of defaulting to UTC.
- Chat rendering is faster and smoother, especially when switching between
  long chats. Chats preserve their scroll position, streamed responses render
  as proper Markdown with a live typing effect, and new output only scrolls the
  view when the reader is already at the bottom.

## [0.2.0] - 2026-07-19

### Added

- Chat messages can now be edited. Hover a message, hit the pencil, and the
  assistant recomputes its answer from that point with exactly the context
  that preceded the message (the underlying Claude session or Codex thread is
  forked, not replayed). Every version stays around: a `‹ 1/2 ›` pager under
  edited messages switches between the branches.
- Claude chats now switch model and effort without restarting their live agent
  process, preserving background work. Context breakdowns also query that live
  process directly instead of launching a second Claude instance.
- Developing Isolade within Isolade got easier. A nested instance now starts
  with the host profiles listed under `seed_profiles` already built and ready to
  run, and providers stay signed in across nested instances after a single
  login.
- Port forwards can now pin the host port with `isolade ports add 8080:8080`.
  This supersedes the previous `isolade forward` syntax.

### Fixed

- Fixed chats getting permanently stuck in an error state (`has no agent
endpoint`) after an unclean shutdown. Startup and "Restart VM" now repair
  such VMs automatically.
- Fixed streamed Claude output corrupting multibyte characters when a UTF-8
  sequence spans transport chunks.
- Fixed the chat Stop button for OpenAI models so it properly stops the active
  response instead of only disconnecting the visible stream.

## [0.1.0] - 2026-07-15

Initial release.
