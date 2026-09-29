import type { Workspace } from "./api";

/** Removal availability and wording come from the current owner, never Git fields. */
export function canDeleteWorkspace(workspace: Workspace | undefined): boolean {
  return workspace?.removal !== undefined && !workspace.isMain;
}

export function workspaceRemovalConfirmation(workspace: Workspace): string | undefined {
  return workspace.removal?.confirmation;
}
