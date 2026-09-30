---
"@jmfederico/pi-web": major
---

**Breaking:** a new session now gets a Git worktree of its own.

`New session` creates a detached worktree and starts the session in it, so two
sessions on one project no longer share a working tree. The worktree is created
before the session — a session's working directory is fixed for its lifetime, so
it has to point at something that already exists — and its directory name is
generated rather than asked for. Nothing about the click changes: PI WEB creates
the worktree, selects it, and focuses the prompt.

The opt-out is explicit, per session, from the checkout's ⋯ menu
(`New session in this checkout`) or per project with `worktrees.newSession:
"never"`. Those sessions are marked `shared` on their row. Two settings are new:

- `worktrees.root` — where worktrees are created. Defaults to `worktrees/`
  beside the checkout; each project gets a subdirectory of its own.
- `worktrees.newSession` — `always` (default) or `never`.

**Breaking:** archiving a session detaches its worktree from its branch.

A parked worktree kept its branch checked out, so the next session that wanted
the branch was told it was in use by a session nobody was looking at. Archiving
now releases the checkout without moving the branch or touching the working
tree, and records the branch and commit in the session so a resumed session is
told what happened — otherwise its next commit would land on a detached HEAD
only this worktree can reach. A detach that fails is reported and the archive
still happens. Checkouts you created yourself are never detached.

Sessions show their worktree state on their own row — the branch, the commit
they are detached at, or `shared` when they have no worktree of their own. A
parked session's worktree can be removed from its archived row without losing
the transcript. Deleting a session still deletes the worktree it owns, and only
that one. The sidebar now lists sessions above checkouts.

Creating or removing a worktree no longer opens a terminal run. The request now
waits for the command and answers with the outcome: the worktree exists, or it
does not and the error carries what the command said. The `New worktree` dialog
still shows the exact command before you confirm it.

Also: dependencies are managed with pnpm. `npm ci` no longer works — use
`pnpm install --frozen-lockfile` — and `package-lock.json` is replaced by
`pnpm-lock.yaml`.
