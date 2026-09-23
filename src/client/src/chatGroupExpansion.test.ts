import { describe, expect, it } from "vitest";
import { loadChatGroupExpansion, saveChatGroupExpansion } from "./chatGroupExpansion";

describe("chat group expansion preference", () => {
  it("defaults to expanded event groups with no stored preference", () => {
    expect(loadChatGroupExpansion(undefined)).toBe(true);
    expect(loadChatGroupExpansion({ getItem: () => null })).toBe(true);
  });

  it("round-trips the stored value and ignores storage errors", () => {
    const values = new Map<string, string>();
    const readStorage = { getItem: (key: string) => values.get(key) ?? null };
    const writeStorage = { setItem: (key: string, value: string) => { values.set(key, value); } };

    expect(loadChatGroupExpansion(readStorage)).toBe(true);

    saveChatGroupExpansion(false, writeStorage);
    expect(loadChatGroupExpansion(readStorage)).toBe(false);

    saveChatGroupExpansion(true, writeStorage);
    expect(loadChatGroupExpansion(readStorage)).toBe(true);
  });

  it("treats malformed or blocked storage as expanded", () => {
    expect(loadChatGroupExpansion({ getItem: () => "off" })).toBe(false);
    expect(loadChatGroupExpansion({ getItem: () => { throw new Error("blocked"); } })).toBe(true);
    try {
      saveChatGroupExpansion(false, { setItem: () => { throw new Error("quota"); } });
    } catch {
      throw new Error("save should not raise on storage errors");
    }
  });
});
