import type { Project } from "../types.js";
import type { WorkspaceListing } from "../../shared/apiTypes.js";

export interface WorkspaceContextSectionDeps {
  /** Registered projects, so a session's cwd can be attributed to one. */
  listProjects(): Promise<Project[]>;
  /** Current workspaces of one project. */
  listWorkspaces(project: Project): Promise<WorkspaceListing[]>;
  /** Records a failure to describe workspaces; never fails session startup. */
  warn(message: string, error: unknown): void;
}

/**
 * System-prompt section naming the workspaces of the session's own project.
 *
 * A project can have several workspaces (a Git repository's worktrees), and
 * each session runs in exactly one of them. The agent is told which one is
 * theirs and that the others belong to someone else's work, because a session
 * that edits files in another workspace is editing state another session is
 * relying on, and the agent has no way to know that from its working directory
 * alone.
 *
 * Deliberately states only facts and one boundary. It does not suggest
 * creating or switching workspaces: which workspace a task belongs in is the
 * user's decision, and the user has already made it by starting this session
 * here.
 *
 * Returns no section for a project with a single workspace — the agent's
 * working directory already says everything there is to say.
 */
export async function workspaceContextPromptSection(
  cwd: string,
  deps: WorkspaceContextSectionDeps,
): Promise<string[]> {
  try {
    const projects = await deps.listProjects();
    for (const project of projects) {
      const workspaces = await deps.listWorkspaces(project);
      if (workspaces.length < 2) continue;
      if (!workspaces.some((workspace) => samePath(workspace.path, cwd))) continue;
      return [workspaceSection(workspaces, cwd)];
    }
    return [];
  } catch (error) {
    // The section improves a prompt; no session depends on it.
    deps.warn("Failed to describe the session's workspaces for its system prompt", error);
    return [];
  }
}

function workspaceSection(workspaces: readonly WorkspaceListing[], cwd: string): string {
  const own = workspaces.filter((workspace) => samePath(workspace.path, cwd));
  const others = workspaces.filter((workspace) => !samePath(workspace.path, cwd));
  return [
    "<pi_web_workspaces>",
    "This session runs in one workspace of a project that has several:",
    ...own.map((workspace) => `- This session's workspace: ${workspace.path} (${describe(workspace)})`),
    ...others.map((workspace) => `- Another workspace: ${workspace.path} (${describe(workspace)})`),
    "Work only inside this session's workspace. Another workspace is the working state of",
    "another session and may change under you; ask the user before reading or changing one.",
    "This list is a snapshot from when the session started: run `git status` or",
    "`git worktree list` for the current state.",
    "</pi_web_workspaces>",
  ].join("\n");
}

function describe(workspace: WorkspaceListing): string {
  return workspace.isMain ? `${workspace.label}, the main checkout` : workspace.label;
}

function samePath(left: string, right: string): boolean {
  return left === right;
}
