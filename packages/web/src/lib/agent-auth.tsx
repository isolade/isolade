import { createContext, type ReactNode, useContext, useMemo } from "react";
import {
  type AuthProvider,
  type AuthStatus,
  CHAT_PROVIDERS,
  type ChatModelDefinition,
  type ChatProvider,
} from "./contracts";

// A model can only run if the profile has signed in to the provider behind it,
// so the catalog alone doesn't say what the user can pick — the login state does.
// This module turns the auth status into that answer and hands it to the
// composers and pickers, which are far from where the status is fetched.
//
// The two vocabularies for the same pair of providers meet here: the catalog
// names them after the APIs (anthropic / openai), the auth store after the CLIs
// whose credentials it holds (claude / codex).
const AUTH_PROVIDER_FOR: Record<ChatProvider, AuthProvider> = {
  anthropic: "claude",
  openai: "codex",
};

/** How each provider is named on screen, matching the Providers settings page. */
export const CHAT_PROVIDER_LABELS: Record<ChatProvider, string> = {
  anthropic: "Claude",
  openai: "Codex",
};

/**
 * The providers a profile can run a chat on right now.
 *
 * `null` means "not known yet": the status hasn't loaded, the API is
 * unreachable, or no profile is resolved. Every consumer reads that as "assume
 * both work", so a signed-in user never sees a flash of models disappearing (or
 * a sign-in prompt) while the first request is in flight.
 */
export type AvailableProviders = ReadonlySet<ChatProvider> | null;

export function availableProvidersFromAuth(status: AuthStatus | null): AvailableProviders {
  if (!status) return null;
  const available = new Set<ChatProvider>();
  for (const provider of CHAT_PROVIDERS) {
    if (status[AUTH_PROVIDER_FOR[provider]]?.loggedIn) available.add(provider);
  }
  return available;
}

export function isProviderAvailable(
  provider: ChatProvider,
  available: AvailableProviders,
): boolean {
  return available === null || available.has(provider);
}

/**
 * The catalog minus every model whose provider isn't signed in, so the picker
 * only offers what a send could actually reach. `keepId` survives the filter:
 * a chat already on a model whose provider has since been signed out still
 * shows it (by name, and switchable) instead of the picker claiming the chat
 * runs on something else.
 */
export function availableModels(
  models: readonly ChatModelDefinition[],
  available: AvailableProviders,
  keepId?: string,
): ChatModelDefinition[] {
  if (available === null) return [...models];
  return models.filter((m) => m.id === keepId || available.has(m.provider));
}

/** Providers that are signed out but have models a sign-in would unlock. */
export function signedOutProviders(
  models: readonly ChatModelDefinition[],
  available: AvailableProviders,
): ChatProvider[] {
  if (available === null) return [];
  return CHAT_PROVIDERS.filter(
    (provider) => !available.has(provider) && models.some((m) => m.provider === provider),
  );
}

/**
 * Why a composer can't send yet, if it can't:
 *   - `no-provider`: nothing is signed in, so there is no model to run at all
 *   - `signed-out`: the chosen model's provider is signed out while the other
 *     one is available, so signing in and picking another model both fix it
 * Anything else is `ok`, including "not known yet".
 */
export type ComposerAuthState =
  | { kind: "ok" }
  | { kind: "no-provider" }
  | { kind: "signed-out"; provider: ChatProvider };

export function composerAuthState(
  available: AvailableProviders,
  model: ChatModelDefinition | null | undefined,
): ComposerAuthState {
  if (available === null) return { kind: "ok" };
  if (available.size === 0) return { kind: "no-provider" };
  if (model && !available.has(model.provider))
    return { kind: "signed-out", provider: model.provider };
  return { kind: "ok" };
}

interface AgentAuth {
  available: AvailableProviders;
  /** Opens Settings → Providers, where the login flows live. */
  openSignIn: () => void;
}

// Read through a context rather than threaded as props: the composers sit under
// three memoized layers (the retained pane, the panel workspace, the panel
// tree), and a login is exactly the kind of change that should re-render the
// pickers without walking every open transcript's panel tree.
//
// The default is deliberately the "not known yet" state with a no-op action, so
// anything rendered outside the provider (tests, the render harnesses) behaves
// as it did before this existed.
const Ctx = createContext<AgentAuth>({ available: null, openSignIn: () => {} });

export function AgentAuthProvider({
  available,
  openSignIn,
  children,
}: AgentAuth & { children: ReactNode }) {
  const value = useMemo(() => ({ available, openSignIn }), [available, openSignIn]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAgentAuth(): AgentAuth {
  return useContext(Ctx);
}
