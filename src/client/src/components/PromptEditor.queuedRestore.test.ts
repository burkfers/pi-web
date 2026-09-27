import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { machineSessionKey } from "../machineKeys";
import { loadDraft } from "../promptDraftStorage";
import { clearStagedAttachments, loadStagedAttachments, type PendingAttachment } from "../promptAttachmentStaging";
import { PromptEditor } from "./PromptEditor";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
});

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
  clearStagedAttachments(machineSessionKey("local", "queued-session"));
});

describe("PromptEditor queued-send restore", () => {
  it("puts a returned queued message back in the draft, replacing what was there", () => {
    const editor = mountedEditor("replacement");

    editor.restoreQueuedSend("second pass");

    expect(Reflect.get(editor, "draft")).toBe("second pass");
    expect(loadDraft(machineSessionKey("local", "queued-session"))).toBe("second pass");
    expect(Reflect.get(editor, "attachments")).toEqual([]);
  });

  it("restages the attachments the queued message was sent with", () => {
    const editor = mountedEditor("replacement");

    editor.restoreQueuedSend("look at this", [{ kind: "image", mimeType: "image/png", data: "QUJD", name: "shot.png" }]);

    expect(Reflect.get(editor, "draft")).toBe("look at this");
    expect(Reflect.get(editor, "attachments")).toEqual([
      { id: "attachment-1", kind: "image", name: "shot.png", mimeType: "image/png", data: "QUJD", size: 3 },
    ]);
    // Staged so the restored files survive the composer being remounted or the
    // session being switched, exactly like files the user attached directly.
    const key = machineSessionKey("local", "queued-session");
    expect(loadStagedAttachments(key).map((attachment) => attachment.name)).toEqual(["shot.png"]);
    expect(loadStagedAttachments(key).map((attachment) => attachment.size)).toEqual([3]);
  });

  it("drops whatever was staged when the returned message carried no attachments", () => {
    const editor = mountedEditor("replacement");

    editor.restoreQueuedSend("plain text", []);

    expect(Reflect.get(editor, "attachments")).toEqual<PendingAttachment[]>([]);
    expect(loadStagedAttachments(machineSessionKey("local", "queued-session"))).toEqual([]);
  });
});

function mountedEditor(draft: string): PromptEditor {
  const editor = new PromptEditor();
  editor.machineId = "local";
  editor.sessionId = "queued-session";
  const dispatch = vi.fn<(transaction: unknown) => void>();
  Reflect.set(editor, "draft", draft);
  Reflect.set(editor, "attachments", [{ id: "attachment-1", kind: "file", name: "notes.txt", mimeType: "text/plain", data: "bm90ZXM=", size: 5 }]);
  Reflect.set(editor, "editor", { state: { doc: { toString: () => draft } }, dispatch });
  return editor;
}
