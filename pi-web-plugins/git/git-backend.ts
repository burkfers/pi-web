import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  JsonValue,
  ServerPluginActivationContext,
  ServerPluginPeerRequestContext,
  ServerPluginExecFileResult,
} from "@jmfederico/pi-web/server-plugin-api";
import {
  GIT_BRANCHES_OPERATION,
  GIT_COMMIT_OPERATION,
  GIT_DIFF_OPERATION,
  GIT_HISTORY_OPERATION,
  GIT_STATUS_OPERATION,
  type GitBranch,
  type GitBranchesResponse,
  type GitCommit,
  type GitCommitDetailResponse,
  type GitCommitFile,
  type GitDiffResponse,
  type GitFileState,
  type GitHistoryResponse,
  type GitStatusFile,
  type GitStatusResponse,
} from "./browser/git-contract.js";

export { GIT_DIFF_OPERATION, GIT_STATUS_OPERATION } from "./browser/git-contract.js";
export type { GitDiffResponse, GitStatusResponse } from "./browser/git-contract.js";

const GIT_COMMAND_TIMEOUT_MS = 10_000;
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

type RunGit = (cwd: string, args: readonly string[]) => Promise<GitCommandResult>;

interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

interface ValidatedSubmodule {
  path: string;
  cwd: string;
}

/** Dispatch the Git status/diff schema through the package peer request seam. */
export async function requestGitBackend(
  activationContext: ServerPluginActivationContext,
  request: ServerPluginPeerRequestContext,
): Promise<JsonValue> {
  const runGit = createGitRunner(activationContext, request.signal);
  if (request.operation === GIT_STATUS_OPERATION) {
    requireStatusInput(request.input);
    return statusPeerResponse(await gitStatusWithRunner(runGit, request.workspace.path));
  }
  if (request.operation === GIT_DIFF_OPERATION) {
    return diffPeerResponse(await gitDiffWithRunner(runGit, request.workspace.path, parseDiffInput(request.input)));
  }
  if (request.operation === GIT_HISTORY_OPERATION) {
    return historyPeerResponse(await gitHistoryWithRunner(runGit, request.workspace.path, parseHistoryInput(request.input)));
  }
  if (request.operation === GIT_COMMIT_OPERATION) {
    return commitPeerResponse(await gitCommitWithRunner(runGit, request.workspace.path, parseCommitInput(request.input)));
  }
  if (request.operation === GIT_BRANCHES_OPERATION) {
    requireBranchesInput(request.input);
    return branchesPeerResponse(await gitBranchesWithRunner(runGit, request.workspace.path));
  }
  throw new Error(`Unsupported Git workspace backend operation: ${request.operation}`);
}

/**
 * A submodule row parsed from the superproject status. `git status` reports a
 * submodule as a single path with an `S<c><m><u>` flag field (commit changed /
 * modified tracked content / untracked content) but never lists the files that
 * changed inside it, so we recurse in `expandSubmodules`.
 */
interface SubmoduleRecord {
  path: string;
  index: GitFileState;
  workingTree: GitFileState;
  commitChanged: boolean;
  hasModifiedContent: boolean;
  hasUntrackedContent: boolean;
  headOid: string;
  indexOid: string;
}

interface ParsedStatus {
  isGitRepo: true;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files: GitStatusFile[];
  submodules: SubmoduleRecord[];
}

export async function gitStatus(
  context: ServerPluginActivationContext,
  cwd: string,
  signal: AbortSignal,
): Promise<GitStatusResponse> {
  return gitStatusWithRunner(createGitRunner(context, signal), cwd);
}

