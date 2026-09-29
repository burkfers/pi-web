import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import { WorktreeSessionError, WorktreeSessionService, type WorktreeSessionHost, type WorktreeSessionRequest } from "./worktreeSessionService.js";

const CREATED_AT = "2026-03-04T10:00:00.000Z";
const PROJECT: Project = { id: "p1", name: "roadmap", path: "/srv/dev/roadmap", createdAt: CREATED_AT };

interface HarnessOptions {
  readonly mode?: "always" | "never";
  readonly existingSessions?: SessionInfo[];
  readonly startFailure?: Error;
  readonly worktreeExists?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  let createdPaths: string[] = [];
  const started: { cwd: string }[] = [];
  const ownership: { id: string; cwd: string; createdAt: string }[] = [];

  const host: WorktreeSessionHost = {
    projects: {
      requireProject: (id) => {
        calls.push(`project:${id}`);
        return Promise.resolve(PROJECT);
      },
    },
    creations: {
      preview: (_project, request, signal) => {
        signal.throwIfAborted();
        calls.push(`preview:${request.name}`);
        return Promise.resolve({ path: `/mnt/worktrees/roadmap/${request.name}`, precondition: "v1.preview" });
      },
      create: (_project, request, precondition, signal) => {
        signal.throwIfAborted();
        calls.push(`create:${request.name}:${precondition}`);
        createdPaths = createdPaths.concat(`/mnt/worktrees/roadmap/${request.name}`);
        return Promise.resolve();
      },
    },
    sessions: {
      start: (cwd) => {
        calls.push(`start:${cwd}`);
        if (options.startFailure !== undefined) return Promise.reject(options.startFailure);
        started.push({ cwd });
        const index = String(started.length);
        return Promise.resolve({ id: `s${index}`, path: `/sessions/s${index}.jsonl`, cwd, created: CREATED_AT, modified: CREATED_AT, messageCount: 0, firstMessage: "" });
      },
      list: () => Promise.resolve(options.existingSessions ?? []),
      recordWorktreeOwnership: (ref, own) => {
        calls.push("own");
        ownership.push({ ...ref, createdAt: own.createdAt });
        return Promise.resolve();
      },
    },
    newSessionMode: () => Promise.resolve(options.mode ?? "always"),
    workspaceExists: () => Promise.resolve(options.worktreeExists ?? true),
  };

  // Names are generated, so a test that needs one reads it back out of the
  // recorded calls rather than predicting it.
  return { service: new WorktreeSessionService(host), calls, started, ownership, createdPaths: () => createdPaths };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const listed = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  path: `/sessions/${id}.jsonl`,
  cwd: "/worktrees/repo/session-1",
  created: CREATED_AT,
  modified: CREATED_AT,
  messageCount: 0,
  firstMessage: "",
  ...extra,
});

const request = (overrides: Partial<WorktreeSessionRequest> = {}): WorktreeSessionRequest => ({
  projectId: "p1",
  workspacePath: "/srv/dev/roadmap",
  shared: false,
  ...overrides,
});

