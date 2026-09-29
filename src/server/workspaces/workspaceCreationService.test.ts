import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ProviderCreateContext,
  ProviderWorkspace,
  WorkspaceCreatePlan,
  WorkspaceProvider,
} from "../../server-plugin-api.js";
import type { TerminalCommandRun } from "../../shared/apiTypes.js";
import { parseWorkspaceCreationRequest } from "../../shared/workspaceCreationProtocol.js";
import type { ServerNoticeCreator } from "../notices/serverNoticeService.js";
import type { ServerNoticeInput } from "../notices/serverNoticeStore.js";
import type { ServerPluginProviderContribution } from "../plugins/serverPluginRuntime.js";
import type { Project } from "../types.js";
import type { RunTerminalCommandOptions } from "../terminals/requiredTerminalService.js";
import { WorkspaceProviderRegistry } from "./workspaceProviderRegistry.js";
import {
  derivedWorktreeDirectory,
  WorkspaceCreationService,
  type WorkspaceCreationTerminalHost,
} from "./workspaceCreationService.js";

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
        command: `git worktree add --detach ${shellQuote(context.request.path)} ${shellQuote(context.request.baseRef)}`,
        path: context.request.path,
        label: "detached@abc1234",
        confirmation: `Create a detached worktree at ${context.request.path}?`,
      };
    });
    const registry = registryFor(provider);
    const main = (await registry.resolve(project)).workspaces.find(({ isMain }) => isMain);
    if (main === undefined) throw new Error("Expected a main workspace");
    const terminals = terminalHost(calls);
    const creations = new WorkspaceCreationService(registry, terminals);
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
    expect(terminals.runOptions).toEqual([]);

    const run = await creations.create(project, request, preview.precondition);

    expect(run).toMatchObject({ title: "Create worktree: review", terminalId: "terminal-1" });
    expect(terminals.runOptions).toEqual([{
      origin: "core",
      projectId: project.id,
      workspaceId: main.id,
      cwd: hostPath("/workspace/roadmap"),
      title: "Create worktree: review",
      command: "git worktree add --detach '/workspace/worktrees/roadmap/review' 'origin/main'",
      metadata: {
        "pi.operation": "workspace.create",
        "target.workspacePath": hostPath("/workspace/worktrees/roadmap/review"),
      },
      failureNotice: {
        message: "Workspace creation failed. See terminal output.",
        context: { targetWorkspacePath: hostPath("/workspace/worktrees/roadmap/review") },
      },
    }]);
  });

  it("rejects a confirmation whose plan no longer matches the request", async () => {
    let base = "origin/main";
    const provider = creatingProvider([], (context) => ({
      title: "Create worktree",
      command: `git worktree add --detach ${shellQuote(context.request.path)} ${shellQuote(context.request.baseRef)}`,
      path: context.request.path,
      label: "detached@abc1234",
      confirmation: `Create at ${context.request.path} from ${base}?`,
    }));
    const creations = new WorkspaceCreationService(registryFor(provider), terminalHost());
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
    const creations = new WorkspaceCreationService(registryFor(provider), terminalHost());
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
    const creations = new WorkspaceCreationService(registryFor(provider), terminalHost());

    await expect(creations.preview(project, parseWorkspaceCreationRequest({ name: "review", baseRef: "main", path: mainPath })))
      .rejects.toMatchObject({ statusCode: 400, message: "A new workspace cannot be created inside the existing workspace root" });
  });

  it("rejects a path that would contain the registered project", async () => {
    const creations = new WorkspaceCreationService(registryFor(creatingProvider([], () => { throw new Error("must not plan"); })), terminalHost());

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
    const creations = new WorkspaceCreationService(registryFor(provider), terminalHost());

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
    const creations = new WorkspaceCreationService(registry, terminalHost());

    await expect(creations.preview(project, parseWorkspaceCreationRequest({ name: "review", baseRef: "main" })))
      .rejects.toMatchObject({ statusCode: 409, message: "Server plugin neutral does not support creating workspaces" });
  });

  it("coalesces identical concurrent creations into one command run", async () => {
    let runs = 0;
    const terminals: WorkspaceCreationTerminalHost = {
      runCommand(options) {
        runs += 1;
        return commandRun(options);
      },
    };
    const provider = creatingProvider([], (context) => ({
      title: "Create worktree",
      command: `git worktree add --detach ${shellQuote(context.request.path)} main`,
      path: context.request.path,
      label: "detached@abc1234",
      confirmation: "Create it?",
    }));
    const creations = new WorkspaceCreationService(registryFor(provider), terminals);
    const request = parseWorkspaceCreationRequest({ name: "review", baseRef: "main" });
    const preview = await creations.preview(project, request);

    const [first, second] = await Promise.all([
      creations.create(project, request, preview.precondition),
      creations.create(project, request, preview.precondition),
    ]);

    expect(first.id).toBe(second.id);
    expect(runs).toBe(1);
  });

  it("records a notice and rejects when the command run cannot start", async () => {
    const failure = new Error("terminal unavailable");
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
    }, { notices: noticeCreator });
    const request = parseWorkspaceCreationRequest({ name: "review", baseRef: "main" });
    const preview = await creations.preview(project, request);

    await expect(creations.create(project, request, preview.precondition)).rejects.toMatchObject({
      statusCode: 400,
      message: "Failed to start workspace creation: terminal unavailable",
    });
    expect(notices).toEqual([{
      severity: "error",
      source: "workspace.create",
      message: "Workspace creation failed: Failed to start workspace creation: terminal unavailable",
      scope: { projectId: project.id },
      context: { targetWorkspacePath: "" },
    }]);
  });

  it("aborts in-flight planning when the daemon shuts down", async () => {
    const provider = creatingProvider([], () => new Promise<WorkspaceCreatePlan>(() => undefined));
    const creations = new WorkspaceCreationService(registryFor(provider), terminalHost(), { timeoutMs: 5_000 });

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

function terminalHost(calls: string[] = []): WorkspaceCreationTerminalHost & { runOptions: RunTerminalCommandOptions[] } {
  const runOptions: RunTerminalCommandOptions[] = [];
  return {
    runOptions,
    runCommand(options) {
      calls.push("run");
      runOptions.push(options);
      return commandRun(options);
    },
  };
}

function commandRun(options: RunTerminalCommandOptions): TerminalCommandRun {
  return {
    id: "run-1",
    origin: options.origin,
    projectId: options.projectId,
    workspaceId: options.workspaceId,
    terminalId: "terminal-1",
    title: options.title,
    command: options.command,
    status: "running",
    createdAt: "2026-07-27T00:00:00.000Z",
    metadata: requireStringMetadata(options.metadata),
  };
}

function requireStringMetadata(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected command metadata");
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    throw new Error("Expected string command metadata");
  }
  return Object.fromEntries(entries);
}

function rejectPlanning(): never {
  throw new Error("must not plan");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
