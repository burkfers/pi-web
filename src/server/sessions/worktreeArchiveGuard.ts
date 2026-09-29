import type { SessionDetachment, SessionInfo } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import type { SessionRouteRef, SessionRouteService } from "./sessionService.js";

/**
 * Parking a session releases the branch its worktree was holding.
 *
 * An archived session is not gone, it is put away: the user expects to come
 * back to it. But a worktree parked on a branch keeps that branch checked out,
 * so the next session that wants the branch is told it is already in use — by
 * a session nobody is looking at. Detaching releases the branch and leaves the
 * working tree untouched, so resuming costs a `switch` rather than a
 * reconciliation.
 *
 * Only a worktree PI WEB created is detached. A checkout the user made is
 * theirs, and archiving a session in it says nothing about its branch.
 */
export interface WorktreeArchiveHost {
  /** The session about to be archived, as the host currently sees it. */
  findSession(ref: SessionRouteRef): Promise<SessionInfo | undefined>;
  /** Release the session's worktree from its branch; resolves once settled. */
  detachWorktree(project: Project, workspacePath: string): Promise<SessionDetachment | "already-detached" | "unsupported">;
  /** The project a workspace belongs to, when the host still knows it. */
  projectForWorkspace(workspacePath: string): Promise<Project | undefined>;
  /** Record the branch a parked session's worktree was detached from. */
  recordDetachment(ref: SessionRouteRef, detachment: SessionDetachment): Promise<void>;
  /** Remove a worktree PI WEB created, with the host's own removal contract. */
  removeWorktree(project: Project, workspacePath: string): Promise<void>;
}

/**
 * The three archive routes this guard covers. Naming them in the constraint is
 * what keeps the guard honest: a caller cannot wrap a service that has none of
 * them and get a wrapper that quietly does nothing.
 */
type ArchiveCapableService = Pick<SessionRouteService, "archive" | "archiveMany" | "archiveTree" | "deleteArchivedMany">;

const ARCHIVE_METHODS: ReadonlySet<string> = new Set<string>(["archive", "archiveMany", "archiveTree"]);
const DELETE_METHODS: ReadonlySet<string> = new Set<string>(["deleteArchivedMany"]);

/**
 * Wrap the session service so archiving detaches and deletion removes.
 *
 * The proxy exists because both are reachable from several routes — one
 * session, a tree, a bulk selection — and they must not be able to drift apart
 * on what happens to the session's worktree. Detachment is best-effort by
 * design: a failure is reported to the user, and the archive still happens,
 * because parking a session is not contingent on a branch being free.
 *
 * Deletion is the other half of the same lifecycle. A worktree PI WEB created
 * for a session exists for that session, so deleting the session removes it —
 * with its uncommitted work, which the confirmation already warns about. This
 * is the only path that removes a worktree, and it only ever removes one PI
 * WEB created: a checkout the user made survives the session that used it.
 */
export function withWorktreeArchive<T extends ArchiveCapableService>(sessions: T, host: WorktreeArchiveHost): T {
  return new Proxy(sessions, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      const isArchive = typeof property === "string" && ARCHIVE_METHODS.has(property);
      const isDelete = typeof property === "string" && DELETE_METHODS.has(property);
      if (typeof value !== "function" || (!isArchive && !isDelete)) {
        return value;
      }
      return (...args: unknown[]): unknown => {
        // The archive or delete itself is invoked *after* the worktree work it
        // depends on, never alongside it: `Reflect.apply` starts the method, so
        // anything awaited afterwards would be racing a session that is already
        // being parked or deleted.
        return (async (): Promise<unknown> => {
          if (isDelete) {
            // Which worktrees these sessions own is read first, because after
            // the delete there is no session left to ask. Removal happens
            // after: a worktree whose session is still there is recoverable,
            // one deleted before its session is not.
            const owned = await ownedWorktreesFor(args[0], host);
            // `Reflect.apply` keeps the receiver, which a spread call would not.
            const result: unknown = await Reflect.apply(value, target, args);
            for (const ownedWorktree of owned) {
              await removeOwnedWorktree(ownedWorktree, host);
            }
            return result;
          }
          // Detach before the archive, not after: the session's file carries
          // the detachment record, and once the session is archived the host
          // reads that record back from the archive instead of the header.
          await releaseWorktreesFor(args[0], host);
          return await Reflect.apply(value, target, args);
        })();
      };
    },
  });
}

/** One worktree, settled on its own so a stubborn one leaves the rest removed. */
async function removeOwnedWorktree(owned: { project: Project; path: string }, host: WorktreeArchiveHost): Promise<void> {
  try {
    await host.removeWorktree(owned.project, owned.path);
  } catch (error: unknown) {
    console.warn(`Failed to remove the worktree of a deleted session: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The worktrees the sessions in a delete request own, resolved while they still exist. */
async function ownedWorktreesFor(target: unknown, host: WorktreeArchiveHost): Promise<{ project: Project; path: string }[]> {
  const owned: { project: Project; path: string }[] = [];
  for (const ref of archiveRefs(target)) {
    const session = await host.findSession(ref);
    if (session?.worktree === undefined) continue;
    const project = await host.projectForWorkspace(session.cwd);
    if (project === undefined) continue;
    owned.push({ project, path: session.cwd });
  }
  return owned;
}

/** Detach every worktree an archive request touches, then let the archive run. */
async function releaseWorktreesFor(target: unknown, host: WorktreeArchiveHost): Promise<void> {
  for (const ref of archiveRefs(target)) {
    // One worktree failing to release must not strand the others, and must not
    // stop the archive: each session is settled on its own.
    await releaseWorktree(ref, host).catch((error: unknown) => {
      console.warn(`Failed to release the worktree for an archived session: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

async function releaseWorktree(ref: SessionRouteRef, host: WorktreeArchiveHost): Promise<void> {
  const session = await host.findSession(ref);
  if (session?.worktree === undefined) return;
  // A session that was already parked and detached has nothing left to give.
  const project = await host.projectForWorkspace(session.cwd);
  if (project === undefined) return;
  const outcome = await host.detachWorktree(project, session.cwd);
  if (outcome === "already-detached" || outcome === "unsupported") return;
  await host.recordDetachment(ref, outcome);
}

/**
 * Every session reference an archive call names. The three archive routes pass
 * their target differently — one ref for a single session or a tree, a list of
 * bulk refs for a selection — and an argument in none of those shapes is left
 * to the archive itself, which remains the authority on what it archives.
 */
function archiveRefs(target: unknown): SessionRouteRef[] {
  if (Array.isArray(target)) return target.flatMap((entry) => archiveRefs(entry));
  if (!isRecord(target) || typeof target["cwd"] !== "string") return [];
  const id = target["id"];
  return typeof id === "string" && id !== "" ? [{ id, cwd: target["cwd"] }] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
