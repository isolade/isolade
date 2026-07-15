import { useEffect, useState } from "react";

// One localStorage-backed, cross-component reactive setting: a read, a set
// that persists and notifies, and a hook that re-renders every subscribed
// component on set. The listener set is module-level, so two components
// showing the same setting stay in sync without a context provider.
function createLocalSetting<T>(opts: { read: () => T; persist: (v: T) => void }) {
  const listeners = new Set<(v: T) => void>();
  return {
    read: opts.read,
    set(v: T): void {
      opts.persist(v);
      listeners.forEach((l) => l(v));
    },
    use(): T {
      const [v, setV] = useState(opts.read);
      useEffect(() => {
        listeners.add(setV);
        return () => {
          listeners.delete(setV);
        };
      }, []);
      return v;
    },
  };
}

const DEBUG_KEY = "isolade.debug";

const debugSetting = createLocalSetting<boolean>({
  read: () => {
    try {
      return window.localStorage.getItem(DEBUG_KEY) === "true";
    } catch {
      return false;
    }
  },
  persist: (v) => {
    try {
      window.localStorage.setItem(DEBUG_KEY, v ? "true" : "false");
    } catch {}
  },
});

export const setDebugSetting = debugSetting.set;
export const useDebugSetting = debugSetting.use;

// ---------------------------------------------------------------------------
// Fonts
//
// The typeface for assistant ("agent") messages and for the user's own
// messages can be chosen independently. A value is either one of the generic
// keywords below (mapped to a curated font stack) or the name of a specific
// font family installed on the viewing machine (enumerated by the native
// Tauri `list_system_fonts` command, and typed freely in a plain browser).
// `resolveFontFamily` turns a stored value into a CSS `font-family` string.
// ---------------------------------------------------------------------------

// The generic families, offered as dropdown entries in every environment.
// Values are the CSS generic keywords so they're valid font-family values on
// their own and map to a curated stack via GENERIC_STACKS.
export const FONT_GENERICS: { value: string; label: string }[] = [
  { value: "sans-serif", label: "Sans-serif" },
  { value: "serif", label: "Serif" },
  { value: "monospace", label: "Monospace" },
];

const GENERIC_STACKS: Record<string, string> = {
  "sans-serif":
    'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  monospace: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
};

export function resolveFontFamily(value: string): string {
  const generic = GENERIC_STACKS[value];
  if (generic) return generic;
  const family = value.trim();
  // Empty (the field was cleared) renders the default sans-serif stack.
  if (!family) return GENERIC_STACKS["sans-serif"]!;
  // A specific family name, so quote it (names may contain spaces) and keep a
  // generic fallback in case the font is not actually installed.
  return `"${family}", ui-sans-serif, system-ui, sans-serif`;
}

const AGENT_FONT_KEY = "isolade.font.agent";
const USER_FONT_KEY = "isolade.font.user";
// Legacy boolean that toggled the agent font between serif (false) and
// sans-serif (true). Read once to seed the agent font for existing users.
const LEGACY_SANS_SERIF_KEY = "isolade.sansSerif";

function stringSetting(key: string, read: () => string) {
  return createLocalSetting<string>({
    read,
    persist: (v) => {
      try {
        window.localStorage.setItem(key, v);
      } catch {}
    },
  });
}

const agentFontSetting = stringSetting(AGENT_FONT_KEY, () => {
  try {
    const v = window.localStorage.getItem(AGENT_FONT_KEY);
    if (v) return v;
    if (window.localStorage.getItem(LEGACY_SANS_SERIF_KEY) === "true") {
      return "sans-serif";
    }
  } catch {}
  return "serif";
});

const userFontSetting = stringSetting(USER_FONT_KEY, () => {
  try {
    const v = window.localStorage.getItem(USER_FONT_KEY);
    if (v) return v;
  } catch {}
  return "sans-serif";
});

export const setAgentFontSetting = agentFontSetting.set;
export const useAgentFontSetting = agentFontSetting.use;
export const setUserFontSetting = userFontSetting.set;
export const useUserFontSetting = userFontSetting.use;

