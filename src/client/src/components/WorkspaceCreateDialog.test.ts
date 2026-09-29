// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceCreationPreview } from "../api";
import { WorkspaceCreateDialog, type WorkspaceCreateRequest, type WorkspaceCreateSubmission } from "./WorkspaceCreateDialog";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

const plan: WorkspaceCreationPreview = {
  path: "/worktrees/repo/review",
  label: "detached@abc1234",
  confirmation: "Create a Git worktree at /worktrees/repo/review?",
  command: "git worktree add --detach '/worktrees/repo/review' 'main'",
  precondition: "v1.confirmed",
};

describe("workspace create dialog", () => {
  it("plans on the trailing edge of typing and shows the provider's confirmation", async () => {
    const requests: WorkspaceCreateRequest[] = [];
    const dialog = mounted((request) => {
      requests.push(request);
      return Promise.resolve(plan);
    }, { defaultBaseRef: "origin/main" });
    await dialog.updateComplete;

    const name = input(dialog, 0);
    const baseRef = input(dialog, 1);
    expect(baseRef.value).toBe("origin/main");

    name.value = "review";
    name.dispatchEvent(new Event("input"));
    baseRef.value = "main";
    baseRef.dispatchEvent(new Event("input"));
    await dialog.updateComplete;

    // Debounced: nothing is asked for until typing settles.
    expect(requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    await dialog.updateComplete;

    expect(requests).toEqual([{ name: "review", baseRef: "main" }]);
    expect(shadowText(dialog)).toContain(plan.confirmation);
    expect(shadowText(dialog)).toContain(plan.path);
  });

  it("submits the resolved plan, not the typed request", async () => {
    const submitted: WorkspaceCreateSubmission[] = [];
    const dialog = mounted(() => Promise.resolve(plan), { defaultBaseRef: "origin/main" });
    dialog.onSubmit = (submission) => { submitted.push(submission); };
    await resolvePreview(dialog, "review");

    const create = dialog.shadowRoot?.querySelector<HTMLButtonElement>("footer .primary");
    expect(create?.disabled).toBe(false);
    create?.click();
    await dialog.updateComplete;

    expect(submitted).toEqual([{ name: "review", baseRef: "origin/main", preview: plan }]);
  });

  it("keeps the action unavailable while the plan is missing, errored, or in flight", async () => {
    const failing = mounted(() => Promise.reject(new Error("review does not resolve to a commit")));
    await resolvePreview(failing, "review");

    expect(shadowText(failing)).toContain("review does not resolve to a commit");
    expect(failing.shadowRoot?.querySelector<HTMLButtonElement>("footer .primary")?.disabled).toBe(true);

    const empty = mounted(() => Promise.resolve(plan));
    await empty.updateComplete;
    expect(empty.shadowRoot?.querySelector<HTMLButtonElement>("footer .primary")?.disabled).toBe(true);
  });

  it("drops a plan that arrives after the request it belongs to was superseded", async () => {
    const pending: ((value: WorkspaceCreationPreview) => void)[] = [];
    const dialog = mounted(() => new Promise<WorkspaceCreationPreview>((resolve) => { pending.push(resolve); }));
    await dialog.updateComplete;
    const name = input(dialog, 0);

    name.value = "first";
    name.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);
    name.value = "second";
    name.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);
    expect(pending).toHaveLength(2);

    // The stale first plan lands last and must not be shown.
    pending[1]?.(plan);
    await dialog.updateComplete;
    pending[0]?.({ ...plan, path: "/worktrees/repo/first" });
    await dialog.updateComplete;

    expect(shadowText(dialog)).toContain(plan.path);
    expect(shadowText(dialog)).not.toContain("/worktrees/repo/first");
  });

  it("stays open for presses inside the panel and dismisses for presses outside it", async () => {
    const onCancel = vi.fn();
    const dialog = mounted(() => Promise.resolve(plan), { defaultBaseRef: "origin/main" });
    dialog.open = true;
    dialog.onCancel = onCancel;
    await dialog.updateComplete;

    // Content lives in the panel's shadow root, so a document-level listener
    // must use the composed path: event.target arrives retargeted to the
    // outermost host and would read as an outside press.
    const section = dialog.shadowRoot?.querySelector("[role=dialog]");
    if (!(section instanceof HTMLElement)) throw new Error("Expected the panel section");
    section.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    input(dialog, 0).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    await dialog.updateComplete;

    expect(onCancel).not.toHaveBeenCalled();

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    await dialog.updateComplete;

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("sends an explicit path override when one is typed", async () => {
    const requests: WorkspaceCreateRequest[] = [];
    const dialog = mounted((request) => {
      requests.push(request);
      return Promise.resolve(plan);
    });
    await dialog.updateComplete;

    const name = input(dialog, 0);
    const path = input(dialog, 2);
    name.value = "review";
    name.dispatchEvent(new Event("input"));
    path.value = "/elsewhere/review";
    path.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    expect(requests).toEqual([{ name: "review", baseRef: "HEAD", path: "/elsewhere/review" }]);
  });
});

function mounted(
  preview: (request: WorkspaceCreateRequest) => Promise<WorkspaceCreationPreview>,
  options: { defaultBaseRef?: string } = {},
): WorkspaceCreateDialog {
  vi.useFakeTimers();
  const dialog = new WorkspaceCreateDialog();
  dialog.projectId = "project-1";
  dialog.preview = preview;
  if (options.defaultBaseRef !== undefined) dialog.defaultBaseRef = options.defaultBaseRef;
  document.body.append(dialog);
  return dialog;
}

async function resolvePreview(dialog: WorkspaceCreateDialog, name: string): Promise<void> {
  await dialog.updateComplete;
  const nameInput = input(dialog, 0);
  nameInput.value = name;
  nameInput.dispatchEvent(new Event("input"));
  await vi.advanceTimersByTimeAsync(300);
  await dialog.updateComplete;
}

function input(dialog: WorkspaceCreateDialog, index: number): HTMLInputElement {
  const found = dialog.shadowRoot?.querySelectorAll<HTMLInputElement>("input")[index];
  if (found === undefined) throw new Error(`Expected a dialog input at index ${String(index)}`);
  return found;
}

function shadowText(dialog: WorkspaceCreateDialog): string {
  return dialog.shadowRoot?.textContent ?? "";
}
