import type { ProjectActivitySnapshot } from "../../shared/apiTypes.js";
import type { WorkspaceActivityService } from "../activity/workspaceActivityService.js";
import type { ArchivedSessionRecord } from "../sessions/sessionArchiveStore.js";
import type { PiSessionActivityEntry, PiSessionListEntry } from "../sessions/piSessionService.js";
import type { WorkspaceAttribution } from "../status/workspaceAttribution.js";

/** Cross-project session listing (all Pi session stores at once). */
interface ProjectActivitySessionLister {
  listAll(): Promise<PiSessionListEntry[]>;
  listActivity?(): Promise<PiSessionActivityEntry[]>;
}

interface ProjectActivityArchiveStore {
  list(): Promise<ArchivedSessionRecord[]>;
}

export interface ProjectActivityDependencies {
  sessions: ProjectActivitySessionLister;
  archiveStore: ProjectActivityArchiveStore;
  /** cwd → project attribution shared with the machine status projection. */
  attribution: Pick<WorkspaceAttribution, "attribute">;
  workspaceActivity: Pick<WorkspaceActivityService, "latestActivityAtByCwd">;
  /**
   * Durable session listings scan the whole Pi session store, so their recency
   * map is reused within this window. Attribution and live activity are applied
   * after this cache so current workspace changes remain visible between rebuilds.
   */
  cacheTtlMs?: number;
  now?: () => number;
}

const DEFAULT_CACHE_TTL_MS = 30_000;

/**
 * Computes the most recent session activity per project from the durable
 * session stores (transcript mtimes and the archive store), attributed to
 * projects through the shared workspace topology. Live session activity
 * timestamps layer on top so the browser sees fresh activity without waiting
 * for the next durable scan.
 */
export class ProjectActivityService {
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cache: DurableRecencyCacheEntry | undefined;

  constructor(private readonly dependencies: ProjectActivityDependencies) {
    this.cacheTtlMs = dependencies.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = dependencies.now ?? (() => Date.now());
  }

  async snapshot(): Promise<ProjectActivitySnapshot> {
    const durableRecency = await this.durableRecency();
    return this.projectSnapshot(durableRecency);
  }

  private async durableRecency(): Promise<ReadonlyMap<string, string>> {
    const cached = this.cache;
    if (cached !== undefined && this.now() - cached.loadedAt < this.cacheTtlMs) return cached.recency;
    const sessions = this.dependencies.sessions.listActivity?.() ?? this.dependencies.sessions.listAll();
    const recency = await durableRecencyByCwd(sessions, this.dependencies.archiveStore.list());
    this.cache = { loadedAt: this.now(), recency };
    return recency;
  }

  private async projectSnapshot(durableRecency: ReadonlyMap<string, string>): Promise<ProjectActivitySnapshot> {
    // Attribution rejects only on project listing failures; it logs listing
    // problems per project instead, so one bad provider cannot blank the map.
    const sessionCwdRecency = new Map(durableRecency);
    const liveActivity = this.dependencies.workspaceActivity.latestActivityAtByCwd();
    for (const [cwd, at] of liveActivity) {
      const previous = sessionCwdRecency.get(cwd);
      if (previous === undefined || Date.parse(at) > Date.parse(previous)) sessionCwdRecency.set(cwd, at);
    }

    const attributed = await this.dependencies.attribution.attribute(sessionCwdRecency.keys());
    const projects: Record<string, { lastActivityAt: string }> = {};
    for (const [cwd, at] of sessionCwdRecency) {
      const owner = attributed.get(cwd);
      if (owner === undefined) continue;
      const projectId = owner.projectId;
      const previous = projects[projectId]?.lastActivityAt;
      if (previous === undefined || Date.parse(at) > Date.parse(previous)) {
        projects[projectId] = { lastActivityAt: at };
      }
    }
    return { projects };
  }
}

interface DurableRecencyCacheEntry {
  loadedAt: number;
  recency: ReadonlyMap<string, string>;
}

/**
 * Merges the transcript listing and the archive store into one recency value
 * per cwd. Archived sessions keep their last `modified` even though their
 * transcripts moved, so closed work stays attributed at its original project.
 */
async function durableRecencyByCwd(
  sessions: Promise<PiSessionListEntry[] | PiSessionActivityEntry[]>,
  archived: Promise<ArchivedSessionRecord[]>,
): Promise<Map<string, string>> {
  const [sessionEntries, archivedRecords] = await Promise.all([sessions, archived]);
  const recency = new Map<string, string>();
  const raise = (cwd: string | undefined, at: string | undefined): void => {
    if (cwd === undefined || cwd === "" || at === undefined || at === "") return;
    const previous = recency.get(cwd);
    if (previous === undefined || Date.parse(at) > Date.parse(previous)) recency.set(cwd, at);
  };
  for (const entry of sessionEntries) raise(entry.cwd, entry.modified.toISOString());
  for (const record of archivedRecords) raise(record.cwd, record.modified ?? record.archivedAt);
  return recency;
}
