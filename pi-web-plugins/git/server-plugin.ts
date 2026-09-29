import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type {
  PiWebServerPlugin,
  ProjectInput,
  ProviderClaim,
  ProviderCreateContext,
  ProviderCreationDescriptor,
  ProviderRemoveContext,
  ProviderWorkspace,
  ServerPluginActivationContext,
  ServerPluginExecFileResult,
  WorkspaceCreatePlan,
  WorkspaceProvider,
  WorkspaceRemovePlan,
} from "@jmfederico/pi-web/server-plugin-api";
import { requestGitBackend } from "./git-backend.js";

const GIT_LOCAL_ENV_VARS = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
]);

interface GitWorktreeInfo {
  path: string;
  branch?: string;
  bare?: boolean;
  /** Commit the worktree's HEAD points at, as reported by `git worktree list`. */
  head?: string;
  detached?: boolean;
  prunable?: boolean;
}

const plugin: PiWebServerPlugin = {
  apiVersion: 3,
  name: "Git",
  activate(context) {
    return {
      workspaceProvider: createGitWorkspaceProvider(context),
      peer: { request: (request) => requestGitBackend(context, request) },
    };
  },
};

export default plugin;

export function createGitWorkspaceProvider(context: ServerPluginActivationContext): WorkspaceProvider {
  return Object.freeze({
    fallback: true,
    async probe(project: ProjectInput, signal: AbortSignal): Promise<ProviderClaim> {
      const result = await runGit(context, project.path, ["rev-parse", "--is-inside-work-tree"], signal);
      if (result.signal !== null) throw new Error(`git repository probe ended from signal ${result.signal}`);
      if (result.exitCode !== 0) return "pass";
      return result.stdout.trim() === "true" ? "claim" : "pass";
    },
    async list(project: ProjectInput, signal: AbortSignal): Promise<ProviderWorkspace[]> {
      const rootResult = await requireGit(
        runGit(context, project.path, ["rev-parse", "--show-toplevel"], signal),
        "resolve the Git worktree root",
      );
      const mainRootOutput = rootResult.stdout.trim();
      if (mainRootOutput === "") throw new Error("Git returned an empty worktree root");
      const mainRoot = resolve(mainRootOutput);
      const commonDirectoryResult = await requireGit(
        runGit(context, project.path, ["rev-parse", "--git-common-dir"], signal),
        "resolve the Git common directory",
      );
      const commonDirectoryOutput = commonDirectoryResult.stdout.trim();
      if (commonDirectoryOutput === "") throw new Error("Git returned an empty common directory");
      const commonDirectory = resolve(project.path, commonDirectoryOutput);

      const listResult = await requireGit(
        runGit(context, project.path, ["worktree", "list", "--porcelain", "-z"], signal),
        "list Git worktrees",
      );
      const worktrees = parseGitWorktreeList(listResult.stdout)
        .filter((worktree) => worktree.bare !== true)
        .map((worktree) => {
          const path = resolve(worktree.path);
          return { worktree: { ...worktree, path }, path };
        });
      // Prefer the checkout Git identifies for the registered project. A
      // submodule is the exception: its sole worktree record points at common
      // storage under the superproject instead of at --show-toplevel.
      const mainWorkspacePath = worktrees.some(({ path }) => path === mainRoot)
        ? mainRoot
        : commonDirectory;
      const selectable = worktrees
        .map(({ worktree, path }) => ({ worktree, path, isMain: path === mainWorkspacePath }))
        .filter(({ worktree, path, isMain }) => worktree.prunable !== true || isMain || path === project.path);
      if (selectable.length === 0) return [singleGitWorkspace(project)];

      const removalPresentations = new Map<string, ProviderWorkspace["removal"]>();
      for (const { worktree, path, isMain } of selectable) {
        if (isMain) continue;
        removalPresentations.set(path, await removalPresentation(context, worktree, path, worktreeLabel(worktree, path), signal));
      }

      return selectable.map(({ worktree, path, isMain }) => {
        const label = worktreeLabel(worktree, path);
        return {
          key: path,
          path,
          label,
          isMain,
          data: {
            worktreePath: worktree.path,
            ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
          },
          publicMetadata: {
            isGitRepo: true,
            isGitWorktree: true,
            ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
            ...(worktree.detached === undefined ? {} : { detached: worktree.detached }),
            ...(worktree.head === undefined ? {} : { head: worktree.head }),
          },
          ...(isMain ? {} : { removal: removalPresentations.get(path) ?? gitRemovalPresentation(label, path) }),
        };
      });
    },
    async describeCreation(project: ProjectInput, signal: AbortSignal): Promise<ProviderCreationDescriptor> {
      return { actionLabel: "New worktree", defaultBaseRef: await resolveDefaultBaseRef(context, project.path, signal) };
    },
    async prepareCreate({ source, request, signal }: ProviderCreateContext): Promise<WorkspaceCreatePlan> {
      const path = resolve(request.path);
      if (await pathExists(path)) {
        throw new Error(`A file or directory already exists at ${path}`);
      }
      // A host that does not choose a base gets the repository's own default,
      // so a session's worktree starts where the project starts.
      const baseRef = request.baseRef ?? await resolveDefaultBaseRef(context, source.path, signal);
      const resolved = await runGit(context, source.path, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], signal);
      if (resolved.signal !== null) throw new Error(`git rev-parse ended from signal ${resolved.signal}`);
      if (resolved.exitCode !== 0 || resolved.stdout.trim() === "") {
        throw new Error(`${baseRef} does not resolve to a commit`);
      }
      const shortHead = resolved.stdout.trim().slice(0, 7);
      const command = `git worktree add --detach ${shellQuote(path)} ${shellQuote(baseRef)}`;
      return {
        title: `Create worktree: ${basename(path) || path}`,
        command,
        path,
        label: `detached@${shortHead}`,
        confirmation: [
          `Create a Git worktree at ${path}?`,
          "",
          `It starts detached at ${baseRef} (${shortHead}). Nothing is committed to a branch:` ,
          "check out a branch, or create one, when the work has a direction.",
          "",
          "This will run:",
          command,
        ].join("\n"),
      };
    },
    async prepareRemove({ project, workspace, signal }: ProviderRemoveContext): Promise<WorkspaceRemovePlan> {
      const privatePath = gitPrivateWorktreePath(workspace);
      if (resolve(privatePath) !== workspace.path) {
        throw new Error("Git workspace removal data no longer matches the current workspace path");
      }
      const listResult = await requireGit(
        runGit(context, project.path, ["worktree", "list", "--porcelain", "-z"], signal),
        "validate the Git worktree before removal",
      );
      const current = parseGitWorktreeList(listResult.stdout)
        .find((worktree) => resolve(worktree.path) === workspace.path);
      if (current === undefined || current.prunable === true) {
        throw new Error("Git worktree is no longer available for removal");
      }
      if (current.bare === true) throw new Error("A bare Git workspace cannot be removed as a linked worktree");
      return {
        title: `Delete workspace: ${workspace.label}`,
        command: `git worktree remove ${shellQuote(workspace.path)}`,
      };
    },
  });
}

