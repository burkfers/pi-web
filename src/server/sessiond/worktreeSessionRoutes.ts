import type { FastifyInstance } from "fastify";
import { requestCancellation } from "../requestCancellation.js";
import { WorktreeSessionError, type WorktreeSessionRequest, type WorktreeSessionService } from "../sessions/worktreeSessionService.js";

/** Bounded: a project id, a workspace path, and one boolean. */
const WORKTREE_SESSION_REQUEST_BODY_MAX_BYTES = 8 * 1024;

interface StartRequest {
  Params: { projectId: string };
  Body: unknown;
}

/**
 * Internal sessiond endpoint that starts one top-level session, giving it a
 * worktree of its own unless the caller opted out or the project is configured
 * to share checkouts.
 */
export function registerWorktreeSessionRoutes(
  app: FastifyInstance,
  service: Pick<WorktreeSessionService, "start">,
  prefix = "/worktree-sessions",
): void {
  app.post<StartRequest>(
    `${prefix}/projects/:projectId`,
    { bodyLimit: WORKTREE_SESSION_REQUEST_BODY_MAX_BYTES },
    async (request, reply) => {
      let parsed: WorktreeSessionRequest;
      try {
        parsed = parseWorktreeSessionRequest(request.params.projectId, request.body);
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }

      const cancellation = requestCancellation(request, reply);
      try {
        return await service.start(parsed, cancellation.signal);
      } catch (error: unknown) {
        const statusCode = error instanceof WorktreeSessionError ? error.statusCode : 500;
        return await reply.code(statusCode).send({ error: errorMessage(error) });
      } finally {
        cancellation.dispose();
      }
    },
  );
}

function parseWorktreeSessionRequest(projectId: string, body: unknown): WorktreeSessionRequest {
  if (!isRecord(body)) throw new Error("Session start request must be an object");
  const shared = body["shared"];
  if (shared !== undefined && typeof shared !== "boolean") throw new Error("Session start shared field must be a boolean");
  const workspacePath = body["workspacePath"];
  if (typeof workspacePath !== "string" || workspacePath === "") throw new Error("Session start workspacePath is required");
  if (!workspacePath.startsWith("/")) throw new Error("Session start workspacePath must be absolute");
  return Object.freeze({ projectId, workspacePath, shared: shared === true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