// ---------------------------------------------------------------------------
// Theme
//
// A theme is plain data: a `mode` (which decides whether the `.dark` class,
// and therefore Tailwind's `dark:` variants, is active) plus a set of CSS
// custom-property overrides. `applyTheme` writes those overrides as inline
// styles on <html>, so the registry is the single source of truth for colors.
//
// Built-in Light/Dark ship an empty `tokens` map and lean on the static
// `:root` / `.dark` definitions in index.css. The Extra themes layer
// max-contrast overrides on top of their base mode. Custom themes would slot
// into this same registry and require no changes to the apply/persist/select
// code below.
// ---------------------------------------------------------------------------

export type ThemeMode = "light" | "dark";

// The full set of themeable CSS custom properties (without the `--` prefix is
// not used, and keys are the real var names so they can be set/removed directly).
const THEME_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--ring",
  "--link",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

export interface Theme {
  /** Stable identifier persisted to localStorage. */
  id: string;
  /** Human-readable name shown in the picker. */
  label: string;
  /** Short blurb shown under the name in the picker. */
  description?: string;
  /** Drives the `.dark` class + `color-scheme`. Tailwind `dark:` variants
      apply iff this is "dark". */
  mode: ThemeMode;
  /** Background used for instant first-paint (FOUC prevention) and the picker
      swatch. */
  background: string;
  /** Foreground used for the picker swatch. */
  foreground: string;
  /** Border/accent used for the picker swatch. */
  accent: string;
  /** CSS custom-property overrides layered on top of the mode's base palette
      (the `:root` / `.dark` definitions in index.css). Empty for Light/Dark. */
  tokens: Partial<Record<ThemeToken, string>>;
}

const THEME_KEY = "isolade.theme";
// Minimal hint the inline boot script in index.html reads to avoid a flash
// before this module loads. Kept in sync by `setThemeSetting` / `initTheme`.
const THEME_BOOT_KEY = "isolade.themeBoot";
const DEFAULT_THEME_ID = "dark";

