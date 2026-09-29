import type { ReactiveController, ReactiveControllerHost } from "lit";

/**
 * Sessions sit above checkouts because a session is what a user comes back to,
 * and under the one-session-per-worktree default most of them have a worktree
 * of their own — which makes the checkout list a detail of where they run
 * rather than the place work starts.
 */
export const NAVIGATION_SECTION_ORDER = ["machines", "projects", "sessions", "workspaces"] as const;
export type NavigationSection = (typeof NAVIGATION_SECTION_ORDER)[number];
export type ExpandedNavigationSection = NavigationSection | "none" | undefined;

export interface NavigationSelectionState {
  selectedProject: object | undefined;
  selectedWorkspace: object | undefined;
}

/**
 * Drop everything that is not a known section, and never hide every section:
 * a stored preference that would blank the sidebar falls back to showing all
 * sections rather than leaving no navigation at all.
 */
export function sanitizeHiddenNavigationSections(value: unknown): NavigationSection[] {
  if (!Array.isArray(value)) return [];
  const hidden = NAVIGATION_SECTION_ORDER.filter((section) => value.includes(section));
  return hidden.length === NAVIGATION_SECTION_ORDER.length ? [] : hidden;
}

export function isNavigationSectionHidden(section: NavigationSection, hiddenSections: readonly NavigationSection[]): boolean {
  return hiddenSections.includes(section);
}

/**
 * Destination for a requested section: the section when it renders, otherwise
 * the next visible one. Undefined when the request cannot be honored, so the
 * caller can fall back to the chat composer instead of wrapping around.
 */
export function resolveVisibleNavigationSection(section: NavigationSection, hiddenSections: readonly NavigationSection[]): NavigationSection | undefined {
  if (!isNavigationSectionHidden(section, hiddenSections)) return section;
  return nextNavigationSection(section, hiddenSections);
}

/** Next section in order that still renders. Never wraps, so callers can stop at the end. */
export function nextNavigationSection(section: NavigationSection, hiddenSections: readonly NavigationSection[] = []): NavigationSection | undefined {
  const index = NAVIGATION_SECTION_ORDER.indexOf(section);
  return NAVIGATION_SECTION_ORDER.slice(index + 1).find((candidate) => !isNavigationSectionHidden(candidate, hiddenSections));
}

export function defaultNavigationSection(state: NavigationSelectionState, hiddenSections: readonly NavigationSection[] = []): NavigationSection {
  const preferred = state.selectedProject === undefined ? "projects"
    : state.selectedWorkspace === undefined ? "workspaces"
      : "sessions";
  const index = NAVIGATION_SECTION_ORDER.indexOf(preferred);
  const candidates = [...NAVIGATION_SECTION_ORDER.slice(index), ...NAVIGATION_SECTION_ORDER.slice(0, index)];
  const visible = candidates.filter((candidate) => !isNavigationSectionHidden(candidate, hiddenSections));
  return visible.find((candidate) => candidate !== "machines") ?? visible[0] ?? preferred;
}

export function expandedNavigationSection(expanded: ExpandedNavigationSection, state: NavigationSelectionState, hiddenSections: readonly NavigationSection[] = []): NavigationSection | undefined {
  if (expanded === "none") return undefined;
  if (expanded !== undefined && !isNavigationSectionHidden(expanded, hiddenSections)) return expanded;
  return defaultNavigationSection(state, hiddenSections);
}

export function isNavigationSectionCollapsed(section: NavigationSection, options: { isMobileLayout: boolean; expanded: ExpandedNavigationSection; state: NavigationSelectionState; collapsedSections?: readonly NavigationSection[] | undefined; hiddenSections?: readonly NavigationSection[] | undefined }): boolean {
  if (options.isMobileLayout) return expandedNavigationSection(options.expanded, options.state, options.hiddenSections ?? []) !== section;
  return options.collapsedSections?.includes(section) ?? false;
}

export function toggleNavigationSection(expanded: ExpandedNavigationSection, section: NavigationSection, options: { isMobileLayout: boolean; state: NavigationSelectionState; hiddenSections?: readonly NavigationSection[] | undefined }): ExpandedNavigationSection {
  if (!options.isMobileLayout) return expanded;
  return expandedNavigationSection(expanded, options.state, options.hiddenSections ?? []) === section ? "none" : section;
}

export function expandNavigationSection(expanded: ExpandedNavigationSection, section: NavigationSection, isMobileLayout: boolean): ExpandedNavigationSection {
  return isMobileLayout ? section : expanded;
}

export function toggleCollapsedNavigationSection(collapsedSections: readonly NavigationSection[], section: NavigationSection): NavigationSection[] {
  const collapsed = new Set(collapsedSections);
  if (collapsed.has(section)) collapsed.delete(section);
  else collapsed.add(section);
  return orderedNavigationSections(collapsed);
}

export class NavigationSectionsController implements ReactiveController {
  private expanded: ExpandedNavigationSection;
  private collapsedSections: readonly NavigationSection[] = [];

  hostConnected(): void {
    return;
  }

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly getState: () => NavigationSelectionState,
    private readonly isMobileLayout: () => boolean,
    private readonly getHiddenSections: () => readonly NavigationSection[],
  ) {
    host.addController(this);
  }

  expandedSection(): NavigationSection | undefined {
    return expandedNavigationSection(this.expanded, this.getState(), this.getHiddenSections());
  }

  isCollapsed(section: NavigationSection): boolean {
    return isNavigationSectionCollapsed(section, {
      isMobileLayout: this.isMobileLayout(),
      expanded: this.expanded,
      state: this.getState(),
      collapsedSections: this.collapsedSections,
      hiddenSections: this.getHiddenSections(),
    });
  }

  toggle(section: NavigationSection): void {
    if (this.isMobileLayout()) {
      this.setExpanded(toggleNavigationSection(this.expanded, section, { isMobileLayout: true, state: this.getState(), hiddenSections: this.getHiddenSections() }));
      return;
    }
    this.setCollapsedSections(toggleCollapsedNavigationSection(this.collapsedSections, section));
  }

  expand(section: NavigationSection): void {
    if (this.isMobileLayout()) {
      this.setExpanded(expandNavigationSection(this.expanded, section, true));
      return;
    }
    this.setCollapsedSections(this.collapsedSections.filter((collapsedSection) => collapsedSection !== section));
  }

  advanceAfterSelection(section: NavigationSection): void {
    if (!this.isMobileLayout()) return;
    const next = nextNavigationSection(section, this.getHiddenSections());
    if (next !== undefined) this.expand(next);
  }

  open(section: NavigationSection, openNavigationView: () => void): void {
    if (!this.isMobileLayout()) return;
    if (isNavigationSectionHidden(section, this.getHiddenSections())) return;
    this.expand(section);
    openNavigationView();
  }

  private setExpanded(expanded: ExpandedNavigationSection): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.host.requestUpdate();
  }

  private setCollapsedSections(collapsedSections: readonly NavigationSection[]): void {
    if (navigationSectionListsEqual(this.collapsedSections, collapsedSections)) return;
    this.collapsedSections = collapsedSections;
    this.host.requestUpdate();
  }
}

function orderedNavigationSections(sections: Iterable<NavigationSection>): NavigationSection[] {
  const sectionSet = new Set(sections);
  return NAVIGATION_SECTION_ORDER.filter((section) => sectionSet.has(section));
}

function navigationSectionListsEqual(first: readonly NavigationSection[], second: readonly NavigationSection[]): boolean {
  return first.length === second.length && first.every((section, index) => section === second[index]);
}
