// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../api";
import { SessionList } from "./SessionList";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("session rename", () => {
  it("offers Rename for persisted non-archived sessions only", async () => {
    const list = await mountedList([session("current", { persisted: true }), session("archived", { persisted: true, archived: true, archivedAt: "2026-06-09T00:00:00.000Z" }), session("transient", { persisted: false })]);

    await openMenu(list, "current");
    expect(menuButtonLabels(list)).toContain("Rename");

    await openMenu(list, "archived");
    expect(menuButtonLabels(list)).toEqual(["Restore", "Delete archived session"]);

    await openMenu(list, "transient");
    expect(menuButtonLabels(list)).toEqual(["Delete"]);
  });

  it("renames through the inline form and reflects the update in the list", async () => {
    const persisted = session("current", { persisted: true });
    const list = await mountedList([persisted], (session, name) => {
      list.sessions = [{ ...session, name }];
    });

    await openMenu(list, "current");
    menuButton(list, "Rename").click();
    await list.updateComplete;
    const input = requireRenameInput(list);
    expect(input.value).toBe("");
    input.value = "Build auth";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await list.updateComplete;

    requireRenameForm(list).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(list);

    expect(list.shadowRoot?.textContent).toContain("Build auth");
    expect(renameForm(list)).toBeUndefined();
  });

  it("cancels renaming with Escape and submits the trimmed name", async () => {
    const persisted = session("current", { persisted: true, name: "Old name" });
    const renamed: string[] = [];
    const list = await mountedList([persisted], (session, name) => { renamed.push(name); });

    await openMenu(list, "current");
    menuButton(list, "Rename").click();
    await list.updateComplete;
    const input = requireRenameInput(list);
    input.value = "  Pinned name  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await list.updateComplete;
    requireRenameForm(list).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(list);
    expect(renamed).toEqual(["Pinned name"]);

    await openMenu(list, "current");
    menuButton(list, "Rename").click();
    await list.updateComplete;
    requireRenameInput(list).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await list.updateComplete;
    expect(renameForm(list)).toBeUndefined();
    expect(renamed).toEqual(["Pinned name"]);
  });

  it("does not let a closed rename request mutate a later form", async () => {
    const first = session("first", { persisted: true });
    const second = session("second", { persisted: true });
    let resolveRename: (() => void) | undefined;
    const rename = new Promise<void>((resolve) => { resolveRename = resolve; });
    const list = await mountedList([first, second], () => rename);

    await openMenu(list, "first");
    menuButton(list, "Rename").click();
    await list.updateComplete;
    const input = requireRenameInput(list);
    input.value = "First name";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await list.updateComplete;
    requireRenameForm(list).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await list.updateComplete;

    const firstToggle = [...(list.shadowRoot?.querySelectorAll<HTMLElement>(".action-menu-toggle") ?? [])][0];
    firstToggle?.click();
    await openMenu(list, "second");
    menuButton(list, "Rename").click();
    await list.updateComplete;
    expect(renameForm(list)).toBeDefined();

    resolveRename?.();
    await settle(list);

    expect(renameForm(list)).toBeDefined();
  });

  it("keeps the form open and shows the failure when the rename is rejected", async () => {
    const persisted = session("current", { persisted: true });
    const onRename = vi.fn(() => Promise.reject(new Error("Usage: /name <session name>")));
    const list = await mountedList([persisted], onRename);

    await openMenu(list, "current");
    menuButton(list, "Rename").click();
    await list.updateComplete;
    const input = renameInput(list);
    if (input === undefined) throw new Error("Missing rename input");
    input.value = "Anything";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await list.updateComplete;
    requireRenameForm(list).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(list);
    await list.updateComplete;

    expect(onRename).toHaveBeenCalledWith(persisted, "Anything");
    expect(list.shadowRoot?.querySelector(".rename-error")?.textContent).toContain("Usage: /name <session name>");
    expect(renameInput(list)).toBeDefined();
  });
});

async function mountedList(
  sessions: SessionInfo[],
  onRename?: (session: SessionInfo, name: string) => void | Promise<void>,
): Promise<SessionList> {
  const list = new SessionList();
  list.sessions = [...sessions];
  if (onRename !== undefined) list.onRename = onRename;
  document.body.append(list);
  await list.updateComplete;
  return list;
}

async function openMenu(list: SessionList, sessionId: string): Promise<void> {
  // Archived rows live in the collapsed Archived section.
  const archivedToggle = [...(list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".subheading .section-toggle") ?? [])][0];
  if (archivedToggle !== undefined && archivedToggle.getAttribute("aria-expanded") !== "true") archivedToggle.click();
  await list.updateComplete;
  const session = list.sessions.find((candidate) => candidate.id === sessionId);
  const row = [...(list.shadowRoot?.querySelectorAll<HTMLElement>(".action-row") ?? [])].find((candidate) => candidate.title === session?.path);
  const toggle = row?.querySelector<HTMLButtonElement>(".action-menu-toggle");
  if (toggle === undefined || toggle === null) throw new Error(`Missing session actions for ${sessionId}`);
  toggle.click();
  await list.updateComplete;
}

async function settle(list: SessionList): Promise<void> {
  await list.updateComplete;
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await list.updateComplete;
}

function menuButtonLabels(list: SessionList): string[] {
  return [...(list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".action-menu-panel > button") ?? [])].map((button) => button.textContent);
}

function menuButton(list: SessionList, label: string): HTMLButtonElement {
  const button = [...(list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".action-menu-panel > button") ?? [])].find((candidate) => candidate.textContent === label);
  if (button === undefined) throw new Error(`Missing ${label} menu entry`);
  return button;
}

function renameForm(list: SessionList): HTMLFormElement | undefined {
  return list.shadowRoot?.querySelector<HTMLFormElement>(".rename-form") ?? undefined;
}

function requireRenameForm(list: SessionList): HTMLFormElement {
  const form = renameForm(list);
  if (form === undefined) throw new Error("Missing rename form");
  return form;
}

function requireRenameInput(list: SessionList): HTMLInputElement {
  const input = renameInput(list);
  if (input === undefined) throw new Error("Missing rename input");
  return input;
}

function renameInput(list: SessionList): HTMLInputElement | undefined {
  return list.shadowRoot?.querySelector<HTMLInputElement>(".rename-input") ?? undefined;
}

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/workspace",
    created: "2026-06-09T00:00:00.000Z",
    modified: "2026-06-09T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
    ...overrides,
  };
}
