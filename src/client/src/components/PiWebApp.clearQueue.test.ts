import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionStatus } from "../api";
import { initialAppState, type AppState } from "../appState";
import { SessionController } from "../controllers/sessionController";
// Template inspection here is the escape hatch for verifying the Clear-queue
// callback wiring in a node environment (no DOM harness). See
// templateInspection.testSupport for the proportionality rationale.
import { templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebApp } from "./PiWebApp";
import type { QueuedMessageAction } from "./ChatView";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp queued-message clear wiring", () => {
  it("passes a stable clear-queue callback through to SessionController", () => {
    const app = createApp();
    const state = stateWithQueuedSession();
    setAppState(app, state);
    const controller = appSessionController(app);
    const clearServerQueue = vi.spyOn(controller, "clearServerQueue").mockResolvedValue(undefined);

    const firstRender = renderChatView(app, state);
    const secondRender = renderChatView(app, state);
    const firstCallback = templateCallbackAfterMarker(firstRender, ".onClearServerQueue=");
    const secondCallback = templateCallbackAfterMarker(secondRender, ".onClearServerQueue=");

    expect(secondCallback).toBe(firstCallback);
    firstCallback();
    expect(clearServerQueue).toHaveBeenCalledOnce();
  });
});

describe("PiWebApp queued-message action wiring", () => {
  it("routes a server-queue edit through the controller and back into the composer", async () => {
    const app = createApp();
    const state = stateWithQueuedSession();
    setAppState(app, state);
    const controller = appSessionController(app);
    const removeServerQueuedMessage = vi.spyOn(controller, "removeServerQueuedMessage").mockResolvedValue(true);
    const restoreQueuedSend = vi.fn();
    const focusInput = vi.fn();
    setPromptEditor(app, { restoreQueuedSend, focusInput });

    templateQueuedActionAfterMarker(renderChatView(app, state), ".onQueuedMessageAction=")({
      action: "edit",
      source: "server",
      index: 0,
      message: { kind: "followUp", text: "queued" },
    });
    await vi.waitFor(() => { expect(restoreQueuedSend).toHaveBeenCalledWith("queued", undefined); });

    expect(removeServerQueuedMessage).toHaveBeenCalledWith({ kind: "followUp", text: "queued" });
    expect(focusInput).toHaveBeenCalledOnce();
  });

  it("does not restore a message the server refused to remove", async () => {
    const app = createApp();
    const state = stateWithQueuedSession();
    setAppState(app, state);
    vi.spyOn(appSessionController(app), "removeServerQueuedMessage").mockResolvedValue(false);
    const restoreQueuedSend = vi.fn();
    setPromptEditor(app, { restoreQueuedSend, focusInput: vi.fn() });

    templateQueuedActionAfterMarker(renderChatView(app, state), ".onQueuedMessageAction=")({
      action: "edit",
      source: "server",
      index: 0,
      message: { kind: "followUp", text: "queued" },
    });
    await Promise.resolve();

    expect(restoreQueuedSend).not.toHaveBeenCalled();
  });

  it("takes a client-queued message out of the queue and restores it, attachments included", () => {
    const app = createApp();
    const state = stateWithClientQueuedSession();
    setAppState(app, state);
    const taken = { text: "queued before start", attachments: [{ kind: "image" as const, mimeType: "image/png", data: "QUJD", name: "shot.png" }] };
    vi.spyOn(appSessionController(app), "takeClientQueuedMessage").mockReturnValue(taken);
    const restoreQueuedSend = vi.fn();
    setPromptEditor(app, { restoreQueuedSend, focusInput: vi.fn() });

    templateQueuedActionAfterMarker(renderChatView(app, state), ".onQueuedMessageAction=")({
      action: "edit",
      source: "client",
      index: 0,
      message: { kind: "followUp", text: "queued before start" },
    });

    expect(restoreQueuedSend).toHaveBeenCalledWith(taken.text, taken.attachments);
  });
});

type RenderChatView = (this: PiWebApp, state: AppState, session: SessionInfo) => TemplateResult;
type ClearServerQueueCallback = () => void;
type QueuedMessageActionCallback = (action: QueuedMessageAction) => void;

function createApp(): PiWebApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebApp();
}

/**
 * The app reaches the composer through a `@query` getter, which has no setter,
 * so the stub shadows it on the instance instead of being assigned.
 */
function setPromptEditor(app: PiWebApp, editor: { restoreQueuedSend: (text: string, attachments?: unknown) => void; focusInput: () => void }): void {
  Object.defineProperty(app, "promptEditor", { value: editor, configurable: true });
}

function stateWithQueuedSession(): AppState {
  const session: SessionInfo = {
    id: "session-1",
    cwd: "/repo",
    path: "/repo/session-1.jsonl",
    created: "2026-07-14T00:00:00.000Z",
    modified: "2026-07-14T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
  };
  return {
    ...initialAppState(),
    selectedSession: session,
    status: queuedStatus(),
  };
}

function queuedStatus(): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 1,
    queuedMessages: [{ kind: "followUp", text: "queued" }],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

function stateWithClientQueuedSession(): AppState {
  const base = stateWithQueuedSession();
  const session = base.selectedSession;
  if (session === undefined) throw new Error("Expected a selected session");
  return {
    ...base,
    status: undefined,
    clientQueuedSessionMessages: { [session.id]: [{ kind: "followUp", text: "queued before start" }] },
  };
}

function setAppState(app: PiWebApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebApp state");
}

function appSessionController(app: PiWebApp): SessionController {
  const controller: unknown = Reflect.get(app, "sessions");
  if (!(controller instanceof SessionController)) throw new Error("PiWebApp SessionController was unavailable");
  return controller;
}

function renderChatView(app: PiWebApp, state: AppState): TemplateResult {
  const method: unknown = Reflect.get(app, "renderChatView");
  if (!isRenderChatView(method)) throw new Error("PiWebApp.renderChatView is not callable");
  const session = state.selectedSession;
  if (session === undefined) throw new Error("Expected a selected session");
  return method.call(app, state, session);
}

function isRenderChatView(value: unknown): value is RenderChatView {
  return typeof value === "function";
}

function templateCallbackAfterMarker(template: TemplateResult, marker: string): ClearServerQueueCallback {
  const value = templateValueAfterMarker(template, marker);
  if (!isClearServerQueueCallback(value)) throw new Error(`Expected callback after ${marker}`);
  return value;
}

function templateQueuedActionAfterMarker(template: TemplateResult, marker: string): QueuedMessageActionCallback {
  const value: unknown = templateValueAfterMarker(template, marker);
  if (typeof value !== "function") throw new Error(`Expected queued-message action callback after ${marker}`);
  return (action: QueuedMessageAction) => { Reflect.apply(value, undefined, [action]); };
}

function isClearServerQueueCallback(value: unknown): value is ClearServerQueueCallback {
  return typeof value === "function";
}
