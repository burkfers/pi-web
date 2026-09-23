// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { ChatView } from "./ChatView";
import type { ChatLine } from "./shared";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

const thinkingMessage: ChatLine = {
  role: "assistant",
  parts: [{ type: "thinking", text: "thinking through the plan" }],
};

it("renders thinking parts open or closed by default per browser preference", async () => {
  const view = new ChatView();
  view.sessionId = "thinking-session";
  view.messages = [thinkingMessage];
  view.isSendingPrompt = true;
  document.body.append(view);
  await view.updateComplete;

  const thinking = view.renderRoot.querySelector<HTMLDetailsElement>("details.msg details.part");
  if (thinking === null) throw new Error("Expected thinking details");
  expect(thinking.open).toBe(true);

  view.thinkingPartsExpandedByDefault = false;
  await view.updateComplete;
  expect(thinking.open).toBe(false);
});

it("keeps a user-collapsed thinking part closed across streaming re-renders", async () => {
  const view = new ChatView();
  view.sessionId = "thinking-session";
  view.messages = [thinkingMessage];
  view.isSendingPrompt = true;
  document.body.append(view);
  await view.updateComplete;
  const thinking = view.renderRoot.querySelector<HTMLDetailsElement>("details.msg details.part");
  if (thinking === null) throw new Error("Expected thinking details");
  thinking.open = false;

  view.messages = [{ role: "assistant", parts: [{ type: "thinking", text: "plus more thinking" }] }];
  await view.updateComplete;

  expect(view.renderRoot.querySelector<HTMLDetailsElement>("details.msg details.part")?.open).toBe(false);
});
