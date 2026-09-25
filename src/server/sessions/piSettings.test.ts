import { describe, expect, it, vi } from "vitest";
import type { PiSettingsCacheWarming, PiSettingsMode, PiSettingsProjectTrust, PiSettingsTransport, PiSettingsUpdate } from "../../shared/apiTypes.js";
import { applyPiSettingsUpdate, parsePiSettingsUpdate, piSettingsProjectOverrides, readPiSettingsSnapshot, type PiSettingsManager, type PiSettingsSession } from "./piSettings.js";

function settingsManager(overrides: Partial<PiSettingsManager> = {}): PiSettingsManager {
  const state: {
    transport: PiSettingsTransport;
    cacheWarming: PiSettingsCacheWarming;
    httpIdleTimeoutMs: number;
    defaultProjectTrust: PiSettingsProjectTrust;
    showCacheMissNotices: boolean;
    warnings: { anthropicExtraUsage?: boolean };
    project: Record<string, unknown>;
  } = {
    transport: "auto",
    cacheWarming: "streaming",
    httpIdleTimeoutMs: 300_000,
    defaultProjectTrust: "ask",
    showCacheMissNotices: false,
    warnings: { anthropicExtraUsage: true },
    project: {},
  };
  const manager: PiSettingsManager = {
    getTransport: () => state.transport,
    setTransport: (value) => { state.transport = value; },
    getCacheWarmingMode: () => state.cacheWarming,
    getHttpIdleTimeoutMs: () => state.httpIdleTimeoutMs,
    setHttpIdleTimeoutMs: (value) => { state.httpIdleTimeoutMs = value; },
    getDefaultProjectTrust: () => state.defaultProjectTrust,
    setDefaultProjectTrust: (value) => { state.defaultProjectTrust = value; },
    getShowCacheMissNotices: () => state.showCacheMissNotices,
    setShowCacheMissNotices: (value) => { state.showCacheMissNotices = value; },
    getWarnings: () => ({ ...state.warnings }),
    setWarnings: (value) => { state.warnings = { ...value }; },
    getProjectSettings: () => state.project,
    flush: () => Promise.resolve(),
    drainErrors: () => [],
    ...overrides,
  };
  return manager;
}

interface TestPiSettingsSession extends Omit<PiSettingsSession, "autoCompactionEnabled" | "steeringMode" | "followUpMode"> {
  manager: PiSettingsManager;
  autoCompactionEnabled: boolean;
  steeringMode: PiSettingsMode;
  followUpMode: PiSettingsMode;
}

function session(manager = settingsManager()): TestPiSettingsSession {
  const value: TestPiSettingsSession = {
    manager,
    autoCompactionEnabled: true,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    settingsManager: manager,
    agent: { transport: manager.getTransport() },
    setAutoCompactionEnabled: vi.fn<(enabled: boolean) => void>((enabled) => { value.autoCompactionEnabled = enabled; }),
    setSteeringMode: vi.fn<(mode: PiSettingsMode) => void>((mode) => { value.steeringMode = mode; }),
    setFollowUpMode: vi.fn<(mode: PiSettingsMode) => void>((mode) => { value.followUpMode = mode; }),
    setCacheWarmingMode: vi.fn((mode) => { manager.setTransport(manager.getTransport()); value.agent.transport = manager.getTransport(); void mode; }),
  };
  return value;
}

describe("Pi settings", () => {
  it("reads effective values and identifies project overrides", () => {
    const manager = settingsManager({
      getProjectSettings: () => ({ transport: "sse", warnings: { anthropicExtraUsage: false } }),
    });
    const current = session(manager);

    expect(readPiSettingsSnapshot(current)).toMatchObject({
      transport: "auto",
      anthropicExtraUsageWarning: true,
      projectOverrides: ["transport", "anthropicExtraUsageWarning"],
      restartRequired: ["httpIdleTimeoutMs"],
    });
    expect(piSettingsProjectOverrides(manager)).toEqual(["transport", "anthropicExtraUsageWarning"]);
  });

  it("applies live and persisted settings through the active Pi session", async () => {
    const current = session();
    const flush = vi.fn<() => Promise<void>>(() => Promise.resolve());
    current.settingsManager.flush = flush;

    const result = await applyPiSettingsUpdate(current, { key: "transport", value: "websocket" });
    expect(current.agent.transport).toBe("websocket");
    expect(flush).toHaveBeenCalledOnce();

    await applyPiSettingsUpdate(current, { key: "autoCompact", value: false });
    await applyPiSettingsUpdate(current, { key: "steeringMode", value: "all" });
    await applyPiSettingsUpdate(current, { key: "followUpMode", value: "all" });
    await applyPiSettingsUpdate(current, { key: "httpIdleTimeoutMs", value: 0 });
    await applyPiSettingsUpdate(current, { key: "defaultProjectTrust", value: "always" });
    await applyPiSettingsUpdate(current, { key: "showCacheMissNotices", value: true });
    await applyPiSettingsUpdate(current, { key: "anthropicExtraUsageWarning", value: false });

    expect(result).toMatchObject({ transport: "websocket" });
    expect(current.autoCompactionEnabled).toBe(false);
    expect(current.steeringMode).toBe("all");
    expect(current.followUpMode).toBe("all");
    expect(readPiSettingsSnapshot(current)).toMatchObject({
      httpIdleTimeoutMs: 0,
      defaultProjectTrust: "always",
      showCacheMissNotices: true,
      anthropicExtraUsageWarning: false,
    });
  });

  it("rejects writes controlled by a trusted workspace settings file", async () => {
    const manager = settingsManager({ getProjectSettings: () => ({ steeringMode: "all" }) });
    const flush = vi.fn<() => Promise<void>>(() => Promise.resolve());
    manager.flush = flush;
    const current = session(manager);
    await expect(applyPiSettingsUpdate(current, { key: "steeringMode", value: "one-at-a-time" })).rejects.toThrow(".pi/settings.json controls steeringMode");
    expect(flush).not.toHaveBeenCalled();
  });

  it("parses only the known update shapes", () => {
    const updates: PiSettingsUpdate[] = [
      { key: "autoCompact", value: false },
      { key: "steeringMode", value: "all" },
      { key: "followUpMode", value: "one-at-a-time" },
      { key: "transport", value: "websocket-cached" },
      { key: "cacheWarming", value: "idle" },
      { key: "httpIdleTimeoutMs", value: 0 },
      { key: "defaultProjectTrust", value: "never" },
      { key: "showCacheMissNotices", value: true },
      { key: "anthropicExtraUsageWarning", value: false },
    ];
    for (const update of updates) expect(parsePiSettingsUpdate(update)).toEqual(update);
    expect(() => parsePiSettingsUpdate({ key: "transport", value: "carrier-pigeon" })).toThrow("Invalid Pi transport");
    expect(() => parsePiSettingsUpdate({ key: "httpIdleTimeoutMs", value: -1 })).toThrow("non-negative safe integer");
    expect(() => parsePiSettingsUpdate({ key: "unknown", value: true })).toThrow("Unknown Pi setting");
  });
});
