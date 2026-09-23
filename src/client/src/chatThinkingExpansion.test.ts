import { describe, expect, it } from "vitest";
import { loadThinkingExpansion, saveThinkingExpansion } from "./chatThinkingExpansion";

describe("thinking expansion preference", () => {
  it("defaults to open thinking parts with no stored preference", () => {
    expect(loadThinkingExpansion(undefined)).toBe(true);
    expect(loadThinkingExpansion({ getItem: () => null })).toBe(true);
  });

  it("round-trips the stored value", () => {
    const values = new Map<string, string>();
    const readStorage = { getItem: (key: string) => values.get(key) ?? null };
    const writeStorage = { setItem: (key: string, value: string) => { values.set(key, value); } };

    expect(loadThinkingExpansion(readStorage)).toBe(true);

    saveThinkingExpansion(false, writeStorage);
    expect(loadThinkingExpansion(readStorage)).toBe(false);

    saveThinkingExpansion(true, writeStorage);
    expect(loadThinkingExpansion(readStorage)).toBe(true);
  });

  it("treats malformed or blocked storage as open", () => {
    expect(loadThinkingExpansion({ getItem: () => "off" })).toBe(false);
    expect(loadThinkingExpansion({ getItem: () => { throw new Error("blocked"); } })).toBe(true);
    try {
      saveThinkingExpansion(false, { setItem: () => { throw new Error("quota"); } });
    } catch {
      throw new Error("save should not raise on storage errors");
    }
  });
});
