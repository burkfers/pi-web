// @vitest-environment happy-dom

import { html, render, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, PluginPeer, PluginRuntimeContext, Workspace, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { GIT_FILE_VIEW_STORAGE_KEY } from "./browser/gitFileViewPreference.js";
import plugin from "./browser/pi-web-plugin.js";

const projectId = "project-1";
const workspaceId = "workspace-1";

const gitWorkspace: Workspace = {
  id: workspaceId,
  projectId,
  path: "/repo",
  label: "main",
  isMain: true,
  provider: { pluginId: "git", capabilities: { remove: false, create: false } },
};

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  document.body.replaceChildren();
});

describe("bundled Git browser plugin", () => {
  it("contributes provider-owned actions and a panel that replacements suppress", async () => {
    const contributions = activate("git");
    const panel = contributions.workspacePanels?.[0];
    if (panel === undefined) throw new Error("Expected Git workspace panel");
    const backend = backendFixture();
    const context = panelContext(backend.request);

    expect(panel.id).toBe("workspace.git");
    expect(panel.order).toBe(20);
    expect(panel.icon).toBeDefined();
    expect(panel.visible?.(context)).toBe(true);
    expect(panel.visible?.(panelContext(backend.request, {
      ...gitWorkspace,
      // Legacy Git-shaped data must not override a declared replacement owner.
      provider: { pluginId: "jj", capabilities: { remove: false, create: false } },
    }))).toBe(false);

    const selectWorkspaceTool = vi.fn<PluginRuntimeContext["selectWorkspaceTool"]>();
    const refreshWorkspacePanels = vi.fn<PluginRuntimeContext["refreshWorkspacePanels"]>(() => panel.onInvalidate?.(context));
    const runtime = runtimeContext({ selectWorkspaceTool, refreshWorkspacePanels });
    const goToGit = contributions.actions?.find((action) => action.id === "view.git");
    const refresh = contributions.actions?.find((action) => action.id === "workspace.refresh-git");

    expect(contributions.actions?.map(({ id }) => id)).toEqual(["view.git", "workspace.refresh-git"]);
    expect(panel.routeAliases).toEqual(["git", "core:workspace.git"]);
    expect(goToGit?.shortcut).toBe("mod+3");
    expect(goToGit?.shortcutAliases).toEqual(["core:view.git"]);
    expect(refresh?.shortcutAliases).toEqual(["core:workspace.refresh-git"]);
    expect(goToGit?.enabled?.(runtime)).toBe(true);
    await goToGit?.run(runtime);
    expect(selectWorkspaceTool).toHaveBeenCalledWith("git:workspace.git");

    await refresh?.run(runtime);
    expect(refreshWorkspacePanels).toHaveBeenCalledWith("git:workspace.git");
    expect(backend.request).toHaveBeenCalledWith("status", null);

    backend.request.mockClear();
    await panel.onInvalidate?.(context);
    expect(backend.request).toHaveBeenCalledWith("status", null);
  });

  it("uses source identity for ownership and runtime identity for federated routes", async () => {
    const runtimePluginId = "machine.72656d6f74652d31.git";
    const contributions = activate("git", runtimePluginId);
    const panel = requiredPanel(contributions);
    const backend = backendFixture();

    expect(panel.visible?.(panelContext(backend.request))).toBe(true);
    expect(panel.visible?.(panelContext(backend.request, {
      ...gitWorkspace,
      provider: { pluginId: runtimePluginId, capabilities: { remove: false, create: false } },
    }))).toBe(false);

    const selectWorkspaceTool = vi.fn<PluginRuntimeContext["selectWorkspaceTool"]>();
    const action = contributions.actions?.find((candidate) => candidate.id === "view.git");
    await action?.run(runtimeContext({ selectWorkspaceTool }));
    expect(selectWorkspaceTool).toHaveBeenCalledWith(`${runtimePluginId}:workspace.git`);
  });

  it("keeps visibility checks free of route side effects", () => {
    window.history.replaceState({}, "", `/?project=${projectId}&workspace=${workspaceId}&core.workspace.git--diff=README.md`);
    const replaceState = vi.spyOn(window.history, "replaceState");
    const panel = requiredPanel(activate("git"));

    expect(panel.visible?.(panelContext(backendFixture().request))).toBe(true);

    expect(replaceState).not.toHaveBeenCalled();
    expect(new URL(window.location.href).searchParams.get("core.workspace.git--diff")).toBe("README.md");
  });

  it("uses the generic panel invalidation hook and reports an actionable error without a paired backend", async () => {
    const panel = requiredPanel(activate("git"));
    const context = panelContext(undefined);
    expect(panel.visible?.(context)).toBe(true);

    await panel.onInvalidate?.(context);
    const container = document.createElement("div");
    render(panel.render(context), container);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Git workspace backend is unavailable. Update and restart PI WEB on this machine, then reload the browser.",
    );
  });

  it("loads status and diffs through context.peer, preserves URL selection, views, grouping, and rich diff rendering", async () => {
    window.history.replaceState({}, "", `/?project=${projectId}&workspace=${workspaceId}`);
    const backend = backendFixture({
      files: [
        changedFile("src/main.ts"),
        changedFile("vendor/harl", { submoduleFromCommit: "abc1234", submoduleToCommit: "def5678" }),
        changedFile("vendor/harl/lib.ts"),
      ],
      submodules: ["vendor/harl"],
    });
    const panel = requiredPanel(activate("git"));
    const context = panelContext(backend.request);
    expect(panel.visible?.(context)).toBe(true);

    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    expect(container.textContent).toContain("main");
    expect(button(container, "src/main.ts")).toBeDefined();
    expect(button(container, "harl").textContent).toContain("submodule");

    button(container, "harl").click();
    render(panel.render(context), container);
    expect(button(container, "abc1234 → def5678")).toBeDefined();
    expect(button(container, "lib.ts")).toBeDefined();

    button(container, "src/main.ts").click();
    expect(new URL(window.location.href).searchParams.get("git.workspace.git--diff")).toBe("src/main.ts");
    await settleBackend();
    render(panel.render(context), container);

    expect(backend.request).toHaveBeenCalledWith("diff", { path: "src/main.ts" });
    expect(backend.request).toHaveBeenCalledWith("diff", { path: "src/main.ts", staged: true });
    expect(container.textContent).toContain("staged");
    expect(container.textContent).toContain("unstaged");
    expect(container.querySelector(".git-panel")).not.toBeNull();
    expect(container.querySelector(".split")).toBeNull();
    const styleRules = (container.querySelector("style")?.textContent ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("{"));
    expect(styleRules).toContainEqual(expect.stringContaining(".git-panel .git-row"));
    expect(styleRules.every((rule) => rule.startsWith(".git-panel"))).toBe(true);
    expect(container.querySelector('[role="table"][aria-label="Unified diff"]')).not.toBeNull();
    expect([...container.querySelectorAll(".inline-change")].map((entry) => entry.textContent)).toContain("new");

    button(container, "Tree").click();
    render(panel.render(context), container);
    expect(window.localStorage.getItem(GIT_FILE_VIEW_STORAGE_KEY)).toBe("tree");
    expect(findButton(container, "src/main.ts")).toBeUndefined();
    button(container, "src").click();
    render(panel.render(context), container);
    expect(button(container, "main.ts")).toBeDefined();

    render(null, container);
  });

  it("loads log and branch modes, selects commits, and scopes branch logs without checkout", async () => {
    window.history.replaceState({}, "", `/?project=${projectId}&workspace=${workspaceId}`);
    const backend = backendFixture({ includeRepositoryViews: true });
    const panel = requiredPanel(activate("git"));
    const context = panelContext(backend.request);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    button(container, "Log").click();
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    expect(backend.request).toHaveBeenCalledWith("history", { scope: "all", limit: 100 });
    expect(container.textContent).toContain("Initial commit");
    expect(container.querySelector(".git-author-initials")?.textContent).toBe("TU");
    expect(container.querySelector(".git-commit-meta")?.textContent).not.toContain("2026");

    button(container, "Initial commit").click();
    await settleBackend();
    render(panel.render(context), container);
    expect(backend.request).toHaveBeenCalledWith("commit", { oid: "a".repeat(40) });
    expect(container.querySelector('[role="table"][aria-label="Commit patch"]')).not.toBeNull();
    expect(container.querySelector(".git-diff-cell.add")).not.toBeNull();
    expect(container.querySelector(".git-diff-cell.remove")).not.toBeNull();
    expect(container.querySelector(".git-stat-added")).not.toBeNull();
    expect(container.querySelector(".git-stat-deleted")).not.toBeNull();
    expect(container.textContent).toContain("test@example.com");
    expect(container.textContent).toContain("2026");
    expect(new URL(window.location.href).searchParams.get("git.workspace.git--commit")).toBe("a".repeat(40));

    button(container, "Branches").click();
    await settleBackend();
    render(panel.render(context), container);
    expect(container.textContent).toContain("feature/name");
    expect(backend.request).toHaveBeenCalledWith("branches", null);
    button(container, "feature/name").click();
    render(panel.render(context), container);
    const viewBranchButtons = [...container.querySelectorAll("button")].filter((candidate) => candidate.textContent.trim() === "View branch log");
    viewBranchButtons[1]?.click();
    await settleBackend();
    render(panel.render(context), container);
    expect(backend.request).toHaveBeenCalledWith("history", { scope: "branch", ref: "feature/name", limit: 100 });
    expect(new URL(window.location.href).searchParams.get("git.workspace.git--branch")).toBe("feature/name");
    expect(new URL(window.location.href).searchParams.get("git.workspace.git--view")).toBe("log");
    render(null, container);
  });

  it("starts a fresh commit request when the selected commit changes", async () => {
    window.history.replaceState({}, "", `/?project=${projectId}&workspace=${workspaceId}`);
    const backend = backendFixture({ includeRepositoryViews: true });
    const originalRequest = backend.request.getMockImplementation();
    if (originalRequest === undefined) throw new Error("Expected backend implementation");
    const commitRequests: { oid: string; resolve: (value: JsonValue) => void }[] = [];
    const panel = requiredPanel(activate("git"));
    const context = panelContext(backend.request);
    const container = document.body.appendChild(document.createElement("div"));
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    backend.request.mockImplementation((operation, input) => {
      if (operation === "commit") {
        const oid = isRecord(input) && typeof input["oid"] === "string" ? input["oid"] : "";
        return new Promise<JsonValue>((resolve) => { commitRequests.push({ oid, resolve }); });
      }
      if (operation === "history") return Promise.resolve({
        commits: [
          { oid: "1".repeat(40), shortOid: "1111111", authorName: "Test User", authorEmail: "test@example.com", authoredAt: "2026-01-01T00:00:00Z", subject: "First commit", body: "", parents: [], decorations: [], status: "neutral" },
          { oid: "2".repeat(40), shortOid: "2222222", authorName: "Test User", authorEmail: "test@example.com", authoredAt: "2026-01-01T00:00:00Z", subject: "Second commit", body: "", parents: [], decorations: [], status: "neutral" },
        ],
        truncated: false,
      });
      return originalRequest(operation, input);
    });
    button(container, "Log").click();
    await settleBackend();
    render(panel.render(context), container);

    button(container, "First commit").click();
    render(panel.render(context), container);
    button(container, "Second commit").click();
    render(panel.render(context), container);
    expect(commitRequests.map((request) => request.oid)).toEqual(["1".repeat(40), "2".repeat(40)]);

    commitRequests[1]?.resolve({ commit: { oid: "2".repeat(40), shortOid: "2222222", authorName: "Test User", authorEmail: "test@example.com", authoredAt: "2026-01-01T00:00:00Z", subject: "Second commit", body: "", parents: [], decorations: [], status: "neutral" }, files: [], patch: "second", truncated: false });
    await settleBackend();
    render(panel.render(context), container);
    expect(container.textContent).toContain("Second commit");
    commitRequests[0]?.resolve({ commit: { oid: "1".repeat(40), shortOid: "1111111", authorName: "Test User", authorEmail: "test@example.com", authoredAt: "2026-01-01T00:00:00Z", subject: "First commit", body: "", parents: [], decorations: [], status: "neutral" }, files: [], patch: "first", truncated: false });
    await settleBackend();
    render(panel.render(context), container);
    expect(container.textContent).toContain("Second commit");
  });

  it.each([false, true])("keeps unchanged background polls quiet (selected diff: %s)", async (selected) => {
    vi.useFakeTimers();
    const backend = backendFixture();
    const panel = requiredPanel(activate("git"));
    const requestRender = vi.fn();
    const context = { ...panelContext(backend.request), host: { requestRender } };
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    render(panel.render(context), container);
    expect(button(container, "Refresh").disabled).toBe(true);
    await settleBackend();
    render(panel.render(context), container);
    if (selected) {
      button(container, "src/main.ts").click();
      await settleBackend();
      render(panel.render(context), container);
    }
    requestRender.mockClear();
    const respond = backend.request.getMockImplementation();
    if (respond === undefined) throw new Error("Expected backend implementation");
    let release: () => void = () => { throw new Error("Expected pending request"); };
    const pending = new Promise<void>((resolve) => { release = resolve; });
    backend.request.mockImplementation(async (operation, input) => {
      await pending;
      return respond(operation, input);
    });

    await vi.advanceTimersByTimeAsync(8_000);
    expect(requestRender).not.toHaveBeenCalled();
    render(panel.render(context), container);
    expect(button(container, "Refresh").disabled).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(requestRender).not.toHaveBeenCalled();

    button(container, "Refresh").click();
    render(panel.render(context), container);
    expect(button(container, "Refresh").disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    render(panel.render(context), container);
    expect(button(container, "Refresh").disabled).toBe(false);
    expect(requestRender).toHaveBeenCalled();
    render(null, container);
  });

  it("shows explicit refresh feedback when joining an in-flight background poll", async () => {
    vi.useFakeTimers();
    const backend = backendFixture();
    const panel = requiredPanel(activate("git"));
    const requestRender = vi.fn();
    const context = { ...panelContext(backend.request), host: { requestRender } };
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    const respond = backend.request.getMockImplementation();
    if (respond === undefined) throw new Error("Expected backend implementation");
    let release: () => void = () => { throw new Error("Expected pending request"); };
    const pending = new Promise<void>((resolve) => { release = resolve; });
    backend.request.mockImplementation(async (operation, input) => {
      await pending;
      return respond(operation, input);
    });
    await vi.advanceTimersByTimeAsync(8_000);
    backend.request.mockClear();
    requestRender.mockClear();
    button(container, "Refresh").click();
    expect(backend.request).not.toHaveBeenCalled();
    expect(requestRender).toHaveBeenCalledOnce();
    render(panel.render(context), container);
    expect(button(container, "Refresh").disabled).toBe(true);
    requestRender.mockClear();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(requestRender).toHaveBeenCalledOnce();
    render(panel.render(context), container);
    expect(button(container, "Refresh").disabled).toBe(false);
    render(null, container);
  });

  it.each(["status", "diff"])("renders background %s errors and recovery, but not repeated failures", async (operation) => {
    vi.useFakeTimers();
    const backend = backendFixture();
    const panel = requiredPanel(activate("git"));
    const container = document.createElement("div");
    const requestRender = vi.fn();
    const context = { ...panelContext(backend.request), host: { requestRender } };
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    button(container, "src/main.ts").click();
    await settleBackend();
    const respond = backend.request.getMockImplementation();
    if (respond === undefined) throw new Error("Expected backend implementation");
    backend.request.mockImplementation((requested, input) => requested === operation
      ? Promise.reject(new Error("Polling failed")) : respond(requested, input));
    requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(requestRender).toHaveBeenCalled();
    render(panel.render(context), container);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Polling failed");
    requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(requestRender).not.toHaveBeenCalled();

    backend.request.mockImplementation(respond);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(requestRender).toHaveBeenCalled();
    render(panel.render(context), container);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    render(null, container);
  });

  it("renders changed status, staged and unstaged diffs, and removed selection during polls", async () => {
    vi.useFakeTimers();
    const backend = backendFixture();
    const panel = requiredPanel(activate("git"));
    const container = document.createElement("div");
    const requestRender = vi.fn();
    const context = { ...panelContext(backend.request), host: { requestRender } };
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    button(container, "src/main.ts").click();
    await settleBackend();
    requestRender.mockClear();
    backend.status.files.push(changedFile("added.ts"));
    await vi.advanceTimersByTimeAsync(8_000);
    expect(requestRender).toHaveBeenCalled();
    render(panel.render(context), container);
    expect(button(container, "added.ts")).toBeDefined();

    const respond = backend.request.getMockImplementation();
    if (respond === undefined) throw new Error("Expected backend implementation");
    for (const staged of [true, false]) {
      backend.request.mockImplementation(async (operation, input) => {
        const response = await respond(operation, input);
        return operation === "diff" && isRecord(response) && response["staged"] === staged
          ? { ...response, hash: `changed-${String(staged)}`, diff: `@@ -1 +1 @@\n-old\n+changed-${String(staged)}` }
          : response;
      });
      requestRender.mockClear();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(requestRender).toHaveBeenCalled();
      render(panel.render(context), container);
      expect(container.textContent).toContain(`changed-${String(staged)}`);
    }
    backend.status.files = [];
    requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(requestRender).toHaveBeenCalled();
    render(panel.render(context), container);
    expect(container.querySelector('[aria-label="Unified diff"]')).toBeNull();
    render(null, container);
  });

  it("asks the host to re-read workspaces when the polled branch no longer matches the workspace label", async () => {
    vi.useFakeTimers();
    const backend = backendFixture({ branch: "feature/renamed" });
    const panel = requiredPanel(activate("git"));
    const container = document.createElement("div");
    const refreshWorkspaces = vi.fn();
    // The list still shows the branch this workspace had when it was listed.
    const stale = { ...gitWorkspace, label: "main" };
    const context = { ...panelContext(backend.request, stale), host: { requestRender: vi.fn(), refreshWorkspaces } };
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();

    expect(refreshWorkspaces).toHaveBeenCalled();

    // A workspace whose label already matches is not reported on every poll.
    refreshWorkspaces.mockClear();
    const current = { ...gitWorkspace, label: "feature/renamed" };
    const settled = { ...panelContext(backend.request, current), host: { requestRender: vi.fn(), refreshWorkspaces } };
    render(panel.render(settled), container);
    await settleBackend();
    await vi.advanceTimersByTimeAsync(8_000);

    expect(refreshWorkspaces).not.toHaveBeenCalled();
    render(null, container);
  });

  it("refreshes truncation metadata even when polled diff text has the same hash", async () => {
    vi.useFakeTimers();
    const backend = backendFixture();
    const panel = requiredPanel(activate("git"));
    const requestRender = vi.fn();
    const context = { ...panelContext(backend.request), host: { requestRender } };
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);
    button(container, "src/main.ts").click();
    await settleBackend();
    const respond = backend.request.getMockImplementation();
    if (respond === undefined) throw new Error("Expected backend implementation");
    backend.request.mockImplementation(async (operation, input) => {
      const response = await respond(operation, input);
      return operation === "diff" && isRecord(response) ? { ...response, truncated: true } : response;
    });
    requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(requestRender).toHaveBeenCalled();
    render(panel.render(context), container);
    expect(container.querySelector(".git-viewer-header")?.textContent).toContain("truncated");
    requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(requestRender).not.toHaveBeenCalled();
    render(null, container);
  });

  it("preserves a deep link when entering a fresh workspace after route initialization", async () => {
    window.history.replaceState({}, "", `/?project=${projectId}&workspace=${workspaceId}`);
    const panel = requiredPanel(activate("git"));
    const firstBackend = backendFixture();
    const firstContext = panelContext(firstBackend.request);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(firstContext), container);
    await settleBackend();
    render(null, container);

    const secondWorkspace = { ...gitWorkspace, id: "workspace-2" };
    const secondBackend = backendFixture({ files: [changedFile("README.md")] });
    const secondContext = panelContext(secondBackend.request, secondWorkspace);
    window.history.replaceState({}, "", `/?project=${projectId}&workspace=${secondWorkspace.id}&core.workspace.git--diff=README.md`);
    render(panel.render(secondContext), container);
    await settleBackend();

    expect(secondBackend.request).toHaveBeenCalledWith("diff", { path: "README.md" });
    expect(new URL(window.location.href).searchParams.get("git.workspace.git--diff")).toBe("README.md");
    render(null, container);
  });

  it("scopes cached state by machine and evicts old workspaces", async () => {
    const panel = requiredPanel(activate("git"));
    const localBackend = backendFixture({ branch: "local-main" });
    const remoteBackend = backendFixture({ branch: "remote-main" });
    const localContext = panelContext(localBackend.request, gitWorkspace, "local");
    const remoteContext = panelContext(remoteBackend.request, gitWorkspace, "remote-1");

    await panel.onInvalidate?.(localContext);
    await panel.onInvalidate?.(remoteContext);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(localContext), container);
    expect(container.textContent).toContain("local-main");
    render(panel.render(remoteContext), container);
    expect(container.textContent).toContain("remote-main");

    const oldestBackend = backendFixture({ branch: "oldest" });
    const oldestContext = panelContext(oldestBackend.request, { ...gitWorkspace, id: "bounded-0" });
    await panel.onInvalidate?.(oldestContext);
    // Traverse well beyond the intentionally small workspace-state cache.
    for (let index = 1; index <= 16; index += 1) {
      const backend = backendFixture({ branch: `bounded-${String(index)}` });
      await panel.onInvalidate?.(panelContext(backend.request, { ...gitWorkspace, id: `bounded-${String(index)}` }));
    }

    render(panel.render(oldestContext), container);
    await settleBackend();
    expect(oldestBackend.request.mock.calls.filter(([operation]) => operation === "status")).toHaveLength(2);
    render(null, container);
  });

  it("restores deep-linked selections, clears removed files, and polls only while mounted", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", `/?project=${projectId}&workspace=${workspaceId}&core.workspace.git--diff=README.md`);
    const backend = backendFixture({ files: [changedFile("README.md")] });
    const panel = requiredPanel(activate("git"));
    const context = panelContext(backend.request);
    panel.visible?.(context);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settleBackend();
    render(panel.render(context), container);

    expect(backend.request).toHaveBeenCalledWith("diff", { path: "README.md" });
    expect(new URL(window.location.href).searchParams.get("git.workspace.git--diff")).toBe("README.md");
    expect(new URL(window.location.href).searchParams.has("core.workspace.git--diff")).toBe(false);

    const statusCallsBeforePoll = backend.request.mock.calls.filter(([operation]) => operation === "status").length;
    await vi.advanceTimersByTimeAsync(8_000);
    await settleBackend();
    expect(backend.request.mock.calls.filter(([operation]) => operation === "status")).toHaveLength(statusCallsBeforePoll + 1);

    backend.status.files = [];
    await vi.advanceTimersByTimeAsync(8_000);
    await settleBackend();
    expect(new URL(window.location.href).searchParams.has("git.workspace.git--diff")).toBe(false);

    render(null, container);
    const callsAfterDisconnect = backend.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(backend.request).toHaveBeenCalledTimes(callsAfterDisconnect);
  });
});

