import {
  BarChart3,
  Boxes,
  Bug,
  FileCode,
  GitBranch,
  Hammer,
  Info,
  KeyRound,
  Layers,
  MessageSquareText,
  Network,
  Palette,
  Play,
  Plug,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import { useId } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SIDEBAR_TABS_TRIGGER_CLASS, useResizableSidebarWidth } from "@/lib/sidebar";
import { cn } from "@/lib/utils";
import { setProfileAppearance } from "../lib/api";
import type { ChatModelDefinition } from "../lib/contracts";
import {
  FONT_GENERICS,
  listThemes,
  resolveFontFamily,
  setAgentFontSetting,
  setDebugSetting,
  setThemeSetting,
  setUserFontSetting,
  useAgentFontSetting,
  useDebugSetting,
  useThemeSetting,
  useUserFontSetting,
} from "../lib/settings";
import { useSystemFonts } from "../lib/system-fonts";
import AboutTab from "./AboutTab";
import BuildTab from "./BuildTab";
import ConfigurationTab from "./ConfigurationTab";
import DockerfileTab from "./DockerfileTab";
import GitTab from "./GitTab";
import ModelsTab from "./ModelsTab";
import NetworkTab from "./NetworkTab";
import ProfilesTab from "./ProfilesTab";
import PromptTab from "./PromptTab";
import ProvidersTab from "./ProvidersTab";
import ResourcesTab from "./ResourcesTab";
import RuntimeTab from "./RuntimeTab";
import SecretsTab from "./SecretsTab";
import SidebarResizeHandle from "./SidebarResizeHandle";
import UsageTab from "./UsageTab";

