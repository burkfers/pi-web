import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceListing } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import { workspaceContextPromptSection, type WorkspaceContextSectionDeps } from "./workspaceContextSections.js";

const project: Project = {
  id: "project-1",
  name: "Roadmap",
  path: hostPath("/workspace/roadmap"),
  createdAt: "2026-07-27T00:00:00.000Z",
};

function hostPath(path: string): string {
  return resolve(path);
}

function workspace(id: string, path: string, label: string, isMain: boolean): WorkspaceListing {
  return { id, projectId: project.id, path, label, isMain };
}

function deps(workspaces: readonly WorkspaceListing[], overrides: Partial<WorkspaceContextSectionDeps> = {}): WorkspaceContextSectionDeps {
  return {
    listProjects: () => Promise.resolve([project]),
    listWorkspaces: () => Promise.resolve([...workspaces]),
    warn: vi.fn(),
    ...overrides,
  };
}

describe("workspaceContextPromptSection", () => {
  it("names this session's workspace and the project's others", async () => {
    const main = workspace("w1", hostPath("/workspace/roadmap"), "local", true);
    const review = workspace("w2", hostPath("/workspace/worktrees/roadmap/review"), "detached@abc1234", false);

    const [section] = await workspaceContextPromptSection(review.path, deps([main, review]));
    if (section === undefined) throw new Error("Expected a workspace context section");

    expect(section).toContain("<pi_web_workspaces>");
    expect(section).toContain("- This session's workspace: /workspace/worktrees/roadmap/review (detached@abc1234)");
    expect(section).toContain("- Another workspace: /workspace/roadmap (local, the main checkout)");
    expect(section).toContain("Work only inside this session's workspace");
    expect(section).toContain("snapshot from when the session started");
    expect(section.trimEnd().endsWith("</pi_web_workspaces>")).toBe(true);
  });

  it("says nothing about creating or switching workspaces", async () => {
    const main = workspace("w1", hostPath("/workspace/roadmap"), "local", true);
    const review = workspace("w2", hostPath("/workspace/worktrees/roadmap/review"), "detached@abc1234", false);

    const [section] = await workspaceContextPromptSection(review.path, deps([main, review]));
    if (section === undefined) throw new Error("Expected a workspace context section");

    const text = section.toLowerCase();
    expect(text).not.toContain("worktree add");
    expect(text).not.toContain("create a worktree");
    expect(text).not.toContain("switch to");
  });

  it("adds nothing for a project with a single workspace", async () => {
    const main = workspace("w1", hostPath("/workspace/roadmap"), "local", true);

    await expect(workspaceContextPromptSection(main.path, deps([main]))).resolves.toEqual([]);
  });

  it("adds nothing when the session's workspace is not one of the project's", async () => {
    const main = workspace("w1", hostPath("/workspace/roadmap"), "local", true);
    const other = workspace("w2", hostPath("/workspace/worktrees/roadmap/review"), "detached@abc1234", false);

    await expect(workspaceContextPromptSection("/somewhere/else", deps([main, other]))).resolves.toEqual([]);
  });

  it("reports a failure to describe workspaces without failing the session", async () => {
    const warn = vi.fn();
    const failure = new Error("workspace authority unavailable");

    const sections = await workspaceContextPromptSection("/workspace/roadmap", deps([], {
      listWorkspaces: () => Promise.reject(failure),
      warn,
    }));

    expect(sections).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("workspaces"), failure);
  });

  it("matches the session's workspace whichever project owns it", async () => {
    const main = workspace("w1", hostPath("/workspace/roadmap"), "local", true);
    const other = workspace("w2", hostPath("/workspace/roadmap-views/roadmap"), "views", false);

    const [section] = await workspaceContextPromptSection(main.path, deps([main, other]));
    if (section === undefined) throw new Error("Expected a workspace context section");

    expect(section).toContain("- This session's workspace: /workspace/roadmap (local, the main checkout)");
    expect(section).toContain("- Another workspace: /workspace/roadmap-views/roadmap (views)");
  });
});
