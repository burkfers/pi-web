import { describe, expect, it } from "vitest";
import type { Workspace } from "./api";
import { canDeleteWorkspace, workspaceRemovalConfirmation } from "./workspaceDeletion";

/** A checkout the owner advertises removal for, unless overridden. */
const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: "workspace-1",
  projectId: "project-1",
  path: "/repo/worktree",
  label: "detached@abc1234",
  isMain: false,
  effectiveConfig: {},
  removal: { actionLabel: "Remove worktree", confirmation: "Remove /repo/worktree?", precondition: "v1.confirmed" },
  ...overrides,
});

describe("workspace removal availability", () => {
  it("is offered only for a secondary checkout the owner advertises", () => {
    expect(canDeleteWorkspace(workspace())).toBe(true);
    // The main checkout is the project, not a worktree of it.
    expect(canDeleteWorkspace(workspace({ isMain: true }))).toBe(false);
    // A provider that will not remove it has said so by advertising nothing.
    const withoutRemoval: Workspace = { ...workspace() };
    Reflect.deleteProperty(withoutRemoval, "removal");
    expect(canDeleteWorkspace(withoutRemoval)).toBe(false);
    expect(canDeleteWorkspace(undefined)).toBe(false);
  });

  it("takes the wording from the owner rather than composing its own", () => {
    expect(workspaceRemovalConfirmation(workspace())).toBe("Remove /repo/worktree?");
    const withoutRemoval: Workspace = { ...workspace() };
    Reflect.deleteProperty(withoutRemoval, "removal");
    expect(workspaceRemovalConfirmation(withoutRemoval)).toBeUndefined();
  });
});