const BUILTIN_THEMES: Theme[] = [
  {
    id: "light",
    label: "Light",
    description: "Soft, low-glare light.",
    mode: "light",
    background: "#f6f8fa",
    foreground: "#1f2328",
    accent: "#d0d7de",
    tokens: {},
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    description: "Schoonover's warm cream palette.",
    mode: "light",
    background: "#fdf6e3",
    foreground: "#586e75",
    accent: "#ddd6c1",
    // Solarized "light" (base3 canvas, base2 panels) with the signature blue
    // accent. base01 text on base3/base2 surfaces, red for destructive.
    tokens: {
      "--background": "#fdf6e3", // base3
      "--foreground": "#586e75", // base01
      "--card": "#eee8d5", // base2
      "--card-foreground": "#586e75",
      "--popover": "#eee8d5",
      "--popover-foreground": "#586e75",
      "--primary": "#268bd2", // blue
      "--primary-foreground": "#fdf6e3",
      "--secondary": "#eee8d5",
      "--secondary-foreground": "#586e75",
      "--muted": "#eee8d5",
      "--muted-foreground": "#657b83", // base00
      "--accent": "#e3dcc6",
      "--accent-foreground": "#586e75",
      "--destructive": "#dc322f", // red
      "--destructive-foreground": "#fdf6e3",
      "--border": "#ddd6c1",
      "--input": "#ddd6c1",
      "--ring": "#268bd2",
      "--link": "#268bd2",
      "--chart-1": "#268bd2",
      "--chart-2": "#2aa198",
      "--chart-3": "#859900",
      "--chart-4": "#b58900",
      "--chart-5": "#d33682",
    },
  },
  {
    id: "dark",
    label: "Dark",
    description: "GitHub Dark.",
    mode: "dark",
    background: "#0d1117",
    foreground: "#e6edf3",
    accent: "#30363d",
    tokens: {},
  },
  {
    id: "extra-dark",
    label: "Extra Dark",
    description: "Pure white on black for maximum contrast.",
    mode: "dark",
    background: "#000000",
    foreground: "#ffffff",
    accent: "#ffffff",
    // Forces a pure-black background and pure-white text on top of the
    // (dark-gray) dark base. Borders, inputs and the focus ring are left
    // unset so they inherit the standard dark theme's separators.
    tokens: {
      "--background": "oklch(0 0 0)",
      "--foreground": "oklch(1 0 0)",
      "--card": "oklch(0 0 0)",
      "--card-foreground": "oklch(1 0 0)",
      "--popover": "oklch(0 0 0)",
      "--popover-foreground": "oklch(1 0 0)",
      "--primary": "oklch(1 0 0)",
      "--primary-foreground": "oklch(0 0 0)",
      "--secondary-foreground": "oklch(1 0 0)",
      "--muted-foreground": "oklch(0.85 0 0)",
      "--accent-foreground": "oklch(1 0 0)",
      "--destructive-foreground": "oklch(1 0 0)",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    description: "Vivid purple & pink on slate.",
    mode: "dark",
    background: "#282a36",
    foreground: "#f8f8f2",
    accent: "#44475a",
    // Official Dracula palette: #282a36 base, #44475a "current line" used for
    // surfaces/borders, purple as the primary accent.
    tokens: {
      "--background": "#282a36",
      "--foreground": "#f8f8f2",
      "--card": "#343746",
      "--card-foreground": "#f8f8f2",
      "--popover": "#343746",
      "--popover-foreground": "#f8f8f2",
      "--primary": "#bd93f9", // purple
      "--primary-foreground": "#282a36",
      "--secondary": "#44475a",
      "--secondary-foreground": "#f8f8f2",
      "--muted": "#44475a",
      "--muted-foreground": "#8b95c9", // lightened comment for legibility
      "--accent": "#44475a",
      "--accent-foreground": "#f8f8f2",
      "--destructive": "#ff5555", // red
      "--destructive-foreground": "#f8f8f2",
      "--border": "#44475a",
      "--input": "#44475a",
      "--ring": "#bd93f9",
      "--link": "#8be9fd", // cyan
      "--chart-1": "#bd93f9",
      "--chart-2": "#ff79c6",
      "--chart-3": "#8be9fd",
      "--chart-4": "#50fa7b",
      "--chart-5": "#ffb86c",
    },
  },
  {
    id: "nord",
    label: "Nord",
    description: "Cool arctic blue-gray.",
    mode: "dark",
    background: "#2e3440",
    foreground: "#e5e9f0",
    accent: "#434c5e",
    // Nord: Polar Night surfaces (nord0–nord3) with a Frost accent (nord8).
    tokens: {
      "--background": "#2e3440", // nord0
      "--foreground": "#eceff4", // nord6
      "--card": "#3b4252", // nord1
      "--card-foreground": "#eceff4",
      "--popover": "#3b4252",
      "--popover-foreground": "#eceff4",
      "--primary": "#88c0d0", // nord8 frost
      "--primary-foreground": "#2e3440",
      "--secondary": "#3b4252",
      "--secondary-foreground": "#e5e9f0",
      "--muted": "#3b4252",
      "--muted-foreground": "#9aa3b6", // lightened nord3 for legibility
      "--accent": "#434c5e", // nord2
      "--accent-foreground": "#eceff4",
      "--destructive": "#bf616a", // nord11 red
      "--destructive-foreground": "#eceff4",
      "--border": "#434c5e",
      "--input": "#434c5e",
      "--ring": "#88c0d0",
      "--link": "#88c0d0",
      "--chart-1": "#88c0d0",
      "--chart-2": "#81a1c1",
      "--chart-3": "#a3be8c",
      "--chart-4": "#ebcb8b",
      "--chart-5": "#b48ead",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    description: "Deep teal-blue, low glare.",
    mode: "dark",
    background: "#002b36",
    foreground: "#93a1a1",
    accent: "#0a4856",
    // Solarized "dark" (base03 canvas, base02 panels) with the signature blue
    // accent. base1 text, red for destructive.
    tokens: {
      "--background": "#002b36", // base03
      "--foreground": "#93a1a1", // base1
      "--card": "#073642", // base02
      "--card-foreground": "#93a1a1",
      "--popover": "#073642",
      "--popover-foreground": "#93a1a1",
      "--primary": "#268bd2", // blue
      "--primary-foreground": "#fdf6e3",
      "--secondary": "#073642",
      "--secondary-foreground": "#93a1a1",
      "--muted": "#073642",
      "--muted-foreground": "#657b83", // base00
      "--accent": "#0a4856",
      "--accent-foreground": "#93a1a1",
      "--destructive": "#dc322f", // red
      "--destructive-foreground": "#fdf6e3",
      "--border": "#0a4856",
      "--input": "#0a4856",
      "--ring": "#268bd2",
      "--link": "#268bd2",
      "--chart-1": "#268bd2",
      "--chart-2": "#2aa198",
      "--chart-3": "#859900",
      "--chart-4": "#b58900",
      "--chart-5": "#d33682",
    },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    description: "Deep navy with neon blue & purple.",
    mode: "dark",
    background: "#1a1b26",
    foreground: "#c0caf5",
    accent: "#292e42",
    // Tokyo Night (enkia): #1a1b26 canvas, #1f2335 panels, #292e42 line
    // highlight, #3b4261 borders, blue/purple accents.
    tokens: {
      "--background": "#1a1b26",
      "--foreground": "#c0caf5",
      "--card": "#1f2335",
      "--card-foreground": "#c0caf5",
      "--popover": "#1f2335",
      "--popover-foreground": "#c0caf5",
      "--primary": "#7aa2f7", // blue
      "--primary-foreground": "#1a1b26",
      "--secondary": "#292e42",
      "--secondary-foreground": "#c0caf5",
      "--muted": "#292e42",
      "--muted-foreground": "#7f8bb0", // brightened comment for legibility
      "--accent": "#292e42",
      "--accent-foreground": "#c0caf5",
      "--destructive": "#f7768e", // red
      "--destructive-foreground": "#1a1b26",
      "--border": "#3b4261",
      "--input": "#3b4261",
      "--ring": "#7aa2f7",
      "--link": "#7dcfff", // cyan
      "--chart-1": "#7aa2f7",
      "--chart-2": "#bb9af7",
      "--chart-3": "#7dcfff",
      "--chart-4": "#9ece6a",
      "--chart-5": "#e0af68",
    },
  },
];

const themeRegistry: Theme[] = [...BUILTIN_THEMES];

/** All known themes, in display order. */
export function listThemes(): Theme[] {
  return themeRegistry;
}

function getTheme(id: string): Theme | undefined {
  return themeRegistry.find((t) => t.id === id);
}

function resolveTheme(id: string): Theme {
  return getTheme(id) ?? getTheme(DEFAULT_THEME_ID) ?? BUILTIN_THEMES[1]!;
}

/** Write a theme's mode/background/tokens onto <html>. Token overrides are set
    as inline styles; any previously-set overrides are cleared so switching
    back to a base theme reveals the static :root/.dark values again. */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme.mode === "dark");
  root.style.colorScheme = theme.mode;
  root.style.backgroundColor = theme.background;
  for (const name of THEME_TOKENS) {
    const value = theme.tokens[name];
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
}

const themeSetting = stringSetting(THEME_KEY, () => {
  try {
    return window.localStorage.getItem(THEME_KEY) ?? DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
});

function persistBootHint(theme: Theme) {
  try {
    window.localStorage.setItem(
      THEME_BOOT_KEY,
      JSON.stringify({ mode: theme.mode, background: theme.background }),
    );
  } catch {}
}

/** Apply the persisted theme on startup. Call once before the app renders. */
export function initTheme() {
  const theme = resolveTheme(themeSetting.read());
  applyTheme(theme);
  persistBootHint(theme);
}

export function setThemeSetting(id: string) {
  const theme = resolveTheme(id);
  persistBootHint(theme);
  applyTheme(theme);
  themeSetting.set(theme.id);
}

// Appearance is owned by the active profile and persisted server-side. The
// localStorage values here are a cache that drives the pre-render FOUC hint and
// the first paint. These two helpers bridge that cache to the server: the app
// reads the active profile's appearance on boot and on (post-reload) profile
// switch and applies it, and pushes local values up the first time a profile
// has none (one-time migration off localStorage).

/** The appearance currently reflected in the localStorage cache. */
export function getLocalAppearance(): {
  theme: string;
  fontAgent: string;
  fontUser: string;
  debug: boolean;
} {
  return {
    theme: themeSetting.read(),
    fontAgent: agentFontSetting.read(),
    fontUser: userFontSetting.read(),
    debug: debugSetting.read(),
  };
}

/** Apply a server-sourced appearance, syncing the localStorage cache + FOUC
 * hint and notifying React subscribers. Missing fields are left untouched. */
export function applyAppearance(appearance: {
  theme?: string;
  fontAgent?: string;
  fontUser?: string;
  debug?: boolean;
}) {
  if (appearance.theme) setThemeSetting(appearance.theme);
  if (appearance.fontAgent) setAgentFontSetting(appearance.fontAgent);
  if (appearance.fontUser) setUserFontSetting(appearance.fontUser);
  if (appearance.debug !== undefined) setDebugSetting(appearance.debug);
}

/** The active theme id. */
export const useThemeSetting = themeSetting.use;
