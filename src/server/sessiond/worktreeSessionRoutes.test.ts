import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "../../shared/apiTypes.js";
import { WorktreeSessionError, type WorktreeSessionRequest, type WorktreeSessionResult } from "../sessions/worktreeSessionService.js";
import { registerWorktreeSessionRoutes } from "./worktreeSessionRoutes.js";

const CREATED_AT = "2026-03-04T10:00:00.000Z";

let app: FastifyInstance;

beforeEach(() => {
  app = Fastify({ logger: false });
});

afterEach(async () => {
  await app.close();
});

const session = (cwd: string): SessionInfo => ({ id: "s1", path: "/s1.jsonl", cwd, created: CREATED_AT, modified: CREATED_AT, messageCount: 0, firstMessage: "" });

const started: WorktreeSessionResult = { session: session("/worktrees/repo/session-1"), worktree: { path: "/worktrees/repo/session-1" } };

type Start = (request: WorktreeSessionRequest, signal: AbortSignal) => Promise<WorktreeSessionResult>;

function register(start: Start): WorktreeSessionRequest[] {
  const calls: WorktreeSessionRequest[] = [];
  registerWorktreeSessionRoutes(app, {
    start: (request, signal) => {
      calls.push(request);
      return start(request, signal);
    },
  });
  return calls;
}

describe("session daemon worktree session routes", () => {
  it("starts a session with a worktree of its own", async () => {
    const calls = register(() => Promise.resolve(started));

    const response = await app.inject({ method: "POST", url: "/worktree-sessions/projects/project%20one", payload: { workspacePath: "/repo" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(started);
    // A body that omits the opt-out gets the paradigm's default, not a shared
    // start, and the flag is normalized to a boolean either way.
    expect(calls).toEqual([{ projectId: "project one", workspacePath: "/repo", shared: false }]);
  });

  it("passes an explicit opt-out through", async () => {
    const calls = register(() => Promise.resolve({ session: session("/repo"), worktree: null }));

    const response = await app.inject({ method: "POST", url: "/worktree-sessions/projects/project%20one", payload: { workspacePath: "/repo", shared: true } });

    expect(response.statusCode).toBe(200);
    expect(calls[0]?.shared).toBe(true);
  });

  it.each([
    ["a missing workspace path", {}],
    ["an empty workspace path", { workspacePath: "" }],
    ["a relative workspace path", { workspacePath: "repo" }],
    ["a non-boolean opt-out", { workspacePath: "/repo", shared: "yes" }],
    ["an array body", [1, 2]],
  ] satisfies [string, Record<string, unknown> | unknown[]][])("rejects %s", async (_case, payload: Record<string, unknown> | unknown[]) => {
    const calls = register(() => Promise.resolve(started));

    const response = await app.inject({ method: "POST", url: "/worktree-sessions/projects/project%20one", payload });

    expect(response.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("reports a refused start with its own status", async () => {
    register(() => Promise.reject(new WorktreeSessionError("This worktree already has a session", 409)));

    const response = await app.inject({ method: "POST", url: "/worktree-sessions/projects/project%20one", payload: { workspacePath: "/worktrees/repo/session-1" } });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "This worktree already has a session" });
  });

  it("reports an unexpected failure as a server error", async () => {
    register(() => Promise.reject(new Error("socket hang up")));

    const response = await app.inject({ method: "POST", url: "/worktree-sessions/projects/project%20one", payload: { workspacePath: "/repo" } });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "socket hang up" });
  });

  it("hands the service an abort signal it can watch", async () => {
    const signals: AbortSignal[] = [];
    registerWorktreeSessionRoutes(app, {
      start: (_request, signal) => {
        signals.push(signal);
        return Promise.resolve(started);
      },
    });

    await app.inject({ method: "POST", url: "/worktree-sessions/projects/project%20one", payload: { workspacePath: "/repo" } });

    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});
