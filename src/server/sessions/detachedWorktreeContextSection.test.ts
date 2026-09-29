import { describe, expect, it, vi } from "vitest";
import type { JsonObject, Project, WorkspaceListing } from "../../shared/apiTypes.js";
import { detachedWorktreePromptSection } from "./detachedWorktreeContextSection.js";

const PROJECT: Project = { id: "p1", name: "roadmap", path: "/srv/dev/roadmap", createdAt: "2026-01-01T00:00:00.000Z" };
const WORKTREE = "/mnt/worktrees/roadmap/session-1";
const HEADER = { type: "session", id: "s1", piWeb: { worktree: { owned: true, createdAt: "2026-01-01T00:00:00.000Z" }, detachedFrom: "feature-x", detachedAt: "afdd9b8a" } };

function workspace(metadata: JsonObject | undefined, path = WORKTREE): WorkspaceListing {
  return {
    id: path,
    projectId: PROJECT.id,
    path,
    label: "worktree",
    isMain: false,
    ...(metadata === undefined ? {} : { provider: { pluginId: "git", capabilities: { remove: true, create: true }, metadata } }),
  };
}

function deps(workspaces: WorkspaceListing[], warn = vi.fn()) {
  return {
    listProjects: () => Promise.resolve([PROJECT]),
    listWorkspaces: () => Promise.resolve(workspaces),
    warn,
  };
}

describe("detached worktree prompt section", () => {
  it("tells a resumed session what its worktree was released from", async () => {
    const [section] = await detachedWorktreePromptSection(WORKTREE, HEADER, deps([workspace({ detached: true, head: "afdd9b8a1c2d" })]));

    expect(section).toContain("<pi_web_detached_worktree>");
    expect(section).toContain("detached at afdd9b8");
    expect(section).toContain("last attached to feature-x");
    // The branch may have moved while the session was parked, and the agent is
    // the only one who can say whether that matters.
    expect(section).toContain("may have moved or been deleted");
    expect(section).toContain("before you commit");
  });

  it("falls back to the recorded commit when the worktree reports no head", async () => {
    const [section] = await detachedWorktreePromptSection(WORKTREE, HEADER, deps([workspace({ detached: true })]));

    expect(section).toContain("detached at afdd9b8");
  });

  it("says nothing for a session that was never detached", async () => {
    const header = { type: "session", id: "s1", piWeb: { worktree: { owned: true, createdAt: "2026-01-01T00:00:00.000Z" } } };

    await expect(detachedWorktreePromptSection(WORKTREE, header, deps([workspace({ detached: true, head: "afdd9b8" })]))).resolves.toEqual([]);
  });

  it("says nothing once the agent has checked a branch out again", async () => {
    // The section describes the present, and a reattached worktree has nothing
    // left to be warned about.
    await expect(detachedWorktreePromptSection(WORKTREE, HEADER, deps([workspace({ branch: "feature-x" })]))).resolves.toEqual([]);
    await expect(detachedWorktreePromptSection(WORKTREE, HEADER, deps([workspace({ detached: false, head: "afdd9b8" })]))).resolves.toEqual([]);
  });

  it("says nothing for a workspace that is not a provider worktree", async () => {
    await expect(detachedWorktreePromptSection(WORKTREE, HEADER, deps([workspace(undefined)]))).resolves.toEqual([]);
  });

  it("says nothing when the worktree is not in the project's workspace list", async () => {
    await expect(detachedWorktreePromptSection("/elsewhere", HEADER, deps([workspace({ detached: true })]))).resolves.toEqual([]);
  });

  it("warns instead of failing a session start", async () => {
    const warn = vi.fn();
    const failing = {
      listProjects: () => Promise.reject(new Error("provider is down")),
      listWorkspaces: () => Promise.resolve([]),
      warn,
    };

    await expect(detachedWorktreePromptSection(WORKTREE, HEADER, failing)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith("Failed to describe the session's detached worktree for its system prompt", expect.any(Error));
  });
});
