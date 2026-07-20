# Changelog

We loosely follow [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

_Changes landed on `main` that haven't shipped in a release yet._

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
