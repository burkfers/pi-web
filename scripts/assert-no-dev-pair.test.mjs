import { describe, expect, it, vi } from "vitest";
import { assertNoDevPair } from "./assert-no-dev-pair.mjs";

describe("assertNoDevPair", () => {
  it("allows the build when no isolated dev pair is running", () => {
    const listProcesses = vi.fn(() => []);
    const log = vi.fn();

    expect(assertNoDevPair({
      env: { PI_WEB_DEV_ROOT: "/tmp/custom-dev", PI_WEB_DEV_UI_PORT: "9000" },
      listProcesses,
      log,
    })).toBe(true);
    expect(listProcesses).toHaveBeenCalledWith({
      socket: "/tmp/custom-dev/sessiond.sock",
      dataDir: "/tmp/custom-dev/data",
      uiPort: 9000,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("refuses the build and gives the safe recovery command", () => {
    const log = vi.fn();

    expect(assertNoDevPair({
      env: {},
      listProcesses: vi.fn(() => [123, 456]),
      log,
    })).toBe(false);
    expect(log).toHaveBeenNthCalledWith(1, "refusing to build while the dev pair is running (pids: 123, 456).");
    expect(log).toHaveBeenNthCalledWith(2, "Run 'scripts/dev-pair.sh stop' first, then start it again after the build.");
  });
});
