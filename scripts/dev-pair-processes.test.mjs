import { describe, expect, it } from "vitest";
import { ancestorPids, isDevPairProcess, listDevPairProcesses } from "./dev-pair-processes.mjs";

const socket = "/tmp/pi-web-dev/sessiond.sock";
const dataDir = "/tmp/pi-web-dev/data";
const options = { socket, dataDir, uiPort: 8599 };

function environ(entries) {
  return `${entries.map(([key, value]) => `${key}=${value}`).join("\0")}\0`;
}

const devEnv = environ([
  ["PI_WEB_SESSIOND_SOCKET", socket],
  ["PI_WEB_DATA_DIR", dataDir],
]);
const prodEnv = environ([
  ["PI_WEB_SESSIOND_SOCKET", "/data/pi-web/sessiond.sock"],
  ["PI_WEB_DATA_DIR", "/data/pi-web"],
]);

function cmdline(...parts) {
  return `${parts.join("\0")}\0`;
}

describe("isDevPairProcess", () => {
  it("accepts the dev pair's own watchers, runtimes, and helpers", () => {
    const commands = [
      cmdline("/usr/local/bin/node", "/workspace/pi-web/node_modules/tsx/dist/cli.mjs", "watch", "src/server/sessiond.ts"),
      cmdline("/usr/local/bin/node", "/workspace/pi-web/node_modules/tsx/dist/cli.mjs", "watch", "src/server/index.ts"),
      cmdline("/usr/local/bin/node", "/workspace/pi-web/scripts/dev-sessiond.mjs", "--watch"),
      cmdline("/usr/local/bin/node", "/workspace/pi-web/scripts/dev-web.mjs"),
      cmdline("/usr/local/bin/node", "/workspace/pi-web/scripts/build-plugins.mjs", "--watch"),
      cmdline("/usr/local/bin/node", "--import", "file:///…/tsx/dist/loader.mjs", "src/server/sessiond.ts"),
      cmdline("/usr/local/bin/node", "--import", "file:///…/tsx/dist/loader.mjs", "src/server/index.ts"),
      cmdline("/usr/local/bin/node", "/workspace/pi-web/node_modules/.bin/vite", "--host", "0.0.0.0", "--port", "8599"),
    ];
    for (const command of commands) {
      expect(isDevPairProcess(devEnv, command, options), command).toBe(true);
    }
  });

  it("never matches production processes that share entrypoint names", () => {
    const production = [
      // The production session daemon binary shares no dev marker.
      cmdline("/usr/local/bin/node", "/usr/local/bin/pi-web-sessiond"),
      // The production UI service also runs vite and the dev-web entrypoint.
      cmdline("/usr/local/bin/node", "/workspace/pi-web/node_modules/.bin/vite", "--host", "0.0.0.0", "--port", "3000"),
      cmdline("/usr/local/bin/node", "/workspace/pi-web/scripts/dev-web.mjs"),
      cmdline("/usr/local/bin/node", "/workspace/pi-web/node_modules/tsx/dist/cli.mjs", "watch", "src/server/index.ts"),
      cmdline("/usr/local/bin/node", "--import", "file:///…/tsx/dist/loader.mjs", "src/server/index.ts"),
    ];
    for (const command of production) {
      expect(isDevPairProcess(prodEnv, command, options), command).toBe(false);
    }
  });

  it("requires both dev markers, never just one", () => {
    const command = cmdline("/usr/local/bin/node", "/workspace/pi-web/scripts/dev-web.mjs");
    const socketOnly = environ([["PI_WEB_SESSIOND_SOCKET", socket]]);
    const dataDirOnly = environ([["PI_WEB_DATA_DIR", dataDir]]);
    expect(isDevPairProcess(socketOnly, command, options)).toBe(false);
    expect(isDevPairProcess(dataDirOnly, command, options)).toBe(false);
    expect(isDevPairProcess(socketOnly, command, { ...options, socket: "/data/pi-web/sessiond.sock" })).toBe(false);
  });

  it("requires the dev UI port for vite, so another port is never taken", () => {
    const vite = cmdline("/usr/local/bin/node", "vite", "--port", "3000");
    expect(isDevPairProcess(devEnv, vite, options)).toBe(false);
    expect(isDevPairProcess(devEnv, cmdline("/usr/local/bin/node", "vite", "--port", "8599"), options)).toBe(true);
  });
});

describe("ancestorPids", () => {
  it("walks the parent chain up to init", () => {
    const stats = {
      30: "node (a b) S 20 1",
      20: "bash (c) S 1 1",
      1: "init (d) S 0 1",
    };
    const readFile = (path) => {
      const pid = Number(path.split("/")[2]);
      if (stats[pid] === undefined) throw new Error("missing");
      return stats[pid];
    };
    expect([...ancestorPids(30, { procRoot: "/proc", readFile })]).toEqual([30, 20]);
  });
});

describe("listDevPairProcesses", () => {
  function fakeProcRoot(processes) {
    return {
      readdir: () => Object.keys(processes),
      readFile: (path) => {
        const parts = path.split("/").filter((part) => part !== "");
        const pid = parts.at(-2);
        const file = parts.at(-1);
        const process_ = processes[pid];
        if (process_ === undefined) throw new Error(`missing ${path}`);
        if (file === "environ") return process_.environ;
        if (file === "cmdline") return process_.cmdline;
        if (file === "stat") return process_.stat ?? "node (x) S 1 1";
        throw new Error("missing");
      },
    };
  }

  it("lists dev-owned processes and skips pid 1, itself, and its own ancestors", () => {
    const procRoot = fakeProcRoot({
      1: { environ: prodEnv, cmdline: cmdline("node", "/usr/local/bin/pi-web-sessiond") },
      2: { environ: devEnv, cmdline: cmdline("node", "/workspace/pi-web/scripts/dev-web.mjs") },
      3: { stat: "node (x) S 2 1", environ: prodEnv, cmdline: cmdline("node", "/workspace/pi-web/scripts/dev-web.mjs") },
      4: { environ: devEnv, cmdline: cmdline("node", "/workspace/pi-web/scripts/dev-web.mjs") },
    });
    // pid 2 is this process's parent, so it is never signalled even though it
    // matches; pid 3 carries production env despite a dev-looking command line.
    expect(listDevPairProcesses({ ...procRoot, ...options, selfPid: 3 })).toEqual([4]);
    expect(listDevPairProcesses({ ...procRoot, ...options, selfPid: 5 })).toEqual([2, 4]);
  });

  it("skips processes it cannot read, such as another user's", () => {
    const procRoot = fakeProcRoot({
      1: { environ: prodEnv, cmdline: cmdline("node", "/usr/local/bin/pi-web-sessiond") },
    });
    const readdir = () => ["1", "2", "3"];
    const readFile = (path) => {
      if (path.endsWith("/2/environ")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      if (path.endsWith("/2/cmdline")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      if (path.endsWith("/3/environ")) return devEnv;
      if (path.endsWith("/3/cmdline")) return cmdline("node", "vite", "--port", "8599");
      throw new Error("missing");
    };
    expect(listDevPairProcesses({ readdir, readFile, ...options, selfPid: 9 })).toEqual([3]);
  });
});
