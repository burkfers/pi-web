import type { FastifyInstance } from "fastify";
import { SessionDaemonClient } from "../../sessiond/sessionDaemonClient.js";
import type { SessionProxyDaemon } from "../sessiond/sessionProxyRoutes.js";
import { requestCancellation } from "../requestCancellation.js";

/** Browser-facing adapter; sessiond owns the worktree and session decisions. */
export function registerWorktreeSessionRoutes(
  app: FastifyInstance,
  daemon: SessionProxyDaemon = new SessionDaemonClient(),
  prefix = "/api",
): void {
  app.post<{ Params: { projectId: string }; Body: unknown }>(
    `${prefix}/projects/:projectId/worktree-sessions`,
    async (request, reply) => {
      const cancellation = requestCancellation(request, reply);
      try {
        const upstream = await daemon.request(
          "POST",
          `/worktree-sessions/projects/${encodeURIComponent(request.params.projectId)}`,
          request.body,
          { signal: cancellation.signal },
        );
        reply.code(upstream.statusCode);
        const contentType = upstream.headers["content-type"];
        if (contentType !== undefined && contentType !== "") reply.header("content-type", contentType);
        if (upstream.body === "") return undefined;
        return await reply.send(JSON.parse(upstream.body));
      } catch (error) {
        return await reply.code(502).send({ error: `Session daemon unavailable: ${errorMessage(error)}` });
      } finally {
        cancellation.dispose();
      }
    },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
