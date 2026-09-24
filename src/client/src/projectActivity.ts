import type { Project, ProjectActivitySnapshot } from "./api";

/**
 * Browser-local recency stamps per project id. Seeded from the daemon's
 * durable snapshot (`GET /projects/activity`) and refreshed whenever a
 * project's sessions load, so it survives reloads and covers visited projects.
 */
export function mergeProjectActivity(
  existing: Record<string, string>,
  snapshot: ProjectActivitySnapshot | undefined,
): Record<string, string> {
  if (snapshot === undefined) return { ...existing };
  const merged: Record<string, string> = { ...existing };
  for (const [projectId, entry] of Object.entries(snapshot.projects)) {
    const previous = merged[projectId];
    if (previous === undefined || Date.parse(entry.lastActivityAt) > Date.parse(previous)) {
      merged[projectId] = entry.lastActivityAt;
    }
  }
  return merged;
}

/** Stamp one project with an activity moment known to be fresher than what is recorded. */
export function recordProjectActivity(
  existing: Record<string, string>,
  projectId: string | undefined,
  at: string,
): Record<string, string> {
  if (projectId === undefined || projectId === "") return existing;
  const previous = existing[projectId];
  if (previous !== undefined && Date.parse(previous) >= Date.parse(at)) return existing;
  return { ...existing, [projectId]: at };
}

/**
 * Display order for the Projects pane, driven by most recent session activity.
 *
 * - Projects with known recency sort newest-first; ties keep the input order.
 * - Projects with no known recency keep their relative input order and follow
 *   the recency-known group.
 * - The selected project never competes: it keeps its current slot while the
 *   remaining projects order around it, so selecting a project alone never
 *   bounces the pane. `currentOrder` supplies that slot for an already-rendered
 *   list; the source index remains the fallback for first render.
 */
export function orderProjectsByRecentActivity(
  projects: readonly Project[],
  activityAt: Readonly<Record<string, string>>,
  selectedProjectId?: string,
  currentOrder?: readonly Project[],
): Project[] {
  const others = projects.filter((project) => project.id !== selectedProjectId);
  const known = others.filter((project) => activityAt[project.id] !== undefined);
  const unknown = others.filter((project) => activityAt[project.id] === undefined);
  known.sort((left, right) => Date.parse(activityAt[right.id] ?? "") - Date.parse(activityAt[left.id] ?? ""));

  const selected = selectedProjectId === undefined ? undefined : projects.find((project) => project.id === selectedProjectId);
  if (selected === undefined) return [...known, ...unknown];
  const reordered = [...known, ...unknown];
  const currentSlot = currentOrder?.indexOf(selected) ?? -1;
  const slot = Math.min(currentSlot >= 0 ? currentSlot : projects.indexOf(selected), reordered.length);
  return [...reordered.slice(0, slot), selected, ...reordered.slice(slot)];
}