/**
 * Removal wording for one linked worktree. A detached worktree can hold commits
 * no branch points at, and deleting the worktree takes its reflog with them, so
 * the confirmation says so while the user is still choosing: this text is what
 * the host binds the confirmation to, and the plan runs after it is confirmed.
 */
async function removalPresentation(
  context: ServerPluginActivationContext,
  worktree: GitWorktreeInfo,
  path: string,
  label: string,
  signal: AbortSignal,
): Promise<NonNullable<ProviderWorkspace["removal"]>> {
  const unanchored = worktree.detached === true && path !== ""
    ? await countUnanchoredCommits(context, path, signal)
    : 0;
  if (unanchored === 0) return gitRemovalPresentation(label, path);
  const commits = `${String(unanchored)} commit${unanchored === 1 ? "" : "s"}`;
  return {
    actionLabel: "Delete workspace",
    confirmation: [
      `Delete workspace ${label}?`,
      "",
      "This will run git worktree remove and delete:",
      path,
      "",
      `This worktree is detached and holds ${commits} that no branch points at.`,
      "Deleting it deletes them: nothing else reaches them, and this worktree's",
      "reflog goes with it.",
      "",
      "The Git branch will not be deleted.",
    ].join("\n"),
  };
}

async function countUnanchoredCommits(
  context: ServerPluginActivationContext,
  worktreePath: string,
  signal: AbortSignal,
): Promise<number> {
  const result = await runGit(context, worktreePath, ["rev-list", "--count", "HEAD", "--not", "--branches"], signal);
  const count = result.exitCode === 0 ? Number.parseInt(result.stdout.trim(), 10) : Number.NaN;
  return Number.isInteger(count) && count > 0 ? count : 0;
}

