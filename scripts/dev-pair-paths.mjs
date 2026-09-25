import { relative, resolve, sep } from "node:path";

/**
 * Path safety for `scripts/dev-pair.sh`.
 *
 * The dev pair writes a data directory, an agent clone, a log, a pid file, and
 * a sessiond socket. Given the wrong `PI_WEB_DEV_ROOT`, those paths can land on
 * the production instance: pointing the dev root at the production data
 * directory makes the dev sessiond bind (and unlink) the production socket, and
 * a dev root *inside* the production data directory writes into it the same way.
 * So every start refuses before touching anything when the resolved dev paths
 * could reach production.
 */

function isInside(child, parent) {
  if (child === parent) return true;
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !path.startsWith(`${sep}..`) && !path.startsWith("/");
}

/**
 * Human-readable conflicts; empty means the dev paths are safe to use.
 * `inheritedSocket` is the caller's ambient sessiond socket, i.e. production's.
 */
export function devPairPathConflicts({ devRoot, prodDataDir, prodAgentDir, inheritedSocket }) {
  const conflicts = [];
  const root = resolve(devRoot ?? "");
  if (root === sep) conflicts.push(`dev root "${devRoot}" is the filesystem root`);

  const productionData = prodDataDir === undefined ? undefined : resolve(prodDataDir);
  const productionAgent = prodAgentDir === undefined ? undefined : resolve(prodAgentDir);
  const devData = resolve(root, "data");
  const devAgent = resolve(root, "agent");
  const devSocket = resolve(root, "sessiond.sock");
  const devLog = resolve(root, "dev.log");

  if (productionData !== undefined) {
    // The dev root holds the log and pid file, the data dir holds the cloned
    // agent and project state, so the dev root may not be the production data
    // directory, inside it, or an ancestor of it.
    if (isInside(root, productionData)) {
      conflicts.push(`dev root "${root}" is inside the production data directory "${productionData}"`);
    }
    if (isInside(productionData, root)) {
      conflicts.push(`dev root "${root}" contains the production data directory "${productionData}"`);
    }
  }
  if (productionAgent !== undefined && isInside(devAgent, productionAgent)) {
    conflicts.push(`dev agent directory "${devAgent}" is inside the production agent directory "${productionAgent}"`);
  }
  if (inheritedSocket !== undefined && resolve(inheritedSocket) === devSocket) {
    conflicts.push(`dev sessiond socket "${devSocket}" is the ambient (production) socket`);
  }

  return conflicts;
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
  const conflicts = devPairPathConflicts({
    devRoot: options.dev_root,
    prodDataDir: options.prod_data_dir,
    prodAgentDir: options.prod_agent_dir,
    inheritedSocket: options.inherited_socket,
  });
  process.stdout.write(`${conflicts.map((conflict) => `${conflict}\n`).join("")}`);
  process.exitCode = conflicts.length === 0 ? 0 : 1;
}
