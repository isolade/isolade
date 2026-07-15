import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  type ProfileConfigForm,
  type ProfileConfigView,
  profileConfigFormSchema,
} from "@isolade/shared";
import { parseTOML } from "toml-eslint-parser";
import { profileConfigPath, profileConfigSchema, profileDir } from "./profile-config";

// Editing a profile's build definition (config.toml) and its Dockerfile from the
// UI. The structured form (writeProfileConfigForm) is comment-preserving: we
// parse the file to a CST (toml-eslint-parser, which keeps exact source ranges),
// then splice minimal edits: a changed value replaces only its value range (so
// inline comments and the rest of the line survive), a removed field drops its
// line, and a new field is inserted as canonical TOML (bare keys in the leading
// root region, tables/array-tables at EOF). Everything the form didn't touch
// stays byte-identical.
//
// It re-parses the result and validates it against the *authoritative* server
// schema before touching disk, so a bad edit fails cleanly rather than
// corrupting the file. Secrets are owned by their own editor
// (writeSecretDeclarations); the merge never edits [[secrets]] tables, so the
// two writers don't clobber each other.

// The default Dockerfile for a profile with no (or unparseable) config.toml.
// It sits in the conventional spot beside config.toml.
const DEFAULT_DOCKERFILE_REL = "./Dockerfile";

function parseToml(text: string): Record<string, unknown> {
  const parsed = Bun.TOML.parse(text);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

// The string a TOML key CST node denotes. Bare keys carry it as `.name`; quoted
// keys (TOMLQuoted, e.g. `"gpt-5.5"`) carry it as `.value`.
function keyName(node: { name?: string; value?: string } | undefined): string | undefined {
  return node?.name ?? node?.value;
}

// ---- form <-> TOML object mapping ----

// Derive the structured form from a parsed config.toml object, un-nesting the
// `[build]` fields the form flattens. Missing optionals become their empty
// defaults so the shape is total (and stable for the round-trip integrity check).
function mapParsedToForm(parsed: Record<string, unknown>): ProfileConfigForm {
  const build = (parsed.build ?? {}) as Record<string, unknown>;
  return profileConfigFormSchema.parse({
    repos: ((parsed.repos ?? []) as Record<string, unknown>[]).map((r) => ({
      name: r.name,
      source: r.source,
      ...(r.branch !== undefined ? { branch: r.branch } : {}),
    })),
    dockerfile: build.dockerfile,
    skills: build.skills ?? [],
  });
}

// The desired TOML object for a form, the counterpart of mapParsedToForm. Empty
// optionals are omitted entirely (no `skills = []`), which keeps files clean
// and, on the round-trip path, makes "user cleared this field" delete the line
// rather than leave `= []` behind. Everything outside the build definition (the
// [runtime]/[prompt]/[network] tables, secrets, identity) is added by other
// writers and left untouched here.
function formToConfigObject(form: ProfileConfigForm): Record<string, unknown> {
  const build: Record<string, unknown> = { dockerfile: form.dockerfile };
  if (form.skills.length) build.skills = form.skills;
  return {
    build,
    repos: form.repos.map((r) => ({
      name: r.name,
      source: r.source,
      ...(r.branch ? { branch: r.branch } : {}),
    })),
  };
}

// ---- canonical TOML serialization (fresh files + new-key fragments) ----

// Serialize a string as a TOML value. A single-line string stays a basic string
// (a JSON string is a valid TOML basic string). A string containing newlines
// becomes a *multi-line* string so its newlines survive as real newlines rather
// than "\n" escapes. It becomes a literal ''' block when the content permits it
// (verbatim, no escaping), otherwise a basic """ block escaping only \, " and CR.
//
// Content sits directly after the opening delimiter, not on the next line: our
// read path (Bun.TOML) does not trim a newline following the delimiter (a
// non-spec quirk the read side already relies on), so injecting one would leave
// a stray leading newline that breaks the round-trip. A value that itself begins
// with "\n" therefore renders in the conventional delimiter-on-its-own-line form
// and still round-trips exactly.
function serializeString(s: string): string {
  if (!s.includes("\n")) return JSON.stringify(s);
  // A literal block can't hold a ''' run, a trailing quote (it would fuse with
  // the closing delimiter), a bare CR, or other C0 control chars. Those fall to
  // a basic block. (Bun.TOML rejects \uXXXX escapes, so genuinely unrepresentable
  // control chars fail validation either way, as they did before this change.)
  const literalUnsafe =
    s.includes("'''") ||
    s.endsWith("'") ||
    /\r(?!\n)/.test(s) ||
    // oxlint-disable-next-line no-control-regex -- deliberately detects C0 control chars that are unsafe in TOML literal blocks
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
  if (!literalUnsafe) return `'''${s}'''`;
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r");
  return `"""${escaped}"""`;
}

// Serialize a value to canonical TOML. `multilineStrings` governs the one place
// the two positions differ: a top-level or table value with newlines becomes a
// multi-line string (so newlines survive), whereas an inline array element stays
// single-line, since a multi-line string mid-array is legal TOML but jarring, and
// these arrays only ever hold ports and cache/skill ids.
function serializeValue(v: unknown, multilineStrings = true): string {
  if (typeof v === "string") return multilineStrings ? serializeString(v) : JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map((e) => serializeValue(e, false)).join(", ")}]`;
  // A plain object becomes an inline table (`{ a = 1, b = "x" }`) — used for the
  // structured, keyed values in the [models] table. Inline tables are one line,
  // so nested values serialize single-line too.
  if (typeof v === "object" && v !== null) {
    const entries = Object.entries(v as Record<string, unknown>).map(
      ([k, val]) => `${renderKey(k)} = ${serializeValue(val, false)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }
  throw new Error(`cannot serialize TOML value: ${String(v)}`);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isArrayOfTables = (v: unknown): v is Record<string, unknown>[] =>
  Array.isArray(v) && v.every(isPlainObject) && v.length > 0;

