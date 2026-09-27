// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueuedSessionMessage, SessionStatus } from "../api";
import { ChatView, type QueuedMessageAction } from "./ChatView";

afterEach(() => {
  document.body.replaceChildren();
});

describe("ChatView queued-message actions", () => {
  it("returns a server-queued message to the editor and removes another, addressed by what it renders", async () => {
    const onQueuedMessageAction = vi.fn<(action: QueuedMessageAction) => void>();
    const view = await mountChatView({
      queued: [{ kind: "steer", text: "adjust this turn" }, { kind: "followUp", text: "then do this" }],
      onQueuedMessageAction,
    });

    button(view, "Return Steer 1 to the editor").click();
    button(view, "Remove Follow-up 2").click();
    await view.updateComplete;

    expect(onQueuedMessageAction.mock.calls.map(([action]) => action)).toEqual([
      { action: "edit", source: "server", index: 0, message: { kind: "steer", text: "adjust this turn" } },
      { action: "remove", source: "server", index: 1, message: { kind: "followUp", text: "then do this" } },
    ]);
  });

  it("leaves a lone queued message to the section's Clear queue action", async () => {
    const onQueuedMessageAction = vi.fn<(action: QueuedMessageAction) => void>();
    const view = await mountChatView({ queued: [{ kind: "followUp", text: "only one" }], onQueuedMessageAction, onClearServerQueue: vi.fn() });

    expect(button(view, "Return Follow-up 1 to the editor")).toBeDefined();
    expect(view.shadowRoot?.querySelector(".queued-message-action[aria-label^='Remove']")).toBeNull();
    expect(view.shadowRoot?.querySelector(".queued-clear-button")).not.toBeNull();
  });

  it("offers no per-message action once a pending-start queue is being delivered", async () => {
    const onQueuedMessageAction = vi.fn<(action: QueuedMessageAction) => void>();
    const view = await mountChatView({
      clientQueued: [{ kind: "followUp", text: "queued before start" }, { kind: "followUp", text: "and this too" }],
      onQueuedMessageAction,
      clientQueueEditable: false,
    });

    expect(view.shadowRoot?.querySelector(".queued-message-action")).toBeNull();
  });

  it("acts on a client-queued message while its start is still pending", async () => {
    const onQueuedMessageAction = vi.fn<(action: QueuedMessageAction) => void>();
    const view = await mountChatView({
      clientQueued: [{ kind: "followUp", text: "queued before start" }],
      onQueuedMessageAction,
      clientQueueEditable: true,
    });

    button(view, "Return Follow-up 1 to the editor").click();
    await view.updateComplete;

    expect(onQueuedMessageAction).toHaveBeenCalledWith({ action: "edit", source: "client", index: 0, message: { kind: "followUp", text: "queued before start" } });
  });
});

interface MountOptions {
  queued?: QueuedSessionMessage[];
  clientQueued?: QueuedSessionMessage[];
  onQueuedMessageAction?: (action: QueuedMessageAction) => void;
  onClearServerQueue?: () => void;
  clientQueueEditable?: boolean;
}

async function mountChatView(options: MountOptions): Promise<ChatView> {
  const view = new ChatView();
  view.sessionId = "session-1";
  view.status = queuedStatus(options.queued ?? []);
  view.clientQueuedMessages = options.clientQueued ?? [];
  view.clientQueueEditable = options.clientQueueEditable ?? true;
  if (options.onQueuedMessageAction !== undefined) view.onQueuedMessageAction = options.onQueuedMessageAction;
  if (options.onClearServerQueue !== undefined) view.onClearServerQueue = options.onClearServerQueue;
  document.body.append(view);
  await view.updateComplete;
  return view;
}

function button(view: ChatView, label: string): HTMLButtonElement {
  const found = view.shadowRoot?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (found === undefined || found === null) throw new Error(`No queued-message button labelled "${label}"`);
  return found;
}

function queuedStatus(queuedMessages: QueuedSessionMessage[]): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: queuedMessages.length,
    queuedMessages,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}
