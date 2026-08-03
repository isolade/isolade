import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useComposerAuth } from "../src/components/ComposerAuthGate";
import { MessageBox } from "../src/components/MessageBox";
import { ModelEffortPicker } from "../src/components/ModelEffortPicker";
import {
  AgentAuthProvider,
  availableModels,
  availableProvidersFromAuth,
  composerAuthState,
  signedOutProviders,
} from "../src/lib/agent-auth";
import {
  type AuthStatus,
  CHAT_MODELS,
  type ChatModelDefinition,
  findChatModel,
} from "../src/lib/contracts";

const opus5 = findChatModel("claude-opus-5") as ChatModelDefinition;
const sol = findChatModel("gpt-5.6-sol") as ChatModelDefinition;

function status(claude: boolean, codex: boolean): AuthStatus {
  return {
    claude: { loggedIn: claude, expiresAt: null },
    codex: { loggedIn: codex, expiresAt: null },
  };
}

// A model can only run on a provider the profile has signed in to, so the login
// state — not the catalog — decides what the pickers offer.
describe("provider availability", () => {
  it("maps each login onto the models it can run", () => {
    const claudeOnly = availableProvidersFromAuth(status(true, false));
    expect([...(claudeOnly ?? [])]).toEqual(["anthropic"]);
    const codexOnly = availableProvidersFromAuth(status(false, true));
    expect([...(codexOnly ?? [])]).toEqual(["openai"]);
    expect(availableProvidersFromAuth(status(false, false))?.size).toBe(0);
  });

  // Until the status lands there is nothing to say, and saying "signed out"
  // would flash a sign-in prompt at a signed-in user on every load.
  it("treats an unknown status as everything working", () => {
    expect(availableProvidersFromAuth(null)).toBeNull();
    expect(availableModels(CHAT_MODELS, null)).toHaveLength(CHAT_MODELS.length);
    expect(signedOutProviders(CHAT_MODELS, null)).toEqual([]);
    expect(composerAuthState(null, sol)).toEqual({ kind: "ok" });
  });

  it("drops the signed-out provider's models from the catalog", () => {
    const available = availableProvidersFromAuth(status(true, false));
    const offered = availableModels(CHAT_MODELS, available);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((m) => m.provider === "anthropic")).toBe(true);
    expect(signedOutProviders(CHAT_MODELS, available)).toEqual(["openai"]);
  });

  // A chat already running on a since-signed-out model still has to name it, or
  // the picker would claim the chat runs on something it doesn't.
  it("keeps the chat's own model listed either way", () => {
    const available = availableProvidersFromAuth(status(true, false));
    const offered = availableModels(CHAT_MODELS, available, sol.id);
    expect(offered.some((m) => m.id === sol.id)).toBe(true);
    expect(offered.filter((m) => m.provider === "openai")).toHaveLength(1);
  });

  it("blocks a send with no login at all, and one aimed at a signed-out provider", () => {
    expect(composerAuthState(availableProvidersFromAuth(status(false, false)), opus5)).toEqual({
      kind: "no-provider",
    });
    expect(composerAuthState(availableProvidersFromAuth(status(true, false)), sol)).toEqual({
      kind: "signed-out",
      provider: "openai",
    });
    expect(composerAuthState(availableProvidersFromAuth(status(true, false)), opus5)).toEqual({
      kind: "ok",
    });
  });
});

function Composer({ model, auth }: { model: ChatModelDefinition; auth: AuthStatus | null }) {
  return (
    <AgentAuthProvider available={availableProvidersFromAuth(auth)} openSignIn={() => {}}>
      <Inner model={model} />
    </AgentAuthProvider>
  );
}

function Inner({ model }: { model: ChatModelDefinition }) {
  const auth = useComposerAuth(model);
  return (
    <MessageBox
      value="ship it"
      onChange={() => {}}
      onSubmit={() => {}}
      onAttachClick={() => {}}
      disabled={auth.disabled}
      sendDisabled={auth.sendDisabled}
      sendDisabledReason={auth.sendDisabledReason}
      cover={auth.cover}
      modelPicker={
        <ModelEffortPicker
          models={[...CHAT_MODELS]}
          overrides={{}}
          currentModelId={model.id}
          currentEffort={model.defaultEffort}
          onModelChange={() => {}}
          onEffortChange={() => {}}
          disabled={auth.disabled}
        />
      }
    />
  );
}

