import type { SessionInfo, Workspace } from "../../shared/apiTypes.js";

/**
 * What a session row says about the checkout it runs in.
 *
 * The row is the only place a user looks to answer "what is this session
 * doing to my repository", so the worktree's branch state belongs next to the
 * session's name rather than in a separate worktree list they have to
 * correlate. `shared` is a real state and says so out loud: a session in the
 * user's own checkout has no isolation, and that is worth seeing.
 */
export type SessionWorktreeState =
  | { readonly kind: "branch"; readonly branch: string }
  | { readonly kind: "detached"; readonly sha: string }
  | { readonly kind: "shared" }
  /** A worktree PI WEB created that is no longer on disk. */
  | { readonly kind: "removed" };

/**
 * The worktree state for one session, from the workspaces its project
 * currently lists.
 *
 * A session whose workspace is not listed at all has nothing to report unless
 * PI WEB created that worktree, in which case its absence is the news.
 */
export function sessionWorktreeState(
  session: Pick<SessionInfo, "worktree" | "cwd">,
  workspaces: readonly Workspace[],
): SessionWorktreeState | undefined {
  const workspace = workspaces.find((candidate) => candidate.path === session.cwd);
  if (workspace === undefined) {
    // A session PI WEB gave a worktree whose worktree is gone is worth saying
    // so: its files are not where the session expects them to be.
    return session.worktree === undefined ? undefined : { kind: "removed" };
  }
  // The main checkout is not a worktree: a session in it has no isolation, and
  // naming the branch it happens to sit on would read as if it had some. The
  // branch is on the checkout's own row, where it belongs.
  if (workspace.isMain) return { kind: "shared" };
  const metadata = workspace.provider?.metadata;
  const branch = isRecord(metadata) ? metadata["branch"] : undefined;
  if (typeof branch === "string" && branch !== "") return { kind: "branch", branch };
  if (isRecord(metadata) && metadata["detached"] === true) {
    const head = metadata["head"];
    return { kind: "detached", sha: typeof head === "string" ? head.slice(0, 7) : "" };
  }
  // A checkout the session works in directly: the main one, a plain folder, or
  // anything the provider cannot describe a branch for.
  return { kind: "shared" };
}

/** The short label a session row shows for its worktree state. */
export function sessionWorktreeStateLabel(state: SessionWorktreeState): string {
  switch (state.kind) {
    case "branch":
      return state.branch;
    case "detached":
      return state.sha === "" ? "detached" : `detached@${state.sha}`;
    case "removed":
      return "worktree removed";
    case "shared":
      return "shared";
  }
}

/** Longer text for the row's tooltip, naming the checkout in question. */
export function sessionWorktreeStateTitle(state: SessionWorktreeState, path: string): string {
  switch (state.kind) {
    case "branch":
      return `Branch ${state.branch} in ${path}`;
    case "detached":
      return `Detached HEAD in ${path}`;
    case "removed":
      return `This session's worktree (${path}) is no longer on disk`;
    case "shared":
      return `No worktree of its own: this session works directly in ${path}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