// Each section is a real route under /settings/<section>, so the sidebar
// entries are deep-linkable and survive reload / back-forward. Ordered as they
// render in the sidebar — alphabetically, except the three environment sections
// (configuration → dockerfile → build) stay grouped in build-workflow order.
const SETTINGS_SECTIONS = [
  "about",
  "configuration",
  "dockerfile",
  "build",
  "debugging",
  "git",
  "models",
  "network",
  "profiles",
  "prompt",
  "providers",
  "resources",
  "runtime",
  "secrets",
  "theme",
  "usage",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SETTINGS_SECTION: SettingsSection = "about";

export function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

interface SettingsPaneProps {
  isTauri: boolean;
  section: SettingsSection;
  // The active profile every section configures. Theme/Providers/Git/
  // Network all act on it (the server resolves them per active profile). The
  // Profiles section switches it. Null only briefly while it loads.
  activeProfileId: string | null;
  // The full model catalog, shared with the pickers so the Models section and
  // the pickers agree on what exists. Overrides are fetched/saved per active
  // profile inside ModelsTab; the pickers re-sync when settings closes.
  chatModels: ChatModelDefinition[];
  onSectionChange: (section: SettingsSection) => void;
  // Shared with the instances sidebar: the title-bar toggle collapses whichever
  // sidebar occupies the slot, so the section nav hides when collapsed too.
  sidebarCollapsed: boolean;
  // The settings surface reaches the top of the window. These blank drag rows
  // keep its content below the floating traffic lights and controls while the
  // sidebar background continues behind them.
  topInset?: number;
  topDrag?: {
    onMouseDown: (e: React.MouseEvent) => void;
    onDoubleClick: (e: React.MouseEvent) => void;
  };
}

// Picks a typeface for one text role. Three generic defaults are always
// offered as a segmented control. A specific installed family can be chosen
// from a dropdown (Tauri, where the native command enumerates fonts) or typed
// freely (plain browser, which can't enumerate local fonts). A live preview
// renders the current selection.
function FontSelect({
  label,
  description,
  value,
  onChange,
  isTauri,
  fonts,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  isTauri: boolean;
  fonts: string[];
}) {
  const listId = useId();
  const isGeneric = FONT_GENERICS.some((g) => g.value === value);
  // Tauri can enumerate installed fonts, so offer a real dropdown. A plain
  // browser can't, so we use a combobox: generic families in the dropdown plus
  // freeform entry for any installed family.
  const useDropdown = isTauri && fonts.length > 0;

  return (
    <div className="space-y-2 max-w-md">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>

      {useDropdown ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="w-full" style={{ fontFamily: resolveFontFamily(value) }}>
            <SelectValue placeholder="Choose a font…" />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {FONT_GENERICS.map((generic) => (
              <SelectItem
                key={generic.value}
                value={generic.value}
                style={{ fontFamily: resolveFontFamily(generic.value) }}
              >
                {generic.label}
              </SelectItem>
            ))}
            <SelectSeparator />
            {/* Keep a stored-but-uninstalled font selectable (Radix Select
                rejects an empty-string item value, so guard against it). */}
            {value !== "" && !isGeneric && !fonts.includes(value) && (
              <SelectItem value={value} style={{ fontFamily: resolveFontFamily(value) }}>
                {value}
              </SelectItem>
            )}
            {fonts.map((font) => (
              <SelectItem key={font} value={font} style={{ fontFamily: resolveFontFamily(font) }}>
                {font}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <>
          <Input
            list={listId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Pick or type a font, e.g. Georgia, Menlo…"
            className="w-full"
            style={{ fontFamily: resolveFontFamily(value) }}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <datalist id={listId}>
            {FONT_GENERICS.map((generic) => (
              <option key={generic.value} value={generic.value}>
                {generic.label}
              </option>
            ))}
          </datalist>
        </>
      )}

      <div
        className="rounded-md border border-border bg-card px-3 py-2 text-base text-card-foreground"
        style={{ fontFamily: resolveFontFamily(value) }}
      >
        The quick brown fox jumps over the lazy dog
      </div>
    </div>
  );
}

export default function SettingsPane({
  isTauri,
  section,
  activeProfileId,
  chatModels,
  onSectionChange,
  sidebarCollapsed,
  topInset = 0,
  topDrag,
}: SettingsPaneProps) {
  const debug = useDebugSetting();
  const agentFont = useAgentFontSetting();
  const userFont = useUserFontSetting();
  const systemFonts = useSystemFonts(isTauri);
  const themeId = useThemeSetting();
  const themes = listThemes();

  // Appearance is owned by the active profile. Each change applies instantly
  // (local cache + live re-skin via the setters) and is persisted to the
  // active profile server-side so it survives reloads and follows the identity.
  const persistAppearance = (patch: {
    theme?: string;
    fontAgent?: string;
    fontUser?: string;
    debug?: boolean;
  }) => {
    if (!activeProfileId) return;
    void setProfileAppearance(activeProfileId, {
      theme: themeId,
      fontAgent: agentFont,
      fontUser: userFont,
      debug,
      ...patch,
    }).catch(() => {});
  };
  const chooseTheme = (id: string) => {
    setThemeSetting(id);
    persistAppearance({ theme: id });
  };
  const chooseAgentFont = (v: string) => {
    setAgentFontSetting(v);
    persistAppearance({ fontAgent: v });
  };
  const chooseUserFont = (v: string) => {
    setUserFontSetting(v);
    persistAppearance({ fontUser: v });
  };
  // Same width (and drag-to-resize) as the instances sidebar. The section nav
  // shares the instances sidebar's collapse state, so the title-bar toggle hides
  // it here too. The workspace behind keeps the same collapsed state, so Back
  // returns to a matching layout.
  const { width, beginResize } = useResizableSidebarWidth();

  // Only the edge beside the section nav needs a divider. Edges that coincide
  // with the window stay flush and unframed, matching the panel workspace.
  const contentFrame = cn(
    "flex-1 min-w-0 min-h-0 flex flex-col bg-background overflow-hidden",
    !sidebarCollapsed && "border-l border-border",
  );

  return (
    <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-muted/30">
      <Tabs
        orientation="vertical"
        value={section}
        onValueChange={(value) => onSectionChange(value as SettingsSection)}
        className="flex-1 min-h-0 gap-0"
      >
        {/* The section nav is chrome: transparent so the muted body field shows
            through, matching the instances sidebar. It extends behind the
            floating window controls, then starts its rows below them. */}
        {!sidebarCollapsed && (
          <aside className="relative flex-shrink-0 flex flex-col" style={{ width }}>
            {topInset > 0 && (
              // eslint-disable-next-line jsx-a11y/no-static-element-interactions
              <div
                className="flex-shrink-0 select-none"
                style={{ height: topInset }}
                {...topDrag}
              />
            )}
            {/* pt-px matches the instances sidebar's New-chat row so the first
              nav row sits just below the title bar at the same y; pl-[7px] pr-2
              matches the chat-list insets so the rows align pixel-for-pixel. */}
            <TabsList variant="sidebar" className="pl-[7px] pr-2 pt-px pb-2">
              <TabsTrigger value="about" className={SIDEBAR_TABS_TRIGGER_CLASS}>
                <Info />
                About
              </TabsTrigger>
              <TabsTrigger value="configuration" className={SIDEBAR_TABS_TRIGGER_CLASS}>
                <SlidersHorizontal />
                Configuration
              </TabsTrigger>
              <TabsTrigger value="dockerfile" className={SIDEBAR_TABS_TRIGGER_CLASS}>
                <FileCode />
                Dockerfile
              </TabsTrigger>
              <TabsTrigger value="build" className={SIDEBAR_TABS_TRIGGER_CLASS}>
                <Hammer />
                Build
              </TabsTrigger>
              <TabsTrigger value="debugging" className={SIDEBAR_TABS_TRIGGER_CLASS}>
                <Bug />
                Debugging
              </TabsTrigger>
              <TabsTrigger value="git" className={SIDEBAR_TABS_TRIGGER_CLASS}>
                <GitBranch />
                Git
              </TabsTrigger>
              <TabsTrigger value="models" className={SIDEBAR_TABS_TRIGGER_CLASS}>
                <Layers />
                Models
              </TabsTrigger>
              <TabsTrigger
                value="network"
                className={SIDEBAR_TABS_TRIGGER_CLASS}
                data-demo="settings-network"
              >
                <Network />
                Network
              </TabsTrigger>
              <TabsTrigger value="profiles" className={SIDEBAR_TABS_TRIGGER_CLASS}>
                <Users />
                Profiles
              </TabsTrigger>
              <TabsTrigger value="prompt" className={SIDEBAR_TABS_TRIGGER_CLASS}>
                <MessageSquareText />
                Prompt
              </TabsTrigger>
              <TabsTrigger value="providers" className={SIDEBAR_TABS_TRIGGER_CLASS}>
                <Plug />
                Providers
              </TabsTrigger>
              <TabsTrigger value="resources" className={SIDEBAR_TABS_TRIGGER_CLASS}>
                <Boxes />
                Resources
              </TabsTrigger>
              <TabsTrigger value="runtime" className={SIDEBAR_TABS_TRIGGER_CLASS}>
                <Play />
                Runtime
              </TabsTrigger>
              <TabsTrigger
                value="secrets"
                className={SIDEBAR_TABS_TRIGGER_CLASS}
                data-demo="settings-secrets"
              >
                <KeyRound />
                Secrets
              </TabsTrigger>
              <TabsTrigger
                value="theme"
                className={SIDEBAR_TABS_TRIGGER_CLASS}
                data-demo="settings-theme"
              >
                <Palette />
                Theme
              </TabsTrigger>
              <TabsTrigger value="usage" className={SIDEBAR_TABS_TRIGGER_CLASS}>
                <BarChart3 />
                Usage
              </TabsTrigger>
            </TabsList>
            <SidebarResizeHandle onMouseDown={beginResize} />
          </aside>
        )}
        {/* The settings content is the inset card (see contentFrame above):
            bordered only where it meets chrome, with the top-left corner rounded
            when the nav is alongside it. */}
        <div className={contentFrame}>
          {topInset > 0 && (
            // eslint-disable-next-line jsx-a11y/no-static-element-interactions
            <div className="flex-shrink-0 select-none" style={{ height: topInset }} {...topDrag} />
          )}
          <TabsContent value="about" className="flex-1 min-w-0 min-h-0">
            <AboutTab />
          </TabsContent>
          <TabsContent
            value="debugging"
            className="flex-1 min-w-0 min-h-0 overflow-y-auto p-6 space-y-4"
          >
            <label className="flex items-start gap-3 cursor-pointer select-none max-w-2xl">
              <input
                type="checkbox"
                checked={debug}
                onChange={(e) => {
                  setDebugSetting(e.target.checked);
                  persistAppearance({ debug: e.target.checked });
                }}
                className="accent-foreground mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm">Show debug events</span>
                <span className="text-xs text-muted-foreground">
                  Display thinking blocks and raw provider events in chat streams.
                </span>
              </span>
            </label>
          </TabsContent>
          <TabsContent value="git" className="flex-1 min-w-0 min-h-0 flex flex-col">
            <GitTab activeProfileId={activeProfileId} />
          </TabsContent>
          <TabsContent value="models" className="flex-1 min-w-0 min-h-0">
            <ModelsTab activeProfileId={activeProfileId} chatModels={chatModels} />
          </TabsContent>
          <TabsContent value="configuration" className="flex-1 min-w-0 min-h-0 flex flex-col">
            <ConfigurationTab activeProfileId={activeProfileId} />
          </TabsContent>
          <TabsContent value="dockerfile" className="flex-1 min-w-0 min-h-0">
            <DockerfileTab activeProfileId={activeProfileId} />
          </TabsContent>
          <TabsContent value="build" className="flex-1 min-w-0 min-h-0">
            <BuildTab activeProfileId={activeProfileId} />
          </TabsContent>
          <TabsContent value="network" className="flex-1 min-w-0 min-h-0 flex flex-col">
            <NetworkTab activeProfileId={activeProfileId} />
          </TabsContent>
          <TabsContent value="profiles" className="flex-1 min-w-0 min-h-0 flex flex-col">
            <ProfilesTab activeProfileId={activeProfileId} />
          </TabsContent>
          <TabsContent value="prompt" className="flex-1 min-w-0 min-h-0 flex flex-col">
            <PromptTab activeProfileId={activeProfileId} />
          </TabsContent>
          <TabsContent value="runtime" className="flex-1 min-w-0 min-h-0 flex flex-col">
            <RuntimeTab activeProfileId={activeProfileId} />
          </TabsContent>
          <TabsContent value="providers" className="flex-1 min-w-0 min-h-0 flex flex-col">
            <ProvidersTab activeProfileId={activeProfileId} />
          </TabsContent>
          <TabsContent value="resources" className="flex-1 min-w-0 min-h-0">
            <ResourcesTab />
          </TabsContent>
          <TabsContent value="secrets" className="flex-1 min-w-0 min-h-0 flex flex-col">
            <SecretsTab activeProfileId={activeProfileId} />
          </TabsContent>
          <TabsContent
            value="theme"
            className="flex-1 min-w-0 min-h-0 overflow-y-auto p-6 space-y-6"
          >
            <div className="space-y-3 max-w-2xl">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm">Theme</span>
                <span className="text-xs text-muted-foreground">Choose how Isolade looks.</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {themes.map((theme) => {
                  const selected = theme.id === themeId;
                  return (
                    <button
                      key={theme.id}
                      type="button"
                      data-demo={`theme-${theme.id}`}
                      aria-pressed={selected}
                      onClick={() => chooseTheme(theme.id)}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border p-3 text-left transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        selected
                          ? "border-primary ring-2 ring-ring/40"
                          : "border-border hover:bg-accent/40",
                      )}
                    >
                      <span
                        className="flex h-10 w-12 flex-shrink-0 flex-col justify-center gap-1 rounded-md border px-2"
                        style={{
                          background: theme.background,
                          borderColor: theme.accent,
                        }}
                      >
                        <span
                          className="h-1.5 w-7 rounded-full"
                          style={{ background: theme.foreground }}
                        />
                        <span
                          className="h-1.5 w-5 rounded-full"
                          style={{ background: theme.foreground, opacity: 0.5 }}
                        />
                      </span>
                      <span className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-sm font-medium">{theme.label}</span>
                        {theme.description && (
                          <span className="text-xs text-muted-foreground">{theme.description}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <FontSelect
              label="Agent font"
              description="Typeface for assistant messages."
              value={agentFont}
              onChange={chooseAgentFont}
              isTauri={isTauri}
              fonts={systemFonts}
            />
            <FontSelect
              label="Message font"
              description="Typeface for your own messages."
              value={userFont}
              onChange={chooseUserFont}
              isTauri={isTauri}
              fonts={systemFonts}
            />
          </TabsContent>
          <TabsContent value="usage" className="flex-1 min-w-0 min-h-0">
            <UsageTab activeProfileId={activeProfileId} />
          </TabsContent>
        </div>
      </Tabs>
    </main>
  );
}
