import type {
  PiSettingsCacheWarming,
  PiSettingsKey,
  PiSettingsMode,
  PiSettingsProjectTrust,
  PiSettingsSnapshot,
  PiSettingsTransport,
  PiSettingsUpdate,
} from "../../shared/apiTypes.js";

export interface PiSettingsManager {
  getTransport(): PiSettingsTransport;
  setTransport(value: PiSettingsTransport): void;
  getCacheWarmingMode(): PiSettingsCacheWarming;
  getHttpIdleTimeoutMs(): number;
  setHttpIdleTimeoutMs(value: number): void;
  getDefaultProjectTrust(): PiSettingsProjectTrust;
  setDefaultProjectTrust(value: PiSettingsProjectTrust): void;
  getShowCacheMissNotices(): boolean;
  setShowCacheMissNotices(value: boolean): void;
  getWarnings(): { anthropicExtraUsage?: boolean };
  setWarnings(value: { anthropicExtraUsage?: boolean }): void;
  getProjectSettings?(): unknown;
  flush(): Promise<void>;
  drainErrors(): { scope: string; error: Error }[];
}

export interface PiSettingsSession {
  readonly autoCompactionEnabled: boolean;
  readonly steeringMode: PiSettingsMode;
  readonly followUpMode: PiSettingsMode;
  readonly settingsManager: PiSettingsManager;
  readonly agent: { transport: PiSettingsTransport };
  setAutoCompactionEnabled(enabled: boolean): void;
  setSteeringMode(mode: PiSettingsMode): void;
  setFollowUpMode(mode: PiSettingsMode): void;
  setCacheWarmingMode(mode: PiSettingsCacheWarming): void;
}

const PROJECT_OVERRIDE_PATHS: Partial<Record<PiSettingsKey, readonly string[]>> = {
  autoCompact: ["compaction", "enabled"],
  steeringMode: ["steeringMode"],
  followUpMode: ["followUpMode"],
  transport: ["transport"],
  httpIdleTimeoutMs: ["httpIdleTimeoutMs"],
  showCacheMissNotices: ["showCacheMissNotices"],
  anthropicExtraUsageWarning: ["warnings", "anthropicExtraUsage"],
};

const HTTP_IDLE_TIMEOUT_RESTART_KEY: PiSettingsKey = "httpIdleTimeoutMs";
const PROJECT_OVERRIDE_KEYS: readonly PiSettingsKey[] = [
  "autoCompact",
  "steeringMode",
  "followUpMode",
  "transport",
  "httpIdleTimeoutMs",
  "showCacheMissNotices",
  "anthropicExtraUsageWarning",
];

export function asPiSettingsSession(value: unknown): PiSettingsSession {
  if (!isPiSettingsSession(value)) throw new Error("This Pi runtime does not expose the settings required by PI WEB");
  return value;
}

export function piSettingsProjectOverrides(settingsManager: PiSettingsManager): PiSettingsKey[] {
  const projectSettings = settingsManager.getProjectSettings?.();
  if (!isRecord(projectSettings)) return [];
  return PROJECT_OVERRIDE_KEYS.filter((key) => {
    const path = PROJECT_OVERRIDE_PATHS[key];
    return path !== undefined && hasProjectPath(projectSettings, path);
  });
}

export function readPiSettingsSnapshot(session: PiSettingsSession): PiSettingsSnapshot {
  const projectOverrides = piSettingsProjectOverrides(session.settingsManager);
  return {
    autoCompact: session.autoCompactionEnabled,
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    transport: session.settingsManager.getTransport(),
    cacheWarming: session.settingsManager.getCacheWarmingMode(),
    httpIdleTimeoutMs: session.settingsManager.getHttpIdleTimeoutMs(),
    defaultProjectTrust: session.settingsManager.getDefaultProjectTrust(),
    showCacheMissNotices: session.settingsManager.getShowCacheMissNotices(),
    anthropicExtraUsageWarning: session.settingsManager.getWarnings().anthropicExtraUsage !== false,
    projectOverrides,
    restartRequired: [HTTP_IDLE_TIMEOUT_RESTART_KEY],
  };
}

