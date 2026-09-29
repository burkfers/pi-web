import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { isCachedNewSessionInfo, loadCachedNewSessions } from "../cachedNewSessions";
import { SessionController } from "./sessionController";
import { defaultApi, emptyPage, FakeSocket, MemoryStorage, oldSession, sessionLookupId, status, workspace, type AppState, type SessionInfo, type Workspace } from "./sessionController.testSupport";

const WORKTREE = "/mnt/worktrees/roadmap/session-1";

/** The workspace the selection lands on after a worktree is created for a session. */
const worktreeWorkspace: Workspace = { ...workspace, id: "workspace-worktree", path: WORKTREE, isMain: false, label: "detached@abc1234" };

function controllerWith(state: () => AppState, setState: (patch: Partial<AppState>) => void): SessionController {
  return new SessionController(
    () => state(),
    (patch) => { setState(patch); },
    () => undefined,
    undefined,
    {
      api: {
        ...defaultApi,
        messages: () => Promise.resolve(emptyPage),
        status: (session) => Promise.resolve(status(sessionLookupId(session))),
      },
      socket: new FakeSocket(),
    },
  );
}

describe("a session that starts in a newly created worktree", () => {
  it("appears in the worktree it belongs to instead of being dropped", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    const started: SessionInfo = { ...oldSession, id: "worktree-session", cwd: WORKTREE, path: `${WORKTREE}/session.jsonl` };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, workspaces: [workspace], sessions: [] };
    const controller = controllerWith(() => state, (patch) => { state = { ...state, ...patch }; });

    // The row is published in the workspace the user clicked from...
    const pending = controller.beginSessionStart();
    if (pending === undefined) throw new Error("Expected a pending start");
    expect(state.sessions.map((session) => session.id)).toEqual([pending.tempId]);

    // ...and by the time the session exists, the selection has moved to the
    // worktree that was created for it.
    state = { ...state, selectedWorkspace: worktreeWorkspace, sessions: [] };
    await controller.adoptSessionInSelectedWorkspace(pending.tempId, started);

    // The session is on screen, selected, and remembered as one that has no
    // transcript file yet — so the next list reload keeps it instead of
    // replacing it with nothing.
    expect(state.sessions.map((session) => session.id)).toEqual([started.id]);
    expect(state.selectedSession?.id).toBe(started.id);
    expect(state.sessions.some((session) => session.id === pending.tempId)).toBe(false);
    expect(isCachedNewSessionInfo(state.sessions[0])).toBe(true);
    expect(loadCachedNewSessions(storage).map((session) => session.id)).toEqual([started.id]);
  });

  it("keeps the row's draft with the session", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    const started: SessionInfo = { ...oldSession, id: "worktree-session", cwd: WORKTREE, path: `${WORKTREE}/session.jsonl` };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, workspaces: [workspace], sessions: [] };
    const controller = controllerWith(() => state, (patch) => { state = { ...state, ...patch }; });

    const pending = controller.beginSessionStart();
    if (pending === undefined) throw new Error("Expected a pending start");
    state = { ...state, selectedWorkspace: worktreeWorkspace, sessions: [] };
    await controller.adoptSessionInSelectedWorkspace(pending.tempId, started);

    // Nothing typed is lost by the workspace switch: the draft follows the
    // session id rather than the row that no longer exists.
    expect(state.selectedSession?.id).toBe(started.id);
  });

  it("still selects the session when the row was never published", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    const started: SessionInfo = { ...oldSession, id: "worktree-session", cwd: WORKTREE, path: `${WORKTREE}/session.jsonl` };
    let state: AppState = { ...initialAppState(), selectedWorkspace: worktreeWorkspace, workspaces: [worktreeWorkspace], sessions: [] };
    const controller = controllerWith(() => state, (patch) => { state = { ...state, ...patch }; });

    await controller.adoptSessionInSelectedWorkspace("creating:unknown", started);

    expect(state.selectedSession?.id).toBe(started.id);
    expect(state.sessions.map((session) => session.id)).toEqual([started.id]);
  });
});
