import { describe, expect, it } from "vitest";
import { parseGitBranchesResponse, parseGitCommitResponse, parseGitDiffResponse, parseGitHistoryResponse, parseGitStatusResponse } from "./browser/git-contract.js";

describe("Git browser backend contract", () => {
  it("parses status, submodule pointers, and diffs from JSON-only backend results", () => {
    const status = parseGitStatusResponse({
      isGitRepo: true,
      hash: "status-hash",
      branch: "main",
      files: [
        { path: "HARL", index: "unmodified", workingTree: "modified", submoduleFromCommit: "1111111", submoduleToCommit: "2222222" },
        { path: "HARL/inner.txt", index: "modified", workingTree: "modified" },
      ],
      submodules: ["HARL"],
    });
    const diff = parseGitDiffResponse({ path: "HARL/inner.txt", staged: false, hash: "diff-hash", diff: "@@ -1 +1 @@", truncated: false });

    expect(status.submodules).toEqual(["HARL"]);
    expect(status.files[0]).toMatchObject({ submoduleFromCommit: "1111111", submoduleToCommit: "2222222" });
    expect(diff).toMatchObject({ path: "HARL/inner.txt", staged: false, hash: "diff-hash" });
  });

  it("validates structured history, commit detail, and branch responses", () => {
    const commit = { oid: "a".repeat(40), shortOid: "aaaaaaa", authorName: "Tést User", authorEmail: "test@example.com", authoredAt: "2026-01-01T00:00:00Z", subject: "subject\nnext", body: "body", parents: [], decorations: ["HEAD -> main"], status: "pushed" };
    expect(parseGitHistoryResponse({ commits: [commit], truncated: true }).commits[0]?.authorName).toBe("Tést User");
    expect(parseGitCommitResponse({ commit, files: [{ added: 1, deleted: 0, path: "file with spaces.ts" }], patch: "diff", truncated: false }).files[0]?.path).toBe("file with spaces.ts");
    expect(parseGitBranchesResponse({ branches: [{ name: "feature/name", fullName: "refs/heads/feature/name", oid: commit.oid, isRemote: false, isCurrent: true, ahead: 2, behind: 1, checkedOutInCurrentWorktree: true }], currentBranch: "feature/name", detached: false }).branches[0]?.ahead).toBe(2);
  });

  it("rejects malformed history, commit, and branch data", () => {
    expect(() => parseGitHistoryResponse({ commits: [{ oid: "a" }], truncated: false })).toThrow("Expected string field: shortOid");
    expect(() => parseGitCommitResponse({ commit: {}, files: [], patch: "", truncated: false })).toThrow("Expected string field: oid");
    expect(() => parseGitBranchesResponse({ branches: [{ name: "main" }], detached: false })).toThrow("Expected string field: fullName");
  });

  it("keeps the legacy missing-submodules response compatible while rejecting malformed provider data", () => {
    expect(parseGitStatusResponse({ isGitRepo: true, hash: "h", files: [] }).submodules).toEqual([]);
    expect(() => parseGitStatusResponse({ isGitRepo: true, hash: "h", files: [{ path: "a", index: "weird", workingTree: "modified" }] }))
      .toThrow("Invalid Git file state");
    expect(() => parseGitDiffResponse({ staged: false, hash: "h", diff: "" }))
      .toThrow("Expected boolean field: truncated");
  });
});
