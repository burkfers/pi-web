import { readFile, writeFile } from "node:fs/promises";
import type { SessionWorktreeOwnership } from "../../shared/apiTypes.js";

/**
 * PI WEB's own namespaced block in the session file header.
 *
 * The header belongs to the SDK, which writes it once at session creation and
 * never rewrites it. PI WEB writes it in exactly one situation — a fact only
 * PI WEB can know, which the SDK has no field for — and always in place, so the
 * file keeps its path and inode. Anything the SDK or another tool wrote in that
 * header is preserved; only PI WEB's own key is ever changed.
 */
const PI_WEB_HEADER_KEY = "piWeb";

/** Read the worktree-ownership fact from a parsed session header record. */
export function sessionWorktreeOwnershipFromHeader(header: unknown): SessionWorktreeOwnership | undefined {
  if (!isRecord(header)) return undefined;
  const piWeb = header[PI_WEB_HEADER_KEY];
  if (!isRecord(piWeb)) return undefined;
  const worktree = piWeb["worktree"];
  if (!isRecord(worktree)) return undefined;
  if (worktree["owned"] !== true) return undefined;
  const createdAt = worktree["createdAt"];
  if (typeof createdAt !== "string" || createdAt === "") return undefined;
  return { owned: true, createdAt };
}

/**
 * Header rewrites, serialized per file.
 *
 * Every rewrite is a read-modify-write of one line, so two of them racing on
 * the same file — recording worktree ownership while a detach records the
 * branch it left — would let the slower one drop the faster one's key.
 */
const headerRewriteQueues = new Map<string, Promise<unknown>>();

function enqueueHeaderRewrite<T>(sessionFile: string, run: () => Promise<T>): Promise<T> {
  const previous = headerRewriteQueues.get(sessionFile) ?? Promise.resolve();
  // Run even after a failed predecessor: one rejected rewrite must not wedge
  // every later rewrite of the same session file.
  const result = previous.then(run, run);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  headerRewriteQueues.set(sessionFile, settled);
  void settled.then(() => {
    if (headerRewriteQueues.get(sessionFile) === settled) headerRewriteQueues.delete(sessionFile);
  });
  return result;
}

/**
 * Rewrite one session file's header line in place.
 *
 * The mutation receives the parsed header and returns whether anything changed;
 * an unchanged header is not rewritten, because a same-size rewrite is
 * invisible to the listing's size-and-identity memo.
 */
export async function rewriteSessionHeader(
  sessionFile: string,
  mutate: (header: Record<string, unknown>) => boolean,
): Promise<void> {
  await enqueueHeaderRewrite(sessionFile, () => rewriteSessionHeaderNow(sessionFile, mutate));
}

async function rewriteSessionHeaderNow(
  sessionFile: string,
  mutate: (header: Record<string, unknown>) => boolean,
): Promise<void> {
  const content = await readFile(sessionFile, "utf8");
  const newlineIndex = content.indexOf("\n");
  const firstLine = newlineIndex === -1 ? content : content.slice(0, newlineIndex);
  const rest = newlineIndex === -1 ? "" : content.slice(newlineIndex);
  const header: unknown = JSON.parse(firstLine);
  if (!isRecord(header) || header["type"] !== "session") throw new Error("Invalid session file header");
  if (!mutate(header)) return;
  await writeFile(sessionFile, `${JSON.stringify(header)}${rest}`, "utf8");
}

/**
 * Record that PI WEB created this session's worktree. Idempotent: re-recording
 * an existing record keeps the original creation time, so a repeated call can
 * never rewrite history.
 */
export async function recordSessionWorktreeOwnership(
  sessionFile: string,
  ownership: SessionWorktreeOwnership,
): Promise<void> {
  await rewriteSessionHeader(sessionFile, (header) => setWorktreeOwnership(header, ownership));
}

/** Same record, applied to a live runtime's in-memory header. */
export function patchSessionWorktreeOwnershipHeader(
  getHeader: (() => Record<string, unknown> | null | undefined) | undefined,
  ownership: SessionWorktreeOwnership,
): void {
  const header = getHeader?.();
  if (header === undefined || header === null) return;
  setWorktreeOwnership(header, ownership);
}

function setWorktreeOwnership(header: Record<string, unknown>, ownership: SessionWorktreeOwnership): boolean {
  const existing = sessionWorktreeOwnershipFromHeader(header);
  if (existing !== undefined) return false;
  const piWeb = isRecord(header[PI_WEB_HEADER_KEY]) ? { ...header[PI_WEB_HEADER_KEY] } : {};
  piWeb["worktree"] = { owned: true, createdAt: ownership.createdAt };
  header[PI_WEB_HEADER_KEY] = piWeb;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
