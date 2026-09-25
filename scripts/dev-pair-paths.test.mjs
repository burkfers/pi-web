import { describe, expect, it } from "vitest";
import { devPairPathConflicts } from "./dev-pair-paths.mjs";

const production = {
  prodDataDir: "/data/pi-web",
  prodAgentDir: "/data/pi-agent",
  inheritedSocket: "/data/pi-web/sessiond.sock",
};

describe("devPairPathConflicts", () => {
  it("accepts the default dev root and other isolated roots", () => {
    expect(devPairPathConflicts({ devRoot: "/tmp/pi-web-dev", ...production })).toEqual([]);
    expect(devPairPathConflicts({ devRoot: "/home/node/.pi-web-dev", ...production })).toEqual([]);
  });

  it("refuses a dev root that is the production data directory", () => {
    // This is what binds the dev sessiond to the production socket path.
    const conflicts = devPairPathConflicts({ devRoot: "/data/pi-web", ...production });
    expect(conflicts).toContain('dev root "/data/pi-web" is inside the production data directory "/data/pi-web"');
  });

  it("refuses a dev root nested inside the production data directory", () => {
    expect(devPairPathConflicts({ devRoot: "/data/pi-web/dev", ...production })).not.toEqual([]);
    expect(devPairPathConflicts({ devRoot: "/data/pi-web/nested/deep", ...production })).not.toEqual([]);
  });

  it("refuses a dev root that contains the production data directory", () => {
    expect(devPairPathConflicts({ devRoot: "/data", ...production }).join()).toContain("contains the production data directory");
  });

  it("refuses a dev socket that is the ambient production socket", () => {
    const conflicts = devPairPathConflicts({
      devRoot: "/data/pi-web/sessiond-holder",
      prodDataDir: "/srv/prod",
      prodAgentDir: "/srv/agent",
      inheritedSocket: "/data/pi-web/sessiond-holder/sessiond.sock",
    });
    expect(conflicts).toContain('dev sessiond socket "/data/pi-web/sessiond-holder/sessiond.sock" is the ambient (production) socket');
  });

  it("refuses a dev agent directory inside the production agent directory", () => {
    const conflicts = devPairPathConflicts({
      devRoot: "/data/pi-agent-inner",
      prodDataDir: "/srv/prod",
      prodAgentDir: "/data/pi-agent",
      inheritedSocket: "/srv/sessiond.sock",
    });
    // /data/pi-agent-inner is not inside /data/pi-agent, so this must be allowed.
    expect(conflicts).toEqual([]);
    expect(devPairPathConflicts({ devRoot: "/data/pi-agent/inner", prodDataDir: "/srv/prod", prodAgentDir: "/data/pi-agent" })).not.toEqual([]);
  });

  it("refuses the filesystem root", () => {
    expect(devPairPathConflicts({ devRoot: "/", ...production }).join()).toContain("filesystem root");
  });

  it("still works when the caller has no ambient production paths", () => {
    expect(devPairPathConflicts({ devRoot: "/tmp/pi-web-dev" })).toEqual([]);
  });
});
