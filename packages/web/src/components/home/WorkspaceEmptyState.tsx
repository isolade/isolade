import { AlertTriangle, Hammer, Loader2, Wand2, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProfileSummary } from "../../lib/contracts";

// What the workspace shows instead of a composer when a message typed into one
// could not go anywhere.
//
// Each of these replaces the new-chat pane, and each is a state the app can
// genuinely be in on a first run: no server yet, no profile yet, or a profile
// whose first build has not finished. The old behaviour for the last two was a
// composer that accepted a message and then answered "profile <id> has no built
// image yet", which names an internal precondition and offers nothing to do
// about it.

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-sm space-y-3 text-center">{children}</div>
    </div>
  );
}

/** No API. The whole window is inert without it, so say that rather than
 *  reporting whatever the failed request happened to be about. */
export function ServerOffline() {
  return (
    <Panel>
      <p className="flex items-center justify-center gap-1.5 font-medium text-sm">
        <WifiOff className="size-4 text-muted-foreground" />
        Waiting for the Isolade server
      </p>
      <p className="text-muted-foreground text-xs">
        The app runs a local server alongside the window, and this one is not answering yet. It is
        being retried, and the workspace appears as soon as it does.
      </p>
    </Panel>
  );
}

/** An install with no profile at all. The wizard is the way out, and on a fresh
 *  install it has already opened itself over this. */
export function NoProfile({ onOpenWizard }: { onOpenWizard: () => void }) {
  return (
    <Panel>
      <p className="font-medium text-sm">No environment yet</p>
      <p className="text-muted-foreground text-xs">
        Agents run in a VM built from a profile, and there are none. Guided setup takes the
        repositories you want to work on, asks what the image should carry, and builds it.
      </p>
      <Button size="sm" onClick={onOpenWizard}>
        <Wand2 className="size-3.5" />
        Guided setup
      </Button>
    </Panel>
  );
}

/** A profile that exists but has never produced an image: building, failed, or
 *  never started. All three are one screen because they are one situation —
 *  there is nothing to run a chat in yet — differing only in what to do next. */
export function ProfileUnbuilt({
  profile,
  building,
  onWatchBuild,
  onBuild,
}: {
  profile: ProfileSummary;
  /** True while a build this component started is being kicked off, so the
   *  button can't be pressed twice before the poll catches up. */
  building: boolean;
  onWatchBuild: () => void;
  onBuild: () => void;
}) {
  if (profile.status === "building") {
    return (
      <Panel>
        <p className="flex items-center justify-center gap-1.5 font-medium text-sm">
          <Loader2 className="size-4 animate-spin" />
          Building {profile.name}
        </p>
        <p className="text-muted-foreground text-xs">
          The first build of an install is the slow one: BuildKit boots in its own VM and the base
          image is pulled once. A chat can start the moment it finishes, and this screen goes with
          it.
        </p>
        <Button size="sm" variant="secondary" onClick={onWatchBuild}>
          Watch the build
        </Button>
      </Panel>
    );
  }

  if (profile.status === "error") {
    return (
      <Panel>
        <p className="flex items-center justify-center gap-1.5 font-medium text-sm">
          <AlertTriangle className="size-4 text-destructive" />
          {profile.name} has not been built
        </p>
        <p className="text-muted-foreground text-xs">
          Its last build failed, so there is no image to run a chat in. The build log says why, and
          the Dockerfile beside it is where the fix goes.
        </p>
        <Button size="sm" variant="secondary" onClick={onWatchBuild}>
          Open the build log
        </Button>
      </Panel>
    );
  }

  return (
    <Panel>
      <p className="font-medium text-sm">{profile.name} has not been built</p>
      <p className="text-muted-foreground text-xs">
        A chat runs in a VM built from this profile, and its image does not exist yet. Building it
        takes minutes the first time and is then cached.
      </p>
      <Button size="sm" disabled={building} onClick={onBuild}>
        {building ? <Loader2 className="size-3.5 animate-spin" /> : <Hammer className="size-3.5" />}
        Build it
      </Button>
    </Panel>
  );
}
