import type { TerminalCommandRun } from "./api";
import {
  targetWorkspacePathMetadataKey,
  workspaceCreateOperation,
  workspaceCreateOperationMetadataKey,
} from "../../shared/workspaceCreation";

export { workspaceCreateOperation };

/** Command-run query that finds the host's workspace creation runs. */
export function workspaceCreationRunFilter(): { metadata: Record<string, string> } {
  return { metadata: { [workspaceCreateOperationMetadataKey]: workspaceCreateOperation } };
}

/** Absolute path the run was asked to create; absent for any other run. */
export function createdWorkspacePathForRun(run: TerminalCommandRun): string | undefined {
  if (run.metadata[workspaceCreateOperationMetadataKey] !== workspaceCreateOperation) return undefined;
  const path = run.metadata[targetWorkspacePathMetadataKey];
  return path === undefined || path === "" ? undefined : path;
}

export function isWorkspaceCreationRunPending(run: TerminalCommandRun): boolean {
  return run.status === "queued" || run.status === "running";
}

export function isWorkspaceCreationRunSucceeded(run: TerminalCommandRun): boolean {
  return run.status === "succeeded";
}

/** Latest state of the tracked run, when the queried workspace reported one. */
export function latestWorkspaceCreationRun(
  runs: readonly TerminalCommandRun[],
  runId: string,
): TerminalCommandRun | undefined {
  return runs.filter((run) => run.id === runId).at(-1);
}
