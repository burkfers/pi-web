import { describe, expect, it } from "vitest";
import type { Project } from "./api";
import { mergeProjectActivity, orderProjectsByRecentActivity, recordProjectActivity } from "./projectActivity";

function project(id: string): Project {
  return { id, name: id, path: `/repo/${id}`, createdAt: "2024-01-01T00:00:00.000Z" };
}

describe("mergeProjectActivity", () => {
  it("seeds existing stamps from the server snapshot", () => {
    expect(mergeProjectActivity({}, { projects: { p1: { lastActivityAt: "2024-05-01T00:00:00.000Z" } } })).toEqual({
      p1: "2024-05-01T00:00:00.000Z",
    });
  });

  it("keeps a fresher browser-local stamp over an older server value", () => {
    const existing = { p1: "2024-06-01T00:00:00.000Z" };
    expect(mergeProjectActivity(existing, { projects: { p1: { lastActivityAt: "2024-05-01T00:00:00.000Z" } } })).toEqual(existing);
  });

  it("takes the fresher server value over an older browser stamp", () => {
    expect(
      mergeProjectActivity({ p1: "2024-03-01T00:00:00.000Z" }, { projects: { p1: { lastActivityAt: "2024-05-01T00:00:00.000Z" } } }),
    ).toEqual({ p1: "2024-05-01T00:00:00.000Z" });
  });

  it("returns a copy even without a snapshot", () => {
    const existing = { p1: "2024-05-01T00:00:00.000Z" };
    const merged = mergeProjectActivity(existing, undefined);
    expect(merged).toEqual(existing);
    expect(merged).not.toBe(existing);
  });
});

describe("recordProjectActivity", () => {
  it("stamps a project", () => {
    expect(recordProjectActivity({}, "p1", "2024-05-01T00:00:00.000Z")).toEqual({ p1: "2024-05-01T00:00:00.000Z" });
  });

  it("keeps a newer stamp over the incoming value and ignores unknown projects", () => {
    const existing = { p1: "2024-06-01T00:00:00.000Z" };
    expect(recordProjectActivity(existing, "p1", "2024-05-01T00:00:00.000Z")).toBe(existing);
    expect(recordProjectActivity(existing, undefined, "2024-07-01T00:00:00.000Z")).toBe(existing);
  });
});

describe("orderProjectsByRecentActivity", () => {
  const input = [project("a"), project("b"), project("c"), project("d")];

  it("keeps insertion order when nothing is known yet", () => {
    expect(orderProjectsByRecentActivity(input, {})).toEqual(input);
  });

  it("moves projects with known recency to the newest-first front and keeps unknown ones after in their relative order", () => {
    const ordered = orderProjectsByRecentActivity(input, { a: "2024-01-01T00:00:00.000Z", d: "2024-02-01T00:00:00.000Z" });
    expect(ordered.map((project) => project.id)).toEqual(["d", "a", "b", "c"]);
  });

  it("breaks ties by input order", () => {
    const at = "2024-02-01T00:00:00.000Z";
    expect(orderProjectsByRecentActivity(input, { b: at, c: at }).map((p) => p.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("lets the selected project hold its slot while others order around it", () => {
    // "d" last: selecting it keeps it last even though unstamped projects stay put too.
    const ordered = orderProjectsByRecentActivity(input, { a: "2024-02-01T00:00:00.000Z" }, "d");
    expect(ordered.map((project) => project.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the selected project's slot even when its own recency would move it", () => {
    const ordered = orderProjectsByRecentActivity(
      input,
      { a: "2024-01-01T00:00:00.000Z", b: "2024-02-01T00:00:00.000Z", c: "2024-03-01T00:00:00.000Z" },
      "c",
    );
    // b and a reorder by recency around c's held slot.
    expect(ordered.map((project) => project.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("uses the currently displayed slot when selection changes", () => {
    const currentOrder = [input[3], input[0], input[1], input[2]].filter((project): project is Project => project !== undefined);
    const ordered = orderProjectsByRecentActivity(input, { d: "2024-02-01T00:00:00.000Z" }, "b", currentOrder);
    expect(ordered.map((project) => project.id)).toEqual(["d", "a", "b", "c"]);
  });
});
