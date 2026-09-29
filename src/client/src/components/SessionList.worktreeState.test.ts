// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObject, SessionInfo, Workspace } from "../api";
import { SessionList } from "./SessionList";

const WORKTREE = "/mnt/worktrees/roadmap/session-1";
const MAIN = "/srv/dev/roadmap";
const OWNED = { owned: true, createdAt: "2026-01-01T00:00:00.000Z" } as const;

afterEach(() => {
  document.body.replaceChildren();
});

describe("session row worktree state", () => {
  it("shows the branch beside the session name", async () => {
    const list = await renderList({
      sessions: [session({ worktree: OWNED })],
      workspaces: [workspace(WORKTREE, { isGitWorktree: true, branch: "feature-x" })],
    });

    const state = row(list).querySelector(".row-worktree-state");
    expect(state?.textContent).toBe("feature-x");
    expect(state?.getAttribute("title")).toBe(`Branch feature-x in ${WORKTREE}`);
  });

  it("shows the commit a detached worktree sits at", async () => {
    const list = await renderList({
      sessions: [session({ worktree: OWNED })],
      workspaces: [workspace(WORKTREE, { isGitWorktree: true, detached: true, head: "afdd9b8a1c2d" })],
    });

    expect(row(list).querySelector(".row-worktree-state")?.textContent).toBe("detached@afdd9b8");
  });

  it("says out loud that a session has no worktree of its own", async () => {
    const list = await renderList({
      sessions: [session({ cwd: MAIN })],
      workspaces: [workspace(MAIN, { isGitWorktree: true, branch: "local" }, { isMain: true })],
    });

    const state = row(list).querySelector(".row-worktree-state");
    expect(state?.textContent).toBe("shared");
    expect(state?.classList.contains("shared")).toBe(true);
  });

  it("says when a session's worktree is gone", async () => {
    const list = await renderList({ sessions: [session({ worktree: OWNED })], workspaces: [] });

    expect(row(list).querySelector(".row-worktree-state")?.textContent).toBe("worktree removed");
  });

  it("offers to clean up a parked session's worktree without deleting the session", async () => {
    const onRemoveWorktree = vi.fn();
    const list = await renderList({
      sessions: [session({ worktree: OWNED, archived: true, archivedAt: "2026-01-02T00:00:00.000Z" })],
      workspaces: [workspace(WORKTREE, { isGitWorktree: true, detached: true, head: "afdd9b8" }, { removal: removal() })],
      onRemoveWorktree,
    });

    await openArchivedMenu(list);
    const actions = menuLabels(list);
    expect(actions).toContain("Remove worktree");
    expect(actions).toContain("Delete archived session");

    clickAction(list, "Remove worktree");
    expect(onRemoveWorktree).toHaveBeenCalledWith(expect.objectContaining({ worktree: OWNED }));
  });

  it("offers no cleanup for a worktree the provider will not remove", async () => {
    const list = await renderList({
      sessions: [session({ worktree: OWNED, archived: true })],
      workspaces: [workspace(WORKTREE, { isGitWorktree: true, detached: true })],
    });

    await openArchivedMenu(list);
    expect(menuLabels(list)).not.toContain("Remove worktree");
  });

  it("offers no cleanup for a session in a checkout PI WEB did not create", async () => {
    const list = await renderList({
      sessions: [session({ cwd: MAIN, archived: true })],
      workspaces: [workspace(MAIN, undefined, { isMain: true, removal: removal() })],
    });

    await openArchivedMenu(list);
    expect(menuLabels(list)).not.toContain("Remove worktree");
  });
});

async function renderList(options: {
  sessions: SessionInfo[];
  workspaces?: Workspace[];
  onRemoveWorktree?: (session: SessionInfo) => void;
}): Promise<SessionList> {
  const list = new SessionList();
  list.sessions = options.sessions;
  list.workspaces = options.workspaces ?? [];
  if (options.onRemoveWorktree !== undefined) list.onRemoveWorktree = options.onRemoveWorktree;
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function row(list: SessionList, index = 0): Element {
  const found = [...list.shadowRoot?.querySelectorAll(".action-row") ?? []][index];
  if (found === undefined) throw new Error(`No session row at index ${String(index)}`);
  return found;
}

async function openMenu(list: SessionList, index = 0): Promise<void> {
  row(list, index).querySelector<HTMLButtonElement>(".action-menu-toggle")?.click();
  await list.updateComplete;
}

/** Archived rows live behind their own collapsed heading. */
async function openArchivedMenu(list: SessionList): Promise<void> {
  const toggle = list.shadowRoot?.querySelector<HTMLButtonElement>("h2.subheading .section-toggle");
  if (toggle?.getAttribute("aria-expanded") === "false") {
    toggle.click();
    await list.updateComplete;
  }
  await openMenu(list);
}

function menuLabels(list: SessionList): string[] {
  return [...list.shadowRoot?.querySelectorAll(".action-menu-panel button") ?? []].map((button) => button.textContent.trim());
}

function clickAction(list: SessionList, label: string): void {
  for (const button of list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".action-menu-panel button") ?? []) {
    if (button.textContent.trim() === label) {
      button.click();
      return;
    }
  }
}

function removal() {
  return { actionLabel: "Remove workspace", confirmation: "Remove?", precondition: "v1.precondition" };
}

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    path: "/sessions/s1.jsonl",
    cwd: WORKTREE,
    created: "2026-07-28T00:00:00.000Z",
    modified: "2026-07-28T00:00:00.000Z",
    messageCount: 3,
    firstMessage: "hello",
    ...overrides,
  };
}

function workspace(path: string, metadata: JsonObject | undefined, extra: Partial<Workspace> = {}): Workspace {
  return {
    id: path,
    projectId: "p1",
    path,
    label: "worktree",
    isMain: false,
    effectiveConfig: {},
    ...(metadata === undefined ? {} : { provider: { pluginId: "git", capabilities: { remove: true, create: true }, metadata } }),
    ...extra,
  };
}
