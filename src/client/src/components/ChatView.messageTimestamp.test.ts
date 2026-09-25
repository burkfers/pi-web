import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The formatter follows the runtime zone and captures it when the module is
// imported, so this file pins TZ first and imports afterwards. Otherwise the
// expected clock text moves with whatever zone the machine or container uses
// (UTC and Europe/Berlin disagree by two hours).
const originalTz = process.env["TZ"];
let formatMessageTimestamp: (timestamp: string) => string | undefined;

beforeAll(async () => {
  process.env["TZ"] = "UTC";
  ({ formatMessageTimestamp } = await import("./ChatView"));
});

afterAll(() => {
  if (originalTz === undefined) delete process.env["TZ"];
  else process.env["TZ"] = originalTz;
});

describe("formatMessageTimestamp", () => {
  it("renders the clock time in 24-hour form", () => {
    const formatted = formatMessageTimestamp("2026-09-24T18:32:39.315Z");
    expect(formatted).toContain("18:32:39");
    expect(formatted).not.toMatch(/\b(AM|PM)\b/);
  });

  it("keeps late-evening times on the same clock instead of wrapping to a 12-hour clock", () => {
    // 23:05 must not render as 11:05 PM's 12-hour counterpart, and midnight
    // must not render as hour 24.
    expect(formatMessageTimestamp("2026-09-24T23:05:00.000Z")).toContain("23:05:00");
    // An h24 clock renders midnight as hour 24; h23 must not.
    expect(formatMessageTimestamp("2026-09-25T00:05:00.000Z")).toContain("05:00");
    expect(formatMessageTimestamp("2026-09-25T00:05:00.000Z")).not.toContain("24:05:00");
  });

  it("reports unparsable timestamps as absent", () => {
    expect(formatMessageTimestamp("not-a-date")).toBeUndefined();
  });
});
