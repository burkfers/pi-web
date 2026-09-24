import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";

const legacyDiffNamespace = "core.workspace.git";

export type GitPanelMode = "changes" | "log" | "branches";

export interface GitRouteState {
  mode: GitPanelMode;
  diffPath?: string;
  commitOid?: string;
  branchName?: string;
}

export interface GitDiffRoute {
  matches(context: WorkspacePanelContext): boolean;
  read(): string | undefined;
  write(path: string | undefined, options?: { replace?: boolean }): void;
  readState(): GitRouteState;
  writeState(state: GitRouteState, options?: { replace?: boolean }): void;
}

export function createGitDiffRoute(panelContributionId: string): GitDiffRoute {
  const namespace = panelContributionId.replaceAll(":", ".");
  const key = (name: string) => `${namespace}--${name}`;
  const legacyKey = `${legacyDiffNamespace}--diff`;
  const readState = (): GitRouteState => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get(key("view"));
    const diffPath = nonEmpty(params.get(key("diff"))) ?? nonEmpty(params.get(legacyKey));
    const commitOid = nonEmpty(params.get(key("commit")));
    const branchName = nonEmpty(params.get(key("branch")));
    if (mode === "log" || mode === "branches") return { mode, ...(commitOid === undefined ? {} : { commitOid }), ...(branchName === undefined ? {} : { branchName }) };
    return { mode: "changes", ...(diffPath === undefined ? {} : { diffPath }) };
  };
  const writeState = (state: GitRouteState, options?: { replace?: boolean }): void => {
    const url = new URL(window.location.href);
    for (const name of ["view", "diff", "commit", "branch"]) url.searchParams.delete(key(name));
    url.searchParams.delete(legacyKey);
    if (state.mode !== "changes") url.searchParams.set(key("view"), state.mode);
    if (state.mode === "changes" && state.diffPath !== undefined && state.diffPath !== "") url.searchParams.set(key("diff"), state.diffPath);
    if (state.mode === "log" && state.commitOid !== undefined) url.searchParams.set(key("commit"), state.commitOid);
    if ((state.mode === "log" || state.mode === "branches") && state.branchName !== undefined) url.searchParams.set(key("branch"), state.branchName);
    commitUrl(url, options?.replace === true);
  };
  return {
    matches: routeMatchesWorkspace,
    read: () => readState().diffPath,
    write: (path, options) => { writeState({ mode: "changes", ...(path === undefined ? {} : { diffPath: path }) }, options); },
    readState,
    writeState,
  };
}

function routeMatchesWorkspace(context: WorkspacePanelContext): boolean {
  const params = new URLSearchParams(window.location.search);
  return (params.get("machine") ?? "local") === context.machine.id
    && params.get("project") === context.workspace.projectId
    && params.get("workspace") === context.workspace.id;
}

function nonEmpty(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

function commitUrl(url: URL, replace: boolean): void {
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  if (replace) window.history.replaceState({}, "", url);
  else window.history.pushState({}, "", url);
}
