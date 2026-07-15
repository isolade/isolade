import { Plus, Trash2, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Small controls shared by the profile settings sections whose fields map to
// config.toml (Configuration, Runtime, Network). Kept here so the sections
// stay visually and behaviourally identical without duplicating the widgets.

// One labelled setting: a title, optional help text, and its control(s).
export function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        {description && <span className="text-xs text-muted-foreground">{description}</span>}
      </div>
      {children}
    </div>
  );
}

// An editable list of one-line string values (cache paths, skills, commands):
// a stacked row of inputs each with a remove button, plus an Add row.
export function StringRows({
  value,
  onChange,
  placeholder,
  addLabel,
  mono = true,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  addLabel: string;
  mono?: boolean;
}) {
  const set = (i: number, v: string) => onChange(value.map((x, j) => (j === i ? v : x)));
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));
  return (
    <div className="space-y-1.5">
      {value.map((item, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={item}
            placeholder={placeholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => set(i, e.target.value)}
            className={cn("h-8 text-xs", mono && "font-mono")}
          />
          <Button size="icon-xs" variant="ghost" title="Remove" onClick={() => remove(i)}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button size="xs" variant="secondary" onClick={() => onChange([...value, ""])}>
        <Plus className="size-3.5" /> {addLabel}
      </Button>
    </div>
  );
}

// Removable numeric chips (ports): type a number, Enter/Add to append.
export function NumberChips({
  value,
  onChange,
  placeholder,
}: {
  value: number[];
  onChange: (next: number[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const n = Number.parseInt(draft.trim(), 10);
    if (Number.isInteger(n) && n > 0 && !value.includes(n)) onChange([...value, n]);
    setDraft("");
  };
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <Input
          value={draft}
          inputMode="numeric"
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          className="h-8 w-40 text-xs font-mono"
        />
        <Button
          size="sm"
          variant="secondary"
          className="h-8"
          disabled={!draft.trim()}
          onClick={add}
        >
          <Plus className="size-3.5" /> Add
        </Button>
      </div>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((n) => (
            <li
              key={n}
              className="flex items-center gap-1 rounded border border-border bg-muted/40 pl-2 pr-1 py-0.5 text-[11px] font-mono"
            >
              {n}
              <button
                type="button"
                aria-label={`Remove ${n}`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onChange(value.filter((x) => x !== n))}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The two-phase (sync/async) lifecycle editor shared by setup and start.
export function PhaseEditor({
  value,
  onChange,
}: {
  value: { sync: string[]; async: string[] };
  onChange: (next: { sync: string[]; async: string[] }) => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <Field
        label="Sync"
        description="Run in order; each must exit 0 before the next. The instance waits on these."
      >
        <StringRows
          value={value.sync}
          onChange={(sync) => onChange({ ...value, sync })}
          placeholder="pnpm install"
          addLabel="Add command"
        />
      </Field>
      <Field
        label="Async"
        description="Fired in parallel; never block the instance, failures only log."
      >
        <StringRows
          value={value.async}
          onChange={(async) => onChange({ ...value, async })}
          placeholder="./warm-cache.sh"
          addLabel="Add command"
        />
      </Field>
    </div>
  );
}
