import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiWebConfig } from "../../config.js";
import { parseWorktreesConfig } from "../../config.js";
import { PROJECT_PI_WEB_CONFIG_PATH, loadEffectiveProjectWorktreesConfig } from "./projectPiWebConfig.js";
import { generateWorktreeName, resolveProjectWorktreeDirectory, resolveWorktreeRoot, WorktreeRootError, worktreeDirectoryFor } from "./worktreeRoot.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-worktree-root-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const globalConfig = (worktrees?: PiWebConfig["worktrees"]): PiWebConfig => (worktrees === undefined ? {} : { worktrees });

async function writeProjectConfig(worktrees: unknown): Promise<string> {
  const projectPath = join(tempDir, "roadmap");
  await mkdir(join(projectPath, ".pi-web"), { recursive: true });
  await writeFile(join(projectPath, PROJECT_PI_WEB_CONFIG_PATH), JSON.stringify({ worktrees }), "utf8");
  return projectPath;
}

describe("resolveWorktreeRoot", () => {
  it("derives a tree beside the checkout when no root is configured", () => {
    const root = resolveWorktreeRoot("/srv/dev/roadmap", undefined);

    expect(root).toEqual({ root: "/srv/dev/worktrees", directory: "/srv/dev/worktrees/roadmap", configured: false });
  });

  it("uses a configured root, with the project in its own subdirectory", () => {
    const root = resolveWorktreeRoot("/srv/dev/roadmap", { root: "/mnt/fast" });

    expect(root).toEqual({ root: "/mnt/fast", directory: "/mnt/fast/roadmap", configured: true });
  });

  it("expands a home-relative root", () => {
    expect(resolveWorktreeRoot("/srv/dev/roadmap", { root: "~/trees" }).directory).toBe(`${homedir()}/trees/roadmap`);
  });

  it("refuses the filesystem root", () => {
    expect(() => resolveWorktreeRoot("/srv/dev/roadmap", { root: "/" })).toThrow(WorktreeRootError);
  });

  it("refuses a root inside the checkout", () => {
    // A worktree inside the repository it was created from is a nested repo
    // that the parent checkout's tooling keeps walking into.
    expect(() => resolveWorktreeRoot("/srv/dev/roadmap", { root: "/srv/dev/roadmap/trees" })).toThrow(/must not be inside the project/);
  });

  it("refuses the checkout itself as the root", () => {
    expect(() => resolveWorktreeRoot("/srv/dev/roadmap", { root: "/srv/dev/roadmap" })).toThrow(WorktreeRootError);
  });

  it("accepts a root that contains the checkout", () => {
    // The worktree itself never overlaps the project, so a shared parent root
    // like a monorepo of projects stays legal.
    expect(resolveWorktreeRoot("/srv/dev/roadmap", { root: "/srv/dev" }).directory).toBe("/srv/dev/roadmap");
  });

  it("keeps a root that shares a name prefix with the checkout out of the ancestor check", () => {
    expect(resolveWorktreeRoot("/srv/dev/roadmap", { root: "/srv/dev/roadmap-trees" }).directory).toBe("/srv/dev/roadmap-trees/roadmap");
  });
});

describe("worktree config precedence", () => {
  it("prefers the project-local root over the global one", async () => {
    const projectPath = await writeProjectConfig({ root: join(tempDir, "project-trees") });

    expect(await resolveProjectWorktreeDirectory(projectPath, globalConfig({ root: "/mnt/global" }))).toBe(join(tempDir, "project-trees", "roadmap"));
  });

  it("falls back to the global root when the project sets none", async () => {
    const projectPath = await writeProjectConfig({ newSession: "never" });

    expect(await resolveProjectWorktreeDirectory(projectPath, globalConfig({ root: "/mnt/global" }))).toBe("/mnt/global/roadmap");
  });

  it("falls back to the derived tree when neither sets a root", async () => {
    const projectPath = await writeProjectConfig({ newSession: "never" });

    expect(await resolveProjectWorktreeDirectory(projectPath, globalConfig())).toBe(join(tempDir, "worktrees", "roadmap"));
  });

  it("keeps project and global settings independent per key", async () => {
    const projectPath = await writeProjectConfig({ root: join(tempDir, "project-trees") });
    const effective = await loadEffectiveProjectWorktreesConfig(projectPath, globalConfig({ newSession: "never" }));

    expect(effective).toEqual({ root: join(tempDir, "project-trees"), newSession: "never" });
  });
});

describe("parseWorktreesConfig", () => {
  it("normalizes an absolute root", () => {
    expect(parseWorktreesConfig({ root: "/mnt//fast/../fast" }, "config.json")).toEqual({ root: "/mnt/fast" });
  });

  it("accepts a home-relative root", () => {
    expect(parseWorktreesConfig({ root: "~/trees" }, "config.json")).toEqual({ root: `${homedir()}/trees` });
  });

  it("accepts both new-session modes", () => {
    expect(parseWorktreesConfig({ newSession: "never" }, "config.json")).toEqual({ newSession: "never" });
    expect(parseWorktreesConfig({ newSession: "always" }, "config.json")).toEqual({ newSession: "always" });
  });

  it.each([
    ["a relative root", { root: "trees" }],
    ["an empty root", { root: "  " }],
    ["a non-string root", { root: 3 }],
    ["an unknown new-session mode", { newSession: "sometimes" }],
    ["a non-object", "worktrees"],
  ])("rejects %s", (_case, value) => {
    expect(() => parseWorktreesConfig(value, "config.json")).toThrow();
  });
});

describe("generated worktree names", () => {
  it("produces an opaque, unique directory name", () => {
    const first = generateWorktreeName();
    const second = generateWorktreeName();

    expect(first).toMatch(/^session-[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });

  it("places the name inside the project's worktree directory", () => {
    const root = resolveWorktreeRoot("/srv/dev/roadmap", { root: "/mnt/fast" });

    expect(worktreeDirectoryFor(root, "session-1a2b3c4d")).toBe("/mnt/fast/roadmap/session-1a2b3c4d");
  });
});
