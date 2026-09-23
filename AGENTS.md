# Agent Notes

This project is expected to run locally using split systemd user services:

- `pi-web-sessiond.service` runs `npm run start:sessiond` in non-autoreload, non-auto-restart mode.
- `pi-web-ui-dev.service` runs the web/API and Vite UI in dev autoreload mode with `npm run dev:web` and `npm run dev:client`.

When working on this project, assume the session runtime owner is long-lived and separate from the autoreloading UI/API process. Browser disconnects and UI/API restarts should not stop active Pi sessions.

If you make changes that affect `src/server/sessiond.ts`, session runtime ownership, the session daemon protocol, or any code path only loaded by the session daemon, inform the user that a manual restart of the session daemon is needed.

Changes to the web/API/UI side generally only require the `pi-web-ui-dev.service` autoreload/restart path.

## Documentation boundaries

`README.md` is a concise landing page and quick start. Keep it focused on what PI WEB is, basic requirements, the shortest supported install path, essential commands, the core model, and links to detailed documentation.

Put installation variants, troubleshooting, configuration details, operational behavior, architecture, edge cases, and exhaustive explanations under `docs/`. Avoid duplicating detailed documentation in the README; link to its canonical location instead.

Use `.agents/skills/documentation-guide/SKILL.md` whenever writing, modifying, reviewing, or planning user-facing documentation.

## Testing guidance

Project-specific testing rules live in `.agents/skills/testing-guide/SKILL.md`.

Use that skill whenever writing, modifying, reviewing, or planning tests, closing coverage gaps, triaging test failures, or creating test helpers/harnesses. Keep detailed testing conventions there rather than growing this top-level orientation file.

## Verification reporting

Never report failed, incomplete, or skipped verification as passing. Identify any expected check that was not run and why, and do not mask a non-zero result. If a command intentionally probes a failure path or captures an exit for inspection, state that purpose and interpret the result.

## Client application URL convention

- Build PI WEB-owned browser paths as application-relative references without a leading slash, for example `api/...` and `pi-web-plugins/...`.
- Encode every dynamic path segment with `encodeURIComponent`; encode query values, using `URLSearchParams` for multi-field queries.
- Resolve each reference exactly once at the browser boundary: ordinary JSON HTTP paths go to `request()`, direct browser APIs receive URLs from helpers backed by `resolveAppUrl()`, and WebSockets use `resolveAppWebSocketUrl()`.
- Name helpers returning unresolved application references with a `Path` suffix and helpers returning browser-ready absolute values with a `Url` suffix.
- Plugin module references must go through `resolvePluginModuleUrl()`. Its leading-slash handling is the documented rolling-compatibility exception; do not introduce other leading-root app references.
- Pre-JavaScript HTML assets use Vite `%BASE_URL%`; PWA manifest references stay `./`-relative. External links, data URLs, and module-relative plugin assets are not application paths.
- To assess deviations, search production client code for raw `fetch`, `WebSocket`, `XMLHttpRequest`, URL-bearing DOM attributes, and leading `/api` or `/pi-web-plugins` literals. Every app-owned result must follow one of the boundaries above.
- Published nested deployments require a canonical trailing slash; the reverse proxy must redirect a slashless prefix before serving the app.

## Configuration conventions

- `$PI_WEB_DATA_DIR` (`~/.pi-web` by default) contains PI WEB-managed state such as `projects.json` and `machines.json`; do not treat it as the user-editable config API.
- Global user/machine config lives at `$PI_WEB_CONFIG` or `~/.config/pi-web/config.json`.
- Project-local PI WEB core config should use one commit-able file: `<project>/.pi-web/config.json`.
- Core features should add keys to these config files, not create one project file per feature.
- Plugins may own separate project config files, such as `.pi-web/tasks.json`.

---

# pi-web — local working clone

This checkout is the build source for the Docker container (`workspaces/pi-web`
inside the image build context). Local patches are commits on top of upstream;
never push them. Upstream updates are `git fetch` + rebase with our commits on top.