// The composer knows a missing login before the send does, so it says so where
// the click would have happened instead of letting the turn fail in the VM.
describe("composer sign-in gate", () => {
  it("says nothing while a provider is signed in", () => {
    const html = renderToStaticMarkup(<Composer model={opus5} auth={status(true, false)} />);
    expect(html).not.toContain("Sign in");
    expect(html).not.toContain('disabled=""');
  });

  // Nothing signed in: no model, so nothing in the composer can be used. The
  // message sits across it and everything under it is off — but still there, so
  // what is unavailable reads as the composer the user knows.
  it("overlays the composer and turns it off when nothing is signed in", () => {
    const html = renderToStaticMarkup(<Composer model={opus5} auth={status(false, false)} />);
    expect(html).toContain("No providers configured.");
    expect(html).toContain(">Sign in<");
    // The overlay comes first and centers itself in the cell it shares with the
    // composer, which stays in the document, visible, and inert.
    expect(html.indexOf("No providers configured.")).toBeLessThan(html.indexOf("<textarea"));
    const box = html.slice(0, html.indexOf("No providers configured."));
    expect(box).toContain("grid");
    const overlay = html.slice(
      html.lastIndexOf("<div", html.indexOf("No providers")),
      html.indexOf("No providers"),
    );
    expect(overlay).toContain("items-center");
    expect(overlay).toContain("justify-center");
    // Nothing is hidden: the scrim is what dims the composer.
    expect(html).not.toContain("invisible");
    expect(overlay).toContain("bg-background/75");
    for (const label of ['aria-label="Send"', 'aria-label="Attach files"']) {
      const button = html.lastIndexOf("<button", html.indexOf(label));
      expect(html.slice(button, html.indexOf(label))).toContain('disabled=""');
    }
    const textarea = html.slice(html.indexOf("<textarea"), html.indexOf("</textarea>"));
    expect(textarea).toContain('disabled=""');
  });

  // The other case is about the model, not the composer: the composer keeps its
  // exact shape (a chat whose composer grew a row would shove the transcript up
  // over it), the picker carries the flag and both fixes, and the held-back send
  // carries the sentence.
  it("flags the model instead of growing the composer when its provider is signed out", () => {
    const html = renderToStaticMarkup(<Composer model={sol} auth={status(true, false)} />);
    expect(html).not.toContain("No providers configured.");
    // No extra row: the composer's own children are what they always are.
    expect(html).not.toContain("grid");
    // The picker's trigger names the model, flagged amber, and says why on hover.
    const trigger = html.slice(0, html.indexOf("GPT-5.6 Sol"));
    expect(trigger).toContain("text-amber-500");
    expect(trigger).toContain('title="Not signed in to Codex. Pick another model, or sign in."');
    // The draft survives; only the send waits.
    const textarea = html.slice(html.indexOf("<textarea"), html.indexOf("</textarea>"));
    expect(textarea).not.toContain('disabled=""');
    const send = html.slice(
      html.lastIndexOf("<button", html.indexOf('aria-label="Send"')),
      html.indexOf('aria-label="Send"'),
    );
    expect(send).toContain('disabled=""');
    // The reason sits on the wrapper around it, not on the button: a disabled
    // button takes `pointer-events: none`, so a title on it could never be
    // hovered and the sentence would never be seen.
    const wrapper = html.slice(
      html.lastIndexOf("<span", html.indexOf('aria-label="Send"')),
      html.lastIndexOf("<button", html.indexOf('aria-label="Send"')),
    );
    expect(wrapper).toContain('title="Not signed in to Codex. Pick a Claude model, or sign in."');
    expect(send).not.toContain("title=");
  });

  // The signed-in model's picker says nothing of the sort.
  it("leaves an available model unflagged", () => {
    const html = renderToStaticMarkup(<Composer model={opus5} auth={status(true, false)} />);
    expect(html).not.toContain("text-amber-500");
    expect(html).not.toContain("Not signed in");
  });
});
