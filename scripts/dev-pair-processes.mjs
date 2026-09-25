import { readFileSync, readdirSync } from "node:fs";

/**
 * Identity rules for processes owned by the dev pair (`scripts/dev-pair.sh`).
 *
 * The dev pair runs alongside production, and production must never be touched.
 * A process is therefore only ever considered a dev-pair process when it
 * carries BOTH dev-only environment markers *and* runs one of the dev pair's
 * own entrypoints. Either signal alone is deliberately insufficient: the
 * production UI service also runs `dev-web`/`dev:client`, and the production
 * session daemon runs a different binary, so command lines overlap in one
 * direction and environments overlap in the other.
 */

const SOCKET_ENV = "PI_WEB_SESSIOND_SOCKET";
const DATA_DIR_ENV = "PI_WEB_DATA_DIR";

/**
 * Substrings that identify a dev-pair entrypoint. Watchers and their runtime
 * children are both listed: a leaked runtime is exactly the process that keeps
 * holding the sessiond socket after its watcher is gone.
 */
const ENTRYPOINT_PATTERNS = [
  "scripts/dev-sessiond.mjs",
  "scripts/dev-web.mjs",
  "scripts/build-plugins.mjs",
  "tsx/dist/cli.mjs watch src/server/sessiond.ts",
  "tsx/dist/cli.mjs watch src/server/index.ts",
  "src/server/sessiond.ts",
  "src/server/index.ts",
];

/** Vite only counts when it is bound to the dev UI port; production serves its own. */
function matchesEntrypoint(cmdline, uiPort) {
  if (ENTRYPOINT_PATTERNS.some((pattern) => cmdline.includes(pattern))) return true;
  return cmdline.includes("vite") && cmdline.includes(`--port ${uiPort}`);
}

function parseNullSeparated(value) {
  return new Map(
    value
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => {
        const separator = entry.indexOf("=");
        return separator === -1 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
}

function parseStatPidOnly(stat) {
  // After the executable name (which may contain spaces or parens) comes ppid.
  const afterName = stat.slice(stat.lastIndexOf(")") + 2);
  const parentPid = Number.parseInt(afterName.split(" ")[1] ?? "", 10);
  return Number.isInteger(parentPid) ? parentPid : undefined;
}

/** Every ancestor pid of `pid`, so a sweep can never signal its own process tree. */
export function ancestorPids(pid, { procRoot = "/proc", readFile = readFileSync } = {}) {
  const ancestors = new Set();
  let current = pid;
  while (current !== undefined && current > 1 && !ancestors.has(current)) {
    ancestors.add(current);
    let stat;
    try {
      stat = readFile(`${procRoot}/${current}/stat`, "utf8");
    } catch {
      break;
    }
    current = parseStatPidOnly(stat);
  }
  return ancestors;
}

/** Whether one process is a dev-pair process, given its raw environ and cmdline. */
export function isDevPairProcess(environ, cmdline, { socket, dataDir, uiPort }) {
  if (typeof environ !== "string" || typeof cmdline !== "string") return false;
  const env = parseNullSeparated(environ);
  if (env.get(SOCKET_ENV) !== socket) return false;
  if (env.get(DATA_DIR_ENV) !== dataDir) return false;
  return matchesEntrypoint(cmdline.replaceAll("\0", " "), uiPort);
}

export function listDevPairProcesses({
  procRoot = "/proc",
  socket,
  dataDir,
  uiPort,
  selfPid = process.pid,
  readFile = readFileSync,
  readdir = readdirSync,
} = {}) {
  const excluded = new Set([...ancestorPids(selfPid, { procRoot, readFile }), 1, selfPid]);
  const found = [];
  let entries;
  try {
    entries = readdir(procRoot);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (excluded.has(pid)) continue;
    let environ;
    let cmdline;
    try {
      environ = readFile(`${procRoot}/${entry}/environ`, "utf8");
      cmdline = readFile(`${procRoot}/${entry}/cmdline`, "utf8");
    } catch {
      // Another user's process, or it exited between listing and reading.
      continue;
    }
    if (isDevPairProcess(environ, cmdline, { socket, dataDir, uiPort })) found.push(pid);
  }
  return found;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (key === undefined) continue;
    options[key.replace(/^--/, "").replaceAll("-", "_")] = argv[index + 1];
  }
  return options;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  const pids = listDevPairProcesses({
    socket: options.socket,
    dataDir: options.data_dir,
    uiPort: Number(options.ui_port),
  });
  process.stdout.write(pids.map((pid) => `${String(pid)}\n`).join(""));
}
