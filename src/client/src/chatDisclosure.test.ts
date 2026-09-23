import { describe, expect, it } from "vitest";
import { ChatDisclosureController, parseDisclosureSnapshot, type ChatDisclosureSnapshot, type ChatDisclosureStorage } from "./chatDisclosure";

class MemoryDisclosureStorage implements ChatDisclosureStorage {
  readonly snapshots = new Map<string, ChatDisclosureSnapshot>();

  read(sessionId: string): ChatDisclosureSnapshot | undefined {
    const snapshot = this.snapshots.get(sessionId);
    return snapshot === undefined ? undefined : cloneSnapshot(snapshot);
  }

  write(sessionId: string, snapshot: ChatDisclosureSnapshot): void {
    this.snapshots.set(sessionId, cloneSnapshot(snapshot));
  }
}

function cloneSnapshot(snapshot: ChatDisclosureSnapshot): ChatDisclosureSnapshot {
  return { open: [...snapshot.open], closedDefaultOpen: [...snapshot.closedDefaultOpen] };
}

describe("ChatDisclosureController", () => {
  it("keeps a default-open live group closed after the user closes it", () => {
    const storage = new MemoryDisclosureStorage();
    const controller = new ChatDisclosureController(storage);
    const key = "s1:e:12";

    controller.syncSession("s1");

    expect(controller.isOpen(key, true)).toBe(true);
    expect(controller.applyToggle(key, false, true)).toBe(true);
    expect(controller.isOpen(key, true)).toBe(false);
    expect(controller.isOpen(key, false)).toBe(false);
    expect(storage.read("s1")).toEqual({ open: [], closedDefaultOpen: [key] });
  });

  it("allows a closed default-open group to be reopened by the user", () => {
    const controller = new ChatDisclosureController(new MemoryDisclosureStorage());
    const key = "s1:e:12";

    controller.syncSession("s1");
    controller.applyToggle(key, false, true);

    expect(controller.applyToggle(key, true, true)).toBe(true);
    expect(controller.isOpen(key, true)).toBe(true);
    expect(controller.snapshot()).toEqual({ open: [], closedDefaultOpen: [] });
  });

  it("falls back to legacy index keys until a group is toggled with its stable key", () => {
    const storage = new MemoryDisclosureStorage();
    storage.snapshots.set("s1", { open: [], closedDefaultOpen: ["s1:live:2"] });
    const controller = new ChatDisclosureController(storage);

    controller.syncSession("s1");

    expect(controller.isOpen("s1:e:new", true, ["s1:live:2"])).toBe(false);
    controller.applyToggle("s1:e:new", true, true, ["s1:live:2"]);
    expect(controller.isOpen("s1:e:new", true, ["s1:live:2"])).toBe(true);
  });

  it("persists explicit opens for groups that are closed by default", () => {
    const storage = new MemoryDisclosureStorage();
    const key = "s1:e:44";

    const first = new ChatDisclosureController(storage);
    first.syncSession("s1");
    first.applyToggle(key, true, false);

    const second = new ChatDisclosureController(storage);
    second.syncSession("s1");

    expect(second.isOpen(key, false)).toBe(true);
  });

  it("carries an explicit state across a default flip", () => {
    const controller = new ChatDisclosureController(new MemoryDisclosureStorage());
    const key = "s1:e:12";

    controller.syncSession("s1");
    controller.applyToggle(key, true, false);

    // The live tail settles into a default-closed group; the explicit open wins.
    expect(controller.isOpen(key, false)).toBe(true);
    expect(controller.isOpen(key, true)).toBe(true);

    // Closing again while the default matches retires the record.
    expect(controller.applyToggle(key, false, false)).toBe(true);
    expect(controller.snapshot()).toEqual({ open: [], closedDefaultOpen: [] });
    expect(controller.isOpen(key, false)).toBe(false);
  });

  it("retires records instead of re-recording when the toggle lands on the default", () => {
    const controller = new ChatDisclosureController(new MemoryDisclosureStorage());
    const key = "s1:e:12";

    controller.syncSession("s1");

    // Details fire `toggle` for both directions; a toggle that lands on the
    // default must not create storage noise.
    expect(controller.applyToggle(key, true, true)).toBe(false);
    expect(controller.snapshot()).toEqual({ open: [], closedDefaultOpen: [] });

    controller.applyToggle(key, false, true);
    expect(controller.applyToggle(key, true, true)).toBe(true);
    expect(controller.applyToggle(key, false, true)).toBe(true);
    expect(controller.snapshot()).toEqual({ open: [], closedDefaultOpen: [key] });
  });
});

describe("parseDisclosureSnapshot", () => {
  it("hydrates legacy array storage as open group keys", () => {
    expect(parseDisclosureSnapshot(["a", 1, "b"])).toEqual({ open: ["a", "b"], closedDefaultOpen: [] });
  });

  it("hydrates object storage", () => {
    expect(parseDisclosureSnapshot({ open: ["a"], closedDefaultOpen: ["b", false] })).toEqual({ open: ["a"], closedDefaultOpen: ["b"] });
  });
});
