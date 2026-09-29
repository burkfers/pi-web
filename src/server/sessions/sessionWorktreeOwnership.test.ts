import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRecord } from "./sessionFileFormat.js";
import { readSessionHeaderSummary } from "./sessionFileHeader.js";
import { patchSessionWorktreeOwnershipHeader, recordSessionWorktreeOwnership, rewriteSessionHeader, sessionWorktreeOwnershipFromHeader } from "./sessionWorktreeOwnership.js";

const CREATED_AT = "2026-03-04T10:00:00.000Z";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-worktree-ownership-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function readHeaderObject(path: string): Promise<Record<string, unknown>> {
  const content = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(content.slice(0, content.indexOf("\n")));
  if (!isRecord(parsed)) throw new Error("Expected a header object");
  return parsed;
}
async function writeSession(name: string, header: unknown, body = '{"type":"message","id":"m1","parentId":null,"message":{"role":"user","content":"hi"}}'): Promise<string> {
  const path = join(tempDir, name);
  await writeFile(path, `${JSON.stringify(header)}\n${body}\n`, "utf8");
  return path;
}

const sessionHeader = (extra: Record<string, unknown> = {}) => ({ type: "session", version: 3, id: "s1", timestamp: CREATED_AT, cwd: "/srv/app", ...extra });

describe("session worktree ownership header", () => {
  it("records ownership in the header and reads it back", async () => {
    const path = await writeSession("a.jsonl", sessionHeader());

    await recordSessionWorktreeOwnership(path, { owned: true, createdAt: CREATED_AT });

    expect(await readSessionHeaderSummary(path)).toMatchObject({ id: "s1", worktree: { owned: true, createdAt: CREATED_AT } });
  });

  it("leaves the transcript, the id, and the cwd untouched", async () => {
    const body = '{"type":"message","id":"m1","parentId":null,"message":{"role":"user","content":"hi"}}';
    const path = await writeSession("b.jsonl", sessionHeader({ parentSession: "/sessions/parent.jsonl" }), body);

    await recordSessionWorktreeOwnership(path, { owned: true, createdAt: CREATED_AT });

    const lines = (await readFile(path, "utf8")).split("\n");
    expect(await readHeaderObject(path)).toMatchObject({ id: "s1", cwd: "/srv/app", parentSession: "/sessions/parent.jsonl" });
    expect(lines[1]).toBe(body);
  });

  it("keeps PI WEB's other header facts", async () => {
    const path = await writeSession("c.jsonl", sessionHeader({ piWeb: { detachedFrom: "feature-x", detachedAt: "afdd9b8" } }));

    await recordSessionWorktreeOwnership(path, { owned: true, createdAt: CREATED_AT });

    expect((await readHeaderObject(path))["piWeb"]).toEqual({
      detachedFrom: "feature-x",
      detachedAt: "afdd9b8",
      worktree: { owned: true, createdAt: CREATED_AT },
    });
  });

  it("is idempotent and never rewrites an existing record's creation time", async () => {
    const path = await writeSession("d.jsonl", sessionHeader());

    await recordSessionWorktreeOwnership(path, { owned: true, createdAt: CREATED_AT });
    const before = await stat(path);
    await recordSessionWorktreeOwnership(path, { owned: true, createdAt: "2027-01-01T00:00:00.000Z" });
    const after = await stat(path);

    // A same-content rewrite is not just wasteful: it is invisible to the
    // listing memo only when the size holds, so skipping it is what keeps a
    // repeated call from looking like a changed session.
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readSessionHeaderSummary(path)).toMatchObject({ worktree: { owned: true, createdAt: CREATED_AT } });
  });

  it("refuses a file that is not a session", async () => {
    const path = await writeSession("e.jsonl", { type: "not-a-session" });

    await expect(recordSessionWorktreeOwnership(path, { owned: true, createdAt: CREATED_AT })).rejects.toThrow("Invalid session file header");
  });

  it("serializes concurrent rewrites of the same file", async () => {
    const path = await writeSession("g.jsonl", sessionHeader());
    // Two writers, one line: without per-file serialization the second read
    // can land before the first write and drop the first writer's key.
    await Promise.all([
      recordSessionWorktreeOwnership(path, { owned: true, createdAt: CREATED_AT }),
      rewriteSessionHeader(path, (header) => {
        const piWeb = isRecord(header["piWeb"]) ? header["piWeb"] : {};
        piWeb["detachedFrom"] = "feature-x";
        header["piWeb"] = piWeb;
        return true;
      }),
    ]);

    expect((await readHeaderObject(path))["piWeb"]).toEqual({ worktree: { owned: true, createdAt: CREATED_AT }, detachedFrom: "feature-x" });
  });

  it("does not write when the rewrite changes nothing", async () => {
    const path = await writeSession("f.jsonl", sessionHeader({ piWeb: { worktree: { owned: true, createdAt: CREATED_AT } } }));
    const before = await stat(path);

    await rewriteSessionHeader(path, () => false);

    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });
});

describe("session worktree ownership parsing", () => {
  it("reads a well-formed record", () => {
    expect(sessionWorktreeOwnershipFromHeader(sessionHeader({ piWeb: { worktree: { owned: true, createdAt: CREATED_AT } } }))).toEqual({ owned: true, createdAt: CREATED_AT });
  });

  it.each([
    ["no piWeb block", sessionHeader()],
    ["piWeb is not an object", sessionHeader({ piWeb: "yes" })],
    ["worktree is not an object", sessionHeader({ piWeb: { worktree: 3 } })],
    ["not owned", sessionHeader({ piWeb: { worktree: { owned: false, createdAt: CREATED_AT } } })],
    ["no creation time", sessionHeader({ piWeb: { worktree: { owned: true } } })],
    ["empty creation time", sessionHeader({ piWeb: { worktree: { owned: true, createdAt: "" } } })],
    ["header is not an object", "nope"],
  ])("reports no ownership for %s", (_case, header) => {
    expect(sessionWorktreeOwnershipFromHeader(header)).toBeUndefined();
  });
});

describe("patchSessionWorktreeOwnershipHeader", () => {
  it("records ownership in a live runtime's header", () => {
    const header: Record<string, unknown> = { type: "session", id: "s1" };

    patchSessionWorktreeOwnershipHeader(() => header, { owned: true, createdAt: CREATED_AT });

    expect(sessionWorktreeOwnershipFromHeader(header)).toEqual({ owned: true, createdAt: CREATED_AT });
  });

  it("tolerates a runtime that exposes no header", () => {
    expect(() => {
      patchSessionWorktreeOwnershipHeader(() => null, { owned: true, createdAt: CREATED_AT });
      patchSessionWorktreeOwnershipHeader(undefined, { owned: true, createdAt: CREATED_AT });
    }).not.toThrow();
  });
});
