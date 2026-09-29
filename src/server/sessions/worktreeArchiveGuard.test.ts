import { describe, expect, it, vi } from "vitest";
import type { SessionBulkArchiveResponse, SessionBulkDeleteArchivedResponse, SessionDetachment, SessionInfo } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import type { SessionRouteRef } from "./sessionService.js";
import { withWorktreeArchive, type WorktreeArchiveHost } from "./worktreeArchiveGuard.js";

const PROJECT: Project = { id: "p1", name: "roadmap", path: "/srv/dev/roadmap", createdAt: "2026-01-01T00:00:00.000Z" };
const WORKTREE = "/mnt/worktrees/roadmap/session-1";
const OWNERSHIP = { owned: true, createdAt: "2026-01-01T00:00:00.000Z" } as const;
const DETACHMENT: SessionDetachment = { detachedFrom: "feature-x", detachedAt: "afdd9b8" };

const session = (extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "s1",
  path: "/sessions/s1.jsonl",
  cwd: WORKTREE,
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  messageCount: 0,
  firstMessage: "",
  ...extra,
});

const bulkResult = (ids: string[]): SessionBulkArchiveResponse => ({ archived: true, archivedSessionIds: ids, failures: [], generatedAt: "2026-01-01T00:00:00.000Z" });

const bulkDeleted = (ids: string[]): SessionBulkDeleteArchivedResponse => ({ deleted: true, deletedSessionIds: ids, failures: [], generatedAt: "2026-01-01T00:00:00.000Z" });

interface FakeService {
  list: () => Promise<SessionInfo[]>;
  archive: (ref: SessionRouteRef) => Promise<void>;
  archiveTree: (ref: SessionRouteRef) => Promise<SessionBulkArchiveResponse>;
  archiveMany: (refs: readonly SessionRouteRef[]) => Promise<SessionBulkArchiveResponse>;
  deleteArchivedMany: (refs: readonly SessionRouteRef[]) => Promise<SessionBulkDeleteArchivedResponse>;
  messages: () => Promise<{ messages: string[] }>;
}

interface Harness {
  guard: FakeService;
  detachWorktree: ReturnType<typeof vi.fn>;
  recordDetachment: ReturnType<typeof vi.fn>;
  removeWorktree: ReturnType<typeof vi.fn>;
  removed: string[];
  calls: string[];
}

function harness(options: { sessions?: SessionInfo[]; detach?: () => Promise<SessionDetachment | "already-detached" | "unsupported">; project?: Project | undefined } = {}): Harness {
  const calls: string[] = [];
  const sessions = options.sessions ?? [session({ worktree: OWNERSHIP })];
  const detachWorktree = vi.fn(() => (options.detach ?? (() => Promise.resolve(DETACHMENT)))());
  const recordDetachment = vi.fn((_ref: unknown, detachment: SessionDetachment) => {
    calls.push(`record:${detachment.detachedFrom}`);
    return Promise.resolve();
  });
  const archived: string[] = [];
  const removed: string[] = [];
  const service = {
    list: () => Promise.resolve(sessions),
    archive: (ref: { id: string }) => {
      archived.push(ref.id);
      return Promise.resolve();
    },
    archiveTree: (ref: { id: string }) => {
      archived.push(ref.id);
      return Promise.resolve(bulkResult([ref.id]));
    },
    archiveMany: (refs: readonly { id: string }[]) => {
      const ids = refs.map((ref) => ref.id);
      archived.push(...ids);
      return Promise.resolve(bulkResult(ids));
    },
    deleteArchivedMany: (refs: readonly { id: string }[]) => {
      const ids = refs.map((ref) => ref.id);
      removed.push(...ids);
      return Promise.resolve(bulkDeleted(ids));
    },
    messages: () => Promise.resolve({ messages: ["untouched"] }),
  };

  const removeWorktree = vi.fn((project: Project, workspacePath: string) => {
    calls.push(`remove:${project.id}:${workspacePath}`);
    return Promise.resolve();
  });
  const host: WorktreeArchiveHost = {
    findSession: (ref) => Promise.resolve(sessions.find((candidate) => candidate.id === ref.id)),
    detachWorktree: (project, workspacePath) => {
      calls.push(`detach:${project.id}:${workspacePath}`);
      return detachWorktree();
    },
    projectForWorkspace: () => Promise.resolve("project" in options ? options.project : PROJECT),
    recordDetachment: (ref, detachment) => {
      calls.push(`detach:${ref.id}`);
      return recordDetachment(ref, detachment);
    },
    removeWorktree,
  };

  return {
    guard: withWorktreeArchive(service, host),
    detachWorktree,
    recordDetachment,
    removeWorktree,
    removed,
    calls,
  };
}

