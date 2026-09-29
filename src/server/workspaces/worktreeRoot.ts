import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import type { PiWebConfig } from "../../config.js";
import type { PiWebWorktreesConfig } from "../../shared/apiTypes.js";
import { loadEffectiveProjectWorktreesConfig } from "./projectPiWebConfig.js";

/**
 * Where PI WEB puts the worktrees it creates.
 *
 * A configured root is shared by every project, so each project's worktrees go
 * in a subdirectory named after the repository checkout. That keeps one root
 * usable for all projects without their names colliding, and it is why the
 * repository name is part of the resolved path rather than the config value.
 */
export interface WorktreeRoot {
  /** Directory that holds every project's worktrees. */
  root: string;
  /** This project's worktree directory inside {@link root}. */
  directory: string;
  /** True when the root came from configuration rather than the fallback. */
  configured: boolean;
}

export class WorktreeRootError extends Error {
  override name = "WorktreeRootError";
}

/**
 * Resolve the worktree root for a project: the configured root when there is
 * one, otherwise a `worktrees/<project>` tree beside the checkout itself, so
 * the default never needs configuring and stays outside every workspace.
 */
export function resolveWorktreeRoot(projectPath: string, config: PiWebWorktreesConfig | undefined): WorktreeRoot {
  const project = resolve(projectPath);
  const configuredRoot = config?.root;
  if (configuredRoot === undefined) {
    const parent = parse(project).root === project ? project : resolve(project, "..");
    const root = resolve(parent, "worktrees");
    return { root, directory: resolve(root, parse(project).base), configured: false };
  }
  const root = expandWorktreeRoot(configuredRoot);
  if (parse(root).root === root) throw new WorktreeRootError(`The worktree root cannot be the filesystem root: ${root}`);
  if (isAtOrInside(project, root)) {
    // A worktree inside the checkout it was created from is a nested repo the
    // parent checkout's tooling will keep walking into.
    throw new WorktreeRootError(`The worktree root must not be inside the project checkout: ${root}`);
  }
  return { root, directory: resolve(root, parse(project).base), configured: true };
}

/**
 * The effective worktree directory for a project, reading the project-local
 * config over the machine-global one. Project config is a file read, so this is
 * async while the resolution itself is not.
 */
export async function resolveProjectWorktreeDirectory(projectPath: string, globalConfig: PiWebConfig): Promise<string> {
  const effective = await loadEffectiveProjectWorktreesConfig(projectPath, globalConfig);
  return resolveWorktreeRoot(projectPath, effective).directory;
}

/** Absolute path for a project directory inside the worktree root. */
export function worktreeDirectoryFor(root: WorktreeRoot, name: string): string {
  return resolve(root.directory, name);
}

/**
 * Worktree directory names are generated, never chosen by a person: the name
 * is a placeholder to make a worktree recognizable in a filesystem listing,
 * not information a user is meant to read or remember.
 */
export function generateWorktreeName(): string {
  return `session-${randomBytes(4).toString("hex")}`;
}

function expandWorktreeRoot(root: string): string {
  // Config parsing already normalized the global value; a project-local value
  // or a programmatic caller can still arrive with `~`, and resolving what the
  // user obviously meant beats rejecting it here.
  if (root === "~") return resolve(homedir());
  if (root.startsWith("~/")) return resolve(join(homedir(), root.slice(2)));
  // A relative value reaching this point is a bug in the caller rather than a
  // user mistake, so it resolves against the process directory.
  return resolve(root);
}

/** Whether `target` is `candidate` itself or sits somewhere beneath it. */
function isAtOrInside(candidate: string, target: string): boolean {
  const prefix = candidate.endsWith(sep) ? candidate : `${candidate}${sep}`;
  return target === candidate || target.startsWith(prefix);
}
