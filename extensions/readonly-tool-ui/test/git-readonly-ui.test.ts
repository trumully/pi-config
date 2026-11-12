import { describe, it } from "node:test";
import assert from "node:assert/strict";
import gitReadonly from "../../git-readonly/index.ts";
import { loadTool, recordingTheme, render, text } from "./harness.ts";

const tool = loadTool(gitReadonly);
const details = (overrides: Record<string, unknown> = {}) => ({
  operation: "diff", repo: "/work/repo", commits: [], status: "success", exitCode: 0, truncated: false, durationMs: 800, ...overrides,
});
const stat = " src/a.ts | 4 ++--\n src/b.ts | 2 +-\n 2 files changed, 3 insertions(+), 3 deletions(-)";

describe("git_readonly collapsed result", () => {
  it("summarizes the operation, its refs and format, and the first path", () => {
    const theme = recordingTheme();
    const lines = render(tool, {
      args: { operation: "diff", base: "main", target: "HEAD", format: "stat", paths: ["src/a.ts", "src/b.ts", "src/c.ts"] },
      result: { content: text(stat), details: details() },
      durationMs: 800,
    }, 100, theme);
    assert.deepEqual(lines, ["git_readonly ✓ diff main..HEAD stat -- src/a.ts +2 more · 3 lines · 0.8s"]);
    assert.ok(theme.calls.some((call) => call.method === "bold" && call.text === "git_readonly"), "title not bold");
    assert.ok(theme.calls.some((call) => call.color === "toolTitle"), "title not styled through the theme");
  });

  it("describes each operation in its own terms", () => {
    const row = (args: Record<string, unknown>) =>
      render(tool, { args, result: { content: text("x"), details: details() }, durationMs: 800 })[0];
    assert.equal(row({ operation: "status" }), "git_readonly ✓ status · 1 line · 0.8s");
    assert.equal(row({ operation: "status", repo: "../other" }), "git_readonly ✓ status in ../other · 1 line · 0.8s");
    assert.equal(row({ operation: "diff", staged: true }), "git_readonly ✓ diff --staged · 1 line · 0.8s");
    assert.equal(row({ operation: "show", ref: "v1.2.0", format: "names" }), "git_readonly ✓ show v1.2.0 names · 1 line · 0.8s");
    assert.equal(row({ operation: "log", ref: "main", limit: 20, offset: 40 }), "git_readonly ✓ log main limit 20 offset 40 · 1 line · 0.8s");
  });

  it("shows only the operation while arguments stream", () => {
    assert.deepEqual(render(tool, { args: {}, argsComplete: false }), ["git_readonly"]);
    assert.deepEqual(render(tool, { args: { operation: "log" }, argsComplete: false }), ["git_readonly log"]);
  });
});

describe("git_readonly expanded result", () => {
  it("lists every argument and every returned line", () => {
    const lines = render(tool, {
      args: { operation: "diff", base: "main", target: "HEAD", format: "stat", paths: ["src/a.ts", "src/b.ts", "docs/read me.md"], repo: "../other" },
      result: { content: text(stat), details: details() },
      durationMs: 800,
      expanded: true,
    }, 120);
    assert.deepEqual(lines, [
      "git_readonly diff main..HEAD stat in ../other -- src/a.ts src/b.ts 'docs/read me.md'",
      "✓ 3 lines · 0.8s",
      " src/a.ts | 4 ++--",
      " src/b.ts | 2 +-",
      " 2 files changed, 3 insertions(+), 3 deletions(-)",
    ]);
  });
});

describe("git_readonly failures", () => {
  const failed = {
    content: text("Git failed (128).\nfatal: ambiguous argument 'nope': unknown revision\n"),
    details: details({ operation: "show", status: "command_failed", exitCode: 128, durationMs: 50 }),
  };

  it("collapses to the exit header and Git's message", () => {
    const lines = render(tool, { args: { operation: "show", ref: "nope" }, result: failed, isError: true, durationMs: 50 }, 120);
    assert.deepEqual(lines, ["git_readonly ✗ show nope — Git failed (128). fatal: ambiguous argument 'nope': unknown revision · 0.1s"]);
  });

  it("expands to the status, exit code, and full error output", () => {
    const lines = render(tool, { args: { operation: "show", ref: "nope" }, result: failed, isError: true, durationMs: 50, expanded: true }, 120);
    assert.deepEqual(lines, [
      "git_readonly show nope",
      "✗ failed · exit 128 · 0.1s",
      "Git failed (128).",
      "fatal: ambiguous argument 'nope': unknown revision",
    ]);
  });

  it("shows a timeout as timed out", () => {
    const result = { content: text("Git timed out after 30 seconds."), details: details({ operation: "log", status: "timeout", exitCode: null, durationMs: 30000 }) };
    const expanded = render(tool, { args: { operation: "log" }, result, isError: true, durationMs: 30000, expanded: true });
    assert.equal(expanded[1], "✗ timed out · 30.0s");
  });

  it("shows the validation message when execute rejects the input", async () => {
    const args = { operation: "status", ref: "HEAD" };
    const error: Error = await tool.execute("call-1", args, undefined, undefined, { cwd: process.cwd() })
      .then(() => assert.fail("execute accepted ref for status"), (e: Error) => e);
    const [line] = render(tool, { args, result: { content: text(error.message), details: {} }, isError: true }, 120);
    assert.equal(line, `git_readonly ✗ status — ${error.message}`);
  });
});