## How to build

### Workflow model

- **Checkpoint (container image):** only proven, user-tested states. The image
  is built from this tree, so the tree must be clean (committed) at every
  checkpoint.
- **Iteration (dev processes):** run an *isolated* PI WEB instance pair
  (sessiond + web/API) inside this container on a dev port, from the built
  checkout. The production session daemon (PID 1) and the production web
  deployment are never touched or restarted during iteration.
- **Invariant:** image rebuilds iff the tree is clean and the committed patch
  is user-verified. Dev processes are throwaway; recreate is always safe.

### Inner loop (no image rebuild)

1. Edit here. `npm run build` (fast; `node_modules` persists in the workspace
   mount).
2. Gate on tests: `npm test` (and `npm run lint` for touched code).
3. Spawn the isolated dev instance pair (sanctioned second-instance pattern:
   distinct `PI_WEB_DATA_DIR`, `PI_WEB_SESSIOND_SOCKET`, and `PI_WEB_PORT`;
   do NOT point them at `/data/pi-web` or the production socket):

   ```sh
   D=/data/pi-web-dev
   setsid nohup env PI_WEB_DATA_DIR=$D \
     node /usr/local/lib/node_modules/@jmfederico/pi-web/dist/server/sessiond.js \
     >>/home/node/pi-web-dev-sessiond.log 2>&1 &
   sleep 4
   setsid nohup env PI_WEB_HOST=0.0.0.0 PI_WEB_PORT=8599 \
     PI_WEB_DATA_DIR=$D PI_WEB_SESSIOND_SOCKET=$D/sessiond.sock \
     node /usr/local/lib/node_modules/@jmfederico/pi-web/dist/server/index.js \
     >>/home/node/pi-web-dev-web.log 2>&1 &
   sleep 3
   curl -s http://127.0.0.1:8599/api/pi-web/health   # expect {"ok":true}
   ```

4. The user browses via their reverse proxy (container IP + port 8599; the IP
   changes on container recreate). The dev instance has empty state: add a
   project (e.g. `/workspace/pi-web`) and start sessions inside it. It reads
   the same workspaces, so sessions created there are visible elsewhere too;
   renames propagate live. `npm pack` is NOT run in the inner loop.

The actual check runs in the browser against the isolated instance.

### Checkpoint

1. Commit the patches in this tree (the tree is exactly what was tested).
2. User rebuilds the image (`docker compose build` on the host) and recreates
   the containers.
3. The new image becomes the rollback baseline for the next cycle.

### Hazards

- **The `docker/` directory in this checkout is a trap.** It looks like the image
  build (Dockerfile, compose, install.sh) but it is NOT what runs. The real
  build/setup lives on the host, invisibly. Do not read, edit, or reason from
  anything under `docker/`; image-build questions go through the user.
- PWA/service-worker caching can hide a fresh `dist/client`: suspect the
  service worker before suspecting the build (hard reload / SW update).
- Dev processes are unmanaged: `setsid nohup` children survive the spawning
  shell but die with the container, are not restarted on crash, and are
  killed by any sessiond restart of this container. Cleanup: `pkill -f
  'dist/server/(sessiond|index).js'` (matches only the dev pair; the
  production daemon runs via the `pi-web-sessiond` bin) and wipe the dev data
  dir (`rm -rf /data/pi-web-dev`) when a fresh sandbox is wanted.
- Never restart the production session daemon to deploy iteration changes:
  it owns this session, and a daemon-only restart leaves the production web
  deployment broken (its required-Terminal-plugin gate goes into
  "session daemon unavailable" until a coordinated web/API restart + browser
  reload). Deploy by the checkpoint path instead.
- The dev stack is ephemeral overlay state; it evaporates on recreate.
  Long-lived artifacts like logs (under `/home/node`) and the dev data dir
  (`/data/pi-web-dev`) live on the `/data` mount and must be cleaned up
  explicitly.
