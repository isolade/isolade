import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CHAT_PROVIDER_LABELS, composerAuthState, useAgentAuth } from "@/lib/agent-auth";
import type { ChatModelDefinition } from "@/lib/contracts";

/**
 * The composer's answer to "why can't I send this?" when the answer is a missing
 * login.
 *
 * A send that can't reach a provider used to fail deep inside the VM, minutes of
 * confusion later, with the agent CLI's own error. The composer knows before the
 * click, so it says so where the click would have happened and offers the one
 * action that fixes it.
 *
 * The two cases are treated differently, because one has a fix inside the
 * composer and the other has nothing there at all:
 *
 *   - Nothing signed in: there is no model to run, so the composer is turned off
 *     and covered by the message. Nothing under the cover would do anything.
 *   - This chat's provider signed out while the other one is available: only the
 *     model is unusable, so only the model says so. The picker flags it (see
 *     ModelEffortPicker) and holds both fixes — the other provider's models, and
 *     a row that opens the login — while the composer keeps its exact shape and
 *     the held-back send carries the reason as its tooltip. Nothing here grows a
 *     row: a chat whose composer jumped a line taller would push the transcript
 *     up over a state the picker can state on its own.
 *
 * Returns what MessageBox needs for whichever case applies.
 */
export function useComposerAuth(model: ChatModelDefinition | null | undefined): {
  /** Nothing signed in: the whole composer is off, behind `cover`. */
  disabled: boolean;
  /** The chosen model can't run, but the composer itself can still fix that. */
  sendDisabled: boolean;
  sendDisabledReason: string | undefined;
  cover: ReactNode;
} {
  const { available, openSignIn } = useAgentAuth();
  const state = composerAuthState(available, model);
  if (state.kind === "no-provider") {
    return {
      disabled: true,
      sendDisabled: false,
      sendDisabledReason: undefined,
      // Short enough to survive a narrow docked pane: the message names the
      // state, the button the way out, and Settings → Providers names the two
      // logins on offer.
      cover: (
        <>
          <span className="text-sm text-foreground">No providers configured.</span>
          <Button size="sm" onClick={openSignIn}>
            Sign in
          </Button>
        </>
      ),
    };
  }
  if (state.kind === "signed-out") {
    // The catalog has exactly two providers, so a signed-out one while something
    // is available means the other one is the way out — worth naming, because
    // the picker this sentence points at offers it.
    const other = state.provider === "anthropic" ? "openai" : "anthropic";
    return {
      disabled: false,
      sendDisabled: true,
      sendDisabledReason: `Not signed in to ${CHAT_PROVIDER_LABELS[state.provider]}. Pick a ${CHAT_PROVIDER_LABELS[other]} model, or sign in.`,
      cover: null,
    };
  }
  return { disabled: false, sendDisabled: false, sendDisabledReason: undefined, cover: null };
}
