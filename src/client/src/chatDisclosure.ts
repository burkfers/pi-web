export interface ChatDisclosureSnapshot {
  open: string[];
  closedDefaultOpen: string[];
}

export interface ChatDisclosureStorage {
  read(sessionId: string): ChatDisclosureSnapshot | undefined;
  write(sessionId: string, snapshot: ChatDisclosureSnapshot): void;
}

const GROUP_STORAGE_PREFIX = "pi-web:chat-groups:";

const browserChatDisclosureStorage: ChatDisclosureStorage = {
  read(sessionId: string): ChatDisclosureSnapshot | undefined {
    try {
      if (typeof localStorage === "undefined") return undefined;
      const raw = localStorage.getItem(groupStorageKey(sessionId));
      if (raw === null || raw === "") return undefined;
      return parseDisclosureSnapshot(JSON.parse(raw));
    } catch {
      return undefined;
    }
  },

  write(sessionId: string, snapshot: ChatDisclosureSnapshot): void {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(groupStorageKey(sessionId), JSON.stringify(snapshot));
    } catch {
      // Ignore storage failures; group disclosure should still work for this render.
    }
  },
};

export class ChatDisclosureController {
  private sessionId = "";
  private openGroupKeys = new Set<string>();
  private closedDefaultOpenKeys = new Set<string>();

  constructor(private readonly storage: ChatDisclosureStorage = browserChatDisclosureStorage) {}

  syncSession(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    const snapshot = sessionId === "" ? undefined : this.storage.read(sessionId);
    this.openGroupKeys = new Set(snapshot?.open ?? []);
    this.closedDefaultOpenKeys = new Set(snapshot?.closedDefaultOpen ?? []);
  }

  isOpen(groupKey: string, defaultOpen: boolean, legacyKeys: readonly string[] = []): boolean {
    // Explicit toggles win over whatever the current default is, so state
    // carries across default flips (live tail -> settled group, or a change of
    // the expanded-by-default preference). Legacy keys are consulted only when
    // the current stable key has no record, preserving pre-migration choices.
    for (const key of [groupKey, ...legacyKeys]) {
      if (this.openGroupKeys.has(key)) return true;
      if (this.closedDefaultOpenKeys.has(key)) return false;
    }
    return defaultOpen;
  }

  applyToggle(groupKey: string, open: boolean, defaultOpen: boolean, legacyKeys: readonly string[] = []): boolean {
    const wasOpen = this.isOpen(groupKey, defaultOpen, legacyKeys);

    if (open === defaultOpen) {
      // The user accepted the current default; recorded state (if any) is
      // retired so the group follows defaults again hereafter.
      const hadOpen = this.openGroupKeys.delete(groupKey);
      const hadClosed = this.closedDefaultOpenKeys.delete(groupKey);
      const hadLegacy = legacyKeys.some((key) => this.openGroupKeys.delete(key) || this.closedDefaultOpenKeys.delete(key));
      if (!hadOpen && !hadClosed && !hadLegacy) return false;
    } else {
      for (const key of legacyKeys) {
        this.openGroupKeys.delete(key);
        this.closedDefaultOpenKeys.delete(key);
      }
      if (open === wasOpen) return false;
      if (open) {
        this.closedDefaultOpenKeys.delete(groupKey);
        this.openGroupKeys.add(groupKey);
      } else {
        this.openGroupKeys.delete(groupKey);
        this.closedDefaultOpenKeys.add(groupKey);
      }
    }

    this.persist();
    return true;
  }

  snapshot(): ChatDisclosureSnapshot {
    return {
      open: [...this.openGroupKeys],
      closedDefaultOpen: [...this.closedDefaultOpenKeys],
    };
  }

  private persist(): void {
    if (this.sessionId === "") return;
    this.storage.write(this.sessionId, this.snapshot());
  }
}

export function groupStorageKey(sessionId: string): string {
  return `${GROUP_STORAGE_PREFIX}${sessionId}`;
}

export function parseDisclosureSnapshot(value: unknown): ChatDisclosureSnapshot | undefined {
  if (Array.isArray(value)) {
    return { open: stringItems(value), closedDefaultOpen: [] };
  }
  if (!isRecord(value)) return undefined;
  return {
    open: Array.isArray(value["open"]) ? stringItems(value["open"]) : [],
    closedDefaultOpen: Array.isArray(value["closedDefaultOpen"]) ? stringItems(value["closedDefaultOpen"]) : [],
  };
}

function stringItems(items: unknown[]): string[] {
  return items.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