function activate(pluginId: string, runtimePluginId = pluginId) {
  return plugin.activate({
    apiVersion: 4,
    pluginId,
    runtimePluginId,
    html,
    svg,
    signal: new AbortController().signal,
    lifetimeSignal: new AbortController().signal,
  }).contributions;
}

function requiredPanel(contributions: ReturnType<typeof activate>) {
  const panel = contributions.workspacePanels?.[0];
  if (panel === undefined) throw new Error("Expected Git workspace panel");
  return panel;
}

function backendFixture(patch: { files?: ReturnType<typeof changedFile>[]; submodules?: string[]; branch?: string; includeRepositoryViews?: boolean } = {}) {
  const status = {
    isGitRepo: true,
    hash: `status-hash-${patch.branch ?? "main"}`,
    branch: patch.branch ?? "main",
    files: patch.files ?? [changedFile("src/main.ts")],
    submodules: patch.submodules ?? [],
  };
  const request = vi.fn((operation: string, input: JsonValue): Promise<JsonValue> => {
    if (operation === "status") return Promise.resolve({
      ...status,
      hash: `${status.hash}:${JSON.stringify(status.files)}`,
      files: [...status.files],
      submodules: [...status.submodules],
    });
    if (operation === "history" && patch.includeRepositoryViews === true) return Promise.resolve({
      commits: [{ oid: "a".repeat(40), shortOid: "aaaaaaa", authorName: "Test User", authorEmail: "test@example.com", authoredAt: "2026-01-01T00:00:00Z", subject: "Initial commit", body: "Initial body", parents: [], decorations: ["HEAD -> main"], status: "unpushed" }],
      truncated: false,
    });
    if (operation === "commit" && patch.includeRepositoryViews === true) return Promise.resolve({
      commit: { oid: "a".repeat(40), shortOid: "aaaaaaa", authorName: "Test User", authorEmail: "test@example.com", authoredAt: "2026-01-01T00:00:00Z", subject: "Initial commit", body: "Initial body", parents: [], decorations: ["HEAD -> main"], status: "unpushed" },
      files: [{ added: 1, deleted: 0, path: "README.md" }], patch: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old value\n+new value", truncated: false,
    });
    if (operation === "branches" && patch.includeRepositoryViews === true) return Promise.resolve({
      branches: [{ name: "main", fullName: "refs/heads/main", oid: "a".repeat(40), isRemote: false, isCurrent: true, checkedOutInCurrentWorktree: true, subject: "Initial commit" }, { name: "feature/name", fullName: "refs/heads/feature/name", oid: "a".repeat(40), isRemote: false, isCurrent: false, checkedOutInCurrentWorktree: false, subject: "Initial commit" }],
      currentBranch: "main", detached: false,
    });
    const staged = isRecord(input) && input["staged"] === true;
    const path = isRecord(input) && typeof input["path"] === "string" ? input["path"] : "diff";
    return Promise.resolve({
      path,
      staged,
      hash: staged ? "staged-hash" : "unstaged-hash",
      diff: staged ? "@@ -1 +1 @@\n-old value\n+new value" : "@@ -1 +1 @@\n-old work\n+new work",
      truncated: false,
    });
  });
  return { request, status };
}

