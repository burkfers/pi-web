/**
 * Per-user, per-browser preference that renders chat thinking parts (the inner
 * "thinking" disclosures) open by default. Applies immediately, browser-local.
 * Default on: collapsed event groups still hide the thinking blocks, so an
 * open group shows thinking content without an extra click per block.
 */

const storageKey = "pi-web:thinking-expanded";

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadThinkingExpansion(storage: Pick<Storage, "getItem"> | undefined = browserStorage()): boolean {
  try {
    return storage?.getItem(storageKey) !== "off";
  } catch {
    return true;
  }
}

export function saveThinkingExpansion(expanded: boolean, storage: Pick<Storage, "setItem"> | undefined = browserStorage()): void {
  try {
    storage?.setItem(storageKey, expanded ? "on" : "off");
  } catch {
    // Ignore quota/privacy errors for this optional browser preference.
  }
}
