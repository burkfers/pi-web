# Agent Notes

## Run model

The repo build is not what the running instance serves: production runs from the container image, so a container rebuild is how committed source changes reach it. To exercise working-tree changes, use the isolated dev pair — it runs the session daemon, web/API, and Vite UI from this checkout, with its own data/agent directories and sessiond socket, seeded once from the production state:

- `npm run dev:pair` (or `scripts/dev-pair.sh start` / `scripts/dev-pair.sh stop`), UI on `:8599`, API on `:8598`, log at `/tmp/pi-web-dev/dev.log`. The user reaches the dev UI through the reverse proxy at http://dev.ai.btz.

Because the dev pair starts its own session daemon from source, changes to `src/server/sessiond.ts`, session runtime ownership, the session daemon protocol, or any daemon-only code path are picked up there with no production restart. Do not restart or stop the production session daemon to test a change; ask the user to rebuild the container when they want the change live.

The production instance itself runs as split systemd user services:

- `pi-web-sessiond.service` runs `npm run start:sessiond` in non-autoreload, non-auto-restart mode.
- `pi-web-ui-dev.service` runs the web/API and Vite UI in dev autoreload mode with `npm run dev:web` and `npm run dev:client`.

When working on this project, assume the session runtime owner is long-lived and separate from the autoreloading UI/API process. Browser disconnects and UI/API restarts should not stop active Pi sessions.

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

1. Edit here. Before any `npm run build`, stop the isolated dev pair with
   `scripts/dev-pair.sh stop`; the build guard refuses to remove `dist` while
   that pair is live. The build itself is fast (`node_modules` persists in the
   workspace mount).
2. Gate on tests: `npm test` (and `npm run lint` for touched code).
3. Spawn the isolated dev instance pair (sanctioned second-instance pattern:
   distinct `PI_WEB_DATA_DIR`, `PI_WEB_SESSIOND_SOCKET`, and web/API port;
   do NOT point them at `/data/pi-web` or the production socket):

   ```sh
   scripts/dev-pair.sh start   # UI http://dev.ai.btz/ (reverse proxy; local listener :8599), API :8598
   scripts/dev-pair.sh stop    # stops the pair and reaps anything it orphaned
   ```

   The script runs the working tree directly (tsx watch + Vite dev server, no
   build needed) and hard-isolates every shared resource: data dir, daemon
   socket, agent dir (cloned from production on first start so dev sessions
   can run models), API port 8598, UI port 8599. It deliberately unsets the
   inherited `PI_WEB_SESSIOND_SOCKET`/`PI_WEB_SESSIOND_PORT` before
   overriding — in this container the ambient `PI_WEB_*`/`PI_CODING_AGENT_DIR`
   values point at production, and a dev daemon resolving them would clobber
   the production socket. Never launch the pair with an inherited environment.
   Overrides: `PI_WEB_DEV_ROOT`, `PI_WEB_DEV_UI_PORT`, `PI_WEB_DEV_API_PORT`,
   `PI_WEB_DEV_PLUGIN_SOURCE`.
   Logs: `$PI_WEB_DEV_ROOT/dev.log` (default `/tmp/pi-web-dev/dev.log`).
   `start` re-links user plugins into `$PI_WEB_DEV_ROOT/data/plugins` on every
   run, preferring the `../pi-web-plugins` checkout and falling back to the
   running instance's plugins directory, so plugin edits are live on refresh and
   a removed plugin disappears. Only entries the plugin catalog would accept are
   linked (a directory, or a symlink to one, whose `package.json` declares
   `piWeb`), and they are linked rather than copied so nothing goes stale.
   `start` also refuses any dev root at, inside, or containing the production
   data directory, and any dev socket equal to the ambient production socket:
   those resolved paths would make the dev sessiond bind and unlink the
   production socket. `stop` collects processes left behind by a hard kill,
   crash, or container restart: each dev child leads its own process group, so
   teardown cannot rely on the inner supervisors running their cleanup.
   Selection stays conservative — a process must carry both dev-only env
   markers *and* a dev entrypoint, and pid 1, the script, and its ancestors are
   never signalled — so production is never killed even though it runs some of
   the same entrypoints. `start` refuses to run while any dev-pair process
   survives, because a second instance competing for the sessiond socket is what
   breaks the dev UI.
4. The user browses the Vite dev server on port 8599 (container IP + port;
   the IP changes on container recreate). The pair seeds its state from
   production on first start, so the usual projects appear; sessions run in
   the cloned agent dir, never in production's. The Vite dev server reads the
   working tree, so iteration changes are live without a build. `npm pack` is
   NOT run in the inner loop.

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
- **Builds and the dev pair are mutually exclusive.** `npm run build` checks for
  the isolated pair and refuses to run while it is live, because the build
  removes `dist/` and the dev sessiond watches generated plugin files there.
  Stop the pair before building, then start it again after verification.
- Dev processes are unmanaged: the pair survives the spawning shell but dies
  with the container, is not restarted on crash, and is killed by any
  sessiond restart of this container. Cleanup: `scripts/dev-pair.sh stop`
  (kills only its own process group; the production daemon runs via the
  `pi-web-sessiond` bin and is never matched). Default dev state lives in
  `/tmp/pi-web-dev` — ephemeral overlay state that evaporates on recreate,
  so nothing lingers; point `PI_WEB_DEV_ROOT` at a persistent location only
  if you want dev state to survive rebuilds, and clean it up explicitly.
- Never restart the production session daemon to deploy iteration changes:
  it owns this session, and a daemon-only restart leaves the production web
  deployment broken (its required-Terminal-plugin gate goes into
  "session daemon unavailable" until a coordinated web/API restart + browser
  reload). Deploy by the checkpoint path instead.
- The dev stack is ephemeral overlay state; it evaporates on recreate.
  With the default `PI_WEB_DEV_ROOT=/tmp/pi-web-dev` nothing needs cleanup.
  Logs kept elsewhere (e.g. under `/home/node`) are persistent and must be
  cleaned up explicitly.