describe("WorktreeSessionService", () => {
  it("creates the worktree before the session and records ownership", async () => {
    const { service, calls, started, ownership } = harness();

    const result = await service.start(request(), new AbortController().signal);

    // The order is the invariant: the session's cwd must already exist as a
    // directory by the time the session records it.
    const worktreePath = result.worktree?.path ?? "";
    expect(calls.filter((call) => call.startsWith("preview:") || call.startsWith("create:") || call.startsWith("start:")).map((call) => call.split(":")[0]))
      .toEqual(["preview", "create", "start"]);
    expect(started).toEqual([{ cwd: worktreePath }]);
    expect(ownership[0]?.id).toBe(result.session.id);
    expect(ownership[0]?.cwd).toBe(worktreePath);
    expect(result.session.worktree?.owned).toBe(true);
    expect(typeof result.session.worktree?.createdAt).toBe("string");
  });

  it("generates an opaque worktree name the user never chose", async () => {
    const { service, calls } = harness();

    const result = await service.start(request(), new AbortController().signal);

    const name = calls.find((call) => call.startsWith("preview:"))?.slice("preview:".length) ?? "";
    expect(name).toMatch(/^session-[0-9a-f]{8}$/);
    expect(result.worktree?.path).toBe(`/mnt/worktrees/roadmap/${name}`);
  });

  it("executes the plan it previewed, not a fresh guess", async () => {
    const { service, calls } = harness();

    await service.start(request(), new AbortController().signal);

    const name = calls.find((call) => call.startsWith("preview:"))?.slice("preview:".length) ?? "";
    expect(calls).toContain(`create:${name}:v1.preview`);
  });

  it("starts in the checkout when the caller opts out", async () => {
    const { service, calls, started } = harness();

    const result = await service.start(request({ shared: true }), new AbortController().signal);

    expect(calls.some((call) => call.startsWith("preview:"))).toBe(false);
    expect(started).toEqual([{ cwd: "/srv/dev/roadmap" }]);
    expect(result.worktree).toBeNull();
    expect(result.session.worktree).toBeUndefined();
  });

  it("starts in the checkout when the project is configured to share", async () => {
    const { service, started } = harness({ mode: "never" });

    const result = await service.start(request(), new AbortController().signal);

    expect(started).toEqual([{ cwd: "/srv/dev/roadmap" }]);
    expect(result.worktree).toBeNull();
  });

  it("refuses a second session in a worktree PI WEB owns", async () => {
    const { service, started } = harness({ existingSessions: [listed("s1", { name: "Fix the parser", worktree: { owned: true, createdAt: CREATED_AT } })] });

    await expect(service.start(request({ workspacePath: "/mnt/worktrees/roadmap/session-1", shared: true }), new AbortController().signal))
      .rejects.toThrow(WorktreeSessionError);
    expect(started).toEqual([]);
  });

  it("names the session that already owns the worktree", async () => {
    const { service } = harness({ existingSessions: [listed("s1", { name: "Fix the parser", worktree: { owned: true, createdAt: CREATED_AT } })] });

    await expect(service.start(request({ shared: true }), new AbortController().signal))
      .rejects.toThrow(/Fix the parser/);
  });

  it("allows a second session in a checkout PI WEB did not create", async () => {
    const { service, started } = harness({ existingSessions: [listed("s1")] });

    await service.start(request({ shared: true }), new AbortController().signal);

    expect(started).toEqual([{ cwd: "/srv/dev/roadmap" }]);
  });

  it("leaves a created worktree in place and says where it is when the session cannot start", async () => {
    const { service, createdPaths } = harness({ startFailure: new Error("model provider unavailable") });

    const failure = await service.start(request(), new AbortController().signal).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WorktreeSessionError);
    expect(errorText(failure)).toContain("model provider unavailable");
    // The directory the command created is never deleted behind the user's back.
    expect(createdPaths()).toHaveLength(1);
    expect(errorText(failure)).toContain(createdPaths()[0] ?? "");
  });

  it("does not claim a leftover worktree when it is not there", async () => {
    const { service } = harness({ startFailure: new Error("boom"), worktreeExists: false });

    const failure = await service.start(request(), new AbortController().signal).catch((error: unknown) => error);

    expect(errorText(failure)).not.toContain("left in place");
  });

  it("does not start a creation the caller already cancelled", async () => {
    const controller = new AbortController();
    const { service, calls } = harness();
    controller.abort();

    await expect(service.start(request(), controller.signal)).rejects.toThrow();

    expect(calls.some((call) => call.startsWith("create:"))).toBe(false);
  });
});

describe("WorktreeSessionService name generation", () => {
  it("gives each start its own worktree", async () => {
    const { service } = harness();
    const signal = new AbortController().signal;

    const first = await service.start(request(), signal);
    const second = await service.start(request(), signal);

    expect(first.worktree?.path).not.toBe(second.worktree?.path);
  });
});
