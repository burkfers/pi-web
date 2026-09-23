import { describe, expect, it } from "vitest";
import { loadChatGroupExpansion, saveChatGroupExpansion } from "./chatGroupExpansion";

describe("chat group expansion preference", () => {
  it("defaults to collapsed event groups with no stored preference", () => {
    expect(loadChatGroupExpansion(undefined)).toBe(false);
    expect(loadChatGroupExpansion({ getItem: () => null })).toBe(false);
  });

  it("round-trips the stored value and ignores storage errors", () => {
    const values = new Map<string, string>();
    const readStorage = { getItem: (key: string) => values.get(key) ?? null };
    const writeStorage = { setItem: (key: string, value: string) => { values.set(key, value); } };

    expect(loadChatGroupExpansion(readStorage)).toBe(false);

    saveChatGroupExpansion(true, writeStorage);
    expect(loadChatGroupExpansion(readStorage)).toBe(true);

    saveChatGroupExpansion(true, writeStorage);
    expect(loadChatGroupExpansion(readStorage)).toBe(true);
  });

  it("stores on/off and treats blocked storage as collapsed", () => {
    expect(loadChatGroupExpansion({ getItem: () => "on" })).toBe(true);
    expect(loadChatGroupExpansion({ getItem: () => { throw new Error("blocked"); } })).toBe(false);
    try {
      saveChatGroupExpansion(false, { setItem: () => { throw new Error("quota"); } });
    } catch {
      throw new Error("save should not raise on storage errors");
    }
  });
});
