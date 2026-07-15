// POSIX-safe single-quote shell escape for a value interpolated into a
// `/bin/sh -c` command or a Dockerfile RUN instruction. Wrapping in single
// quotes and escaping embedded quotes (`'\''`) means a stray quote in a
// user-controlled value (a skill package slug, a git identity, an init
// command line) can't break out of the argument it's bound to. Security
// sensitive, so it lives in one place rather than being copied per call site.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