describe("worktree archive guard", () => {
  it("releases the worktree from its branch before archiving", async () => {
    const { guard, calls } = harness();

    await guard.archive({ id: "s1", cwd: WORKTREE });

    expect(calls).toEqual([`detach:${PROJECT.id}:${WORKTREE}`, "detach:s1", "record:feature-x"]);
  });

  it("records the branch and commit the worktree was left at", async () => {
    const { guard, recordDetachment } = harness();

    await guard.archive({ id: "s1", cwd: WORKTREE });

    expect(recordDetachment).toHaveBeenCalledWith({ id: "s1", cwd: WORKTREE }, { detachedFrom: "feature-x", detachedAt: "afdd9b8" });
  });

  it("leaves a checkout PI WEB did not create alone", async () => {
    const { guard, detachWorktree } = harness({ sessions: [session()] });

    await guard.archive({ id: "s1", cwd: WORKTREE });

    expect(detachWorktree).not.toHaveBeenCalled();
  });

  it("records nothing when the worktree was already detached", async () => {
    const { guard, recordDetachment, detachWorktree } = harness({ detach: () => Promise.resolve("already-detached") });

    await guard.archive({ id: "s1", cwd: WORKTREE });

    expect(detachWorktree).toHaveBeenCalled();
    expect(recordDetachment).not.toHaveBeenCalled();
  });

  it("records nothing when the provider cannot detach", async () => {
    const { guard, recordDetachment } = harness({ detach: () => Promise.resolve("unsupported") });

    await guard.archive({ id: "s1", cwd: WORKTREE });

    expect(recordDetachment).not.toHaveBeenCalled();
  });

  it("archives even when the worktree cannot be released", async () => {
    const archived: string[] = [];
    const service = {
      list: () => Promise.resolve([session({ worktree: OWNERSHIP })]),
      archive: (ref: SessionRouteRef) => {
        archived.push(ref.id);
        return Promise.resolve();
      },
      archiveTree: (ref: SessionRouteRef) => {
        archived.push(ref.id);
        return Promise.resolve(bulkResult([ref.id]));
      },
      archiveMany: (refs: readonly SessionRouteRef[]) => Promise.resolve(bulkResult(refs.map((ref) => ref.id))),
      deleteArchivedMany: (refs: readonly SessionRouteRef[]) => Promise.resolve(bulkDeleted(refs.map((ref) => ref.id))),
    };
    const guard = withWorktreeArchive(service, {
      findSession: () => Promise.resolve(session({ worktree: OWNERSHIP })),
      detachWorktree: () => Promise.reject(new Error("index.lock exists")),
      projectForWorkspace: () => Promise.resolve(PROJECT),
      recordDetachment: () => Promise.resolve(),
      removeWorktree: () => Promise.resolve(),
    });

    await expect(guard.archive({ id: "s1", cwd: WORKTREE })).resolves.toBeUndefined();

    // Parking a session is not contingent on a branch being free: the user
    // asked to archive, and the archive happened.
    expect(archived).toEqual(["s1"]);
  });

  it("releases every worktree in a bulk archive", async () => {
    const { guard, detachWorktree } = harness({
      sessions: [session({ worktree: OWNERSHIP }), session({ id: "s2", worktree: OWNERSHIP })],
    });

    await guard.archiveMany([{ id: "s1", cwd: WORKTREE }, { id: "s2", cwd: WORKTREE }]);

    expect(detachWorktree).toHaveBeenCalledTimes(2);
  });

  it("covers the tree archive path too", async () => {
    const { guard, detachWorktree } = harness();

    await guard.archiveTree({ id: "s1", cwd: WORKTREE });

    expect(detachWorktree).toHaveBeenCalledTimes(1);
  });

  it("removes the worktree of a deleted session", async () => {
    const { guard, removeWorktree, removed } = harness();

    await guard.deleteArchivedMany([{ id: "s1", cwd: WORKTREE }]);

    expect(removed).toEqual(["s1"]);
    expect(removeWorktree).toHaveBeenCalledWith(PROJECT, WORKTREE);
  });

  it("never removes a worktree for a session in a checkout PI WEB did not create", async () => {
    const { guard, removeWorktree } = harness({ sessions: [session()] });

    await guard.deleteArchivedMany([{ id: "s1", cwd: WORKTREE }]);

    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("removes the worktree after the delete, never before it", async () => {
    const order: string[] = [];
    const service = {
      list: () => Promise.resolve([session({ worktree: OWNERSHIP })]),
      archive: () => Promise.resolve(),
      archiveTree: () => Promise.resolve(bulkResult([])),
      archiveMany: () => Promise.resolve(bulkResult([])),
      deleteArchivedMany: (refs: readonly SessionRouteRef[]) => {
        order.push(`delete:${String(refs.length)}`);
        return Promise.resolve(bulkDeleted(["s1"]));
      },
    };
    const guard = withWorktreeArchive(service, {
      findSession: () => Promise.resolve(session({ worktree: OWNERSHIP })),
      detachWorktree: () => Promise.resolve("already-detached"),
      projectForWorkspace: () => Promise.resolve(PROJECT),
      recordDetachment: () => Promise.resolve(),
      removeWorktree: () => {
        order.push("remove");
        return Promise.resolve();
      },
    });

    await guard.deleteArchivedMany([{ id: "s1", cwd: WORKTREE }]);

    // A worktree whose session is still there is recoverable; one deleted
    // before its session is not.
    expect(order).toEqual(["delete:1", "remove"]);
  });

  it("reads what a session owns before deleting it, and nothing after", async () => {
    // After the delete there is no session left to ask which worktree was
    // its own, so the ownership has to be read while it still exists.
    const seen: string[] = [];
    let owned = true;
    const service = {
      list: () => Promise.resolve([]),
      archive: () => Promise.resolve(),
      archiveTree: () => Promise.resolve(bulkResult([])),
      archiveMany: () => Promise.resolve(bulkResult([])),
      deleteArchivedMany: (refs: readonly SessionRouteRef[]) => {
        owned = false;
        return Promise.resolve(bulkDeleted(refs.map((ref) => ref.id)));
      },
    };
    const guard = withWorktreeArchive(service, {
      findSession: () => Promise.resolve(owned ? session({ worktree: OWNERSHIP }) : undefined),
      detachWorktree: () => Promise.resolve("already-detached"),
      projectForWorkspace: () => Promise.resolve(PROJECT),
      recordDetachment: () => Promise.resolve(),
      removeWorktree: (project, path) => {
        seen.push(path);
        return Promise.resolve();
      },
    });

    await guard.deleteArchivedMany([{ id: "s1", cwd: WORKTREE }]);

    expect(seen).toEqual([WORKTREE]);
  });

  it("does not detach for a session the host cannot find", async () => {
    const { guard, detachWorktree } = harness({ sessions: [] });

    await guard.archive({ id: "gone", cwd: WORKTREE });

    expect(detachWorktree).not.toHaveBeenCalled();
  });

  it("does not detach when no project owns the worktree any more", async () => {
    const { guard, detachWorktree } = harness({ project: undefined });

    await guard.archive({ id: "s1", cwd: WORKTREE });

    expect(detachWorktree).not.toHaveBeenCalled();
  });

  it("passes every other route through untouched", async () => {
    const messages = vi.fn((ref: SessionRouteRef) => Promise.resolve({ messages: [ref.id] }));
    const service = {
      list: () => Promise.resolve([]),
      messages,
      archive: () => Promise.resolve(),
      archiveTree: () => Promise.resolve(bulkResult([])),
      archiveMany: (refs: readonly SessionRouteRef[]) => Promise.resolve(bulkResult(refs.map((ref) => ref.id))),
      deleteArchivedMany: (refs: readonly SessionRouteRef[]) => Promise.resolve(bulkDeleted(refs.map((ref) => ref.id))),
    };
    const guard = withWorktreeArchive(service, {
      findSession: () => Promise.resolve(undefined),
      detachWorktree: () => Promise.resolve("already-detached"),
      projectForWorkspace: () => Promise.resolve(PROJECT),
      recordDetachment: () => Promise.resolve(),
      removeWorktree: () => Promise.resolve(),
    });

    await expect(guard.messages({ id: "s1", cwd: WORKTREE })).resolves.toEqual({ messages: ["s1"] });
    expect(messages).toHaveBeenCalledWith({ id: "s1", cwd: WORKTREE });
  });
});
