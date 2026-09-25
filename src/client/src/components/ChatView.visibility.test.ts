// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { ChatView } from "./ChatView";

afterEach(() => {
  document.body.replaceChildren();
  setDocumentVisibility("visible");
});

describe("ChatView visibility scroll pinning", () => {
  it("re-pins to the bottom when hidden updates detach a bottom-following tab", async () => {
    const { view, chat } = await mountView();
    setScrollGeometry(chat, { scrollTop: 120, scrollHeight: 1000, clientHeight: 300 });
    Reflect.set(view, "pinnedToBottom", true);

    setDocumentVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    Reflect.set(view, "pinnedToBottom", false);
    chat.scrollTop = 320;

    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await nextAnimationFrame();

    expect(Reflect.get(view, "pinnedToBottom")).toBe(true);
    expect(chat.scrollTop).toBe(1000);
  });

  it("does not override a reading position that was detached before the tab was hidden", async () => {
    const { view, chat } = await mountView();
    setScrollGeometry(chat, { scrollTop: 250, scrollHeight: 1000, clientHeight: 300 });
    Reflect.set(view, "pinnedToBottom", false);

    setDocumentVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await nextAnimationFrame();

    expect(chat.scrollTop).toBe(250);
  });
});

async function mountView(): Promise<{ view: ChatView; chat: HTMLDivElement }> {
  const view = new ChatView();
  document.body.append(view);
  await view.updateComplete;
  await nextAnimationFrame();
  const chat = view.renderRoot.querySelector<HTMLDivElement>(".chat");
  if (chat === null) throw new Error("Expected chat scroller");
  return { view, chat };
}

function setScrollGeometry(chat: HTMLDivElement, geometry: { scrollTop: number; scrollHeight: number; clientHeight: number }): void {
  chat.scrollTop = geometry.scrollTop;
  Object.defineProperties(chat, {
    scrollHeight: { configurable: true, value: geometry.scrollHeight },
    clientHeight: { configurable: true, value: geometry.clientHeight },
  });
}

function setDocumentVisibility(visibilityState: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: visibilityState });
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { resolve(); });
    });
  });
}
