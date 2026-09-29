import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceCreationPreview } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import { WorkspaceCreationError } from "../workspaces/workspaceCreationService.js";
import { registerWorkspaceCreationRoutes, type WorkspaceCreator } from "./workspaceCreationRoutes.js";

const project: Project = {
  id: "project one",
  name: "Project",
  path: "/repo",
  createdAt: "2026-07-27T00:00:00.000Z",
};

const preview: WorkspaceCreationPreview = {
  path: "/worktrees/repo/review",
  label: "detached@abc1234",
  confirmation: "Create a detached worktree at /worktrees/repo/review?",
  command: "git worktree add --detach '/worktrees/repo/review' 'origin/main'",
  precondition: "v1.confirmed",
};

let app: FastifyInstance;

beforeEach(() => {
  app = Fastify({ logger: false });
});

afterEach(async () => {
  await app.close();
});

describe("session daemon workspace creation routes", () => {
  it("previews a validated plan for the registered project", async () => {
    const { previewCreate } = creatorFakes();
    registerWorkspaceCreationRoutes(app, { projects: projectReader(), creations: { preview: previewCreate, create: vi.fn() } });

    const response = await app.inject({
      method: "POST",
      url: "/workspace-creations/projects/project%20one/preview",
      payload: { name: "review", baseRef: "origin/main" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<WorkspaceCreationPreview>()).toEqual(preview);
    expect(previewCreate).toHaveBeenCalledTimes(1);
    const call = previewCreate.mock.calls[0];
    expect(call?.slice(0, 2)).toEqual([project, { name: "review", baseRef: "origin/main" }]);
    expect(call?.[2]).toBeInstanceOf(AbortSignal);
    expect(call?.[2].aborted).toBe(false);
  });

  it("runs a confirmed creation and answers with the worktree that now exists", async () => {
    const { create } = creatorFakes();
    registerWorkspaceCreationRoutes(app, { projects: projectReader(), creations: { preview: vi.fn(), create } });

    const response = await app.inject({
      method: "POST",
      url: "/workspace-creations/projects/project%20one",
      payload: { name: "review", baseRef: "origin/main", precondition: "v1.confirmed" },
    });

    expect(response.statusCode).toBe(200);
    // Creation runs and waits, so the answer is the worktree that now exists.
    expect(response.json()).toEqual({ created: true, path: preview.path });
    const call = create.mock.calls[0];
    expect(call?.slice(0, 3)).toEqual([
      project,
      { name: "review", baseRef: "origin/main", precondition: "v1.confirmed" },
      "v1.confirmed",
    ]);
    expect(call?.[3]).toBeInstanceOf(AbortSignal);
  });

  it("requires the confirmation precondition before any creation work", async () => {
    const requireProject = vi.fn(projectReader().requireProject);
    const { previewCreate, create } = creatorFakes();
    registerWorkspaceCreationRoutes(app, {
      projects: { requireProject },
      creations: { preview: previewCreate, create },
    });

    const response = await app.inject({
      method: "POST",
      url: "/workspace-creations/projects/project%20one",
      payload: { name: "review", baseRef: "origin/main" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("precondition");
    expect(requireProject).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an unsafe name or base ref before resolving the project", async () => {
    const requireProject = vi.fn(projectReader().requireProject);
    const { previewCreate, create } = creatorFakes();
    registerWorkspaceCreationRoutes(app, {
      projects: { requireProject },
      creations: { preview: previewCreate, create },
    });

    const badName = await app.inject({
      method: "POST",
      url: "/workspace-creations/projects/project%20one/preview",
      payload: { name: "../escape", baseRef: "main" },
    });
    const badBaseRef = await app.inject({
      method: "POST",
      url: "/workspace-creations/projects/project%20one/preview",
      payload: { name: "review", baseRef: "main; rm -rf /" },
    });

    expect(badName.statusCode).toBe(400);
    expect(badName.json<{ error: string }>().error).toContain("Workspace name");
    expect(badBaseRef.statusCode).toBe(400);
    expect(badBaseRef.json<{ error: string }>().error).toContain("Workspace base ref");
    expect(requireProject).not.toHaveBeenCalled();
    expect(previewCreate).not.toHaveBeenCalled();
  });

  it("serializes project, safety, and unexpected failures without a stack", async () => {
    const previewCreate = vi.fn()
      .mockRejectedValueOnce(new WorkspaceCreationError("A new workspace cannot be created inside the registered project", 400))
      .mockRejectedValueOnce(new Error("unexpected failure"));
    registerWorkspaceCreationRoutes(app, { projects: projectReader(), creations: { preview: previewCreate, create: vi.fn() } });

    const payload = { name: "review", baseRef: "origin/main" };
    const missing = await app.inject({ method: "POST", url: "/workspace-creations/projects/missing/preview", payload });
    const rejected = await app.inject({ method: "POST", url: "/workspace-creations/projects/project%20one/preview", payload });
    const failed = await app.inject({ method: "POST", url: "/workspace-creations/projects/project%20one/preview", payload });

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Project not found" });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: "A new workspace cannot be created inside the registered project" });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "unexpected failure" });
    expect(failed.body).not.toContain("stack");
  });
});

function creatorFakes(): {
  previewCreate: ReturnType<typeof vi.fn<WorkspaceCreator["preview"]>>;
  create: ReturnType<typeof vi.fn<WorkspaceCreator["create"]>>;
} {
  return {
    previewCreate: vi.fn<WorkspaceCreator["preview"]>(() => Promise.resolve(preview)),
    create: vi.fn<WorkspaceCreator["create"]>(() => Promise.resolve({ path: preview.path })),
  };
}

function projectReader() {
  return {
    requireProject: (projectId: string) => projectId === project.id
      ? Promise.resolve(project)
      : Promise.reject(new Error("Project not found")),
  };
}
