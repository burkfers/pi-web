import { execFile } from "node:child_process";

/**
 * A command PI WEB runs on the user's behalf, with no terminal attached.
 *
 * Creating or removing a worktree is something the user asked for by clicking
 * the thing that means it; a second artifact on screen to watch it happen is
 * noise, not information. So the command runs here, its output is captured
 * rather than displayed, and what the caller reports back is whether it worked.
 */
export interface QuietCommandOptions {
  /** Shell command line, exactly as the provider planned it. */
  readonly command: string;
  /** Directory the command runs in; never the directory it operates on. */
  readonly cwd: string;
  readonly signal?: AbortSignal;
  /** Wall-clock bound; a command that outlives it is reported as failed. */
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface QuietCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the command was cut short by the timeout rather than finishing. */
  readonly timedOut: boolean;
}

export const QUIET_COMMAND_DEFAULT_TIMEOUT_MS = 120_000;
/** Enough of a failure to act on without pasting a build log into a toast. */
export const QUIET_COMMAND_OUTPUT_LIMIT_BYTES = 8 * 1024;

/**
 * Variables that would point a command at a repository other than the one it
 * runs in. The Git provider scrubs these for the same reason: a command running
 * in a worktree must not inherit the parent checkout's `GIT_DIR`.
 */
const GIT_LOCAL_ENV_VARS = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
]);

/**
 * Run a command and wait for it, returning its outcome instead of a terminal
 * to watch. A non-zero exit is a result, not an exception: the callers own the
 * wording of their own failures and need the captured stderr to write them.
 */
export function runQuietCommand(options: QuietCommandOptions): Promise<QuietCommandResult> {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  for (const name of GIT_LOCAL_ENV_VARS) {
    Reflect.deleteProperty(env, name);
  }

  return new Promise((resolve, reject) => {
    execFile(
      "/bin/sh",
      ["-lc", options.command],
      {
        cwd: options.cwd,
        env,
        timeout: options.timeoutMs ?? QUIET_COMMAND_DEFAULT_TIMEOUT_MS,
        maxBuffer: QUIET_COMMAND_OUTPUT_LIMIT_BYTES,
        encoding: "utf8",
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        // execFile kills the child on abort; the callback still runs, and the
        // caller's reason is a better rejection than execFile's own.
        if (options.signal?.aborted === true) {
          reject(abortError(options.signal));
          return;
        }
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr, timedOut: false });
          return;
        }
        resolve({
          // A killed process reports the signal it took rather than an exit
          // code; either way it did not do what it was asked to do.
          exitCode: isExitCode(error.code) ? error.code : 1,
          stdout,
          stderr,
          timedOut: error.killed === true,
        });
      },
    );
  });
}

/**
 * The last few lines of a failed command, for an error message. Output is
 * trimmed and bounded: the user needs the reason, not the scrollback.
 */
export function quietCommandFailureDetail(result: QuietCommandResult, limit = 600): string | undefined {
  if (result.timedOut) return "the command did not finish in time";
  const detail = result.stderr.trim() || result.stdout.trim();
  if (detail === "") return undefined;
  return detail.length <= limit ? detail : `…${detail.slice(-limit)}`;
}

function isExitCode(value: string | number | null | undefined): value is number {
  return typeof value === "number";
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("Command cancelled", reason === undefined ? undefined : { cause: reason });
}
