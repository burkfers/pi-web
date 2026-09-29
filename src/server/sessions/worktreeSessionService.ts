import type { PiWebNewSessionWorktreeMode, SessionInfo } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import { generateWorktreeName } from "../workspaces/worktreeRoot.js";
import type { ProviderCreationRequest } from "../workspaces/workspaceCreationService.js";

/**
 * Starting a top-level session in a worktree PI WEB made for it, as one
 * host-owned operation.
 *
 * The ordering is the whole point: the worktree exists before the session does,
 * so the session's `cwd` — immutable for the life of its file — points at an
 * isolated checkout from its first prompt. The reverse order would leave a
 * session recorded against a directory that may never appear.
 */
export interface WorktreeSessionRequest {
  /** The project the session belongs to; its worktree is created beside it. */
  readonly projectId: string;
  /** The checkout the session is opened from. */
  readonly workspacePath: string;
  /**
   * Start in this workspace instead of in a new worktree. The explicit opt-out
   * for quick inspection, branch comparison, and operations work, where
   * isolation would cost more than it buys.
   */
  readonly shared: boolean;
}

export interface WorktreeSessionResult {
  readonly session: SessionInfo;
  /** The worktree PI WEB created for this session; null for a shared start. */
  readonly worktree: { readonly path: string } | null;
}

export class WorktreeSessionError extends Error {
  override name = "WorktreeSessionError";

  constructor(message: string, readonly statusCode = 400, options: ErrorOptions = {}) {
    super(message, options);
  }
}

export interface WorktreeSessionProjectReader {
  requireProject(projectId: string): Promise<Project>;
}

export interface WorktreeSessionCreator {
  preview(project: Project, request: ProviderCreationRequest, signal: AbortSignal): Promise<{ readonly path: string; readonly precondition: string }>;
  create(project: Project, request: ProviderCreationRequest, precondition: string, signal: AbortSignal): Promise<void>;
}

export interface WorktreeSessionLauncher {
  start(cwd: string): Promise<SessionInfo>;
  list(cwd: string): Promise<SessionInfo[]>;
  recordWorktreeOwnership(ref: { readonly id: string; readonly cwd: string }, ownership: { readonly createdAt: string }): Promise<void>;
}

export interface WorktreeSessionHost {
  projects: WorktreeSessionProjectReader;
  creations: WorktreeSessionCreator;
  sessions: WorktreeSessionLauncher;
  /** Whether new sessions in this project get a worktree, from config. */
  newSessionMode(projectPath: string): Promise<PiWebNewSessionWorktreeMode>;
  /** Whether a created worktree is still there, so a failed start can say so. */
  workspaceExists(path: string): Promise<boolean>;
}

export class WorktreeSessionService {
  constructor(private readonly host: WorktreeSessionHost) {}

  async start(request: WorktreeSessionRequest, signal: AbortSignal): Promise<WorktreeSessionResult> {
    const project = await this.host.projects.requireProject(request.projectId);
    const mode = await this.host.newSessionMode(project.path);
    if (request.shared || mode === "never") return await this.startShared(request);
    return await this.startInNewWorktree(project, signal);
  }

  /**
   * A shared start refuses a workspace PI WEB already gave a session of its
   * own. Two top-level sessions in one owned worktree would each believe that
   * worktree was theirs, and archiving or deleting the first would take the
   * second one's files with it.
   *
   * Only a session PI WEB created a worktree for counts: a session in the
   * user's own checkout is an explicit choice, not an owner.
   */
  private async startShared(request: WorktreeSessionRequest): Promise<WorktreeSessionResult> {
    const owner = (await this.host.sessions.list(request.workspacePath)).find((session) => session.worktree !== undefined);
    if (owner !== undefined) {
      throw new WorktreeSessionError(
        `This worktree already has a session (${owner.name ?? owner.id}). Open that session, or delete it before starting another one here.`,
        409,
      );
    }
    return { session: await this.host.sessions.start(request.workspacePath), worktree: null };
  }

  private async startInNewWorktree(project: Project, signal: AbortSignal): Promise<WorktreeSessionResult> {
    // The name is generated rather than chosen: it labels a directory in a
    // filesystem listing, and a person picking it would only invite themselves
    // to treat it as something to remember and recognize.
    const creation: ProviderCreationRequest = { name: generateWorktreeName() };

    // Preview and execute as the two phases they are, within one request: the
    // plan is re-derived at execution, so a repository that moved in between
    // fails the confirmation instead of running a different plan.
    const preview = await this.host.creations.preview(project, creation, signal);
    await this.host.creations.create(project, creation, preview.precondition, signal);

    const worktreePath = preview.path;
    const createdAt = new Date().toISOString();
    try {
      const session = await this.host.sessions.start(worktreePath);
      await this.host.sessions.recordWorktreeOwnership({ id: session.id, cwd: session.cwd }, { createdAt });
      return { session: { ...session, worktree: { owned: true, createdAt } }, worktree: { path: worktreePath } };
    } catch (error) {
      throw await this.orphanedWorktreeError(worktreePath, error);
    }
  }

  /**
   * A worktree that outlived the session it was made for is reported, never
   * deleted. The user asked for an isolated checkout, and whatever the failed
   * start had already put in it may be worth keeping.
   */
  private async orphanedWorktreeError(worktreePath: string, error: unknown): Promise<WorktreeSessionError> {
    const message = error instanceof Error ? error.message : String(error);
    const exists = await this.host.workspaceExists(worktreePath).catch(() => false);
    return new WorktreeSessionError(
      exists
        ? `Could not start the session: ${message} Its worktree was created and left in place at ${worktreePath} — remove it from the workspace list when you no longer need it.`
        : `Could not start the session: ${message}`,
      500,
      { cause: error },
    );
  }
}
