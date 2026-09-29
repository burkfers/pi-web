import { createHash } from "node:crypto";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { ProviderCreateRequest } from "../../server-plugin-api.js";
import type { TerminalCommandRun, WorkspaceCreationPreview } from "../../shared/apiTypes.js";
import { workspaceCreateOperation, workspaceCreationMetadata } from "../../shared/workspaceCreation.js";
import {
  WORKSPACE_CREATION_OPERATION_TIMEOUT_MS,
  type ParsedWorkspaceCreationRequest,
} from "../../shared/workspaceCreationProtocol.js";
import type { Project } from "../types.js";
import type { RunTerminalCommandOptions } from "../terminals/requiredTerminalService.js";
import type { ServerNoticeCreator } from "../notices/serverNoticeService.js";
import {
  WorkspaceProviderCreationError,
  type WorkspaceProviderCreationTarget,
} from "./workspaceProviderRegistry.js";

export interface WorkspaceCreationProvider {
  resolveCreation(
    project: Project,
    request: ProviderCreateRequest,
    signal: AbortSignal,
  ): Promise<WorkspaceProviderCreationTarget>;
}

export interface WorkspaceCreationTerminalHost {
  runCommand(options: RunTerminalCommandOptions): TerminalCommandRun;
}

export interface WorkspaceCreationServiceOptions {
  timeoutMs?: number;
  /** Records creation failures before the request reports them. */
  notices?: Pick<ServerNoticeCreator, "record">;
}

interface WorkspaceCreationFlight {
  controller: AbortController;
  promise: Promise<TerminalCommandRun>;
  waiters: number;
  settled: boolean;
}

export class WorkspaceCreationError extends Error {
  override name = "WorkspaceCreationError";

  constructor(message: string, readonly statusCode = 400, options: ErrorOptions = {}) {
    super(message, options);
  }
}

/** A creation plan the caller may execute, bound to the request that produced it. */
interface PlannedCreation {
  preview: WorkspaceCreationPreview;
  target: WorkspaceProviderCreationTarget;
  plan: Awaited<ReturnType<WorkspaceProviderCreationTarget["prepare"]>>;
}
/**
 * Sessiond-owned creation orchestration. The provider validates and plans its
 * native operation; the host owns the target path, the confirmation binding,
 * and the visible command-run contract.
 */
