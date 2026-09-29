import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SessionDaemonClient } from "../../sessiond/sessionDaemonClient.js";
import { requestCancellation } from "../requestCancellation.js";
import type { SessionProxyDaemon } from "../sessiond/sessionProxyRoutes.js";
import {
  parseWorkspaceCreationRequest,
  WORKSPACE_CREATION_REQUEST_BODY_MAX_BYTES,
} from "../../shared/workspaceCreationProtocol.js";

/** Browser-facing adapter; sessiond owns all workspace creation decisions and effects. */
export function registerWorkspaceCreationRoutes(
  app: FastifyInstance,
  daemon: SessionProxyDaemon = new SessionDaemonClient(),
  prefix = "/api",
): void {
  const routeOptions = { bodyLimit: WORKSPACE_CREATION_REQUEST_BODY_MAX_BYTES };

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    `${prefix}/projects/:projectId/workspace-creations/preview`,
    routeOptions,
    async (request, reply) => proxyCreation(reply, request, daemon, true),
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    `${prefix}/projects/:projectId/workspace-creations`,
    routeOptions,
    async (request, reply) => proxyCreation(reply, request, daemon, false),
  );
}

async function proxyCreation(
  reply: FastifyReply,
  request: FastifyRequest<{ Params: { projectId: string }; Body: unknown }>,
  daemon: SessionProxyDaemon,
  preview: boolean,
): Promise<unknown> {
  // Parsed here only to reject malformed bodies at the web boundary; sessiond
  // re-validates the request and owns every decision about it.
  try {
    parseWorkspaceCreationRequest(request.body);
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }

  const cancellation = requestCancellation(request, reply);
  try {
    const suffix = preview ? "/preview" : "";
    const upstream = await daemon.request(
      "POST",
      `/workspace-creations/projects/${encodeURIComponent(request.params.projectId)}${suffix}`,
      request.body,
      { signal: cancellation.signal },
    );
    return await proxyJsonResponse(reply, upstream);
  } catch (error) {
    return await reply.code(502).send({
      error: `Session daemon unavailable: ${errorMessage(error)}`,
    });
  } finally {
    cancellation.dispose();
  }
}

async function proxyJsonResponse(
  reply: FastifyReply,
  upstream: { statusCode: number; headers: Record<string, string>; body: string },
): Promise<unknown> {
  reply.code(upstream.statusCode);
  const contentType = upstream.headers["content-type"];
  if (contentType !== undefined && contentType !== "") reply.header("content-type", contentType);
  if (upstream.body === "") return undefined;
  try {
    const value: unknown = JSON.parse(upstream.body);
    return value;
  } catch (error) {
    return reply.code(502).send({
      error: `Invalid session daemon workspace creation response: ${errorMessage(error)}`,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