function changedFile(path: string, patch: Record<string, JsonValue> = {}) {
  return { path, index: "unmodified", workingTree: "modified", ...patch };
}

function panelContext(request: NonNullable<PluginPeer["request"]> | undefined, workspace = gitWorkspace, machineId = "local"): WorkspacePanelContext {
  const noop = () => undefined;
  return {
    navigate: () => Promise.resolve(),
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace,
    state: { selectedWorkspace: workspace, workspaceTool: "git:workspace.git", mainView: "workspace" },
    files: {
      readFile: () => Promise.reject(new Error("not implemented")),
      listFiles: () => Promise.reject(new Error("not implemented")),
      writeFile: () => Promise.reject(new Error("not implemented")),
      deleteFile: () => Promise.reject(new Error("not implemented")),
      moveFile: () => Promise.reject(new Error("not implemented")),
    },
    ...(request === undefined ? {} : { peer: { request } }),
    host: { requestRender: noop },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    terminal: { open: noop, runCommand: () => Promise.reject(new Error("not implemented")) },
  };
}

function runtimeContext(patch: Partial<PluginRuntimeContext> = {}): PluginRuntimeContext {
  const noop = () => undefined;
  return {
    navigate: () => Promise.resolve(),
    state: { selectedWorkspace: gitWorkspace, workspaceTool: "git:workspace.git", mainView: "workspace" },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    openActionPalette: noop,
    focusPrompt: noop,
    addProject: noop,
    configureAuth: noop,
    logoutAuth: noop,
    openThemePicker: noop,
    selectMainView: noop,
    selectWorkspaceTool: noop,
    openTerminal: noop,
    refreshFiles: noop,
    refreshWorkspacePanels: noop,
    refreshAppData: noop,
    reloadPage: noop,
    startSession: noop,
    archiveSession: noop,
    stopActiveWork: noop,
    ...patch,
  };
}

function button(container: ParentNode, text: string): HTMLButtonElement {
  const found = findButton(container, text);
  if (found === undefined) throw new Error(`Expected button ${text}; rendered text: ${container.textContent ?? ""}`);
  return found;
}

function findButton(container: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((candidate) => candidate.textContent.trim().includes(text));
}

async function settleBackend(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function isRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
