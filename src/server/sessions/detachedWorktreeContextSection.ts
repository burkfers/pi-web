import type { SessionDetachment, WorkspaceListing } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import { sessionDetachmentFromHeader } from "./sessionWorktreeOwnership.js";

export interface DetachedWorktreeSectionDeps {
  listProjects(): Promise<Project[]>;
  listWorkspaces(project: Project): Promise<WorkspaceListing[]>;
  warn(message: string, error: unknown): void;
}

/**
 * System-prompt section telling a resumed session what happened to its worktree
 * while it was parked.
 *
 * Archiving a session releases the branch its worktree was holding, so the
 * worktree the agent comes back to is sitting at a commit with no branch
 * attached. That is invisible from the working directory — `git status` reports
 * a clean detached HEAD — and it is exactly the state in which an agent's next
 * move, committing, silently writes to nothing.
 *
 * The branch is named because the agent is the one who knows what it was doing
 * on it, and told it may have moved, because time passed while the session was
 * parked. The section states the boundary and stops: reattaching, or starting
 * a new branch, is the agent's call once it knows the state.
 *
 * Appears only for a worktree that is detached *now* and has a recorded
 * detachment. A worktree the agent reattached itself says nothing here, and
 * neither does one that was never released.
 */
export async function detachedWorktreePromptSection(
  cwd: string,
  header: unknown,
  deps: DetachedWorktreeSectionDeps,
): Promise<string[]> {
  const detachment = sessionDetachmentFromHeader(header);
  if (detachment === undefined) return [];
  try {
    const current = await currentDetachment(cwd, deps);
    if (current === undefined) return [];
    return [detachedSection(current, detachment)];
  } catch (error) {
    // The section improves a prompt; no session depends on it.
    deps.warn("Failed to describe the session's detached worktree for its system prompt", error);
    return [];
  }
}

/** The worktree's present branch state, or undefined when it is not detached. */
async function currentDetachment(
  cwd: string,
  deps: DetachedWorktreeSectionDeps,
): Promise<{ head?: string } | undefined> {
  for (const project of await deps.listProjects()) {
    for (const workspace of await deps.listWorkspaces(project)) {
      if (workspace.path !== cwd) continue;
      const metadata = workspace.provider?.metadata;
      if (!isRecord(metadata)) return undefined;
      // `detached: true` is the provider's own answer; a workspace with no
      // provider metadata at all is not a worktree this section can speak for.
      if (metadata["detached"] !== true) return undefined;
      const head = metadata["head"];
      return { ...(typeof head === "string" && head !== "" ? { head } : {}) };
    }
  }
  return undefined;
}

function detachedSection(current: { head?: string }, detachment: SessionDetachment): string {
  const shortHead = current.head?.slice(0, 7) ?? detachment.detachedAt.slice(0, 7);
  return [
    "<pi_web_detached_worktree>",
    "This session's worktree was archived and has since been released from its branch:",
    `- It is detached at ${shortHead}.`,
    `- It was last attached to ${detachment.detachedFrom}, which may have moved or been deleted since.`,
    "Check `git status` and `git log --oneline -5` before you rely on this history, and check out",
    `${detachment.detachedFrom} again — or create a new branch for the work — before you commit.`,
    "Committing here without a branch would leave the commits reachable only from this worktree.",
    "</pi_web_detached_worktree>",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
