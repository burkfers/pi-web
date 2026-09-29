/** Small JSON request carrying one creation request, plus a precondition to execute it. */
export const WORKSPACE_CREATION_REQUEST_BODY_MAX_BYTES = 4 * 1024;
/** One sessiond-owned deadline across owner resolution, validation, and planning. */
export const WORKSPACE_CREATION_OPERATION_TIMEOUT_MS = 25_000;
export const WORKSPACE_CREATION_PRECONDITION_MAX_LENGTH = 256;
export const WORKSPACE_CREATION_NAME_MAX_LENGTH = 128;
export const WORKSPACE_CREATION_BASE_REF_MAX_LENGTH = 255;
export const WORKSPACE_CREATION_PATH_MAX_LENGTH = 4_096;

/** Directory name charset: no path separators, no shell or option metacharacters. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
/** Commit-ish charset: refs, tags, and remote-tracking names, nothing else. */
const BASE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

/**
 * Validated creation request. `name` and `baseRef` are bounded here rather than
 * only quoted by the provider: both end up on a host command line, so neither
 * should ever carry a separator, a leading dash, or a metacharacter.
 */
export interface ParsedWorkspaceCreationRequest {
  name: string;
  baseRef: string;
  path?: string;
  precondition?: string;
}

export function parseWorkspaceCreationRequest(value: unknown): ParsedWorkspaceCreationRequest {
  if (!isRecord(value)) throw new Error("Workspace creation request must be an object");
  const name = requireBoundedString(value, "name", WORKSPACE_CREATION_NAME_MAX_LENGTH);
  if (!NAME_PATTERN.test(name)) {
    throw new Error("Workspace name must start with a letter or digit and contain only letters, digits, dots, dashes, and underscores");
  }
  const baseRef = requireBoundedString(value, "baseRef", WORKSPACE_CREATION_BASE_REF_MAX_LENGTH);
  if (!BASE_REF_PATTERN.test(baseRef) || baseRef.includes("..") || baseRef.includes("//") || baseRef.endsWith("/")) {
    throw new Error("Workspace base ref must be a commit-ish name without parent or trailing path segments");
  }
  const rawPath = value["path"];
  let path: string | undefined;
  if (rawPath !== undefined) {
    if (typeof rawPath !== "string" || rawPath === "" || rawPath.length > WORKSPACE_CREATION_PATH_MAX_LENGTH) {
      throw new Error(`Workspace path must be a non-empty string of at most ${String(WORKSPACE_CREATION_PATH_MAX_LENGTH)} characters`);
    }
    if (!rawPath.startsWith("/")) throw new Error("Workspace path must be absolute");
    path = rawPath;
  }
  const rawPrecondition = value["precondition"];
  const precondition = rawPrecondition === undefined
    ? undefined
    : requireWorkspaceCreationPrecondition(rawPrecondition);
  return Object.freeze({
    name,
    baseRef,
    ...(path === undefined ? {} : { path }),
    ...(precondition === undefined ? {} : { precondition }),
  });
}

export function requireWorkspaceCreationPrecondition(value: unknown): string {
  if (
    typeof value !== "string"
    || value === ""
    || value.length > WORKSPACE_CREATION_PRECONDITION_MAX_LENGTH
  ) {
    throw new Error(
      `Workspace creation precondition must be a non-empty string of at most ${String(WORKSPACE_CREATION_PRECONDITION_MAX_LENGTH)} characters`,
    );
  }
  return value;
}

function requireBoundedString(record: Record<string, unknown>, field: string, maxLength: number): string {
  const value = record[field];
  if (typeof value !== "string" || value === "" || value.length > maxLength) {
    throw new Error(`Workspace ${field} must be a non-empty string of at most ${String(maxLength)} characters`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
