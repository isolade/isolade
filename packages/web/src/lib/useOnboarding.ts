import { useCallback, useEffect, useState } from "react";
import { listProfiles } from "./api";

// When the guided setup opens itself, and how it is reopened deliberately.
//
// This decides whether to show the card, and nothing about what it then does.
// Which profile the run targets, and whether that profile needs signing in, are
// the wizard's own business, because credentials are per profile and the answer
// for the active profile says nothing about the one being set up.
//
// It opens on its own exactly once, on an install with nothing to work with, and
// is otherwise always available from the Profiles section. Dismissal is
// remembered so it opens itself once and never nags. That is the only piece of
// state here: everything else is derived from what the install actually has, so
// there is no flag to go stale against reality.

const DISMISS_KEY = "isolade-onboarding-dismissed";

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    // No localStorage (a sandboxed webview), so treat it as not dismissed. An
    // extra appearance is a smaller failure than never appearing.
    return false;
  }
}

/**
 * Whether the card should put itself on screen. Pure, and the whole rule in one
 * place: no profile has a build definition yet, and the user has not said no.
 *
 * "Has a build definition" rather than "is built" on purpose. A profile whose
 * build failed or is still running is not an empty install, and its owner wants
 * the Build section rather than a setup flow over the top of it.
 *
 * Being signed in is deliberately not part of this. It was, and it was wrong:
 * credentials live under the data dir while profiles live under the config dir,
 * so an install can be signed in with nothing to work with, and signing in is
 * step one of doing this by hand, which made the flow hide from exactly the
 * person it is for.
 */
export function shouldSelfOpen(state: { hasUsableProfile: boolean; dismissed: boolean }): boolean {
  return !state.hasUsableProfile && !state.dismissed;
}

export interface Onboarding {
  /** Whether the card is on screen, for either reason. */
  open: boolean;
  /** True when it put itself there, which decides how it is presented: the
   *  window's contents on a fresh install, a modal over the workspace when it
   *  was asked for. */
  self: boolean;
  open_: () => void;
  close: () => void;
}

/**
 * `profilesVersion` is a counter the caller bumps when profiles change, so the
 * predicate re-evaluates after the wizard creates one without this hook having
 * to own or poll that list.
 */
export function useOnboarding(profilesVersion = 0): Onboarding {
  const [open, setOpen] = useState(false);
  const [self, setSelf] = useState(false);

  // Re-read what the install has. Cheap, and it runs on mount plus whenever the
  // caller says profiles changed.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const profiles = await listProfiles();
        const usable = profiles.some((p) => p.hasConfig);
        if (cancelled) return;

        if (shouldSelfOpen({ hasUsableProfile: usable, dismissed: dismissed() })) {
          setOpen(true);
          setSelf(true);
        }
      } catch {
        // The API being unavailable is not a reason to show a setup flow.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profilesVersion]);

  const close = useCallback(() => {
    setOpen(false);
    setSelf(false);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Nothing to remember it with, so it may appear again. Harmless.
    }
  }, []);

  const open_ = useCallback(() => {
    setOpen(true);
    setSelf(false);
  }, []);

  return { open, self, open_, close };
}
