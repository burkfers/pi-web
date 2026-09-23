import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listDevPairProcesses } from "./dev-pair-processes.mjs";

export function assertNoDevPair({
  env = process.env,
  listProcesses = listDevPairProcesses,
  log = console.error,
} = {}) {
  const devRoot = env.PI_WEB_DEV_ROOT ?? "/tmp/pi-web-dev";
  const uiPort = Number(env.PI_WEB_DEV_UI_PORT ?? 8599);
  const pids = listProcesses({
    socket: join(devRoot, "sessiond.sock"),
    dataDir: join(devRoot, "data"),
    uiPort,
  });
  if (pids.length === 0) return true;

  log(`refusing to build while the dev pair is running (pids: ${pids.join(", ")}).`);
  log("Run 'scripts/dev-pair.sh stop' first, then start it again after the build.");
  return false;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = assertNoDevPair() ? 0 : 1;
}