export class WorkspaceCreationService {
  private readonly timeoutMs: number;
  private readonly notices: Pick<ServerNoticeCreator, "record"> | undefined;
  private readonly flights = new Map<string, WorkspaceCreationFlight>();
  private readonly shutdown = new AbortController();
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly providers: WorkspaceCreationProvider,
    private readonly terminals: WorkspaceCreationTerminalHost,
    options: WorkspaceCreationServiceOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? WORKSPACE_CREATION_OPERATION_TIMEOUT_MS;
    this.notices = options.notices;
  }

  /** Resolve and validate the plan a confirmation would be based on. */
  async preview(
    project: Project,
    request: ParsedWorkspaceCreationRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceCreationPreview> {
    throwIfAborted(this.shutdown.signal);
    throwIfAborted(signal);
    return await runBoundedCreation(this.timeoutMs, signal ?? this.shutdown.signal, async (bounded) => {
      return (await this.resolvePlan(project, request, bounded)).preview;
    });
  }

  /**
   * Run a previously previewed creation. The confirmation is re-derived from a
   * fresh plan, so a repository that moved between preview and confirmation
   * fails with a stale-confirmation error instead of running a different plan.
   */
  async create(
    project: Project,
    request: ParsedWorkspaceCreationRequest,
    precondition: string,
    signal?: AbortSignal,
  ): Promise<TerminalCommandRun> {
    throwIfAborted(this.shutdown.signal);
    throwIfAborted(signal);

    const key = creationFlightKey(project.id, request);
    const currentFlight = this.flights.get(key);
    if (currentFlight !== undefined) return await this.waitForFlight(currentFlight, signal);

    const controller = new AbortController();
    const promise = this.executeCreation(project, request, precondition, controller.signal);
    const flight: WorkspaceCreationFlight = { controller, promise, waiters: 0, settled: false };
    this.flights.set(key, flight);
    void promise.then(
      () => { this.finishFlight(key, flight); },
      () => { this.finishFlight(key, flight); },
    );
    return await this.waitForFlight(flight, signal);
  }

  /** Cancels creation orchestration before the required Terminal capability is disposed. */
  closeAll(reason = "Session daemon shutdown"): Promise<void> {
    this.closePromise ??= this.closeCreationFlights(reason);
    return this.closePromise;
  }

  private async closeCreationFlights(reason: string): Promise<void> {
    if (!this.shutdown.signal.aborted) this.shutdown.abort(new DOMException(reason, "AbortError"));
    const flights = [...this.flights.values()];
    for (const flight of flights) {
      if (!flight.controller.signal.aborted) flight.controller.abort(abortError(this.shutdown.signal));
    }
    await Promise.allSettled(flights.map(({ promise }) => promise));
  }

  private async executeCreation(
    project: Project,
    request: ParsedWorkspaceCreationRequest,
    precondition: string,
    flightSignal: AbortSignal,
  ): Promise<TerminalCommandRun> {
    try {
      return await runBoundedCreation(this.timeoutMs, flightSignal, async (signal) => {
        const planned = await this.resolvePlan(project, request, signal);
        if (planned.preview.precondition !== precondition) {
          throw new WorkspaceCreationError(
            "Workspace creation confirmation is stale; review the current plan and confirm again",
            409,
          );
        }
        throwIfAborted(signal);

        try {
          return this.terminals.runCommand({
            origin: "core",
            projectId: project.id,
            workspaceId: planned.target.source.id,
            cwd: planned.target.source.path,
            title: planned.plan.title,
            command: planned.plan.command,
            metadata: workspaceCreationMetadata(planned.preview),
            failureNotice: {
              message: "Workspace creation failed. See terminal output.",
              context: { targetWorkspacePath: planned.preview.path },
            },          });
        } catch (error) {
          throw new WorkspaceCreationError(
            `Failed to start workspace creation: ${errorMessage(error)}`,
            400,
            { cause: error },
          );
        }
      });
    } catch (error) {
      const failure = error instanceof WorkspaceCreationDeadlineError
        ? new WorkspaceCreationError(error.message, 504, { cause: error })
        : error;
      if (!isAbortError(failure)) this.notices?.record({
        severity: "error",
        message: `Workspace creation failed: ${errorMessage(failure)}`,
        source: workspaceCreateOperation,
        scope: { projectId: project.id },
        context: { targetWorkspacePath: request.path ?? "" },
      });
      throw failure;
    }
  }

  private async resolvePlan(
    project: Project,
    request: ParsedWorkspaceCreationRequest,
    signal: AbortSignal,
  ): Promise<PlannedCreation> {
    const providerRequest = buildProviderRequest(project, request);
    const target = await this.providers.resolveCreation(project, providerRequest, signal);
    throwIfAborted(signal);
    validateTargetPath(project, target, providerRequest.path);
    const plan = await target.prepare();
    throwIfAborted(signal);
    return Object.freeze({
      target,
      plan,
      preview: Object.freeze({
        path: plan.path,
        label: plan.label,
        confirmation: plan.confirmation,
        command: plan.command,
        precondition: creationPrecondition(project, target.ownerPluginId, request, plan),
      }),
    });
  }

  private waitForFlight(flight: WorkspaceCreationFlight, signal?: AbortSignal): Promise<TerminalCommandRun> {
    throwIfAborted(signal);
    flight.waiters += 1;

    return new Promise((resolvePromise, rejectPromise) => {
      let finished = false;
      const finish = (callback: () => void): void => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        flight.waiters -= 1;
        callback();
        if (
          flight.waiters === 0
          && !flight.settled
          && !flight.controller.signal.aborted
        ) {
          flight.controller.abort(new DOMException("Workspace creation request cancelled", "AbortError"));
        }
      };
      const onAbort = (): void => {
        finish(() => { rejectPromise(abortError(signal)); });
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (run) => { finish(() => { resolvePromise(run); }); },
        (error: unknown) => { finish(() => { rejectPromise(asError(error)); }); },
      );
    });
  }

  private finishFlight(key: string, flight: WorkspaceCreationFlight): void {
    flight.settled = true;
    if (this.flights.get(key) === flight) this.flights.delete(key);
  }
}

