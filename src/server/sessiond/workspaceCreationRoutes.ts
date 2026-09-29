import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TerminalCommandRun, WorkspaceCreationPreview } from "../../shared/apiTypes.js";
import {
  parseWorkspaceCreationRequest,
  requireWorkspaceCreationPrecondition,
  WORKSPACE_CREATION_REQUEST_BODY_MAX_BYTES,
  type ParsedWorkspaceCreationRequest,
} from "../../shared/workspaceCreationProtocol.js";
import { requestCancellation } from "../requestCancellation.js";
import type { Project } from "../types.js";
import { workspaceCreationHttpStatus } from "../workspaces/workspaceCreationService.js";

export interface WorkspaceCreationProjectReader {
  requireProject(projectId: string): Promise<Project>;
}

export interface WorkspaceCreator {
  preview(
    project: Project,
    request: ParsedWorkspaceCreationRequest,
    signal: AbortSignal,
  ): Promise<WorkspaceCreationPreview>;
  create(
    project: Project,
    request: ParsedWorkspaceCreationRequest,
    precondition: string,
    signal: AbortSignal,
  ): Promise<TerminalCommandRun>;
}

export interface WorkspaceCreationRouteDependencies {
  projects: WorkspaceCreationProjectReader;
  creations: WorkspaceCreator;
}

interface CreationRequest {
  Params: { projectId: string };
  Body: unknown;
}

/** Internal sessiond endpoint for host-orchestrated provider workspace creation. */
export function registerWorkspaceCreationRoutes(
  app: FastifyInstance,
  dependencies: WorkspaceCreationRouteDependencies,
  prefix = "/workspace-creations",
): void {
  const routeOptions = { bodyLimit: WORKSPACE_CREATION_REQUEST_BODY_MAX_BYTES };

  app.post<CreationRequest>(
    `${prefix}/projects/:projectId/preview`,
    routeOptions,
    async (request, reply) => {
      const prepared = await prepare(dependencies, request, reply);
      if (prepared === undefined) return reply;
      const { project, parsed, cancellation } = prepared;

      try {
        return await dependencies.creations.preview(project, parsed, cancellation.signal);
      } catch (error) {
        return await creationRequestFailed(reply, error);
      } finally {
        cancellation.dispose();
      }
    },
  );

  app.post<CreationRequest>(
    `${prefix}/projects/:projectId`,
    routeOptions,
    async (request, reply) => {
      let precondition: string;
      try {
        precondition = requireWorkspaceCreationPrecondition(parseWorkspaceCreationRequest(request.body).precondition);
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }

      const prepared = await prepare(dependencies, request, reply);
      if (prepared === undefined) return reply;
      const { project, parsed, cancellation } = prepared;

      try {
        return await dependencies.creations.create(project, parsed, precondition, cancellation.signal);
      } catch (error) {
        return await creationRequestFailed(reply, error);
      } finally {
        cancellation.dispose();
      }
    },
  );
}

interface PreparedCreation {
  project: Project;
  parsed: ParsedWorkspaceCreationRequest;
  cancellation: ReturnType<typeof requestCancellation>;
}

async function prepare(
  dependencies: WorkspaceCreationRouteDependencies,
  request: FastifyRequest<CreationRequest>,
  reply: FastifyReply,
): Promise<PreparedCreation | undefined> {
  let parsed: ParsedWorkspaceCreationRequest;
  try {
    parsed = parseWorkspaceCreationRequest(request.body);
  } catch (error) {
    await reply.code(400).send({ error: errorMessage(error) });
    return undefined;
  }

  let project: Project;
  try {
    project = await dependencies.projects.requireProject(request.params.projectId);
  } catch (error) {
    const message = errorMessage(error);
    await reply.code(message === "Project not found" ? 404 : 500).send({ error: message });
    return undefined;
  }

  return { project, parsed, cancellation: requestCancellation(request, reply) };
}

function creationRequestFailed(reply: FastifyReply, error: unknown): FastifyReply {
  return reply.code(workspaceCreationHttpStatus(error)).send({ error: errorMessage(error) });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