async function gitStatusWithRunner(runGit: RunGit, cwd: string): Promise<GitStatusResponse> {
  const result = await runGit(cwd, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"]);
  if (result.code !== 0) return { isGitRepo: false, hash: hash(result.stdout + result.stderr), files: [], submodules: [] };
  const parsed = parseStatus(result.stdout, { deferSubmodules: true });
  return expandSubmodules(runGit, cwd, parsed, result.stdout);
}

/**
 * Merge each dirty submodule's own changes into the flat file list. A moved
 * commit pointer becomes a single entry keyed by the submodule path (carrying
 * the short SHAs for display); modified/untracked content is listed as regular
 * entries under `<submodule>/<inner path>`. A plain `-dirty` pointer (commit
 * unchanged) is intentionally not surfaced as a pointer entry.
 */
async function expandSubmodules(runGit: RunGit, cwd: string, parsed: ParsedStatus, topRaw: string): Promise<GitStatusResponse> {
  // Fan out concurrently — one `git status` per dirty submodule plus one
  // `git rev-parse` per unstaged pointer move — then concatenate in input
  // order so the file list and hash are identical to a serial pass.
  const canonicalRoot = parsed.submodules.length === 0 ? undefined : await canonicalPath(cwd);
  const expanded = await Promise.all(parsed.submodules.map(async (sub) => {
    const location = canonicalRoot === undefined
      ? undefined
      : await validatedSubmodule(runGit, cwd, canonicalRoot, sub.path);
    return { path: sub.path, ...(await expandSubmodule(runGit, sub, location)) };
  }));

  const files: GitStatusFile[] = [...parsed.files];
  const dirtySubmodulePaths: string[] = [];
  let extraForHash = "";
  for (const part of expanded) {
    dirtySubmodulePaths.push(part.path);
    files.push(...part.files);
    extraForHash += part.extraForHash;
  }

  return {
    isGitRepo: true,
    hash: hash(topRaw + extraForHash),
    ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
    ...(parsed.upstream === undefined ? {} : { upstream: parsed.upstream }),
    ...(parsed.ahead === undefined ? {} : { ahead: parsed.ahead }),
    ...(parsed.behind === undefined ? {} : { behind: parsed.behind }),
    files,
    submodules: dirtySubmodulePaths,
  };
}

/** Expand one dirty submodule: the pointer entry first, then its inner files. */
async function expandSubmodule(
  runGit: RunGit,
  sub: SubmoduleRecord,
  location: ValidatedSubmodule | undefined,
): Promise<{ files: GitStatusFile[]; extraForHash: string }> {
  const files: GitStatusFile[] = [];
  let extraForHash = "";
  if (sub.commitChanged) {
    files.push({
      path: sub.path,
      index: sub.index,
      workingTree: sub.workingTree,
      submoduleFromCommit: displayFromCommit(sub.headOid),
      submoduleToCommit: short(await resolveSubmoduleToCommit(runGit, location?.cwd, sub)),
    });
  }
  if ((sub.hasModifiedContent || sub.hasUntrackedContent) && location !== undefined) {
    const inner = await runGit(location.cwd, ["status", "--porcelain=v2", "--untracked-files=all", "-z"]);
    if (inner.code === 0) {
      extraForHash = `\0${sub.path}\0${inner.stdout}`;
      const innerFiles = parseStatus(inner.stdout, { deferSubmodules: false }).files;
      for (const file of innerFiles) {
        files.push({
          ...file,
          path: `${sub.path}/${file.path}`,
          ...(file.oldPath === undefined ? {} : { oldPath: `${sub.path}/${file.oldPath}` }),
        });
      }
    }
    // non-zero exit: uninitialized / unreadable submodule — skip silently
  }
  return { files, extraForHash };
}

async function resolveSubmoduleToCommit(runGit: RunGit, cwd: string | undefined, sub: SubmoduleRecord): Promise<string> {
  // Staged pointer moves already expose the new commit as the index OID; an
  // unstaged move only records the old OID, so read the validated submodule's
  // HEAD. An unavailable checkout cannot safely supply a different pointer.
  if (sub.indexOid !== sub.headOid || cwd === undefined) return sub.indexOid;
  const head = await runGit(cwd, ["rev-parse", "HEAD"]);
  const resolved = head.stdout.trim();
  return head.code === 0 && resolved !== "" ? resolved : sub.indexOid;
}

export async function gitDiff(
  context: ServerPluginActivationContext,
  cwd: string,
  options: { path?: string; staged?: boolean },
  signal: AbortSignal,
): Promise<GitDiffResponse> {
  return gitDiffWithRunner(createGitRunner(context, signal), cwd, options);
}

async function gitDiffWithRunner(runGit: RunGit, cwd: string, options: { path?: string; staged?: boolean }): Promise<GitDiffResponse> {
  const staged = options.staged === true;
  let path: string | undefined;
  if (options.path !== undefined && options.path !== "") path = normalizeRelativePath(options.path);

  if (path !== undefined) {
    const owner = await submoduleForPath(runGit, cwd, path);
    if (owner !== undefined) return submoduleDiff(runGit, owner, path, staged);
  }

  const args = ["diff", "--no-ext-diff", "--color=never"];
  if (staged) args.push("--cached");
  if (path !== undefined) args.push("--", path);

  const result = await runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git diff failed");
  if (!staged && path !== undefined && result.stdout === "" && await isUntracked(runGit, cwd, path)) {
    const untracked = await runGit(cwd, ["diff", "--no-ext-diff", "--color=never", "--no-index", "/dev/null", "--", path]);
    if (untracked.code !== 0 && untracked.code !== 1) throw new Error(untracked.stderr.trim() || "git diff failed");
    return { path, staged, hash: hash(untracked.stdout), diff: untracked.stdout, truncated: untracked.truncated };
  }
  return { ...(path === undefined ? {} : { path }), staged, hash: hash(result.stdout), diff: result.stdout, truncated: result.truncated };
}

/**
 * Run the diff inside the owning submodule's working tree, since `git diff` at
 * the superproject root never shows content changes below a submodule boundary.
 * The response path stays the full superproject-relative path so the viewer and
 * the selected row line up.
 */
async function submoduleDiff(runGit: RunGit, owner: ValidatedSubmodule, path: string, staged: boolean): Promise<GitDiffResponse> {
  const subCwd = owner.cwd;
  const rel = normalizeRelativePath(path.slice(owner.path.length + 1));

  const args = ["diff", "--no-ext-diff", "--color=never"];
  if (staged) args.push("--cached");
  args.push("--", rel);

  const result = await runGit(subCwd, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git diff failed");
  if (!staged && result.stdout === "" && await isUntracked(runGit, subCwd, rel)) {
    const untracked = await runGit(subCwd, ["diff", "--no-ext-diff", "--color=never", "--no-index", "/dev/null", "--", rel]);
    if (untracked.code !== 0 && untracked.code !== 1) throw new Error(untracked.stderr.trim() || "git diff failed");
    return { path, staged, hash: hash(untracked.stdout), diff: untracked.stdout, truncated: untracked.truncated };
  }
  return { path, staged, hash: hash(result.stdout), diff: result.stdout, truncated: result.truncated };
}

export interface GitHistoryOptions {
  scope?: "all" | "current" | "branch";
  ref?: string;
  limit?: number;
}

export async function gitHistory(
  context: ServerPluginActivationContext,
  cwd: string,
  options: GitHistoryOptions,
  signal: AbortSignal,
): Promise<GitHistoryResponse> {
  return gitHistoryWithRunner(createGitRunner(context, signal), cwd, options);
}

async function gitHistoryWithRunner(runGit: RunGit, cwd: string, options: GitHistoryOptions): Promise<GitHistoryResponse> {
  const scope = options.scope ?? "all";
  const limit = options.limit ?? 100;
  const statusRevision = scope === "branch" ? options.ref ?? "HEAD" : "HEAD";
  let revision: string | undefined;
  if (scope === "current") revision = "HEAD";
  if (scope === "branch") revision = options.ref;
  if (scope === "branch" && revision === undefined) throw new Error("Git branch history requires a ref");
  if (revision !== undefined && revision !== "HEAD") {
    const resolved = await runGit(cwd, ["rev-parse", "--verify", `${revision}^{commit}`]);
    if (resolved.code !== 0 || resolved.stdout.trim() === "") throw new Error(resolved.stderr.trim() || "Unable to resolve branch history");
    revision = resolved.stdout.trim();
  }
  const args = ["log", `-n${String(Math.min(Math.max(limit, 1), 200))}`, "--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%P%x00%D%x00%B%x00"];
  if (scope === "all") args.push("--all");
  else if (revision !== undefined) args.push(revision);
  const result = await runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git log failed");
  const commits = parseHistoryRecords(result.stdout);
  await classifyCommitStatuses(runGit, cwd, commits, statusRevision);
  return { commits, truncated: result.truncated };
}

export async function gitCommit(
  context: ServerPluginActivationContext,
  cwd: string,
  oid: string,
  signal: AbortSignal,
): Promise<GitCommitDetailResponse> {
  return gitCommitWithRunner(createGitRunner(context, signal), cwd, oid);
}

async function gitCommitWithRunner(runGit: RunGit, cwd: string, oid: string): Promise<GitCommitDetailResponse> {
  if (!/^[0-9a-f]{7,64}$/iu.test(oid)) throw new Error("Invalid Git commit id");
  const [metadata, stats, patch] = await Promise.all([
    runGit(cwd, ["show", "-s", "--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%P%x00%D%x00%B%x00", oid]),
    runGit(cwd, ["show", "--format=", "--numstat", "-z", "--no-renames", "--first-parent", oid]),
    runGit(cwd, ["show", "--format=", "--patch", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--first-parent", oid]),
  ]);
  if (metadata.code !== 0) throw new Error(metadata.stderr.trim() || "Unable to read commit");
  if (stats.code !== 0) throw new Error(stats.stderr.trim() || "Unable to read commit stats");
  if (patch.code !== 0) throw new Error(patch.stderr.trim() || "Unable to read commit patch");
  const commit = parseHistoryRecord(metadata.stdout);
  if (commit === undefined) throw new Error("Git returned an empty commit record");
  await classifyCommitStatuses(runGit, cwd, [commit], "HEAD");
  return { commit, files: parseCommitFiles(stats.stdout), patch: patch.stdout, truncated: metadata.truncated || stats.truncated || patch.truncated };
}

export async function gitBranches(
  context: ServerPluginActivationContext,
  cwd: string,
  signal: AbortSignal,
): Promise<GitBranchesResponse> {
  return gitBranchesWithRunner(createGitRunner(context, signal), cwd);
}

async function gitBranchesWithRunner(runGit: RunGit, cwd: string): Promise<GitBranchesResponse> {
  const [refs, worktrees, current] = await Promise.all([
    runGit(cwd, ["for-each-ref", "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:iso-strict)%00%(subject)%00%00", "refs/heads", "refs/remotes"]),
    runGit(cwd, ["worktree", "list", "--porcelain", "-z"]),
    runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  ]);
  if (refs.code !== 0) throw new Error(refs.stderr.trim() || "Unable to list Git branches");
  if (worktrees.code !== 0) throw new Error(worktrees.stderr.trim() || "Unable to list Git worktrees");
  const currentBranch = current.code === 0 ? normalizeBranch(current.stdout.trim()) : undefined;
  const occupancy = parseWorktreeOccupancy(worktrees.stdout, cwd);
  const branches = parseBranchRecords(refs.stdout, currentBranch, occupancy);
  return { branches, ...(currentBranch === undefined ? {} : { currentBranch }), detached: currentBranch === undefined };
}

function parseHistoryRecords(raw: string): GitCommit[] {
  const fields = raw.replaceAll("\0\n", "\0").split("\0");
  const commits: GitCommit[] = [];
  for (let index = 0; index < fields.length; index += 9) {
    const parsed = parseHistoryRecord(fields.slice(index, index + 9).join("\0"));
    if (parsed !== undefined) commits.push(parsed);
  }
  return commits;
}

function parseHistoryRecord(raw: string): GitCommit | undefined {
  const fields = raw.split("\0");
  if (fields.length < 9 || fields[0] === undefined) return undefined;
  const oid = fields.at(0) ?? "";
  const shortOid = fields.at(1) ?? "";
  const authorName = fields.at(2) ?? "";
  const authorEmail = fields.at(3) ?? "";
  const authoredAt = fields.at(4) ?? "";
  const subject = fields.at(5) ?? "";
  const parents = fields.at(6) ?? "";
  const decorations = fields.at(7) ?? "";
  const body = fields.at(8) ?? "";
  return { oid, shortOid, authorName, authorEmail, authoredAt, subject, body, parents: parents === "" ? [] : parents.split(" "), decorations: decorations === "" ? [] : decorations.split(",").map((entry) => entry.trim()).filter((entry) => entry !== ""), status: "neutral" };
}

async function classifyCommitStatuses(runGit: RunGit, cwd: string, commits: GitCommit[], revision: string): Promise<void> {
  if (commits.length === 0) return;
  const [currentResult, upstreamResult, branchesResult] = await Promise.all([
    runGit(cwd, ["rev-list", revision]),
    runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${revision}@{upstream}`]),
    runGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
  ]);
  const current = new Set(currentResult.code === 0 ? currentResult.stdout.split(/\s+/u).filter((oid) => oid !== "") : []);
  const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : "";
  const remoteResult = upstream === "" ? undefined : await runGit(cwd, ["rev-list", upstream]);
  const remote = new Set(remoteResult?.code === 0 ? remoteResult.stdout.split(/\s+/u).filter((oid) => oid !== "") : []);
  const mainRefs = branchesResult.code === 0
    ? branchesResult.stdout.split(/\r?\n/u).filter((name) => ["main", "master", "trunk", "develop"].includes(name))
    : [];
  const main = new Set<string>();
  await Promise.all(mainRefs.map(async (ref) => {
    const result = await runGit(cwd, ["rev-list", ref]);
    if (result.code === 0) for (const oid of result.stdout.split(/\s+/u)) if (oid !== "") main.add(oid);
  }));
  for (const commit of commits) {
    if (!current.has(commit.oid)) commit.status = "neutral";
    else if (main.has(commit.oid)) commit.status = "merged";
    else if (remote.has(commit.oid)) commit.status = "pushed";
    else commit.status = "unpushed";
  }
}

function parseCommitFiles(raw: string): GitCommitFile[] {
  return raw.split("\0").flatMap((record) => {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/u.exec(record);
    if (match === null) return [];
    return [{ added: match[1] === "-" ? 0 : Number(match[1]), deleted: match[2] === "-" ? 0 : Number(match[2]), path: match[3] ?? "" }];
  });
}

function parseBranchRecords(raw: string, currentBranch: string | undefined, occupancy: Map<string, string>): GitBranch[] {
  return raw.split("\n").flatMap((record) => {
    const fields = record.split("\0");
    if (fields.length < 8) return [];
    const [fullName, name, oid, upstream, track, committedAt, subject] = fields;
    if (fullName === undefined || name === undefined || oid === undefined || upstream === undefined || track === undefined || committedAt === undefined || subject === undefined) return [];
    const divergence = parseDivergence(track);
    const checkedOutInWorktree = occupancy.get(name);
    return [{
      name,
      fullName,
      oid,
      isRemote: fullName.startsWith("refs/remotes/"),
      isCurrent: name === currentBranch,
      ...(upstream === "" ? {} : { upstream }),
      ...(divergence ?? {}),
      ...(committedAt === "" ? {} : { committedAt }),
      ...(subject === "" ? {} : { subject }),
      ...(checkedOutInWorktree === undefined ? {} : { checkedOutInWorktree }),
      checkedOutInCurrentWorktree: checkedOutInWorktree !== undefined && checkedOutInWorktree === occupancy.get(`current:${name}`),
    }];
  });
}

function parseDivergence(value: string): { ahead: number; behind: number } | undefined {
  const ahead = /ahead (\d+)/u.exec(value)?.[1];
  const behind = /behind (\d+)/u.exec(value)?.[1];
  return ahead === undefined && behind === undefined ? undefined : { ahead: Number(ahead ?? 0), behind: Number(behind ?? 0) };
}

function parseWorktreeOccupancy(raw: string, cwd: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const record of raw.split("\0\0")) {
    const fields = record.split("\0");
    const worktree = fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
    const branch = fields.find((field) => field.startsWith("branch "))?.slice("branch ".length).replace(/^refs\/heads\//u, "");
    if (branch !== undefined && worktree !== undefined) {
      result.set(branch, worktree);
      if (resolve(worktree) === resolve(cwd)) result.set(`current:${branch}`, worktree);
    }
  }
  return result;
}

async function isUntracked(runGit: RunGit, cwd: string, path: string): Promise<boolean> {
  const result = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", path]);
  return result.code === 0 && result.stdout.split("\0").includes(path);
}

/** Configured direct-submodule paths (depth 1), read from `.gitmodules`. */
async function configuredSubmodulePaths(runGit: RunGit, cwd: string): Promise<string[]> {
  // `-z` emits `<key>\n<value>\0` records; keys may themselves contain spaces
  // (`submodule.my sub.path`), so splitting lines at the first space mangles
  // paths with spaces in them.
  const result = await runGit(cwd, ["config", "-z", "--file", ".gitmodules", "--get-regexp", "^submodule\\..+\\.path$"]);
  if (result.code !== 0) return [];
  const paths: string[] = [];
  for (const record of result.stdout.split("\0")) {
    if (record === "") continue;
    const newlineAt = record.indexOf("\n");
    if (newlineAt === -1) continue;
    try {
      const path = normalizeRelativePath(record.slice(newlineAt + 1));
      if (path !== "") paths.push(path);
    } catch {
      // A malformed repository path is not eligible for submodule routing.
    }
  }
  return [...new Set(paths)];
}

/** The validated gitlink that strictly contains `path`, if any (longest match wins). */
async function submoduleForPath(runGit: RunGit, cwd: string, path: string): Promise<ValidatedSubmodule | undefined> {
  if (!path.includes("/")) return undefined;
  const candidates = (await configuredSubmodulePaths(runGit, cwd))
    .filter((sub) => path.startsWith(`${sub}/`))
    .sort((left, right) => right.length - left.length);
  if (candidates.length === 0) return undefined;

  const canonicalRoot = await canonicalPath(cwd);
  if (canonicalRoot === undefined) return undefined;
  for (const candidate of candidates) {
    const validated = await validatedSubmodule(runGit, cwd, canonicalRoot, candidate);
    if (validated !== undefined) return validated;
  }
  return undefined;
}

/**
 * Confirm that repository-controlled `.gitmodules` data names an index
 * gitlink and that its checkout resolves strictly below the workspace root.
 * Commands use the resolved checkout rather than following the configured
 * path as a symlink.
 */
async function validatedSubmodule(
  runGit: RunGit,
  cwd: string,
  canonicalRoot: string,
  path: string,
): Promise<ValidatedSubmodule | undefined> {
  const index = await runGit(cwd, ["ls-files", "--stage", "-z", "--", path]);
  if (index.code !== 0 || !hasGitlink(index.stdout, path)) return undefined;

  const candidate = await canonicalPath(join(cwd, path));
  if (candidate === undefined || !isStrictDescendant(canonicalRoot, candidate)) return undefined;
  return { path, cwd: candidate };
}

function hasGitlink(raw: string, path: string): boolean {
  return raw.split("\0").some((record) => {
    const separator = record.indexOf("\t");
    if (separator === -1 || record.slice(separator + 1) !== path) return false;
    return record.slice(0, separator).split(" ")[0] === "160000";
  });
}

async function canonicalPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation !== ""
    && relation !== ".."
    && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation);
}

function parseStatus(raw: string, options: { deferSubmodules: boolean }): ParsedStatus {
  const records = raw.split("\0").filter((record) => record !== "");
  const files: GitStatusFile[] = [];
  const submodules: SubmoduleRecord[] = [];
  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record === undefined) continue;
    if (record.startsWith("# branch.head ")) branch = normalizeBranch(record.slice("# branch.head ".length));
    else if (record.startsWith("# branch.upstream ")) upstream = record.slice("# branch.upstream ".length);
    else if (record.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(record);
      if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
    } else if (record.startsWith("? ")) files.push({ path: record.slice(2), index: "untracked", workingTree: "untracked" });
    else if (record.startsWith("! ")) files.push({ path: record.slice(2), index: "ignored", workingTree: "ignored" });
    else if (record.startsWith("1 ")) {
      const parts = record.split(" ");
      const sub = parts[2];
      const path = parts.slice(8).join(" ");
      const index = stateFor(parts[1]?.[0]);
      const workingTree = stateFor(parts[1]?.[1]);
      // A deleted gitlink has no pointer move or inner content to expand (a
      // staged deletion even reports the index OID as all zeros), so keep it
      // as a plain row instead of deferring it as a submodule.
      if (options.deferSubmodules && sub?.startsWith("S") === true && index !== "deleted" && workingTree !== "deleted") {
        const headOid = parts[6] ?? "";
        const indexOid = parts[7] ?? "";
        submodules.push({
          path,
          index,
          workingTree,
          // `c` only flags unstaged moves (submodule HEAD left the index OID);
          // a staged move leaves HEAD == index, so compare the recorded OIDs.
          commitChanged: sub[1] === "C" || headOid !== indexOid,
          hasModifiedContent: sub[2] === "M",
          hasUntrackedContent: sub[3] === "U",
          headOid,
          indexOid,
        });
      } else {
        files.push({ path, index, workingTree });
      }
    } else if (record.startsWith("2 ")) {
      const parts = record.split(" ");
      const path = parts.slice(9).join(" ");
      const oldPath = records[i + 1];
      i += 1;
      files.push({ path, ...(oldPath === undefined ? {} : { oldPath }), index: stateFor(parts[1]?.[0]), workingTree: stateFor(parts[1]?.[1]) });
    } else if (record.startsWith("u ")) {
      const parts = record.split(" ");
      files.push({ path: parts.slice(10).join(" "), index: "conflicted", workingTree: "conflicted" });
    }
  }

  return { isGitRepo: true, ...(branch === undefined ? {} : { branch }), ...(upstream === undefined ? {} : { upstream }), ...(ahead === undefined ? {} : { ahead }), ...(behind === undefined ? {} : { behind }), files, submodules };
}

function stateFor(code: string | undefined): GitFileState {
  if (code === undefined) return "unmodified";
  switch (code) {
    case ".": return "unmodified";
    case "M": return "modified";
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "U": return "conflicted";
    default: return "unmodified";
  }
}

function normalizeBranch(value: string): string | undefined {
  return value === "(detached)" ? undefined : value;
}

function short(oid: string): string {
  return oid.slice(0, 7);
}

/** A newly staged submodule records an all-zero head OID; display the pointer as `new → <sha>`. */
function displayFromCommit(headOid: string): string {
  return /^0+$/.test(headOid) ? "new" : short(headOid);
}

function hash(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function historyPeerResponse(history: GitHistoryResponse): JsonValue {
  return { commits: history.commits.map(commitPeerValue), truncated: history.truncated };
}

function commitPeerResponse(detail: GitCommitDetailResponse): JsonValue {
  return { commit: commitPeerValue(detail.commit), files: detail.files.map((file) => ({ added: file.added, deleted: file.deleted, path: file.path })), patch: detail.patch, truncated: detail.truncated };
}

function branchesPeerResponse(response: GitBranchesResponse): JsonValue {
  return {
    branches: response.branches.map((branch) => ({
      name: branch.name,
      fullName: branch.fullName,
      oid: branch.oid,
      isRemote: branch.isRemote,
      isCurrent: branch.isCurrent,
      ...(branch.upstream === undefined ? {} : { upstream: branch.upstream }),
      ...(branch.ahead === undefined ? {} : { ahead: branch.ahead }),
      ...(branch.behind === undefined ? {} : { behind: branch.behind }),
      ...(branch.committedAt === undefined ? {} : { committedAt: branch.committedAt }),
      ...(branch.subject === undefined ? {} : { subject: branch.subject }),
      ...(branch.checkedOutInWorktree === undefined ? {} : { checkedOutInWorktree: branch.checkedOutInWorktree }),
      checkedOutInCurrentWorktree: branch.checkedOutInCurrentWorktree,
    })),
    ...(response.currentBranch === undefined ? {} : { currentBranch: response.currentBranch }),
    detached: response.detached,
  };
}

function commitPeerValue(commit: GitCommit): JsonValue {
  return {
    oid: commit.oid,
    shortOid: commit.shortOid,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    authoredAt: commit.authoredAt,
    subject: commit.subject,
    body: commit.body,
    parents: commit.parents,
    decorations: commit.decorations,
    status: commit.status,
  };
}

function statusPeerResponse(status: GitStatusResponse): JsonValue {
  return {
    isGitRepo: status.isGitRepo,
    hash: status.hash,
    ...(status.branch === undefined ? {} : { branch: status.branch }),
    ...(status.upstream === undefined ? {} : { upstream: status.upstream }),
    ...(status.ahead === undefined ? {} : { ahead: status.ahead }),
    ...(status.behind === undefined ? {} : { behind: status.behind }),
    files: status.files.map((file) => ({
      path: file.path,
      ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
      index: file.index,
      workingTree: file.workingTree,
      ...(file.submoduleFromCommit === undefined ? {} : { submoduleFromCommit: file.submoduleFromCommit }),
      ...(file.submoduleToCommit === undefined ? {} : { submoduleToCommit: file.submoduleToCommit }),
    })),
    submodules: status.submodules,
  };
}

function diffPeerResponse(diff: GitDiffResponse): JsonValue {
  return {
    ...(diff.path === undefined ? {} : { path: diff.path }),
    staged: diff.staged,
    hash: diff.hash,
    diff: diff.diff,
    truncated: diff.truncated,
  };
}

function createGitRunner(context: ServerPluginActivationContext, signal: AbortSignal): RunGit {
  return async (cwd, args) => commandResult(await context.execFile({
    file: "git",
    args,
    cwd,
    unsetEnv: GIT_LOCAL_ENV_VARS,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    signal,
  }), args);
}

function commandResult(result: ServerPluginExecFileResult, args: readonly string[]): GitCommandResult {
  const command = `git ${args.join(" ")}`;
  if (result.signal !== null) throw new Error(`${command} ended from signal ${result.signal}`);
  if (result.exitCode === null) throw new Error(`${command} ended without an exit code`);
  return {
    code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.stdoutTruncated,
  };
}

function requireStatusInput(input: JsonValue): void {
  if (input !== null) throw new Error("Git status input must be null");
}

function requireBranchesInput(input: JsonValue): void {
  if (input !== null) throw new Error("Git branches input must be null");
}

function parseHistoryInput(input: JsonValue): GitHistoryOptions {
  if (input === null) return {};
  if (!isRecord(input)) throw new Error("Git history input must be an object");
  const unsupported = Object.keys(input).find((key) => key !== "scope" && key !== "ref" && key !== "limit");
  if (unsupported !== undefined) throw new Error(`Git history input contains an unsupported field: ${unsupported}`);
  const scope = input["scope"];
  const ref = input["ref"];
  const limit = input["limit"];
  if (scope !== undefined && scope !== "all" && scope !== "current" && scope !== "branch") throw new Error("Invalid Git history scope");
  if (ref !== undefined && (typeof ref !== "string" || ref.trim() === "")) throw new Error("Git history ref must be a non-empty string");
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)) throw new Error("Git history limit must be an integer from 1 to 200");
  return { ...(scope === undefined ? {} : { scope }), ...(ref === undefined ? {} : { ref }), ...(limit === undefined ? {} : { limit }) };
}

function parseCommitInput(input: JsonValue): string {
  if (!isRecord(input)) throw new Error("Git commit input must be an object");
  const unsupported = Object.keys(input).find((key) => key !== "oid");
  if (unsupported !== undefined) throw new Error(`Git commit input contains an unsupported field: ${unsupported}`);
  const oid = input["oid"];
  if (typeof oid !== "string" || !/^[0-9a-f]{7,64}$/iu.test(oid)) throw new Error("Git commit input oid must be a hexadecimal commit id");
  return oid;
}

function parseDiffInput(input: JsonValue): { path?: string; staged?: boolean } {
  if (!isRecord(input)) throw new Error("Git diff input must be an object");
  const unsupported = Object.keys(input).find((key) => key !== "path" && key !== "staged");
  if (unsupported !== undefined) throw new Error(`Git diff input contains an unsupported field: ${unsupported}`);
  const path = input["path"];
  const staged = input["staged"];
  if (path !== undefined && typeof path !== "string") throw new Error("Git diff input path must be a string");
  if (staged !== undefined && typeof staged !== "boolean") throw new Error("Git diff input staged must be a boolean");
  return {
    ...(path === undefined ? {} : { path }),
    ...(staged === undefined ? {} : { staged }),
  };
}

function normalizeRelativePath(input: string | undefined): string {
  const value = input ?? "";
  if (value === "" || value === ".") return "";
  if (isAbsolute(value)) throw new Error("Absolute paths are not allowed");
  const parts = value.split(/[\\/]+/u).filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error("Path traversal is not allowed");
  return parts.join("/");
}

function isRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
