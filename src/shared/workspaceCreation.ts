export const workspaceCreateOperation = "workspace.create";
const workspaceCreateOperationMetadataKey = "pi.operation";
const targetWorkspacePathMetadataKey = "target.workspacePath";

export interface WorkspaceCreationTarget {
  path: string;
}

export function workspaceCreationMetadata(target: WorkspaceCreationTarget): Record<string, string> {
  return {
    [workspaceCreateOperationMetadataKey]: workspaceCreateOperation,
    [targetWorkspacePathMetadataKey]: target.path,
  };
}