export function workspaceCreationHttpStatus(error: unknown, fallback = 500): number {
  if (error instanceof WorkspaceCreationError || error instanceof WorkspaceProviderCreationError) {
    return error.statusCode;
  }
  return fallback;
}

/**
 * Host-derived target path for a request that named no path of its own: a
 * `worktrees/<project>/<name>` tree beside the project's own checkout, so a
 * project's worktrees stay together and outside every existing workspace.
 */
export function defaultWorkspaceCreationPath(projectPath: string, name: string): string {
  const project = resolve(projectPath);
  const parent = parse(project).root === project ? project : resolve(project, "..");
  return resolve(parent, "worktrees", parse(project).base, name);
}

function buildProviderRequest(project: Project, request: ParsedWorkspaceCreationRequest): ProviderCreateRequest {
  const path = request.path === undefined
    ? defaultWorkspaceCreationPath(project.path, request.name)
    : resolve(request.path);
  return Object.freeze({ name: request.name, baseRef: request.baseRef, path });
}

/**
 * Generic path safety, independent of the provider: a new workspace is never
 * the filesystem root, is never inside the project it belongs to, never
 * contains it, and never at or inside any workspace that already exists —
 * which also covers the workspace the command itself runs from.
 */
function validateTargetPath(project: Project, target: WorkspaceProviderCreationTarget, path: string): void {
  if (!isAbsolute(path)) throw new WorkspaceCreationError("Workspace path must be absolute");
  const resolved = resolve(path);
  if (parse(resolved).root === resolved) throw new WorkspaceCreationError("The filesystem root cannot be a workspace path");

  const projectPath = resolve(project.path);
  if (isSameOrAncestor(projectPath, resolved)) {
    throw new WorkspaceCreationError("A new workspace cannot be created inside the registered project");
  }
  if (isSameOrAncestor(resolved, projectPath)) {
    throw new WorkspaceCreationError("A new workspace cannot be created at a path that contains the registered project");
  }
  for (const workspace of target.workspaces) {
    if (isSameOrAncestor(resolve(workspace.path), resolved)) {
      throw new WorkspaceCreationError(`A new workspace cannot be created inside the existing workspace ${workspace.label}`);
    }
  }
}

function creationPrecondition(
  project: Project,
  ownerPluginId: string,
  request: ParsedWorkspaceCreationRequest,
  plan: Awaited<ReturnType<WorkspaceProviderCreationTarget["prepare"]>>,
): string {
  const digest = createHash("sha256").update(JSON.stringify([
    ownerPluginId,
    project.id,
    request.name,
    request.baseRef,
    request.path ?? null,
    plan.path,
    plan.label,
    plan.command,
    plan.confirmation,
  ])).digest("base64url");
  return `v1.${digest}`;
}

async function runBoundedCreation<T>(
  timeoutMs: number,
  parentSignal: AbortSignal,
  operation: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = (): void => { controller.abort(abortError(parentSignal)); };
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });

  const timeoutError = new WorkspaceCreationDeadlineError(
    `Workspace creation timed out after ${String(timeoutMs)}ms`,
  );
  const timeout = setTimeout(() => { controller.abort(timeoutError); }, timeoutMs);
  timeout.unref();
  const deadline = controller.signal.aborted
    ? Promise.reject(abortError(controller.signal))
    : new Promise<never>((_resolve, rejectPromise) => {
        controller.signal.addEventListener(
          "abort",
          () => { rejectPromise(abortError(controller.signal)); },
          { once: true },
        );
      });
  const result = controller.signal.aborted
    ? new Promise<T>(() => { /* Parent cancellation already won. */ })
    : Promise.resolve().then(() => operation(controller.signal));

  try {
    return await Promise.race([result, deadline]);
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abortFromParent);
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("Workspace creation completed", "AbortError"));
    }
  }
}

function creationFlightKey(projectId: string, request: ParsedWorkspaceCreationRequest): string {
  return JSON.stringify([projectId, request.name, request.baseRef, request.path ?? null]);
}

function isSameOrAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const value = relative(ancestor, descendant);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError(signal);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error("Workspace creation request cancelled", { cause: reason });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error), { cause: error });
}

class WorkspaceCreationDeadlineError extends Error {
  override name = "TimeoutError";
}
