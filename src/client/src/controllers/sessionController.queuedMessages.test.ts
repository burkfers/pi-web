import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { browserErrorScopeKey, sessionBrowserErrorScope } from "../browserErrors";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, emptyPage, FakeSocket, oldSession, status, workspace, type AppState } from "./sessionController.testSupport";

describe("SessionController queued-message actions", () => {
  it("takes a client-queued prompt back out of the queue, attachments included", async () => {
    const attachments = [{ kind: "image" as const, mimeType: "image/png", data: "AAA=", name: "shot.png" }];
    const startRequest = deferred<typeof oldSession>();
    const { controller, state } = pendingStartController(startRequest);

    const start = controller.startSession();
    const temporaryId = state().selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");
    await controller.send("queued before start", "followUp", attachments);

    expect(state().clientQueuedSessionMessages[temporaryId]).toEqual([
      { kind: "followUp", text: "queued before start\n\n[1 attachment queued: shot.png]" },
    ]);
    expect(controller.takeClientQueuedMessage(0)).toEqual({ text: "queued before start", attachments });
    expect(state().clientQueuedSessionMessages[temporaryId]).toBeUndefined();

    startRequest.resolve(oldSession);
    await start;
  });

  it("keeps the remaining client-queued sends in order and never delivers a taken one", async () => {
    const startRequest = deferred<typeof oldSession>();
    const promptCalls: string[] = [];
    const { controller, state } = pendingStartController(startRequest, (text) => { promptCalls.push(text); return Promise.resolve({ accepted: true }); });

    const start = controller.startSession();
    const temporaryId = state().selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");
    await controller.send("first", "followUp");
    await controller.send("second", "followUp");

    expect(controller.takeClientQueuedMessage(0)).toEqual({ text: "first", attachments: undefined });
    expect(state().clientQueuedSessionMessages[temporaryId]).toEqual([{ kind: "followUp", text: "second" }]);

    startRequest.resolve(oldSession);
    await start;

    // Readiness delivers what is left, so the taken send is gone for good.
    expect(promptCalls).toEqual(["second"]);
    expect(state().clientQueuedSessionMessages[oldSession.id]).toBeUndefined();
  });

  it("takes a queued shell command back by its text", async () => {
    const startRequest = deferred<typeof oldSession>();
    const { controller, state } = pendingStartController(startRequest);

    const start = controller.startSession();
    const temporaryId = state().selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");
    await controller.runShell("ls -la");

    expect(controller.takeClientQueuedMessage(0)).toEqual({ text: "ls -la" });
    expect(state().clientQueuedSessionMessages[temporaryId]).toBeUndefined();

    startRequest.resolve(oldSession);
    await start;
  });

  it("withdraws nothing once the queued sends are being delivered", async () => {
    const startRequest = deferred<typeof oldSession>();
    const { controller, state } = pendingStartController(startRequest);

    const start = controller.startSession();
    const temporaryId = state().selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");
    await controller.send("queued before start", "followUp");

    startRequest.resolve(oldSession);
    await start;

    expect(state().clientQueuedSessionMessages[oldSession.id]).toEqual([{ kind: "followUp", text: "queued before start" }]);
    expect(controller.takeClientQueuedMessage(0)).toBeUndefined();
  });

  it("applies the queue state a server-queue removal reports back", async () => {
    const removals: { sessionId: string; kind: string; text: string }[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      status: { ...status(oldSession.id), isStreaming: true, pendingMessageCount: 2, queuedMessages: [{ kind: "followUp", text: "remove me" }, { kind: "followUp", text: "keep me" }] },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      {
        api: {
          ...defaultApi,
          removeQueuedMessage: (session, message) => {
            removals.push({ sessionId: session.id, kind: message.kind, text: message.text });
            return Promise.resolve({ ...status(session.id), isStreaming: true, pendingMessageCount: 1, queuedMessages: [{ kind: "followUp" as const, text: "keep me" }] });
          },
        },
        socket: new FakeSocket(),
      },
    );

    await expect(controller.removeServerQueuedMessage({ kind: "followUp", text: "remove me" })).resolves.toBe(true);

    expect(removals).toEqual([{ sessionId: oldSession.id, kind: "followUp", text: "remove me" }]);
    expect(state.status?.queuedMessages).toEqual([{ kind: "followUp", text: "keep me" }]);
  });

  it("keeps the queue and surfaces the reason when the server refuses a removal", async () => {
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      status: { ...status(oldSession.id), isStreaming: true, pendingMessageCount: 1, queuedMessages: [{ kind: "followUp", text: "remove me" }] },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      {
        api: {
          ...defaultApi,
          removeQueuedMessage: () => Promise.reject(new Error("Removing a single queued message needs pi's queue API, which the installed pi build does not expose.")),
        },
        socket: new FakeSocket(),
      },
    );

    await expect(controller.removeServerQueuedMessage({ kind: "followUp", text: "remove me" })).resolves.toBe(false);

    expect(state.status?.queuedMessages).toEqual([{ kind: "followUp", text: "remove me" }]);
    // The refusal has to reach the user: this is how a pi build without the
    // queue API explains itself instead of silently doing nothing.
    const scope = sessionBrowserErrorScope("local", oldSession.id, { cwd: oldSession.cwd, projectId: workspace.projectId, workspaceId: workspace.id });
    expect(state.browserErrors[browserErrorScopeKey(scope)]?.message).toContain("needs pi's queue API");
  });
});

function pendingStartController(startRequest: { promise: Promise<typeof oldSession> }, prompt?: (text: string) => Promise<{ accepted: true }>) {
  let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    {
      api: {
        ...defaultApi,
        startSession: () => startRequest.promise,
        messages: () => Promise.resolve(emptyPage),
        status: (session) => Promise.resolve(status(session.id)),
        ...(prompt === undefined ? {} : { prompt: (_session: { id: string }, text: string) => prompt(text) }),
      },
      socket: new FakeSocket(),
    },
  );
  return { controller, state: () => state };
}