describe("git_readonly truncation", () => {
  it("flags truncated output and keeps the notice out of the line count", () => {
    const notice = "[Output truncated by git_readonly. Narrow paths or use format: stat/names; paginate log with limit/offset.]";
    const body = Array.from({ length: 500 }, (_, i) => `+line ${i}`).join("\n");
    const lines = render(tool, {
      args: { operation: "diff" },
      result: { content: text(`${body}\n${notice}`), details: details({ truncated: true, durationMs: 1500 }) },
      durationMs: 1500,
    });
    assert.deepEqual(lines, ["git_readonly ✓ diff · 500 lines · truncated · 1.5s"]);
  });
});

describe("git_readonly line counts", () => {
  // Git ends its output with a newline; that terminator does not start another line.
  const log = [
    "commit 4f2a9c1e0b7d3a5f6e8c9d0a1b2c3d4e5f6a7b8c",
    "Author: Dev <dev@example.com>",
    "Date:   Mon Nov 9 10:00:00 2026 +0000",
    "",
    "    Fix parser edge case",
    "",
    "    Handles empty input.",
    "",
    "commit 9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
    "Author: Dev <dev@example.com>",
    "Date:   Sun Nov 8 09:00:00 2026 +0000",
    "",
    "    Add tests",
  ];
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,5 +1,5 @@",
    " function a() {",
    "   return 1;",
    " ",
    "-}",
    "+};",
    "  ",
  ];
  const row = (args: Record<string, unknown>, output: string, extra: Record<string, unknown> = {}) =>
    render(tool, { args, result: { content: text(output), details: details(extra) }, durationMs: 800 });

  it("counts blank lines between log entries", () => {
    assert.deepEqual(row({ operation: "log" }, `${log.join("\n")}\n`), [`git_readonly ✓ log · ${log.length} lines · 0.8s`]);
  });

  it("counts whitespace-only context lines in a patch", () => {
    assert.deepEqual(row({ operation: "diff" }, `${patch.join("\n")}\n`), [`git_readonly ✓ diff · ${patch.length} lines · 0.8s`]);
  });

  it("counts output without a final newline the same way", () => {
    assert.deepEqual(row({ operation: "log" }, log.join("\n")), [`git_readonly ✓ log · ${log.length} lines · 0.8s`]);
  });

  it("counts blank lines in truncated output and leaves out only the notice", () => {
    const notice = "[Output truncated by git_readonly. Narrow paths or use format: stat/names; paginate log with limit/offset.]";
    const body = Array.from({ length: 500 }, (_, i) => patch[i % patch.length]).join("\n");
    assert.deepEqual(row({ operation: "diff" }, `${body}\n${notice}`, { truncated: true }), ["git_readonly ✓ diff · 500 lines · truncated · 0.8s"]);
  });

  it("expands to exactly the counted lines", () => {
    const lines = render(tool, { args: { operation: "log" }, result: { content: text(`${log.join("\n")}\n`), details: details() }, durationMs: 800, expanded: true });
    assert.equal(lines[1], `✓ ${log.length} lines · 0.8s`);
    assert.deepEqual(lines.slice(2), log.map((line) => line.trimEnd()));
  });

  it("still reports empty output as no output", () => {
    assert.deepEqual(row({ operation: "status" }, "(no output)"), ["git_readonly ✓ status · no output · 0.8s"]);
  });
});

describe("git_readonly cancellation", () => {
  const abort = (message: string, extra: Record<string, unknown> = {}) =>
    ({ args: { operation: "log" }, result: { content: text(message), details: extra }, isError: true });

  for (const message of ["Operation aborted", "Aborted after 1 retry attempt", "Aborted after 3 retry attempts"]) {
    it(`treats Pi's "${message}" without details as cancelled`, () => {
      const theme = recordingTheme();
      assert.deepEqual(render(tool, abort(message), 100, theme), [`git_readonly ⊘ log — ${message}`]);
      assert.deepEqual(render(tool, { ...abort(message), expanded: true }, 100, theme).slice(1), ["⊘ cancelled", message]);
      assert.ok(!theme.calls.some((call) => call.color === "error"), "cancellation styled as an error");
    });
  }

  it("keeps an explicit failure status over an abort-like message", () => {
    const lines = render(tool, { ...abort("Aborted after 3 retry attempts", details({ status: "command_failed", exitCode: 1, durationMs: undefined })), expanded: true });
    assert.equal(lines[1], "✗ failed · exit 1");
  });

  it("keeps ordinary errors without details as errors", () => {
    const theme = recordingTheme();
    assert.deepEqual(render(tool, abort("Request failed: socket hang up"), 100, theme), ["git_readonly ✗ log — Request failed: socket hang up"]);
    assert.ok(theme.calls.some((call) => call.color === "error"));
  });
});
