import type { ChatEffort } from "./contracts";

// The model + effort the user last *deliberately* picked, remembered so a new
// chat reopens on the same model whether it's picked in the draft composer,
// selected in a fresh chat's composer, or started from a panel's "+".
// Centralized here so the call sites can't drift onto different storage keys.
// Automatic snapping (effort clamping, catalog-fallback model swaps) must NOT
// write these, only explicit picks.
const MODEL_STORAGE_KEY = "isolade.lastModelId";
const EFFORT_STORAGE_KEY = "isolade.lastEffort";

export function readLastModelId(): string | null {
  try {
    return window.localStorage.getItem(MODEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeLastModelId(id: string): void {
  try {
    window.localStorage.setItem(MODEL_STORAGE_KEY, id);
  } catch {}
}

export function readLastEffort(): ChatEffort | null {
  try {
    // Any non-empty string is a valid effort; callers clamp it to the chosen
    // model's supported set before use.
    return (window.localStorage.getItem(EFFORT_STORAGE_KEY) as ChatEffort | null) || null;
  } catch {}
  return null;
}

export function writeLastEffort(effort: ChatEffort): void {
  try {
    window.localStorage.setItem(EFFORT_STORAGE_KEY, effort);
  } catch {}
}
