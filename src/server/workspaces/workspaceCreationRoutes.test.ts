import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalCommandRun, WorkspaceCreationPreview } from "../../shared/apiTypes.js";
import type { SessionProxyDaemon } from "../sessiond/sessionProxyRoutes.js";
import { registerWorkspaceCreationRoutes } from "./workspaceCreationRoutes.js";

let app: FastifyInstance;
let daemonRequests: DaemonRequest[];
let daemonResponse: Awaited<ReturnType<SessionProxyDaemon["request"]>>;
let daemonFailure: Error | undefined;

const preview: WorkspaceCreationPreview = {
  path: "/worktrees/repo/review",
  label: "detached@abc1234",
  confirmation: "Create a Git worktree at /worktrees/repo/review?",
  command: "git worktree add --detach '/worktrees/repo/review' 'main'",
  precondition: "v1.confirmed",
};

const run: TerminalCommandRun = {
  id: "run-1",
  origin: "core",
  projectId: "project one",
  workspaceId: "main",
  terminalId: "terminal-1",
  title: "Create worktree: review",
  command: preview.command,
  status: "running",
  createdAt: "2026-07-27T00:00:00.000Z",
  metadata: { "pi.operation": "workspace.create", "target.workspacePath": preview.path },
};

beforeEach(() => {
  app = Fastify({ logger: false });
  daemonRequests = [];
  daemonFailure = undefined;
  daemonResponse = {
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(preview),
  };
  registerWorkspaceCreationRoutes(app, fakeDaemon(), "/api");
});

afterEach(async () => {
  await app.close();
});

describe("workspace creation routes", () => {
  it("proxies a preview as an encoded sessiond request and preserves the plan", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project%20one/workspace-creations/preview",
      payload: { name: "review", baseRef: "main" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<WorkspaceCreationPreview>()).toEqual(preview);
    expect(daemonRequests).toHaveLength(1);
    expect(daemonRequests[0]).toMatchObject({
      method: "POST",
      path: "/workspace-creations/projects/project%20one/preview",
      body: { name: "review", baseRef: "main" },
    });
    expect(daemonRequests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(daemonRequests[0]?.signal?.aborted).toBe(false);
  });

  it("proxies a confirmed creation and preserves the command-run response", async () => {
    daemonResponse = {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(run),
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project%20one/workspace-creations",
      payload: { name: "review", baseRef: "main", precondition: "v1.confirmed" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<TerminalCommandRun>()).toEqual(run);
    expect(daemonRequests[0]?.path).toBe("/workspace-creations/projects/project%20one");
    expect(daemonRequests[0]?.body).toEqual({ name: "review", baseRef: "main", precondition: "v1.confirmed" });
  });

  it("rejects a malformed body at the web boundary without contacting sessiond", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/p1/workspace-creations/preview",
      payload: { name: "../escape", baseRef: "main" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("Workspace name");
    expect(daemonRequests).toEqual([]);
  });

  it("preserves an attributable sessiond rejection, including a daemon that predates creation", async () => {
    const rejected = { statusCode: 409, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Workspace creation confirmation is stale" }) };
    const unknown = { statusCode: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Route not found" }) };
    daemonResponse = rejected;

    const conflict = await app.inject({
      method: "POST",
      url: "/api/projects/p1/workspace-creations",
      payload: { name: "review", baseRef: "main", precondition: "v1.confirmed" },
    });
    daemonResponse = unknown;
    const notFound = await app.inject({
      method: "POST",
      url: "/api/projects/p1/workspace-creations",
      payload: { name: "review", baseRef: "main", precondition: "v1.confirmed" },
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: "Workspace creation confirmation is stale" });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({ error: "Route not found" });
  });

  it("contains daemon availability and protocol failures at the web boundary", async () => {
    daemonResponse = { statusCode: 200, headers: {}, body: "not json" };
    const malformed = await app.inject({
      method: "POST",
      url: "/api/projects/p1/workspace-creations/preview",
      payload: { name: "review", baseRef: "main" },
    });

    daemonFailure = new Error("socket unavailable");
    const unavailable = await app.inject({
      method: "POST",
      url: "/api/projects/p1/workspace-creations/preview",
      payload: { name: "review", baseRef: "main" },
    });

    expect(malformed.statusCode).toBe(502);
    expect(malformed.json<{ error: string }>().error).toContain("Invalid session daemon workspace creation response");
    expect(unavailable.statusCode).toBe(502);
    expect(unavailable.json()).toEqual({ error: "Session daemon unavailable: socket unavailable" });
  });
});

interface DaemonRequest {
  method: string;
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

function fakeDaemon(): SessionProxyDaemon {
  return {
    request: (method, path, body, options) => {
      daemonRequests.push({
        method,
        path,
        ...(body === undefined ? {} : { body }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      return daemonFailure === undefined ? Promise.resolve(daemonResponse) : Promise.reject(daemonFailure);
    },
    connectWebSocket: () => { throw new Error("WebSocket not configured for test"); },
  };
}
