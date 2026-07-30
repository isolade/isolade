# Changelog

We loosely follow [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

_Changes landed on `main` that haven't shipped in a release yet._

### Added

- A chat can now switch between Claude and Codex without losing its
  conversation. Pick a model from the other provider in the composer and your
  next message carries the conversation over. Very long conversations are
  summarized so the switch still fits the new model.
- Messages can now be queued while an agent is working. By default, they are
  sent when the current turn ends. They can also be sent after the current tool
  call or immediately.
- User messages now warn when delivery could not be confirmed.
- You can now edit a message or switch between its versions while the model is
  replying. Any partial reply remains on the original branch, and the
  replacement starts from the selected conversation point.

### Changed

- The thinking indicator no longer pulses and sways while an agent thinks. Its
  icon now sits still like every other icon in the chat, and the sweeping
  highlight on the "Thinking" label still marks the turn as active.
- While an agent is working, the composer has one button instead of two. With an
  empty composer it is the stop button, which interrupts the turn. As soon as
  you type something it becomes the send button, which queues the message.

### Fixed

- The app stays responsive with many chats open. Chats you are not looking at
  are kept alive so switching back to them is instant, but they no longer cost
  anything to keep around: opening a menu, typing in a new chat, or switching
  chats used to get slower with every long conversation left open, and now takes
  the same time whether one chat is open or twenty. Reading positions, drafts,
  terminals, and browser previews are still preserved exactly as before.
- Settings sections now start at the top of the window, with no empty strip
  above them, and the About section no longer shifts as it loads.
- The chat composer now grows when its panel gets narrower and always leaves
  enough height for at least one line, so draft text is no longer clipped.
- Codex chats now show reconnect progress while Codex retries an interrupted
  OpenAI response stream, and terminal app-server errors settle immediately
  instead of leaving the chat waiting for a second failure notification.

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
