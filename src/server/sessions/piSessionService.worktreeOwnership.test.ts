import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRecord } from "./sessionFileFormat.js";
import { PiSessionService } from "./piSessionService.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";
const LISTING_CWD = "/srv/dev/pi-web";
const CREATED_AT = "2026-03-04T10:00:00.000Z";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-session-worktree-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const header = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "session", version: 3, id, timestamp: CREATED_AT, cwd: LISTING_CWD, ...extra });
async function headerObject(path: string): Promise<Record<string, unknown>> {
  const content = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(content.slice(0, content.indexOf("\n")));
  if (!isRecord(parsed)) throw new Error("Expected a header object");
  return parsed;
}
const message = (id: string, text: string) => JSON.stringify({ type: "message", id, parentId: "root", timestamp: CREATED_AT, message: { role: "user", content: [{ type: "text", text }] } });

interface Harness {
  service: PiSessionService;
  invalidated: string[];
  sessionDir: string;
  writeSessionFile: (name: string, id: string, extra?: Record<string, unknown>) => Promise<string>;
}

function harness(options: { readonly liveHeader?: Record<string, unknown>; readonly sessionFile?: string } = {}): Harness {
  const sessionDir = join(tempDir, "sessions");
  const invalidated: string[] = [];
  const liveHeader = options.liveHeader;
  // The resolved transcript path is only known once the gateway resolves the
  // session, and the runtime is built from it; the getter keeps both in step.
  const sessionFileRef: { path: string | undefined } = { path: options.sessionFile };
  const runtimeFactory = () => {
    const base = fakeRuntime("s1");
    return {
      ...base,
      runtime: {
        ...base.runtime,
        cwd: LISTING_CWD,
        session: {
          ...base.runtime.session,
          get sessionFile() {
            return sessionFileRef.path ?? base.runtime.session.sessionFile;
          },
          sessionManager: fakeSessionManager(LISTING_CWD, liveHeader === undefined ? {} : { getHeader: () => liveHeader }),
        },
      },
    };
  };
  const gateway = createPiSessionManagerGateway({ agentDir: TEST_AGENT_DIR, env: { PI_CODING_AGENT_SESSION_DIR: sessionDir } });
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    createAgentRuntime: async () => {
      await Promise.resolve();
      return runtimeFactory().runtime;
    },
    archiveStore: emptyArchiveStore(),
    sessionManager: {
      create: () => fakeSessionManager(LISTING_CWD, liveHeader === undefined ? {} : { getHeader: () => liveHeader }),
      list: (refCwd: string) => gateway.list(refCwd),
      listAll: () => gateway.listAll(),
      resolveSessionFile: async (refCwd: string, id: string) => {
        const resolved = await gateway.resolveSessionFile(refCwd, id);
        if (resolved !== undefined) sessionFileRef.path = resolved.path;
        return resolved;
      },
      invalidateSessionFile: (sessionFile: string) => {
        invalidated.push(sessionFile);
        gateway.invalidateSessionFile(sessionFile);
      },
      open: () => fakeSessionManager(LISTING_CWD, { getSessionId: () => "s1", ...(liveHeader === undefined ? {} : { getHeader: () => liveHeader }) }),
    },
    heartbeatIntervalMs: 60_000,
  });
  return {
    service,
    invalidated,
    sessionDir,
    writeSessionFile: async (name, id, extra = {}) => {
      await mkdir(sessionDir, { recursive: true });
      const path = join(sessionDir, name);
      await writeFile(path, `${header(id, extra)}\n${message("m1", "hello")}\n`, "utf8");
      return path;
    },
  };
}

describe("PiSessionService worktree ownership", () => {
  it("lists a session whose worktree PI WEB created", async () => {
    const { service, writeSessionFile } = harness();
    await writeSessionFile("2026-03-04T00-00-00-000Z_s1.jsonl", "s1", { piWeb: { worktree: { owned: true, createdAt: CREATED_AT } } });

    const [session] = await service.list(LISTING_CWD);

    expect(session?.worktree).toEqual({ owned: true, createdAt: CREATED_AT });
    await service.dispose();
  });

  it("omits the field for a session in a checkout PI WEB did not create", async () => {
    const { service, writeSessionFile } = harness();
    await writeSessionFile("2026-03-04T00-00-00-000Z_s1.jsonl", "s1");

    const [session] = await service.list(LISTING_CWD);

    expect(session).toBeDefined();
    expect(session?.worktree).toBeUndefined();
    await service.dispose();
  });

  it("records ownership on a persisted session and shows it in the next listing", async () => {
    const { service, writeSessionFile, invalidated } = harness();
    const path = await writeSessionFile("2026-03-04T00-00-00-000Z_s1.jsonl", "s1");
    const before = await service.list(LISTING_CWD);
    expect(before[0]?.worktree).toBeUndefined();

    await service.recordWorktreeOwnership(sessionRef("s1", LISTING_CWD), { createdAt: CREATED_AT });

    expect((await headerObject(path))["piWeb"]).toEqual({ worktree: { owned: true, createdAt: CREATED_AT } });
    // The rewrite keeps the inode and can keep the size, which the listing memo
    // cannot see; without the invalidation a warm listing would report no worktree.
    expect(invalidated).toEqual([path]);
    expect((await service.list(LISTING_CWD))[0]?.worktree).toEqual({ owned: true, createdAt: CREATED_AT });
    await service.dispose();
  });

  it("records ownership on a session that has never persisted without a file rewrite", async () => {
    const liveHeader: Record<string, unknown> = { type: "session", id: "s1" };
    // No file on disk and no session in the listing: this is a started session
    // that has not yet flushed, which only exists in memory.
    const { service, invalidated } = harness({ liveHeader });
    const started = await service.start(LISTING_CWD);

    await service.recordWorktreeOwnership(sessionRef(started.id, LISTING_CWD), { createdAt: CREATED_AT });

    // The SDK writes its in-memory header verbatim on first persist, so a
    // session with no file yet needs the memory patch and nothing else.
    expect(invalidated).toEqual([]);
    expect(liveHeader["piWeb"]).toEqual({ worktree: { owned: true, createdAt: CREATED_AT } });
    await service.dispose();
  });
});
