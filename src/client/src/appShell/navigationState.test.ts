import type { ReactiveControllerHost } from "lit";
import { describe, expect, it } from "vitest";
import type { NavigationSection } from "./navigationState";
import { defaultNavigationSection, expandedNavigationSection, isNavigationSectionCollapsed, isNavigationSectionHidden, NAVIGATION_SECTION_ORDER, NavigationSectionsController, nextNavigationSection, resolveVisibleNavigationSection, sanitizeHiddenNavigationSections, toggleCollapsedNavigationSection, toggleNavigationSection } from "./navigationState";

describe("navigationState", () => {
  it("defaults to the first incomplete selection section", () => {
    expect(defaultNavigationSection({ selectedProject: undefined, selectedWorkspace: undefined })).toBe("projects");
    expect(defaultNavigationSection({ selectedProject: {}, selectedWorkspace: undefined })).toBe("workspaces");
    expect(defaultNavigationSection({ selectedProject: {}, selectedWorkspace: {} })).toBe("sessions");
  });

  it("skips hidden sections when choosing the default section", () => {
    const selected = { selectedProject: {}, selectedWorkspace: undefined };

    // Hiding checkouts leaves sessions as the first thing a user can navigate.
    expect(defaultNavigationSection(selected, ["workspaces"])).toBe("projects");
    expect(defaultNavigationSection({ selectedProject: undefined, selectedWorkspace: undefined }, ["projects", "workspaces"])).toBe("sessions");
    // Prefer a navigable hierarchy section over the optional machine bubble.
    expect(defaultNavigationSection({ selectedProject: {}, selectedWorkspace: {} }, ["sessions"])).toBe("workspaces");
    expect(defaultNavigationSection({ selectedProject: {}, selectedWorkspace: {} }, ["projects", "sessions", "workspaces"])).toBe("machines");
  });

  it("advances to the next visible section and stops at the end instead of wrapping", () => {
    expect(nextNavigationSection("sessions")).toBe("workspaces");
    expect(nextNavigationSection("workspaces")).toBeUndefined();
    expect(nextNavigationSection("sessions", ["workspaces", "projects"])).toBeUndefined();
    expect(nextNavigationSection("machines", ["projects"])).toBe("sessions");
  });

  it("resolves a requested section to itself, or the next visible one when hidden", () => {
    expect(resolveVisibleNavigationSection("workspaces", [])).toBe("workspaces");
    expect(resolveVisibleNavigationSection("workspaces", ["workspaces"])).toBeUndefined();
    expect(resolveVisibleNavigationSection("sessions", ["workspaces", "sessions"])).toBeUndefined();
  });

  it("sanitizes hidden sections to known, non-blanking sets", () => {
    expect(sanitizeHiddenNavigationSections(undefined)).toEqual([]);
    expect(sanitizeHiddenNavigationSections(["workspaces", "nope", "sessions"])).toEqual(["sessions", "workspaces"]);
    expect(sanitizeHiddenNavigationSections(NAVIGATION_SECTION_ORDER)).toEqual([]);
    expect(sanitizeHiddenNavigationSections("workspaces")).toEqual([]);
    expect(isNavigationSectionHidden("workspaces", ["workspaces"])).toBe(true);
  });

  it("expands the default section until the user explicitly toggles a section", () => {
    const state = { selectedProject: {}, selectedWorkspace: undefined };

    expect(expandedNavigationSection(undefined, state)).toBe("workspaces");
    expect(expandedNavigationSection("sessions", state)).toBe("sessions");
    expect(expandedNavigationSection("none", state)).toBeUndefined();
    expect(expandedNavigationSection(undefined, state, ["workspaces"])).toBe("projects");
  });

  it("rebases an explicitly expanded section when it becomes hidden", () => {
    const state = { selectedProject: {}, selectedWorkspace: {} };
    expect(expandedNavigationSection("workspaces", state, ["workspaces"])).toBe("sessions");
  });

  it("uses the mobile accordion state on mobile layouts", () => {
    const state = { selectedProject: {}, selectedWorkspace: {} };

    expect(isNavigationSectionCollapsed("projects", { isMobileLayout: true, expanded: "sessions", state })).toBe(true);
    expect(isNavigationSectionCollapsed("sessions", { isMobileLayout: true, expanded: "sessions", state })).toBe(false);
    expect(isNavigationSectionCollapsed("sessions", { isMobileLayout: true, expanded: undefined, state, hiddenSections: ["projects"] })).toBe(false);
    expect(isNavigationSectionCollapsed("projects", { isMobileLayout: true, expanded: undefined, state, hiddenSections: ["workspaces"] })).toBe(true);
  });

  it("uses independent collapsed sections on desktop layouts", () => {
    const state = { selectedProject: {}, selectedWorkspace: {} };

    expect(isNavigationSectionCollapsed("projects", { isMobileLayout: false, expanded: "sessions", state })).toBe(false);
    expect(isNavigationSectionCollapsed("projects", { isMobileLayout: false, expanded: "sessions", state, collapsedSections: ["projects"] })).toBe(true);
    expect(isNavigationSectionCollapsed("sessions", { isMobileLayout: false, expanded: "sessions", state, collapsedSections: ["projects"] })).toBe(false);
  });

  it("toggles the effective mobile section, including the implicit default section", () => {
    const state = { selectedProject: undefined, selectedWorkspace: undefined };

    expect(toggleNavigationSection(undefined, "projects", { isMobileLayout: true, state })).toBe("none");
    expect(toggleNavigationSection("none", "projects", { isMobileLayout: true, state })).toBe("projects");
    expect(toggleNavigationSection("projects", "workspaces", { isMobileLayout: true, state })).toBe("workspaces");
  });

  it("does not mutate expanded section on desktop layouts", () => {
    const state = { selectedProject: undefined, selectedWorkspace: undefined };

    expect(toggleNavigationSection("projects", "projects", { isMobileLayout: false, state })).toBe("projects");
  });

  it("toggles desktop sections independently", () => {
    expect(toggleCollapsedNavigationSection([], "projects")).toEqual(["projects"]);
    expect(toggleCollapsedNavigationSection(["machines", "projects"], "projects")).toEqual(["machines"]);
    expect(toggleCollapsedNavigationSection(["sessions"], "machines")).toEqual(["machines", "sessions"]);
  });

  it("treats the hidden default section as the implicitly expanded one on mobile", () => {
    const state = { selectedProject: {}, selectedWorkspace: undefined };

    // The default section with no checkout selected is checkouts; tapping the
    // session section is a different section, so the accordion closes.
    expect(toggleNavigationSection(undefined, "sessions", { isMobileLayout: true, state, hiddenSections: ["workspaces"] })).toBe("sessions");
    expect(toggleNavigationSection("none", "sessions", { isMobileLayout: true, state, hiddenSections: ["workspaces"] })).toBe("sessions");
  });

  it("does not expand hidden sections after a selection", () => {
    const controller = navigationController(["workspaces"]);

    controller.advanceAfterSelection("projects");
    expect(controller.expandedSection()).toBe("sessions");
  });

  it("refuses to open a hidden section", () => {
    const controller = navigationController(["workspaces"]);
    let opened = false;

    controller.open("workspaces", () => { opened = true; });
    expect(opened).toBe(false);
    controller.open("sessions", () => { opened = true; });
    expect(opened).toBe(true);
    expect(controller.expandedSection()).toBe("sessions");
  });

});

function navigationController(hiddenSections: readonly NavigationSection[]): NavigationSectionsController {
  const host: ReactiveControllerHost = { addController: () => undefined, removeController: () => undefined, requestUpdate: () => undefined, updateComplete: Promise.resolve(true) };
  const state = { selectedProject: {}, selectedWorkspace: undefined };
  return new NavigationSectionsController(host, () => state, () => true, () => hiddenSections);
}
