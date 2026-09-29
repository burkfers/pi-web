---
"@jmfederico/pi-web": patch
---

Create a Git worktree from the workspace list and start a session in it. PI WEB shows the exact command a new worktree will run before it runs, starts it with a detached HEAD at the repository's default branch, and then selects the workspace, starts a session, and focuses the prompt. Detached worktrees are labelled with the commit they point at, and a delete confirmation names any commits that no branch points at before you confirm.

The workspace list now also follows branch switches: it re-reads when a
workspace panel notices its label no longer matches, rate-limited to one
re-read per project every ten seconds, and immediately after a creation.
