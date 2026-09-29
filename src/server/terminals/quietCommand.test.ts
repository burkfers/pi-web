import { describe, expect, it } from "vitest";
import { quietCommandFailureDetail, runQuietCommand } from "./quietCommand.js";

const CWD = process.cwd();

describe("runQuietCommand", () => {
  it("returns what a successful command printed", async () => {
    const result = await runQuietCommand({ command: "printf 'made it'", cwd: CWD });

    expect(result).toEqual({ exitCode: 0, stdout: "made it", stderr: "", timedOut: false });
  });

  it("reports a failed command instead of throwing, with its output", async () => {
    const result = await runQuietCommand({ command: "printf 'no such branch' >&2; exit 128", cwd: CWD });

    expect(result.exitCode).toBe(128);
    expect(result.stderr).toBe("no such branch");
    expect(result.timedOut).toBe(false);
  });

  it("runs the command in the directory it was given", async () => {
    const result = await runQuietCommand({ command: "pwd", cwd: "/tmp" });

    expect(result.stdout.trim()).toBe("/tmp");
  });

  it("keeps a path with spaces intact through the shell", async () => {
    // The plans are shell command lines with quoted paths; losing the quoting
    // here would remove a worktree in a path the user actually has.
    const result = await runQuietCommand({ command: "printf '%s' \"$(pwd)\"; printf ' ok'", cwd: "/tmp" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("/tmp ok");
  });

  it("does not let a Git environment variable point the command elsewhere", async () => {
    const result = await runQuietCommand({ command: "printf '%s' \"${GIT_DIR:-unset}\"", cwd: CWD, env: { ...process.env, GIT_DIR: "/somewhere/else" } });

    expect(result.stdout).toBe("unset");
  });

  it("reports a command that outlives its deadline as a timeout", async () => {
    const result = await runQuietCommand({ command: "sleep 5", cwd: CWD, timeoutMs: 60 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("rejects with the caller's reason when cancelled", async () => {
    const controller = new AbortController();
    const pending = runQuietCommand({ command: "sleep 5", cwd: CWD, signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow();
  });
});

describe("quietCommandFailureDetail", () => {
  it("prefers stderr, then stdout", () => {
    expect(quietCommandFailureDetail({ exitCode: 1, stdout: "out", stderr: "err", timedOut: false })).toBe("err");
    expect(quietCommandFailureDetail({ exitCode: 1, stdout: "out", stderr: "  ", timedOut: false })).toBe("out");
    expect(quietCommandFailureDetail({ exitCode: 1, stdout: "", stderr: "", timedOut: false })).toBeUndefined();
  });

  it("says a timeout plainly rather than quoting a truncated command", () => {
    expect(quietCommandFailureDetail({ exitCode: 1, stdout: "partial", stderr: "", timedOut: true })).toBe("the command did not finish in time");
  });

  it("keeps only the tail of a long failure", () => {
    const detail = quietCommandFailureDetail({ exitCode: 1, stdout: "", stderr: "x".repeat(2000), timedOut: false }, 100);

    expect(detail?.length).toBe(101);
    expect(detail?.startsWith("…")).toBe(true);
  });
});
