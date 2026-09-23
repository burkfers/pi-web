import { sanitizeHiddenNavigationSections, type NavigationSection } from "./appShell/navigationState";

export interface NavigationPreferences {
  pinnedIds: string[];
  mobileCollapsed: boolean;
  /** Sidebar sections this browser hides; always sanitized to keep one visible. */
  hiddenSections: NavigationSection[];
}

const storageKey = "pi-web:navigation-preferences";

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadNavigationPreferences(storage: Pick<Storage, "getItem"> | undefined = browserStorage()): NavigationPreferences {
  try {
    const value: unknown = JSON.parse(storage?.getItem(storageKey) ?? "null");
    if (typeof value === "object" && value !== null) {
      const pins: unknown = "pinnedIds" in value ? value.pinnedIds : undefined;
      return {
        pinnedIds: Array.isArray(pins) ? [...new Set(pins.filter((id): id is string => typeof id === "string" && id.length > 0))] : [],
        mobileCollapsed: "mobileCollapsed" in value && value.mobileCollapsed === true,
        hiddenSections: sanitizeHiddenNavigationSections("hiddenSections" in value ? value.hiddenSections : undefined),
      };
    }
  } catch {
    // Layout preferences are optional when storage is blocked or malformed.
  }
  return { pinnedIds: [], mobileCollapsed: false, hiddenSections: [] };
}

export function saveNavigationPreferences(preferences: NavigationPreferences, storage: Pick<Storage, "setItem"> | undefined = browserStorage()): void {
  try {
    storage?.setItem(storageKey, JSON.stringify(preferences));
  } catch {
    // Ignore quota/privacy errors for this optional browser layout preference.
  }
}

/**
 * The stored preference after hiding/showing one section. A hide that would
 * leave no visible section is refused: the caller keeps the previous
 * preferences (and the Settings toggle stays disabled for that case).
 */
export function withHiddenNavigationSection(
  preferences: NavigationPreferences,
  section: NavigationSection,
  hidden: boolean,
): NavigationPreferences {
  const isHidden = preferences.hiddenSections.includes(section);
  if (hidden === isHidden) return preferences;
  const hiddenSections = hidden
    ? sanitizeHiddenNavigationSections([...preferences.hiddenSections, section])
    : preferences.hiddenSections.filter((candidate) => candidate !== section);
  if (hidden && !hiddenSections.includes(section)) return preferences;
  return { ...preferences, hiddenSections };
}

/** Section labels for user-facing settings text. */
export const NAVIGATION_SECTION_LABELS: Record<NavigationSection, string> = {
  machines: "Machines",
  projects: "Projects",
  workspaces: "Workspaces",
  sessions: "Sessions",
};

export function isNavigationPinned(id: string, pinnedIds: readonly string[]): boolean {
  return pinnedIds.length === 0 || pinnedIds.includes(id);
}

export function pinnedNavigationTabs<T extends { id: string }>(tabs: readonly T[], pinnedIds: readonly string[]): T[] {
  return tabs.filter((tab) => isNavigationPinned(tab.id, pinnedIds));
}

export function toggleNavigationPin(id: string, pinnedIds: readonly string[], availableIds: readonly string[]): string[] {
  // Materialize the implicit "all" before unpinning. Never prune unavailable plugin IDs.
  const explicitPins = pinnedIds.length === 0 ? availableIds : pinnedIds;
  return explicitPins.includes(id) ? explicitPins.filter((pin) => pin !== id) : [...explicitPins, id];
}
