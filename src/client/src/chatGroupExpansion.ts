/**
 * Per-user, per-browser preference that settles (non-live) chat event groups
 * open by default. Follows the same browser-local storage pattern as the
 * navigation preferences; it applies immediately without a server round-trip.
 * Default off: settled groups keep upstream parity and collapse at the
 * turn boundary.
 */

const storageKey = "pi-web:chat-group-expanded";

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadChatGroupExpansion(storage: Pick<Storage, "getItem"> | undefined = browserStorage()): boolean {
  try {
    return storage?.getItem(storageKey) === "on";
  } catch {
    return false;
  }
}

export function saveChatGroupExpansion(expanded: boolean, storage: Pick<Storage, "setItem"> | undefined = browserStorage()): void {
  try {
    storage?.setItem(storageKey, expanded ? "on" : "off");
  } catch {
    // Ignore quota/privacy errors for this optional browser preference.
  }
}