// A key renders bare when it's a TOML bare key ([A-Za-z0-9_-]+); anything else
// (e.g. a model id like "gpt-5.5", which contains a dot) is emitted as a quoted
// key so it doesn't parse as a dotted path.
function renderKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function renderBareKey(key: string, v: unknown): string {
  return `${renderKey(key)} = ${serializeValue(v)}`;
}

function renderTable(key: string, obj: Record<string, unknown>): string {
  const lines = [`[${key}]`];
  for (const [k, v] of Object.entries(obj)) lines.push(renderBareKey(k, v));
  return lines.join("\n");
}

function renderArrayOfTables(key: string, items: Record<string, unknown>[]): string {
  return items
    .map((item) =>
      [`[[${key}]]`, ...Object.entries(item).map(([k, v]) => renderBareKey(k, v))].join("\n"),
    )
    .join("\n\n");
}

// A sub-table under `parent`, keyed by `key` (quoted when needed), e.g.
// `[models."gpt-5.4"]` followed by its fields. Used for machine-managed maps of
// records like the [models] overrides, where each entry is a table so it can
// hold several fields per model.
function renderNestedTable(parent: string, key: string, obj: Record<string, unknown>): string {
  const lines = [`[${parent}.${renderKey(key)}]`];
  for (const [k, v] of Object.entries(obj)) lines.push(renderBareKey(k, v));
  return lines.join("\n");
}

// A whole config object → canonical TOML. The build definition is just the
// `[build]` table and the `[[repos]]` array-of-tables; everything else lives in
// its own table written by another store.
function serializeConfig(obj: Record<string, unknown>): string {
  const blocks: string[] = [];
  if (isPlainObject(obj.build)) blocks.push(renderTable("build", obj.build));
  if (isArrayOfTables(obj.repos)) blocks.push(renderArrayOfTables("repos", obj.repos));
  return `${blocks.join("\n\n")}\n`;
}

// ---- blank-line hygiene ----

// Byte ranges of values whose source spans multiple lines (multi-line strings,
// multi-line arrays). Blank-line hygiene must never reach inside them, because a
// multi-line string legitimately contains blank runs that are the user's data.
// Returns null when the text doesn't parse. The caller then skips squashing
// entirely rather than risk corrupting string content.
function multilineValueRanges(text: string): [number, number][] | null {
  let ast;
  try {
    ast = parseTOML(text);
  } catch {
    return null;
  }
  const ranges: [number, number][] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const n = node as { type?: string; range?: [number, number] } & Record<string, unknown>;
    if (
      (n.type === "TOMLValue" || n.type === "TOMLArray" || n.type === "TOMLInlineTable") &&
      n.range &&
      text.slice(n.range[0], n.range[1]).includes("\n")
    ) {
      ranges.push(n.range);
      return;
    }
    for (const key of Object.keys(n)) {
      if (key !== "parent") visit(n[key]);
    }
  };
  visit(ast.body);
  return ranges;
}