/**
 * The base ref a new worktree starts from: the remote's default branch when the
 * repository records one, else the current branch of the checkout the project
 * is registered at, else `HEAD`.
 */
async function resolveDefaultBaseRef(
  context: ServerPluginActivationContext,
  projectPath: string,
  signal: AbortSignal,
): Promise<string> {
  const remoteHead = await runGit(context, projectPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], signal);
  const remote = remoteHead.exitCode === 0 ? remoteHead.stdout.trim() : "";
  if (remote !== "") {
    const branch = remote.includes("/") ? remote.slice(remote.indexOf("/") + 1) : remote;
    if (branch !== "") return branch;
  }
  const current = await runGit(context, projectPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
  const branch = current.exitCode === 0 ? current.stdout.trim() : "";
  return branch === "" ? "HEAD" : branch;
}

async function pathExists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false);
}

/** Parse `git worktree list --porcelain -z` without path quoting or space loss. */
export function parseGitWorktreeList(stdout: string): GitWorktreeInfo[] {
  return stdout.split("\0\0").flatMap((record) => {
    if (record === "") return [];
    const info: GitWorktreeInfo = { path: "" };
    for (const field of record.split("\0")) {
      const separator = field.indexOf(" ");
      const key = separator === -1 ? field : field.slice(0, separator);
      const value = separator === -1 ? "" : field.slice(separator + 1);
      if (key === "worktree") info.path = value;
      else if (key === "branch") info.branch = value.replace(/^refs\/heads\//u, "");
      else if (key === "HEAD") info.head = value;
      else if (key === "bare") info.bare = true;
      else if (key === "detached") info.detached = true;
      else if (key === "prunable") info.prunable = true;
    }
    return info.path === "" ? [] : [info];
  });
}

function singleGitWorkspace(project: ProjectInput): ProviderWorkspace {
  return {
    key: project.path,
    path: project.path,
    label: project.name,
    isMain: true,
    data: { worktreePath: project.path },
    publicMetadata: { isGitRepo: true, isGitWorktree: false },
  };
}

function gitRemovalPresentation(label: string, path: string): NonNullable<ProviderWorkspace["removal"]> {
  return {
    actionLabel: "Delete workspace",
    confirmation: `Delete workspace ${label}?\n\nThis will run git worktree remove and delete:\n${path}\n\nThe Git branch will not be deleted.`,
  };
}

function gitPrivateWorktreePath(workspace: ProviderWorkspace): string {
  const data = workspace.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Git workspace removal data is unavailable");
  }
  const path: unknown = Reflect.get(data, "worktreePath");
  if (typeof path !== "string" || path === "") throw new Error("Git worktree path is unavailable for removal");
  return path;
}

/**
 * A detached worktree has no branch to name it, and "detached" alone cannot
 * tell two of them apart in a list, so the commit it points at is part of its
 * identity. Every surface that names a worktree uses this one label.
 */
function worktreeLabel(worktree: GitWorktreeInfo, path: string): string {
  return worktree.branch
    ?? (worktree.detached === true ? `detached@${shortOid(worktree.head)}` : basename(path) || path);
}

function shortOid(head: string | undefined): string {
  return head === undefined || head === "" ? "unknown" : head.slice(0, 7);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runGit(
  context: ServerPluginActivationContext,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<ServerPluginExecFileResult> {
  const result = await context.execFile({
    file: "git",
    args: ["-C", cwd, ...args],
    unsetEnv: GIT_LOCAL_ENV_VARS,
    signal,
  });
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new Error(`git ${args.join(" ")} exceeded the host output limit`);
  }
  return result;
}

async function requireGit(
  resultPromise: Promise<ServerPluginExecFileResult>,
  action: string,
): Promise<ServerPluginExecFileResult> {
  const result = await resultPromise;
  if (result.signal === null && result.exitCode === 0) return result;
  const detail = result.stderr.trim();
  const outcome = result.signal === null ? `exit ${String(result.exitCode)}` : `signal ${result.signal}`;
  throw new Error(`Unable to ${action} (${outcome})${detail === "" ? "" : `: ${detail}`}`);
}
