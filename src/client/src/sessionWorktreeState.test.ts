import { describe, expect, it } from "vitest";
import type { JsonObject, SessionInfo, Workspace, WorkspaceProviderMetadata } from "../../shared/apiTypes";
import { sessionWorktreeState, sessionWorktreeStateLabel, sessionWorktreeStateTitle } from "./sessionWorktreeState";

const WORKTREE = "/mnt/worktrees/roadmap/session-1";
const MAIN = "/srv/dev/roadmap";
const OWNED = { owned: true, createdAt: "2026-01-01T00:00:00.000Z" } as const;

const session = (extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "s1",
  path: "/sessions/s1.jsonl",
  cwd: WORKTREE,
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  messageCount: 0,
  firstMessage: "",
  ...extra,
});

const workspace = (path: string, metadata: JsonObject | undefined, extra: Partial<Workspace> = {}): Workspace => {
  const provider: WorkspaceProviderMetadata = { pluginId: "git", capabilities: { remove: true, create: true }, ...(metadata === undefined ? {} : { metadata }) };
  return {
    id: path,
    projectId: "p1",
    path,
    label: "worktree",
    isMain: false,
    effectiveConfig: {},
    ...(metadata === undefined ? {} : { provider }),
    ...extra,
  };
};

describe("session worktree state", () => {
  it("names the branch a session's worktree is on", () => {
    const state = sessionWorktreeState(session({ worktree: OWNED }), [workspace(WORKTREE, { isGitWorktree: true, branch: "feature-x" })]);

    expect(state).toEqual({ kind: "branch", branch: "feature-x" });
    expect(state && sessionWorktreeStateLabel(state)).toBe("feature-x");
  });

  it("names the commit a detached worktree sits at", () => {
    const state = sessionWorktreeState(session({ worktree: OWNED }), [workspace(WORKTREE, { isGitWorktree: true, detached: true, head: "afdd9b8a1c2d" })]);

    expect(state).toEqual({ kind: "detached", sha: "afdd9b8" });
    expect(state && sessionWorktreeStateLabel(state)).toBe("detached@afdd9b8");
  });

  it("says a session works in a shared checkout when it has no worktree state", () => {
    expect(sessionWorktreeState(session({ cwd: MAIN }), [workspace(MAIN, undefined, { isMain: true })])).toEqual({ kind: "shared" });
  });

  it("calls a session in the main checkout shared, whatever branch that checkout is on", () => {
    // The checkout's own row shows the branch; repeating it on every session in
    // it would read as if those sessions had a branch of their own.
    expect(sessionWorktreeState(session({ cwd: MAIN }), [workspace(MAIN, { isGitWorktree: true, branch: "main" }, { isMain: true })])).toEqual({ kind: "shared" });
  });

  it("still names the branch of a linked worktree PI WEB did not create", () => {
    // A worktree made through the dialog is isolated even though the session in
    // it is not one PI WEB manages, and the branch is the useful fact.
    expect(sessionWorktreeState(session(), [workspace(WORKTREE, { isGitWorktree: true, branch: "review" })])).toEqual({ kind: "branch", branch: "review" });
  });

  it("says shared for a worktree the provider cannot describe a branch for", () => {
    expect(sessionWorktreeState(session(), [workspace(WORKTREE, {})])).toEqual({ kind: "shared" });
  });

  it("reports a worktree PI WEB created that is no longer on disk", () => {
    expect(sessionWorktreeState(session({ worktree: OWNED }), [])).toEqual({ kind: "removed" });
  });

  it("has nothing to say about a session whose workspace is simply not listed", () => {
    expect(sessionWorktreeState(session(), [])).toBeUndefined();
  });

  it("titles each state with the checkout it describes", () => {
    expect(sessionWorktreeStateTitle({ kind: "branch", branch: "feature-x" }, WORKTREE)).toBe(`Branch feature-x in ${WORKTREE}`);
    expect(sessionWorktreeStateTitle({ kind: "removed" }, WORKTREE)).toContain("no longer on disk");
    expect(sessionWorktreeStateTitle({ kind: "shared" }, MAIN)).toContain("works directly in");
    expect(sessionWorktreeStateLabel({ kind: "removed" })).toBe("worktree removed");
    expect(sessionWorktreeStateLabel({ kind: "detached", sha: "" })).toBe("detached");
  });
});
