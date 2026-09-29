import { createHash } from "node:crypto";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { ProviderCreateRequest } from "../../server-plugin-api.js";
import type { WorkspaceCreationPreview } from "../../shared/apiTypes.js";
import { workspaceCreateOperation } from "../../shared/workspaceCreation.js";
import { WORKSPACE_CREATION_OPERATION_TIMEOUT_MS } from "../../shared/workspaceCreationProtocol.js";
import type { Project } from "../types.js";
import { quietCommandFailureDetail, runQuietCommand, type QuietCommandOptions, type QuietCommandResult } from "../terminals/quietCommand.js";

/** The one capability creation needs from the outside world: run a command. */
export type QuietCommandRunner = (options: QuietCommandOptions) => Promise<QuietCommandResult>;
import type { ServerNoticeCreator } from "../notices/serverNoticeService.js";
import {
  WorkspaceProviderCreationError,
  type WorkspaceProviderCreationTarget,
} from "./workspaceProviderRegistry.js";
import { WorktreeRootError } from "./worktreeRoot.js";

export interface WorkspaceCreationProvider {
  resolveCreation(
    project: Project,
    request: ProviderCreateRequest,
    signal: AbortSignal,
  ): Promise<WorkspaceProviderCreationTarget>;
}

/**
 * What a caller asks to create. The HTTP protocol parses and bounds a request
 * of this shape, but a host-driven creation (a worktree for a new session)
 * builds one directly and lets the provider choose the base ref.
 */
export interface ProviderCreationRequest {
  /** Directory name for the new workspace, already bounded by the host. */
  readonly name: string;
  /** Commit-ish to start at; omitted means the provider's own default. */
  readonly baseRef?: string;
  /** Absolute target path; omitted means the worktree directory. */
  readonly path?: string;
}

export interface WorkspaceCreationServiceOptions {
  timeoutMs?: number;
  /** Records creation failures before the request reports them. */
  notices?: Pick<ServerNoticeCreator, "record">;
  /** Runs the planned command; replaced in tests, real by default. */
  runCommand?: QuietCommandRunner;
  /**
   * Where a request that named no path of its own puts its worktree. Injected
   * so the configured root and the derived fallback are the caller's decision,
   * and so the service never reads configuration itself.
   */
  worktreeDirectory?: (projectPath: string) => string | Promise<string>;
}

interface WorkspaceCreationFlight {
  controller: AbortController;
  promise: Promise<{ path: string }>;
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
  private readonly runCommand: QuietCommandRunner;
  private readonly worktreeDirectory: (projectPath: string) => string | Promise<string>;
  private readonly flights = new Map<string, WorkspaceCreationFlight>();
  private readonly shutdown = new AbortController();
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly providers: WorkspaceCreationProvider,
    options: WorkspaceCreationServiceOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? WORKSPACE_CREATION_OPERATION_TIMEOUT_MS;
    this.notices = options.notices;
    this.runCommand = options.runCommand ?? runQuietCommand;
    this.worktreeDirectory = options.worktreeDirectory ?? ((projectPath) => derivedWorktreeDirectory(projectPath));
  }

  /**
   * A worktree root the user configured but the host cannot use — inside the
   * checkout, or the filesystem root — is a configuration problem the user has
   * to fix, so it is reported as such rather than as a server failure.
   */
  private async providerRequestFor(project: Project, request: ProviderCreationRequest): Promise<ProviderCreateRequest> {
    try {
      return await buildProviderRequest(project, request, this.worktreeDirectory);
    } catch (error) {
      if (error instanceof WorktreeRootError) throw new WorkspaceCreationError(error.message, 400, { cause: error });
      throw error;
    }
  }

  /** Resolve and validate the plan a confirmation would be based on. */
  async preview(
    project: Project,
    request: ProviderCreationRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceCreationPreview> {
    throwIfAborted(this.shutdown.signal);
    throwIfAborted(signal);
    return await runBoundedCreation(this.timeoutMs, signal ?? this.shutdown.signal, async (bounded) => {
      return (await this.resolvePlan(project, request, bounded)).preview;
    });
  }

  /**
   * Run a previously previewed creation, and resolve when the worktree exists.
   *
   * The confirmation is re-derived from a fresh plan, so a repository that moved
   * between preview and confirmation fails with a stale-confirmation error
   * instead of running a different plan. The command is run here rather than in
   * a terminal: the plan was already shown before the user confirmed, and this
   * returns only once the worktree is really there — a session cannot record a
   * working directory that does not exist.
   */
  async create(
    project: Project,
    request: ProviderCreationRequest,
    precondition: string,
    signal?: AbortSignal,
  ): Promise<{ path: string }> {
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
    request: ProviderCreationRequest,
    precondition: string,
    flightSignal: AbortSignal,
  ): Promise<{ path: string }> {
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

        // Run and wait, quietly. Creating a worktree is something the user
        // asked for by clicking the thing that means it, so there is no second
        // artifact on screen to watch; the plan was already shown in full before
        // they confirmed, and a failure is reported with what the command said.
        let result: QuietCommandResult;
        try {
          result = await this.runCommand({
            command: planned.plan.command,
            cwd: planned.target.source.path,
            signal,
          });
        } catch (error) {
          // The command never started, which is a different thing from a command
          // that started and failed.
          throw new WorkspaceCreationError(
            `Failed to run workspace creation: ${errorMessage(error)}`,
            400,
            { cause: error },
          );
        }
        if (result.exitCode !== 0) {
          const detail = quietCommandFailureDetail(result);
          throw new WorkspaceCreationError(
            `Workspace creation failed: ${detail ?? `the command exited with code ${String(result.exitCode)}`}`,
            409,
          );
        }
        // The path the command actually used, which is the one that now exists.
        return { path: planned.preview.path };
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
    request: ProviderCreationRequest,
    signal: AbortSignal,
  ): Promise<PlannedCreation> {
    const providerRequest = await this.providerRequestFor(project, request);
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

  private waitForFlight(flight: WorkspaceCreationFlight, signal?: AbortSignal): Promise<{ path: string }> {
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
 * The fallback worktree directory for a project with no configured root: a
 * `worktrees/<project>` tree beside the project's own checkout, so a project's
 * worktrees stay together and outside every existing workspace.
 */
export function derivedWorktreeDirectory(projectPath: string): string {
  const project = resolve(projectPath);
  const parent = parse(project).root === project ? project : resolve(project, "..");
  return resolve(parent, "worktrees", parse(project).base);
}

async function buildProviderRequest(
  project: Project,
  request: ProviderCreationRequest,
  worktreeDirectory: (projectPath: string) => string | Promise<string>,
): Promise<ProviderCreateRequest> {
  const path = request.path === undefined
    ? resolve(await worktreeDirectory(project.path), request.name)
    : resolve(request.path);
  return Object.freeze({
    name: request.name,
    ...(request.baseRef === undefined ? {} : { baseRef: request.baseRef }),
    path,
  });
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
  request: ProviderCreationRequest,
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

function creationFlightKey(projectId: string, request: ProviderCreationRequest): string {
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
