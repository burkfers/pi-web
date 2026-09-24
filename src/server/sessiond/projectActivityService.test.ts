import { describe, expect, it, vi } from "vitest";
import type { CwdAttribution } from "../status/workspaceAttribution";
import { ProjectActivityService } from "./projectActivityService";

function fakeSessions(entries: { cwd: string; modified: Date }[]) {
  return { listAll: vi.fn().mockResolvedValue(entries) };
}

function fakeArchive(records: { cwd: string; modified?: string; archivedAt: string }[]) {
  return { list: vi.fn().mockResolvedValue(records) };
}

function attributionEntries(map: Record<string, CwdAttribution>) {
  return {
    attribute: (cwds: Iterable<string>) => {
      const result = new Map<string, CwdAttribution>();
      for (const cwd of cwds) {
        const owner = map[cwd];
        if (owner !== undefined) result.set(cwd, owner);
      }
      return Promise.resolve(result);
    },
  };
}

function liveActivity(byCwd: Record<string, string>) {
  return { latestActivityAtByCwd: () => new Map(Object.entries(byCwd)) };
}

describe("ProjectActivityService", () => {
  it("merges transcript listings and the archive store, attributed to their projects", async () => {
    const service = new ProjectActivityService({
      sessions: fakeSessions([
        { cwd: "/repo", modified: new Date("2024-01-02T00:00:00.000Z") },
        { cwd: "/other", modified: new Date("2024-01-01T00:00:00.000Z") },
      ]),
      archiveStore: fakeArchive([
        { cwd: "/repo", modified: "2024-03-01T00:00:00.000Z", archivedAt: "2024-03-02T00:00:00.000Z" },
        { cwd: "/repo", archivedAt: "2024-02-01T00:00:00.000Z" },
      ]),
      attribution: attributionEntries({ "/repo": { projectId: "p1", workspaceId: "w1" }, "/other": { projectId: "p2", workspaceId: "w2" } }),
      workspaceActivity: liveActivity({}),
    });

    expect(await service.snapshot()).toEqual({
      projects: {
        // modified wins over archivedAt when both are present; entries without
        // any timestamp are skipped, and the per-project maximum wins.
        p1: { lastActivityAt: "2024-03-01T00:00:00.000Z" },
        p2: { lastActivityAt: "2024-01-01T00:00:00.000Z" },
      },
    });
  });

  it("raises recency with live session activity, even beyond durable sources", async () => {
    const live = new Map<string, string>();
    const service = new ProjectActivityService({
      sessions: fakeSessions([{ cwd: "/repo", modified: new Date("2024-01-01T00:00:00.000Z") }]),
      archiveStore: fakeArchive([]),
      attribution: attributionEntries({ "/repo": { projectId: "p1", workspaceId: "w1" } }),
      workspaceActivity: { latestActivityAtByCwd: () => live },
    });

    expect(await service.snapshot()).toEqual({ projects: { p1: { lastActivityAt: "2024-01-01T00:00:00.000Z" } } });
    live.set("/repo", "2024-05-01T00:00:00.000Z");
    expect(await service.snapshot()).toEqual({ projects: { p1: { lastActivityAt: "2024-05-01T00:00:00.000Z" } } });
  });

  it("omits cwds that match no known project workspace", async () => {
    const service = new ProjectActivityService({
      sessions: fakeSessions([{ cwd: "/somewhere-else", modified: new Date("2024-01-01T00:00:00.000Z") }]),
      archiveStore: fakeArchive([]),
      attribution: attributionEntries({}),
      workspaceActivity: liveActivity({}),
    });

    expect(await service.snapshot()).toEqual({ projects: {} });
  });

  it("reuses durable recency inside the cache window while reapplying attribution", async () => {
    let now = 1_000;
    const listAll = vi.fn().mockResolvedValue([{ cwd: "/repo", modified: new Date("2024-01-01T00:00:00.000Z") }]);
    const service = new ProjectActivityService({
      sessions: { listAll },
      archiveStore: fakeArchive([]),
      attribution: attributionEntries({ "/repo": { projectId: "p1", workspaceId: "w1" } }),
      workspaceActivity: liveActivity({}),
      cacheTtlMs: 30_000,
      now: () => now,
    });

    await service.snapshot();
    now += 10_000;
    await service.snapshot();
    expect(listAll).toHaveBeenCalledTimes(1);

    now += 21_000; // Past the window.
    await service.snapshot();
    expect(listAll).toHaveBeenCalledTimes(2);
  });
});
