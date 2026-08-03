# AGENTS.md

## Layout

- `packages/server`: Hono API, chat backends, SQLite via Drizzle
- `packages/web`: the React + Tailwind frontend
- `packages/shared`: types and protocol shared by both
- `packages/sandbox`: microVM runtime, runs in-process inside the server
- `app`: Tauri (Rust) desktop shell

## Running it

`bun run dev` starts everything in one terminal: UI on http://localhost:5173,
API on `:3000`.

`bun run check` runs format, lint, typecheck and test.
