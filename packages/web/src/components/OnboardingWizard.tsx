import {
  BASES,
  type BaseId,
  composeDockerfile,
  DEFAULT_BASE,
  repoNamesFor,
  TOOL_CATEGORIES,
  TOOLCHAINS,
} from "@isolade/shared";
import { AlertTriangle, Check, FolderGit2, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { setStoredProfileId } from "../lib/activeProfile";
import {
  checkRepoPath,
  createProfile,
  getOnboardingDemo,
  getProfile,
  rebuildProfile,
  setDockerfile,
  setProfileConfigForm,
  setRuntimeConfig,
} from "../lib/api";
import type { ProfileSummary } from "../lib/contracts";
import { BuildLogs } from "./BuildTab";
import { ProviderSignIn } from "./ProvidersTab";

// The guided setup a new install opens onto. It performs the prerequisites nobody
// can skip (sign in, repositories, a Dockerfile, a build) and stops at a built
// profile, handing over to the ordinary UI rather than creating an instance or
// typing into a chat for the user.
//
// Every mutation below is an existing API call, so what it produces is an
// ordinary profile and abandoning it halfway leaves nothing to clean up.

/** The steps a run has. The same ones every time, in the same order, whatever
 *  the install already has: a step that moves between runs is a step nobody can
 *  picture. */
type StepId = "signin" | "branch" | "build";

const STEP_TITLES: Record<StepId, string> = {
  signin: "Sign in to an agent",
  branch: "Choose what to work on",
  build: "Build the environment",
};

/** The steps, in this order, every run.
 *
 * Sign-in is last because it cannot be anywhere else: the in-app login runs the
 * provider's CLI inside a throwaway VM booted from a built profile image
 * (`app.ts`, `loginImage`), so there is nothing to sign in inside until a build
 * has happened. A build needs no credentials, so the dependency runs one way. */
export const STEPS: StepId[] = ["branch", "build", "signin"];

export interface OnboardingWizardProps {
  /** Fired on close, however it closes. The caller records the dismissal. */
  onClose: () => void;
  /** Fired once the profile exists, so the surrounding UI can re-read its list
   *  even if the user closes the card while the build is still running. */
  onProfileCreated?: (profile: ProfileSummary) => void;
}

export default function OnboardingWizard({ onClose, onProfileCreated }: OnboardingWizardProps) {
  const [step, setStep] = useState<StepId>("branch");
  // The profile this run made, which exists from the branch step onwards. The
  // wizard always creates one rather than adopting whatever is active: it is
  // guided profile creation, and a run that quietly reconfigured a profile you
  // were already using would be a surprising way to spend a click.
  const [created, setCreated] = useState<ProfileSummary | null>(null);

  // Landing the user in the profile they just built, since one they cannot see
  // is a confusing thing to be left holding. Switching is a stored id plus a
  // reload in this app, so it belongs at the end rather than mid-flow.
  const finish = useCallback(() => {
    if (created) {
      setStoredProfileId(created.id);
      onClose();
      window.location.reload();
      return;
    }
    onClose();
  }, [created, onClose]);

  const advance = () => {
    const next = STEPS[STEPS.indexOf(step) + 1];
    if (next) setStep(next);
    else finish();
  };

  return (
    <WizardCard steps={STEPS} current={step} onClose={finish}>
      {step === "branch" && (
        <BranchStep
          onCreated={(profile) => {
            setCreated(profile);
            onProfileCreated?.(profile);
            advance();
          }}
        />
      )}
      {step === "build" && created && (
        <BuildStep profileId={created.id} onDone={advance} onClose={finish} />
      )}
      {step === "signin" && created && <SignInStep profileId={created.id} onDone={advance} />}
    </WizardCard>
  );
}

/** The frame: one card, one question, and an indicator so the length of the
 *  thing is knowable from the first screen. Closeable at every step. */
function WizardCard({
  steps,
  current,
  onClose,
  children,
}: {
  steps: StepId[];
  current: StepId;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const index = Math.max(0, steps.indexOf(current));
  return (
    <div className="flex max-h-[80vh] w-full max-w-4xl flex-col rounded-xl border border-border bg-background shadow-lg">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-sm">{STEP_TITLES[current]}</span>
          <span className="text-muted-foreground text-xs tabular-nums">
            Step {index + 1} of {steps.length}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {steps.map((s, i) => (
            <span
              key={s}
              aria-hidden
              className={cn(
                "h-1.5 w-6 rounded-full",
                i <= index ? "bg-primary" : "bg-muted-foreground/25",
              )}
            />
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      <div className="flex justify-end border-t border-border px-5 py-3">
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground text-xs underline-offset-2 hover:underline"
        >
          Close
        </button>
      </div>
    </div>
  );
}

/** Step 3. A frame over the real sign-in, plus the one sentence that stops
 *  "sign in" reading as "create an account with Isolade". */
function SignInStep({ profileId, onDone }: { profileId: string; onDone: () => void }) {
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-xs">
        Isolade signs in to Claude or Codex the way a second device would, against the subscription
        you already pay for. There is no Isolade account, and the CLI logins on this machine are
        left alone.
      </p>
      <ProviderSignIn activeProfileId={profileId} onSignedIn={onDone} />
      <p className="text-muted-foreground text-xs">
        One is enough. Add the other whenever. Credentials belong to the profile being set up, so
        this is its own sign-in even if another profile already has one.
      </p>
    </div>
  );
}

/** Step 1, first screen: which way this run is going. The choice lives inside
 *  the step rather than being a step of its own, so a run is the same three
 *  steps whichever way it goes. */
export function ChooserStep({
  onCreated,
  onCustom,
}: {
  onCreated: (profile: ProfileSummary) => void;
  onCustom: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createDemo = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const demo = await getOnboardingDemo();
      const profile = await createProfile(demo.name);
      await setProfileConfigForm(profile.id, demo.form);
      await setDockerfile(profile.id, demo.dockerfile);
      await setRuntimeConfig(profile.id, demo.runtime);
      await rebuildProfile(profile.id);
      onCreated(profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [onCreated]);

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-xs">
        Two ways in. The demo is a real project, set up and ready to run, for seeing an agent work
        before setting anything up yourself.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <span className="flex items-center gap-1.5 font-medium text-sm">
            <Sparkles className="size-3.5" />
            The Excalidraw demo
          </span>
          <p className="flex-1 text-muted-foreground text-xs">
            Excalidraw, cloned and built for you, with its dev server ready to start. Nothing on
            your machine is touched, and the drawing app shows up in the preview once an agent runs
            it.
          </p>
          <Button
            size="sm"
            className="h-8 w-full text-xs"
            disabled={busy}
            onClick={() => void createDemo()}
          >
            {busy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}
            Use the demo
          </Button>
        </div>
        <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <span className="flex items-center gap-1.5 font-medium text-sm">
            <FolderGit2 className="size-3.5" />
            Your own code
          </span>
          <p className="flex-1 text-muted-foreground text-xs">
            Name the profile, point it at the repositories the work touches, and say what the image
            should carry. Isolade writes the Dockerfile from your answers.
          </p>
          <Button
            size="sm"
            variant="secondary"
            className="h-8 w-full text-xs"
            disabled={busy}
            onClick={() => onCustom()}
          >
            Set this up
          </Button>
        </div>
      </div>
      {error && (
        <p className="flex items-start gap-1.5 text-destructive text-xs">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

/** Step 1, second screen: the profile's name, its repositories, and what the
 *  image should carry. Nothing is inferred from the repositories: the user knows
 *  what their project needs, and a guess only ever decided the base image. */
export function CustomStep({
  onCreated,
  onBack,
}: {
  onCreated: (profile: ProfileSummary) => void;
  onBack: () => void;
}) {
  const [name, setName] = useState("");
  // One empty row to start, so the shape of the answer is visible before typing.
  const [sources, setSources] = useState<string[]>([""]);
  const [tools, setTools] = useState<string[]>([]);
  const [base, setBase] = useState<BaseId>(DEFAULT_BASE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filled = sources.map((s) => s.trim()).filter(Boolean);
  const names = repoNamesFor(filled);
  const dockerfile = composeDockerfile(names, tools, base);

  const setSource = (i: number, value: string) =>
    setSources((prev) => prev.map((s, j) => (j === i ? value : s)));

  const createOwn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // Check local paths before creating anything, so a typo is a sentence here
      // rather than a build failure several minutes from now.
      for (const source of filled) {
        const check = await checkRepoPath(source);
        if (!check.ok) throw new Error(check.problem ?? `${source} cannot be used.`);
      }

      // Created here rather than when the card opened, so a run someone closes
      // earlier leaves no empty profile behind. The name is the one they gave,
      // falling back to the first repository, then to something neutral for a
      // profile with no repositories at all.
      const profile = await createProfile(name.trim() || names[0] || "Workspace");
      await setProfileConfigForm(profile.id, {
        repos: filled.map((source, i) => ({ name: names[i] ?? `repo-${i + 1}`, source })),
        dockerfile: "./Dockerfile",
        skills: [],
      });
      await setDockerfile(profile.id, dockerfile);
      await rebuildProfile(profile.id);
      onCreated(profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [filled, names, dockerfile, name, onCreated]);

  return (
    <div className="grid grid-cols-[1fr_22rem] gap-5">
      <div className="min-w-0 space-y-5">
        <div className="space-y-2">
          <label htmlFor="onboarding-name" className="font-medium text-sm">
            Profile name
          </label>
          <input
            id="onboarding-name"
            value={name}
            spellCheck={false}
            placeholder={names[0] ?? "Workspace"}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-primary"
          />
        </div>

        <div className="space-y-2">
          <span className="font-medium text-sm">Your repositories</span>
          <p className="text-muted-foreground text-xs">
            A repository on github.com, or the path to a checkout on this machine. Add as many as
            the work touches, or none at all: an empty workspace is a valid profile, and an agent
            can clone into it. Your own working trees stay where they are.
          </p>
          <div className="space-y-1.5">
            {sources.map((source, i) => (
              // Rows are positional and can be empty, so the index is the identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: no stable id exists
              <div key={i} className="flex items-center gap-2">
                <input
                  value={source}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  placeholder="github.com/owner/repo"
                  onChange={(e) => setSource(i, e.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none focus:border-primary"
                />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  title="Remove"
                  onClick={() => setSources((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => setSources((prev) => [...prev, ""])}
          >
            <Plus className="mr-1 size-3.5" />
            {sources.length ? "Add another" : "Add a repository"}
          </Button>
        </div>

        <div className="space-y-2">
          <span className="font-medium text-sm">What should the image have?</span>
          <p className="text-muted-foreground text-xs">
            Git, gh, ripgrep, fd and Node are in every image already. Pick whatever else this
            project needs, and edit the Dockerfile afterwards for anything not listed.
          </p>
          <div className="flex gap-1.5">
            {BASES.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setBase(b.id)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs",
                  base === b.id ? "border-primary bg-primary/5 font-medium" : "border-border",
                )}
              >
                {b.label}
              </button>
            ))}
          </div>
          {/* By family rather than one long grid: someone here for a database
              can skip four headings instead of reading every checkbox. */}
          {TOOL_CATEGORIES.map((category) => (
            <div key={category.id} className="space-y-1.5 pt-1">
              <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
                {category.label}
              </span>
              <div className="grid grid-cols-2 gap-1.5">
                {TOOLCHAINS.filter((tool) => tool.category === category.id).map((tool) => {
                  const on = tools.includes(tool.id);
                  return (
                    <label
                      key={tool.id}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs",
                        on ? "border-primary bg-primary/5" : "border-border",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        className="mt-0.5"
                        onChange={() =>
                          setTools((prev) =>
                            prev.includes(tool.id)
                              ? prev.filter((x) => x !== tool.id)
                              : [...prev, tool.id],
                          )
                        }
                      />
                      <span className="flex flex-col gap-0.5">
                        <span className="font-medium">{tool.label}</span>
                        <span className="text-muted-foreground">{tool.blurb}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={busy}
            onClick={() => void createOwn()}
          >
            {busy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}
            Build this
          </Button>
          <button
            type="button"
            onClick={() => onBack()}
            className="text-muted-foreground text-xs underline-offset-2 hover:underline"
          >
            Back
          </button>
        </div>

        {error && (
          <p className="flex items-start gap-1.5 text-destructive text-xs">
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>

      {/* What the answers add up to, live, so the file is something the user has
          already read once by the time it is theirs to edit. */}
      <div className="flex min-w-0 flex-col gap-2">
        <span className="font-medium text-sm">Dockerfile</span>
        <pre className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
          {dockerfile}
        </pre>
        <p className="text-muted-foreground text-xs">
          Yours after this, under Settings, Dockerfile. It installs no project dependencies on
          purpose, so the first build cannot fail on them: the agent can do that in the VM and tell
          you what it needed.
        </p>
      </div>
    </div>
  );
}

/** Step 2. The build, which is slow the first time for reasons worth naming, so
 *  the wait reads as a wait rather than as a hang. Closing does not cancel it. */
export function BuildStep({
  profileId,
  onDone,
  onClose,
}: {
  profileId: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState<ProfileSummary | null>(null);
  // Bumped to reconnect the log stream after a retry, the same way the Build
  // section does it.
  const [runKey, setRunKey] = useState(0);
  const [retrying, setRetrying] = useState(false);

  const poll = useCallback(async () => {
    try {
      setProfile(await getProfile(profileId));
    } catch {
      // A poll that fails changes nothing. The next one may succeed.
    }
  }, [profileId]);

  useEffect(() => {
    const timer = setInterval(() => void poll(), 1500);
    void poll();
    return () => clearInterval(timer);
  }, [poll]);

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      await rebuildProfile(profileId);
      setRunKey((k) => k + 1);
      await poll();
    } finally {
      setRetrying(false);
    }
  }, [profileId, poll]);

  const status = profile?.status ?? "building";
  return (
    <div className="flex h-[26rem] flex-col gap-3">
      {status === "ready" ? (
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-sm">
            <Check className="size-4 text-emerald-500" />
            Built and ready.
          </p>
          <p className="text-muted-foreground text-xs">
            Signing in runs the provider's CLI inside a VM built from this image, which is why it
            comes last.
          </p>
        </div>
      ) : status === "error" ? (
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-sm">
            <AlertTriangle className="size-4 text-destructive" />
            The build failed.
          </p>
          <p className="text-muted-foreground text-xs">
            {profile?.errorMessage ??
              "The output below says why. Common causes are a base image that could not be pulled, or a package that does not exist on this base."}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-sm">
            <Loader2 className="size-4 animate-spin" />
            Building.
          </p>
          <p className="text-muted-foreground text-xs">
            The first build is the slow one. BuildKit boots in its own VM and the base image is
            pulled once, and later builds skip both. Minutes rather than seconds, and closing this
            card does not stop it.
          </p>
        </div>
      )}

      {/* The real build output, the same stream and the same viewer as the Build
          section. Watching it is the difference between a wait and a hang, and on
          a failure it is the only thing that says what went wrong. */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-muted/30">
        <BuildLogs
          profileId={profileId}
          building={status === "building"}
          runKey={runKey}
          onDone={() => void poll()}
        />
      </div>

      <div className="flex items-center gap-3">
        {status === "ready" && (
          <Button size="sm" className="h-8 text-xs" onClick={onDone}>
            Sign in
          </Button>
        )}
        {status === "error" && (
          <>
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={retrying}
              onClick={() => void retry()}
            >
              {retrying ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}
              Try again
            </Button>
            <span className="text-muted-foreground text-xs">
              Or close this and fix the Dockerfile under Settings, Dockerfile. Nothing is lost: the
              profile is there, and rebuilding picks up where this left off.
            </span>
          </>
        )}
        {status === "building" && (
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground text-xs underline-offset-2 hover:underline"
          >
            Leave this running
          </button>
        )}
      </div>
    </div>
  );
}

/** Step 1. The chooser, then the form if that is the way it went. */
export function BranchStep({ onCreated }: { onCreated: (profile: ProfileSummary) => void }) {
  const [own, setOwn] = useState(false);
  return own ? (
    <CustomStep onCreated={onCreated} onBack={() => setOwn(false)} />
  ) : (
    <ChooserStep onCreated={onCreated} onCustom={() => setOwn(true)} />
  );
}