// Squash runs of blank lines (edit artifacts) and normalize the file's edges,
// but never inside a multi-line value, whose bytes belong to the user.
function tidy(text: string): string {
  const protectedRanges = multilineValueRanges(text);
  let out = text;
  if (protectedRanges) {
    out = out.replace(/\n{3,}/g, (run, offset: number) =>
      protectedRanges.some(([s, e]) => offset < e && offset + run.length > s) ? run : "\n\n",
    );
  }
  return `${out.replace(/^\n+/, "").replace(/\s+$/, "")}\n`;
}

// Insert bare root keys into the leading root region, the run of lines before
// the first table/array-table header. Appending them at EOF would silently
// re-scope them into the last table, so they must land up top (below any header
// comment). New keys append at EOF as their own blocks.
function insertRootKeys(text: string, keyLines: string[]): string {
  if (keyLines.length === 0) return text;
  const lines = text.split("\n");
  // The insertion point is the first table header's line, found via the CST.
  // A line-scan would be fooled by a multi-line string containing a line that
  // looks like a header. Falls back to a scan if the text doesn't parse.
  let idx = lines.length;
  try {
    const top = (parseTOML(text).body[0]?.body ?? []) as {
      type?: string;
      range?: [number, number];
    }[];
    const firstTable = top.find((n) => n.type === "TOMLTable");
    if (firstTable?.range) idx = text.slice(0, firstTable.range[0]).split("\n").length - 1;
  } catch {
    const scanned = lines.findIndex((l) => /^\s*\[/.test(l));
    if (scanned !== -1) idx = scanned;
  }
  const head = lines.slice(0, idx);
  const tail = lines.slice(idx);
  while (head.length && head[head.length - 1]?.trim() === "") head.pop();
  const merged = [...head, ...keyLines, "", ...tail];
  return tidy(merged.join("\n"));
}

function appendBlocks(text: string, blocks: string[]): string {
  if (blocks.length === 0) return text;
  return tidy(`${text}\n\n${blocks.join("\n\n")}`);
}

// ---- CST-based minimal-diff merge ----

// The constructs the build-definition (Configuration) form owns: the `[build]`
// table and the `[[repos]]` array-of-tables (handled via spec.repos below).
// Everything else — the [runtime]/[prompt]/[network]/[appearance]/[git] tables,
// [[secrets]], `name`, comments, and any other content — is owned by its own
// store and left byte-identical by the form's merge.
const FORM_TABLE = ["build"] as const;

// Which top-level constructs a given merge is allowed to touch. Everything
// outside the spec is left byte-identical, so independent writers (the form,
// each identity store, the migration) never clobber each other.
interface ManagedSpec {
  bare?: readonly string[];
  tables?: readonly string[];
  /** Reconcile the [[repos]] array-of-tables (only the environment form does). */
  repos?: boolean;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

// Grow [start,end] to whole lines: back to the start of the first line and
// forward past the newline ending the last (consuming any inline comment). Used
// for deletions and array-of-table region replacement.
function fullLines(src: string, start: number, end: number): [number, number] {
  let s = start;
  while (s > 0 && src[s - 1] !== "\n") s--;
  let e = end;
  while (e < src.length && src[e] !== "\n") e++;
  if (e < src.length) e++;
  return [s, e];
}

function endOfLine(src: string, pos: number): number {
  let e = pos;
  while (e < src.length && src[e] !== "\n") e++;
  return e;
}

// Same value, module of TOML formatting, compared through the parsed values so
// `ports = [5173]` and `ports=[ 5173 ]` don't count as a change.
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Repo equality must also ignore the key order of hand-authored tables
// (`source` before `name` is the same repo), so both sides are compared
// through the projection the form writes. Only real changes re-render repos.
const normalizeRepos = (v: unknown) =>
  isArrayOfTables(v) ? v.map((r) => ({ name: r.name, source: r.source, branch: r.branch })) : v;
const sameRepos = (a: unknown, b: unknown) => sameValue(normalizeRepos(a), normalizeRepos(b));

// Merge `desired` onto the existing config text, preserving comments/formatting
// for everything outside `spec`. A managed key/table present in `desired` is
// upserted; one absent from `desired` (but present in the file) is removed.
function mergeConfig(src: string, desired: Record<string, unknown>, spec: ManagedSpec): string {
  const ast = parseTOML(src);
  const top = (ast.body[0]?.body ?? []) as any[];
  const current = parseToml(src);

  const bareKV = new Map<string, any>();
  const stdTable = new Map<string, any>();
  const arrTables = new Map<string, any[]>();
  for (const item of top) {
    const name = keyName(item.key?.keys?.[0]);
    if (!name) continue;
    if (item.type === "TOMLKeyValue") bareKV.set(name, item);
    else if (item.type === "TOMLTable" && item.kind === "standard") stdTable.set(name, item);
    else if (item.type === "TOMLTable" && item.kind === "array") {
      const list = arrTables.get(name) ?? [];
      list.push(item);
      arrTables.set(name, list);
    }
  }

  const edits: Edit[] = [];
  const rootInserts: string[] = [];
  const eofInserts: string[] = [];

  // Bare root keys: replace the value range on change, drop the line on removal.
  for (const key of spec.bare ?? []) {
    const cur = bareKV.get(key);
    const des = desired[key];
    if (des !== undefined) {
      if (cur) {
        if (!sameValue(current[key], des)) {
          edits.push({
            start: cur.value.range[0],
            end: cur.value.range[1],
            text: serializeValue(des),
          });
        }
      } else {
        rootInserts.push(renderBareKey(key, des));
      }
    } else if (cur) {
      const [s, e] = fullLines(src, cur.range[0], cur.range[1]);
      edits.push({ start: s, end: e, text: "" });
    }
  }

  // Standard tables: reconcile one level of sub-keys in place.
  for (const key of spec.tables ?? []) {
    const cur = stdTable.get(key);
    const des = desired[key];
    if (des !== undefined && isPlainObject(des)) {
      if (cur) {
        editTableSubKeys(src, cur, des, current[key] as Record<string, unknown>, edits);
      } else {
        eofInserts.push(renderTable(key, des));
      }
    } else if (cur) {
      const [s, e] = fullLines(src, cur.range[0], cur.range[1]);
      edits.push({ start: s, end: e, text: "" });
    }
  }

  // repos ([[repos]]): if the set changed at all, re-render the whole set.
  // Each existing [[repos]] table is dropped in place (TOML allows them to be
  // interleaved with other tables, which must survive) and the fresh block
  // lands where the first one stood. When the desired set is empty, every
  // [[repos]] block is simply removed (a Dockerfile-only profile). Repo-internal
  // comments are the only casualty, and only when repos actually change.
  // [[secrets]] tables are never touched by the merge at all.
  const curRepos = arrTables.get("repos") ?? [];
  if (spec.repos && !sameRepos(current.repos, desired.repos)) {
    const desiredRepos = isArrayOfTables(desired.repos) ? desired.repos : [];
    if (desiredRepos.length === 0) {
      curRepos.forEach((node) => {
        const [s, e] = fullLines(src, node.range[0], node.range[1]);
        edits.push({ start: s, end: e, text: "" });
      });
    } else if (curRepos.length) {
      const rendered = renderArrayOfTables("repos", desiredRepos);
      curRepos.forEach((node, i) => {
        const [s, e] = fullLines(src, node.range[0], node.range[1]);
        edits.push({ start: s, end: e, text: i === 0 ? `${rendered}\n` : "" });
      });
    } else {
      eofInserts.push(renderArrayOfTables("repos", desiredRepos));
    }
  }

  // Apply range edits right-to-left (they're over original offsets and disjoint),
  // then the offset-independent root/EOF inserts.
  let out = src;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  out = insertRootKeys(tidy(out), rootInserts);
  out = appendBlocks(out, eofInserts);
  return out;
}

// Reconcile the sub-keys of a standard table (one level deep): change → replace
// the value range. remove → drop the line. add → append a line to the table.
function editTableSubKeys(
  src: string,
  tableNode: any,
  desired: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
  edits: Edit[],
): void {
  const subs = new Map<string, any>();
  for (const kv of tableNode.body as any[]) subs.set(keyName(kv.key.keys[0]) ?? "", kv);

  for (const [k, v] of Object.entries(desired)) {
    const kv = subs.get(k);
    if (kv) {
      if (!sameValue(current?.[k], v)) {
        edits.push({
          start: kv.value.range[0],
          end: kv.value.range[1],
          text: serializeValue(v),
        });
      }
    } else {
      // Append after the table's last line (header line if the table is empty).
      const body = tableNode.body as any[];
      const anchor = body.length ? body[body.length - 1].range[1] : tableNode.range[1];
      const at = endOfLine(src, anchor);
      edits.push({ start: at, end: at, text: `\n${renderBareKey(k, v)}` });
    }
  }
  for (const [k, kv] of subs) {
    if (!(k in desired)) {
      const [s, e] = fullLines(src, kv.range[0], kv.range[1]);
      edits.push({ start: s, end: e, text: "" });
    }
  }
}

// ---- validation ----

// Parse text as TOML and validate it against the authoritative server schema.
// Guarantees loadProfileConfig would accept the shape (FS existence aside),
// so we never write a file that the build path can't parse.
function validateConfigText(text: string): void {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (err) {
    throw new Error(
      `config is not valid TOML: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  profileConfigSchema.parse(parsed ?? {});
}

// Whether text is syntactically valid TOML (schema aside). Empty text counts as
// parseable (an empty document is a valid TOML file), so a not-yet-populated
// config can still be merged into.
function isParseable(text: string): boolean {
  if (text.trim() === "") return true;
  try {
    Bun.TOML.parse(text);
    return true;
  } catch {
    return false;
  }
}

// ---- reads ----

// Resolve a profile's Dockerfile path from its config (falling back to the
// conventional ./Dockerfile when config is missing/unparseable) and read it.
function resolveDockerfile(
  profileId: string,
  form: ProfileConfigForm | null,
): {
  path: string;
  content: string | null;
} {
  const dir = profileDir(profileId);
  const rel = form?.dockerfile ?? DEFAULT_DOCKERFILE_REL;
  const expanded = rel.replace(/^~(?=\/|$)/, homedir());
  const path = isAbsolute(expanded) ? resolve(expanded) : resolve(dir, expanded);
  return {
    path,
    content: existsSync(path) ? readFileSync(path, "utf-8") : null,
  };
}

export function readProfileConfigView(profileId: string): ProfileConfigView {
  const configPath = profileConfigPath(profileId);
  const exists = existsSync(configPath);
  const text = exists ? readFileSync(configPath, "utf-8") : "";

  // `hasConfig` here means "has a build definition" (repos + build), matching
  // the profile summary. A config.toml that only carries identity (name/[git]/
  // …) is not yet authored: `form` stays null with no parseError, so the editor
  // opens a blank form rather than reporting an error. A genuinely unparseable
  // or malformed build definition sets parseError.
  let form: ProfileConfigForm | null = null;
  let parseError: string | null = null;
  let hasConfig = false;
  if (exists) {
    try {
      const parsed = parseToml(text);
      // Buildable = has a [build]. Repos may be empty (Dockerfile-only profile).
      if (parsed.build != null) {
        form = mapParsedToForm(parsed);
        hasConfig = true;
      }
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
  }

  const { path, content } = resolveDockerfile(profileId, form);
  return {
    form,
    parseError,
    hasConfig,
    // "" (not null) when absent, so the editor opens ready to create one.
    dockerfile: content ?? "",
    dockerfilePath: path,
  };
}

// ---- writes ----

export function writeProfileConfigForm(profileId: string, input: ProfileConfigForm): void {
  const form = profileConfigFormSchema.parse(input);
  const desired = formToConfigObject(form);
  const configPath = profileConfigPath(profileId);

  let text: string;
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    if (isParseable(raw)) {
      // The identity tables (name/[git]/[network]/[appearance]) and [[secrets]]
      // survive untouched: they belong to other writers, and the merge only
      // edits the constructs in its spec.
      text = mergeConfig(raw, desired, { tables: FORM_TABLE, repos: true });
    } else {
      // Never silently replace an unparseable file: that would discard the
      // profile's identity/comments. Fix config.toml on disk instead.
      throw new Error("config.toml is not valid TOML; fix it on disk first");
    }
  } else {
    mkdirSync(profileDir(profileId), { recursive: true });
    text = serializeConfig(desired);
  }

  text = tidy(text);
  // Never commit a file the schema would reject...
  validateConfigText(text);
  // ...and never commit one whose structured meaning drifted from the intent
  // (guards against a merge surprise on an unusual source file).
  const roundTripped = mapParsedToForm(parseToml(text));
  if (JSON.stringify(roundTripped) !== JSON.stringify(form)) {
    throw new Error(
      "config round-trip changed the definition; edit config.toml on disk to preserve its layout",
    );
  }
  writeFileSync(configPath, text);
}

// ---- generic comment-preserving writers (identity stores) ----
//
// These operate on a config.toml path (not a profileId) and each own exactly
// one top-level construct, so the git/network/appearance stores can persist
// their table without disturbing the build definition, comments, or each other.
// Passing `undefined` removes the key/table.

function readConfigText(configPath: string): string {
  return existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
}

// Upsert one bare root key into config text, comment-preservingly (string in,
// string out).
function upsertConfigBareKey(src: string, key: string, value: unknown | undefined): string {
  return mergeConfig(src, value === undefined ? {} : { [key]: value }, { bare: [key] });
}

// Upsert one standard table into config text, comment-preservingly.
function upsertConfigTable(
  src: string,
  table: string,
  obj: Record<string, unknown> | undefined,
): string {
  return mergeConfig(src, obj === undefined ? {} : { [table]: obj }, { tables: [table] });
}

// Replace the whole `[parent]` / `[parent."<key>"]` region — a machine-managed
// map of sub-tables — with freshly rendered blocks, leaving the rest of the file
// (other tables, comments) untouched. The region is rewritten wholesale (like
// [[repos]]) rather than sub-key-merged, since it carries no user comments;
// passing an empty/undefined map removes it entirely.
function upsertNestedTables(
  src: string,
  parent: string,
  entries: Record<string, Record<string, unknown>> | undefined,
): string {
  const ast = parseTOML(src);
  const top = (ast.body[0]?.body ?? []) as {
    type?: string;
    key?: { keys?: { name?: string; value?: string }[] };
    range?: [number, number];
  }[];
  // Existing `[parent]` and `[parent."x"]` tables share `parent` as their first
  // key segment. Drop them right-to-left over original offsets.
  const ranges = top
    .filter((n) => n.type === "TOMLTable" && keyName(n.key?.keys?.[0]) === parent && n.range)
    .map((n) => fullLines(src, n.range![0], n.range![1]))
    .toSorted((a, b) => b[0] - a[0]);
  let out = src;
  for (const [s, e] of ranges) out = out.slice(0, s) + out.slice(e);
  out = tidy(out);
  if (entries && Object.keys(entries).length > 0) {
    const block = Object.entries(entries)
      .map(([key, fields]) => renderNestedTable(parent, key, fields))
      .join("\n\n");
    out = appendBlocks(out, [block]);
  }
  return out;
}

// Tidy, validate against the authoritative schema, and write. The one commit
// path for the generic writers.
function commitConfigText(configPath: string, text: string): void {
  const tidied = tidy(text);
  validateConfigText(tidied);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, tidied);
}

export function writeConfigBareKey(
  configPath: string,
  key: string,
  value: unknown | undefined,
): void {
  const src = readConfigText(configPath);
  if (!isParseable(src)) {
    throw new Error("config.toml is not valid TOML; fix it on disk first");
  }
  commitConfigText(configPath, upsertConfigBareKey(src, key, value));
}

export function writeConfigTable(
  configPath: string,
  table: string,
  obj: Record<string, unknown> | undefined,
): void {
  const src = readConfigText(configPath);
  if (!isParseable(src)) {
    throw new Error("config.toml is not valid TOML; fix it on disk first");
  }
  commitConfigText(configPath, upsertConfigTable(src, table, obj));
}

// Write a machine-managed map of sub-tables (`[parent."<key>"]`), replacing any
// existing `[parent…]` region. An empty/undefined map removes it. Used for the
// [models] overrides.
export function writeConfigNestedTables(
  configPath: string,
  parent: string,
  entries: Record<string, Record<string, unknown>> | undefined,
): void {
  const src = readConfigText(configPath);
  if (!isParseable(src)) {
    throw new Error("config.toml is not valid TOML; fix it on disk first");
  }
  commitConfigText(configPath, upsertNestedTables(src, parent, entries));
}

export function writeDockerfile(profileId: string, content: string): void {
  const view = readProfileConfigView(profileId);
  const path = view.dockerfilePath!;
  const dir = profileDir(profileId);
  // Only write Dockerfiles that live under the profile dir. A config pointing at
  // a shared Dockerfile elsewhere is edited on disk, not through this endpoint.
  const rel = resolve(path);
  if (rel !== dir && !rel.startsWith(`${dir}/`)) {
    throw new Error("Dockerfile is outside the profile directory; edit it on disk");
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
