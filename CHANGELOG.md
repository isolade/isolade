# Changelog

We loosely follow [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

_Changes landed on `main` that haven't shipped in a release yet._

### Added

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

- Fixed streamed Claude output corrupting multibyte characters when a UTF-8
  sequence spans transport chunks.
- Fixed the chat Stop button for OpenAI models so it properly stops the active
  response instead of only disconnecting the visible stream.

## [0.1.0] - 2026-07-15

Initial release.
