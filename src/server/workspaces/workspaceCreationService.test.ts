import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ProviderCreateContext,
  ProviderWorkspace,
  WorkspaceCreatePlan,
  WorkspaceProvider,
} from "../../server-plugin-api.js";
import { parseWorkspaceCreationRequest } from "../../shared/workspaceCreationProtocol.js";
import type { ServerNoticeCreator } from "../notices/serverNoticeService.js";
import type { ServerNoticeInput } from "../notices/serverNoticeStore.js";
import type { ServerPluginProviderContribution } from "../plugins/serverPluginRuntime.js";
import type { Project } from "../types.js";
import type { QuietCommandOptions, QuietCommandResult } from "../terminals/quietCommand.js";
import type { QuietCommandRunner } from "./workspaceCreationService.js";
import { WorkspaceProviderRegistry } from "./workspaceProviderRegistry.js";
import { derivedWorktreeDirectory, WorkspaceCreationService } from "./workspaceCreationService.js";

const project: Project = {
  id: "project-1",
  name: "Roadmap",
  path: hostPath("/workspace/roadmap"),
  createdAt: "2026-07-27T00:00:00.000Z",
};

function hostPath(path: string): string {
  return resolve(path);
}

describe("WorkspaceCreationService", () => {
  it("previews a provider plan, derives the default path, and runs exactly that plan once confirmed", async () => {
    const calls: string[] = [];
    let prepared: ProviderCreateContext | undefined;
    const provider = creatingProvider(calls, (context) => {
      prepared = context;
      return {
        title: "Create worktree: review",
        command: `git worktree add --detach ${shellQuote(context.request.path)} ${shellQuote(context.request.baseRef ?? "HEAD")}`,
        path: context.request.path,
        label: "detached@abc1234",
        confirmation: `Create a detached worktree at ${context.request.path}?`,
      };
    });
    const registry = registryFor(provider);
    const runner = commandRunner({ calls });
    const creations = new WorkspaceCreationService(registry, { runCommand: runner.runCommand });
    const request = parseWorkspaceCreationRequest({ name: "review", baseRef: "origin/main" });

    const preview = await creations.preview(project, request);

    expect(preview).toMatchObject({
      path: hostPath("/workspace/worktrees/roadmap/review"),
      label: "detached@abc1234",
      command: "git worktree add --detach '/workspace/worktrees/roadmap/review' 'origin/main'",
      confirmation: "Create a detached worktree at /workspace/worktrees/roadmap/review?",
    });
    expect(preview.precondition).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/u);
    expect(prepared?.source.path).toBe(hostPath("/workspace/roadmap"));
    expect(prepared?.request).toEqual({
      name: "review",
      baseRef: "origin/main",
      path: hostPath("/workspace/worktrees/roadmap/review"),
    });
    // A preview plans; it does not touch anything.
    expect(runner.runOptions).toEqual([]);

    await expect(creations.create(project, request, preview.precondition)).resolves.toEqual({ path: preview.path });

    // One command, from the project's own checkout, exactly as planned.
    expect(runner.runOptions).toHaveLength(1);
    expect(runner.runOptions[0]?.command).toBe("git worktree add --detach '/workspace/worktrees/roadmap/review' 'origin/main'");
    expect(runner.runOptions[0]?.cwd).toBe(hostPath("/workspace/roadmap"));
    expect(runner.runOptions[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a confirmation whose plan no longer matches the request", async () => {
    let base = "origin/main";
    const provider = creatingProvider([], (context) => ({
      title: "Create worktree",
      command: `git worktree add --detach ${shellQuote(context.request.path)} ${shellQuote(context.request.baseRef ?? "HEAD")}`,
      path: context.request.path,
      label: "detached@abc1234",
      confirmation: `Create at ${context.request.path} from ${base}?`,
    }));
    const creations = new WorkspaceCreationService(registryFor(provider), { runCommand: commandRunner().runCommand });
    const request = parseWorkspaceCreationRequest({ name: "review", baseRef: "origin/main" });
    const preview = await creations.preview(project, request);
    base = "origin/release";

    await expect(creations.create(project, request, preview.precondition)).rejects.toMatchObject({
      statusCode: 409,
      message: "Workspace creation confirmation is stale; review the current plan and confirm again",
    });
  });

  it.each([
    {
      name: "a path inside the registered project",
      body: { name: "review", baseRef: "main", path: hostPath("/workspace/roadmap/nested") },
      message: "A new workspace cannot be created inside the registered project",
    },
    {
      name: "a path inside an existing workspace",
      body: { name: "review", baseRef: "main", path: hostPath("/workspace/roadmap-views/roadmap") },
      message: "A new workspace cannot be created inside the existing workspace views",
    },
    {
      name: "the filesystem root",
      body: { name: "review", baseRef: "main", path: "/" },
      message: "The filesystem root cannot be a workspace path",
    },
  ])("rejects $name before the provider plans anything", async ({ body, message }) => {
    const prepare = vi.fn<() => Promise<WorkspaceCreatePlan>>();
    const provider = creatingProvider([], prepare, [
      providerWorkspace("views", hostPath("/workspace/roadmap-views/roadmap"), false),
    ]);
    const creations = new WorkspaceCreationService(registryFor(provider), { runCommand: commandRunner().runCommand });
    const request = parseWorkspaceCreationRequest(body);

    await expect(creations.preview(project, request)).rejects.toMatchObject({
      statusCode: 400,
      message,
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects the source workspace path, which is an existing workspace like any other", async () => {
    const mainPath = hostPath("/workspace/roadmap-main");
    const provider = creatingProvider([], rejectPlanning, [], mainPath);
    const creations = new WorkspaceCreationService(registryFor(provider), { runCommand: commandRunner().runCommand });

    await expect(creations.preview(project, parseWorkspaceCreationRequest({ name: "review", baseRef: "main", path: mainPath })))
      .rejects.toMatchObject({ statusCode: 400, message: "A new workspace cannot be created inside the existing workspace root" });
  });

  it("rejects a path that would contain the registered project", async () => {
    const creations = new WorkspaceCreationService(registryFor(creatingProvider([], () => { throw new Error("must not plan"); })), { runCommand: commandRunner().runCommand });

    await expect(creations.preview(project, parseWorkspaceCreationRequest({ name: "review", baseRef: "main", path: hostPath("/workspace") })))
      .rejects.toMatchObject({ statusCode: 400, message: "A new workspace cannot be created at a path that contains the registered project" });
  });

  it.each([
    { name: "a relative path", body: { name: "review", baseRef: "main", path: "relative/review" }, message: "Workspace path must be absolute" },
    { name: "an empty name", body: { name: "", baseRef: "main" }, message: "Workspace name must be a non-empty string" },
    { name: "a name with a path separator", body: { name: "team/review", baseRef: "main" }, message: "Workspace name must start with a letter or digit" },
    { name: "a name that looks like an option", body: { name: "--upload-pack=evil", baseRef: "main" }, message: "Workspace name must start with a letter or digit" },
    { name: "a base ref with a metacharacter", body: { name: "review", baseRef: "main;rm -rf /" }, message: "Workspace base ref must be a commit-ish name" },
    { name: "a base ref with parent segments", body: { name: "review", baseRef: "../../etc" }, message: "Workspace base ref must be a commit-ish name" },
  ])("rejects $name at the protocol boundary", ({ body, message }) => {
    expect(() => parseWorkspaceCreationRequest(body)).toThrow(message);
  });

  it("rejects a provider plan that targets a path other than the validated one", async () => {
    const provider = creatingProvider([], () => ({
      title: "Create worktree",
      command: "git worktree add --detach '/elsewhere' main",
      path: hostPath("/elsewhere"),
      label: "detached@abc1234",
      confirmation: "Create it?",
    }));
    const creations = new WorkspaceCreationService(registryFor(provider), { runCommand: commandRunner().runCommand });

    await expect(creations.preview(project, parseWorkspaceCreationRequest({ name: "review", baseRef: "main" })))
      .rejects.toMatchObject({
        statusCode: 502,
        message: "Server plugin neutral creation plan targets /elsewhere instead of the validated path /workspace/worktrees/roadmap/review",
      });
  });

  it("reports a provider that cannot create as unavailable rather than as a failure", async () => {
    const registry = registryFor({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([providerWorkspace("root", project.path, true)]),
    });
    const creations = new WorkspaceCreationService(registry, { runCommand: commandRunner().runCommand });

    await expect(creations.preview(project, parseWorkspaceCreationRequest({ name: "review", baseRef: "main" })))
      .rejects.toMatchObject({ statusCode: 409, message: "Server plugin neutral does not support creating workspaces" });
  });

  it("reports a command that failed with what it said, and creates nothing", async () => {
    const provider = creatingProvider([], (context) => ({
      title: "Create worktree",
      command: `git worktree add --detach ${shellQuote(context.request.path)} main`,
      path: context.request.path,
      label: "detached@abc1234",
      confirmation: "Create it?",
    }));
    const failing = commandRunner({ result: { exitCode: 128, stdout: "", stderr: "fatal: invalid reference: main", timedOut: false } });
    const creations = new WorkspaceCreationService(registryFor(provider), { runCommand: failing.runCommand });
    const request = parseWorkspaceCreationRequest({ name: "review", baseRef: "main" });
    const preview = await creations.preview(project, request);

    // Nothing is watching a terminal for this, so the reason has to travel back
    // with the failure or the user has nothing to act on.
    await expect(creations.create(project, request, preview.precondition)).rejects.toMatchObject({
      statusCode: 409,
      message: "Workspace creation failed: fatal: invalid reference: main",
    });
  });

  it("coalesces identical concurrent creations into one command", async () => {
    let runs = 0;
    const runCommand: QuietCommandRunner = () => {
      runs += 1;
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false } satisfies QuietCommandResult);
    };
    const provider = creatingProvider([], (context) => ({
      title: "Create worktree",
      command: `git worktree add --detach ${shellQuote(context.request.path)} main`,
      path: context.request.path,
      label: "detached@abc1234",
      confirmation: "Create it?",
    }));
    const creations = new WorkspaceCreationService(registryFor(provider), { runCommand });
    const request = parseWorkspaceCreationRequest({ name: "review", baseRef: "main" });
    const preview = await creations.preview(project, request);

    // Two clicks on the same request are one worktree, not a race between two.
    await Promise.all([
      creations.create(project, request, preview.precondition),
      creations.create(project, request, preview.precondition),
    ]);

    expect(runs).toBe(1);
  });

  it("records a notice and rejects when the command cannot start", async () => {
    const failure = new Error("could not spawn");
    const notices: ServerNoticeInput[] = [];
    const noticeCreator: Pick<ServerNoticeCreator, "record"> = {
      record(notice) {
        notices.push(notice);
        return { ...notice, id: "notice-1", createdAt: "2026-07-27T00:00:00.000Z" };
      },
    };
    const provider = creatingProvider([], (context) => ({
      title: "Create worktree",
      command: `git worktree add --detach ${shellQuote(context.request.path)} main`,
      path: context.request.path,
      label: "detached@abc1234",
      confirmation: "Create it?",
    }));
    const creations = new WorkspaceCreationService(registryFor(provider), {
      runCommand: () => { throw failure; },
      notices: noticeCreator,
    });
    const request = parseWorkspaceCreationRequest({ name: "review", baseRef: "main" });
    const preview = await creations.preview(project, request);

    await expect(creations.create(project, request, preview.precondition)).rejects.toMatchObject({
      statusCode: 400,
      message: "Failed to run workspace creation: could not spawn",
    });
    expect(notices).toEqual([{
      severity: "error",
      source: "workspace.create",
      message: "Workspace creation failed: Failed to run workspace creation: could not spawn",
      scope: { projectId: project.id },
      context: { targetWorkspacePath: "" },
    }]);
  });

  it("aborts in-flight planning when the daemon shuts down", async () => {
    const provider = creatingProvider([], () => new Promise<WorkspaceCreatePlan>(() => undefined));
    const creations = new WorkspaceCreationService(registryFor(provider), { runCommand: commandRunner().runCommand, timeoutMs: 5_000 });

    const pending = creations.preview(project, parseWorkspaceCreationRequest({ name: "review", baseRef: "main" }));
    await creations.closeAll("test shutdown");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("derivedWorktreeDirectory", () => {
  it("places worktrees in a worktrees tree beside the project checkout", () => {
    expect(derivedWorktreeDirectory("/workspace/roadmap")).toBe("/workspace/worktrees/roadmap");
  });

  it("keeps a project checked out at the filesystem root from escaping it", () => {
    expect(derivedWorktreeDirectory("/")).toBe("/worktrees");
  });
});

function creatingProvider(
  calls: string[],
  prepare: (context: ProviderCreateContext) => WorkspaceCreatePlan | Promise<WorkspaceCreatePlan>,
  extraWorkspaces: readonly ProviderWorkspace[] = [],
  mainPath: string = project.path,
): WorkspaceProvider {
  return {
    probe: () => { calls.push("probe"); return Promise.resolve("claim"); },
    list: () => {
      calls.push("list");
      return Promise.resolve([
        providerWorkspace("root", mainPath, true),
        ...extraWorkspaces,
      ]);
    },
    describeCreation: () => Promise.resolve({ actionLabel: "New worktree", defaultBaseRef: "origin/main" }),
    prepareCreate: (context) => {
      calls.push("prepare");
      return Promise.resolve(prepare(context));
    },
  };
}

function registryFor(provider: WorkspaceProvider): WorkspaceProviderRegistry {
  return new WorkspaceProviderRegistry({
    contributions: [contribution("neutral", provider)],
    logger: { warn: vi.fn() },
    pathInspector: () => true,
  });
}

function contribution(pluginId: string, provider: WorkspaceProvider): ServerPluginProviderContribution {
  return {
    pluginId,
    pluginName: pluginId,
    packageRoot: `/plugins/${pluginId}`,
    source: "test fixture",
    scope: "local",
    moduleRevision: "1",
    provider,
  };
}

function providerWorkspace(
  key: string,
  path: string,
  isMain: boolean,
  extras: Partial<ProviderWorkspace> = {},
): ProviderWorkspace {
  return { key, path, label: key, isMain, ...extras };
}

/**
 * Stands in for the command runner. Creation is quiet now, so what a test
 * asserts is the command that was run and whether it was allowed to succeed —
 * not a terminal run to watch.
 */
function commandRunner(options: { calls?: string[]; result?: QuietCommandResult } = {}): {
  runCommand: (input: QuietCommandOptions) => Promise<QuietCommandResult>;
  runOptions: QuietCommandOptions[];
} {
  const runOptions: QuietCommandOptions[] = [];
  return {
    runOptions,
    runCommand: (input) => {
      options.calls?.push("run");
      runOptions.push(input);
      return Promise.resolve(options.result ?? { exitCode: 0, stdout: "", stderr: "", timedOut: false });
    },
  };
}



function rejectPlanning(): never {
  throw new Error("must not plan");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
