import { describe, expect, it } from "vitest";
import type { NavigationPreferences } from "./navigationPreferences";
import { isNavigationPinned, loadNavigationPreferences, pinnedNavigationTabs, saveNavigationPreferences, toggleNavigationPin, withHiddenNavigationSection } from "./navigationPreferences";

const tabs = [{ id: "navigation" }, { id: "chat" }, { id: "plugin:files" }];

describe("navigation preferences", () => {
  it("shows all tabs for empty pins and explicit all pins, in destination order", () => {
    expect(pinnedNavigationTabs(tabs, [])).toEqual(tabs);
    expect(pinnedNavigationTabs(tabs, ["plugin:files", "chat", "navigation"])).toEqual(tabs);
    expect(pinnedNavigationTabs(tabs, ["plugin:files"])).toEqual([tabs[2]]);
  });

  it("materializes implicit all pins on unpin and treats removing the last pin as all", () => {
    expect(toggleNavigationPin("chat", [], tabs.map((tab) => tab.id))).toEqual(["navigation", "plugin:files"]);
    const pins = toggleNavigationPin("chat", ["chat"], []);
    expect(pins).toEqual([]);
    expect(isNavigationPinned("plugin:files", pins)).toBe(true);
  });

  it("retains unavailable plugins through filtering and pin management", () => {
    const pins = ["missing:tool"];
    expect(pinnedNavigationTabs(tabs, pins)).toEqual([]);
    expect(toggleNavigationPin("chat", pins, ["chat"])).toEqual(["missing:tool", "chat"]);
    expect(pinnedNavigationTabs([{ id: "missing:tool" }], pins)).toEqual([{ id: "missing:tool" }]);
    expect(pins).toEqual(["missing:tool"]);
  });

  it("round-trips pins, mobile collapse, and hidden sections", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const preferences: NavigationPreferences = { pinnedIds: ["missing:tool"], mobileCollapsed: true, hiddenSections: ["workspaces"] };
    saveNavigationPreferences(preferences, storage);
    expect(loadNavigationPreferences(storage)).toEqual(preferences);
    saveNavigationPreferences({ ...preferences, mobileCollapsed: false }, storage);
    expect(loadNavigationPreferences(storage)).toEqual({ ...preferences, mobileCollapsed: false });
  });

  it("defaults safely for malformed or unavailable storage and validates stored values", () => {
    const storage = (raw: string) => ({ getItem: () => raw });
    expect(loadNavigationPreferences(storage("{"))).toEqual({ pinnedIds: [], mobileCollapsed: false, hiddenSections: [] });
    expect(loadNavigationPreferences(storage('{"pinnedIds":["chat",5,"chat",""],"mobileCollapsed":"true"}'))).toEqual({ pinnedIds: ["chat"], mobileCollapsed: false, hiddenSections: [] });
    const blocked = { getItem: () => { throw new Error("Blocked"); }, setItem: () => { throw new Error("Blocked"); } };
    expect(loadNavigationPreferences(blocked)).toEqual({ pinnedIds: [], mobileCollapsed: false, hiddenSections: [] });
    expect(() => { saveNavigationPreferences({ pinnedIds: [], mobileCollapsed: true, hiddenSections: [] }, blocked); }).not.toThrow();
  });

  it("keeps hidden sections known, ordered, and never hiding every section", () => {
    const stored = storageOf('{"pinnedIds":[],"mobileCollapsed":false,"hiddenSections":["workspaces","nope","projects"]}');
    expect(loadNavigationPreferences(stored).hiddenSections).toEqual(["projects", "workspaces"]);

    const everything = storageOf('{"hiddenSections":["machines","projects","workspaces","sessions"]}');
    expect(loadNavigationPreferences(everything).hiddenSections).toEqual([]);
  });

  it("hides and shows one section without touching the rest of the preferences", () => {
    const preferences: NavigationPreferences = { pinnedIds: ["chat"], mobileCollapsed: true, hiddenSections: ["projects"] };
    expect(withHiddenNavigationSection(preferences, "workspaces", true)).toEqual({ ...preferences, hiddenSections: ["projects", "workspaces"] });
    expect(withHiddenNavigationSection(preferences, "projects", false)).toEqual({ ...preferences, hiddenSections: [] });
    // Unchanged requests and refused hides keep identity so hosts do not re-render.
    expect(withHiddenNavigationSection(preferences, "projects", true)).toBe(preferences);
    // The last visible section cannot be hidden.
    const onlyProjectsVisible: NavigationPreferences = { ...preferences, hiddenSections: ["machines", "workspaces", "sessions"] };
    expect(withHiddenNavigationSection(onlyProjectsVisible, "projects", true)).toBe(onlyProjectsVisible);
  });
});

function storageOf(raw: string) {
  return { getItem: () => raw };
}