export async function applyPiSettingsUpdate(session: PiSettingsSession, update: PiSettingsUpdate): Promise<PiSettingsSnapshot> {
  if (piSettingsProjectOverrides(session.settingsManager).includes(update.key)) {
    throw new Error(`This workspace's .pi/settings.json controls ${update.key}; edit the project file or change the global setting outside this session.`);
  }

  switch (update.key) {
    case "autoCompact":
      session.setAutoCompactionEnabled(update.value);
      break;
    case "steeringMode":
      session.setSteeringMode(update.value);
      break;
    case "followUpMode":
      session.setFollowUpMode(update.value);
      break;
    case "transport":
      session.settingsManager.setTransport(update.value);
      session.agent.transport = update.value;
      break;
    case "cacheWarming":
      session.setCacheWarmingMode(update.value);
      break;
    case "httpIdleTimeoutMs":
      session.settingsManager.setHttpIdleTimeoutMs(update.value);
      break;
    case "defaultProjectTrust":
      session.settingsManager.setDefaultProjectTrust(update.value);
      break;
    case "showCacheMissNotices":
      session.settingsManager.setShowCacheMissNotices(update.value);
      break;
    case "anthropicExtraUsageWarning":
      session.settingsManager.setWarnings({ ...session.settingsManager.getWarnings(), anthropicExtraUsage: update.value });
      break;
  }

  await session.settingsManager.flush();
  const errors = session.settingsManager.drainErrors();
  if (errors.length > 0) {
    throw new Error(`Pi settings could not be saved: ${errors.map(({ error }) => error.message).join("; ")}`);
  }
  return readPiSettingsSnapshot(session);
}

export function parsePiSettingsUpdate(value: unknown): PiSettingsUpdate {
  const record = requireRecord(value);
  const key = requireString(record, "key");
  switch (key) {
    case "autoCompact":
      return { key, value: requireBoolean(record) };
    case "steeringMode":
      return { key, value: requireMode(record) };
    case "followUpMode":
      return { key, value: requireMode(record) };
    case "transport":
      return { key, value: requireTransport(record) };
    case "cacheWarming":
      return { key, value: requireCacheWarming(record) };
    case "httpIdleTimeoutMs": {
      const value = record["value"];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("httpIdleTimeoutMs must be a non-negative safe integer");
      return { key, value };
    }
    case "defaultProjectTrust":
      return { key, value: requireProjectTrust(record) };
    case "showCacheMissNotices":
      return { key, value: requireBoolean(record) };
    case "anthropicExtraUsageWarning":
      return { key, value: requireBoolean(record) };
    default:
      throw new Error(`Unknown Pi setting: ${key}`);
  }
}

function isPiSettingsSession(value: unknown): value is PiSettingsSession {
  if (!isRecord(value) || !isRecord(value["settingsManager"]) || !isRecord(value["agent"])) return false;
  for (const method of ["setAutoCompactionEnabled", "setSteeringMode", "setFollowUpMode", "setCacheWarmingMode"]) {
    if (typeof value[method] !== "function") return false;
  }
  const manager = value["settingsManager"];
  for (const method of ["getTransport", "setTransport", "getCacheWarmingMode", "getHttpIdleTimeoutMs", "setHttpIdleTimeoutMs", "getDefaultProjectTrust", "setDefaultProjectTrust", "getShowCacheMissNotices", "setShowCacheMissNotices", "getWarnings", "setWarnings", "flush", "drainErrors"]) {
    if (typeof manager[method] !== "function") return false;
  }
  return typeof value["autoCompactionEnabled"] === "boolean"
    && isPiSettingsMode(value["steeringMode"])
    && isPiSettingsMode(value["followUpMode"])
    && isPiSettingsTransport(value["agent"]["transport"]);
}

function isPiSettingsMode(value: unknown): value is PiSettingsMode {
  return value === "all" || value === "one-at-a-time";
}

function isPiSettingsTransport(value: unknown): value is PiSettingsTransport {
  return value === "sse" || value === "websocket" || value === "websocket-cached" || value === "auto";
}

function hasProjectPath(settings: Record<string, unknown>, path: readonly string[]): boolean {
  let current: unknown = settings;
  for (const segment of path) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return false;
    current = current[segment];
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Pi settings update must be an object");
  return value;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requireBoolean(record: Record<string, unknown>): boolean {
  const value = record["value"];
  if (typeof value !== "boolean") throw new Error("Pi setting value must be a boolean");
  return value;
}

function requireMode(record: Record<string, unknown>): PiSettingsMode {
  const value = record["value"];
  if (value !== "all" && value !== "one-at-a-time") throw new Error("Pi setting value must be all or one-at-a-time");
  return value;
}

function requireTransport(record: Record<string, unknown>): PiSettingsTransport {
  const value = record["value"];
  if (value !== "sse" && value !== "websocket" && value !== "websocket-cached" && value !== "auto") throw new Error("Invalid Pi transport setting");
  return value;
}

function requireCacheWarming(record: Record<string, unknown>): PiSettingsCacheWarming {
  const value = record["value"];
  if (value !== "off" && value !== "streaming" && value !== "idle") throw new Error("Invalid Pi cache warming setting");
  return value;
}

function requireProjectTrust(record: Record<string, unknown>): PiSettingsProjectTrust {
  const value = record["value"];
  if (value !== "ask" && value !== "always" && value !== "never") throw new Error("Invalid Pi project trust setting");
  return value;
}
