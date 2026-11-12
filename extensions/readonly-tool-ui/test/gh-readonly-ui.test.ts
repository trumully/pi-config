import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ghReadonly from "../../gh-readonly/index.ts";
import { loadTool, recordingTheme, render, text, toolRow } from "./harness.ts";

const tool = loadTool(ghReadonly);
const prView = ["pr", "view", "123", "--repo", "octo/repo", "--json", "title,state"];
const details = (overrides: Record<string, unknown> = {}) => ({
  command: ["gh", ...prView], status: "success", exitCode: 0, truncated: false, durationMs: 1200, ...overrides,
});

describe("gh_readonly collapsed result", () => {
  it("shows one row with command, success mark, line count, and duration", () => {
    const lines = render(tool, {
      args: { args: prView },
      result: { content: text('{\n  "title": "Fix",\n  "state": "OPEN"\n}'), details: details() },
      durationMs: 1234,
    });
    assert.deepEqual(lines, ["gh_readonly ✓ pr view 123 --repo octo/repo --json title,state · 4 lines · 1.2s"]);
  });
});

describe("gh_readonly failures", () => {
  const failed = {
    content: text("gh failed (1).\nHTTP 404: Not Found\n"),
    details: details({ status: "command_failed", exitCode: 1, durationMs: 400 }),
  };

  it("collapses to a failure mark with the exit header and first stderr line", () => {
    const theme = recordingTheme();
    const lines = render(tool, { args: { args: prView }, result: failed, isError: true, durationMs: 400 }, 140, theme);
    assert.deepEqual(lines, ["gh_readonly ✗ pr view 123 --repo octo/repo --json title,state — gh failed (1). HTTP 404: Not Found · 0.4s"]);
    assert.ok(theme.calls.some((call) => call.color === "error" && call.text.includes("HTTP 404")), "diagnostic not error-styled");
  });

  it("keeps the start of the diagnostic visible on a narrow row", () => {
    const [line] = render(tool, { args: { args: prView }, result: failed, isError: true, durationMs: 400 }, 60);
    assert.match(line, /^gh_readonly ✗ pr view.*… — gh failed \(1\)\. HTTP 4.*· 0\.4s$/);
  });

  it("expands to the status, exit code, and the full error output in error color", () => {
    const theme = recordingTheme();
    const lines = render(tool, { args: { args: prView }, result: failed, isError: true, durationMs: 400, expanded: true }, 80, theme);
    assert.deepEqual(lines, [
      "gh_readonly gh pr view 123 --repo octo/repo --json title,state",
      "✗ failed · exit 1 · 0.4s",
      "gh failed (1).",
      "HTTP 404: Not Found",
    ]);
    assert.ok(theme.calls.some((call) => call.color === "error" && call.text === "HTTP 404: Not Found"));
  });
});

describe("gh_readonly truncation", () => {
  const notice = "[Output truncated by gh_readonly. Narrow the request with --json/--jq, a smaller --limit, or explicit REST page/per_page parameters.]";
  const body = Array.from({ length: 500 }, (_, i) => `row ${i + 1}`).join("\n");
  const clipped = { content: text(`${body}\n${notice}`), details: details({ truncated: true, durationMs: 2000 }) };

  it("counts returned lines without the notice and flags truncation in warning color", () => {
    const theme = recordingTheme();
    const lines = render(tool, { args: { args: ["pr", "list", "--repo", "octo/repo"] }, result: clipped, durationMs: 2000 }, 100, theme);
    assert.deepEqual(lines, ["gh_readonly ✓ pr list --repo octo/repo · 500 lines · truncated · 2.0s"]);
    assert.ok(theme.calls.some((call) => call.color === "warning" && call.text.includes("truncated")));
  });

  it("highlights the truncation notice in the expanded output", () => {
    const theme = recordingTheme();
    const lines = render(tool, { args: { args: ["pr", "list", "--repo", "octo/repo"] }, result: clipped, durationMs: 2000, expanded: true }, 200, theme);
    assert.equal(lines.length, 503);
    assert.equal(lines[1], "✓ 500 lines · truncated · 2.0s");
    assert.equal(lines.at(-1), notice);
    assert.ok(theme.calls.some((call) => call.color === "warning" && call.text === notice));
  });
});

describe("gh_readonly cancellation", () => {
  it("marks a cancelled request as cancelled, not failed", () => {
    const theme = recordingTheme();
    const lines = render(tool, {
      args: { args: prView },
      result: { content: text("GitHub request cancelled."), details: details({ status: "cancelled", exitCode: null, durationMs: 100 }) },
      isError: true, durationMs: 100,
    }, 120, theme);
    assert.deepEqual(lines, ["gh_readonly ⊘ pr view 123 --repo octo/repo --json title,state — GitHub request cancelled. · 0.1s"]);
    assert.ok(!theme.calls.some((call) => call.color === "error"), "cancellation styled as an error");
  });

  it("treats Pi's abort result, which has no tool details, as cancelled", () => {
    const lines = render(tool, { args: { args: prView }, result: { content: text("Operation aborted"), details: {} }, isError: true }, 120);
    assert.deepEqual(lines, ["gh_readonly ⊘ pr view 123 --repo octo/repo --json title,state — Operation aborted"]);
  });
});

describe("gh_readonly expanded result", () => {
  it("shows the whole command, a status line, and every returned line", () => {
    const lines = render(tool, {
      args: { args: [...prView, "--jq", ".title | ascii_downcase"] },
      result: { content: text('{\n  "title": "Fix",\n  "state": "OPEN"\n}'), details: details() },
      durationMs: 1234,
      expanded: true,
    }, 60);
    assert.deepEqual(lines, [
      "gh_readonly gh pr view 123 --repo octo/repo --json",
      "title,state --jq '.title | ascii_downcase'",
      "✓ 4 lines · 1.2s",
      "{",
      '  "title": "Fix",',
      '  "state": "OPEN"',
      "}",
    ]);
  });
});

describe("gh_readonly empty output", () => {
  const empty = { content: text("(no output)"), details: details({ durationMs: 300 }) };

  it("says no output instead of counting the placeholder as a line", () => {
    const lines = render(tool, { args: { args: ["issue", "list", "--repo", "octo/repo"] }, result: empty, durationMs: 300 });
    assert.deepEqual(lines, ["gh_readonly ✓ issue list --repo octo/repo · no output · 0.3s"]);
  });

  it("still shows the placeholder when expanded", () => {
    const lines = render(tool, { args: { args: ["issue", "list", "--repo", "octo/repo"] }, result: empty, durationMs: 300, expanded: true });
    assert.deepEqual(lines, ["gh_readonly gh issue list --repo octo/repo", "✓ no output · 0.3s", "(no output)"]);
  });
});

describe("gh_readonly rejected arguments", () => {
  it("shows the validation message from execute as the failure reason", async () => {
    const args = { args: ["auth", "token"] };
    const error: Error = await tool.execute("call-1", args, undefined).then(() => assert.fail("execute accepted auth token"), (e: Error) => e);
    // Pi turns a thrown error into this result.
    const result = { content: text(error.message), details: {} };
    const [line] = render(tool, { args, result, isError: true }, 200);
    assert.equal(line, `gh_readonly ✗ auth token — ${error.message}`);
    const expanded = render(tool, { args, result, isError: true, expanded: true }, 200);
    assert.deepEqual(expanded, ["gh_readonly gh auth token", "✗ error", error.message]);
  });
});

describe("gh_readonly while running", () => {
  it("shows the title before arguments arrive and whatever arguments have streamed", () => {
    assert.deepEqual(render(tool, { args: {}, argsComplete: false }), ["gh_readonly"]);
    assert.deepEqual(render(tool, { args: { args: ["pr", "vi"] }, argsComplete: false }), ["gh_readonly pr vi"]);
  });

  it("keeps the call visible under a partial result and does not dump the output", () => {
    const partial = { content: text("line one\nline two\nline three"), details: {} };
    const lines = render(tool, { args: { args: prView }, result: partial, isPartial: true });
    assert.deepEqual(lines, ["gh_readonly pr view 123 --repo octo/repo --json title,state", "running · 3 lines"]);
  });

  it("never hides both rows across partial, final, expand, and collapse", () => {
    const row = toolRow(tool);
    const final = { content: text("a\nb"), details: details() };
    const steps = [
      row.show({ args: {}, argsComplete: false }, 80),
      row.show({ args: { args: prView } }, 80),
      row.show({ args: { args: prView }, result: { content: text("a"), details: {} }, isPartial: true }, 80),
      row.show({ args: { args: prView }, result: final, durationMs: 1200 }, 80),
      row.show({ args: { args: prView }, result: final, durationMs: 1200, expanded: true }, 80),
      row.show({ args: { args: prView }, result: final, durationMs: 1200 }, 80),
    ];
    for (const lines of steps) assert.ok(lines.length > 0, "tool row rendered nothing");
    assert.deepEqual(steps[3], ["gh_readonly ✓ pr view 123 --repo octo/repo --json title,state · 2 lines · 1.2s"]);
    assert.deepEqual(steps[4], ["gh_readonly gh pr view 123 --repo octo/repo --json title,state", "✓ 2 lines · 1.2s", "a", "b"]);
    assert.deepEqual(steps[5], steps[3]);
  });
});

describe("gh_readonly expanded while running", () => {
  it("labels partial output as running, not succeeded", () => {
    const partial = { content: text("a\nb"), details: {} };
    const lines = render(tool, { args: { args: prView }, result: partial, isPartial: true, expanded: true });
    assert.deepEqual(lines, ["gh_readonly gh pr view 123 --repo octo/repo --json title,state", "running · 2 lines", "a", "b"]);
  });
});

describe("gh_readonly terminal safety", () => {
  const hostile = "ok\x1b]8;;http://evil.example\x07link\x1b]8;;\x07\x1b[31m red\x1b[0m\r\nnext\ttab\x07\u202ehidden\x9b";

  it("strips escapes, controls, and bidi overrides from arguments and output", () => {
    const theme = recordingTheme();
    const args = { args: ["search", "issues", "\x1b[2Jbug\u202e"] };
    const result = { content: text(hostile), details: details() };
    const collapsed = render(tool, { args, result, durationMs: 1200 }, 100, theme);
    const expanded = render(tool, { args, result, durationMs: 1200, expanded: true }, 100, theme);
    assert.deepEqual(collapsed, ["gh_readonly ✓ search issues bug · 2 lines · 1.2s"]);
    assert.deepEqual(expanded, ["gh_readonly gh search issues bug", "✓ 2 lines · 1.2s", "oklink red", "next  tabhidden"]);
    // Ignore the escapes the recording theme itself wraps around styled text.
    const own = /\x1b\[(?:38;5;3|39|1|22)m/g;
    for (const call of theme.calls) {
      assert.doesNotMatch(call.text.replace(own, ""), /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/, JSON.stringify(call.text));
    }
  });

  it("leaves the result and arguments it was given untouched", () => {
    const args = { args: ["search", "issues", "\x1b[2Jbug"] };
    const result = { content: text(hostile), details: details({ truncated: true }) };
    const before = structuredClone({ args, result });
    render(tool, { args, result, durationMs: 1200 });
    render(tool, { args, result, durationMs: 1200, expanded: true });
    assert.deepEqual({ args, result }, before);
  });

  it("fits wide characters to the row width", () => {
    const wide = "日本語のテキスト".repeat(20);
    const args = { args: ["search", "issues", wide] };
    const result = { content: text(`${wide}\n${wide}`), details: details() };
    for (const width of [20, 41, 80]) {
      const [line] = render(tool, { args, result, durationMs: 1200 }, width);
      assert.match(line, /^gh_readonly ✓ /);
      assert.ok(line.includes("…") || width >= 80, line);
      render(tool, { args, result, durationMs: 1200, expanded: true }, width);
      render(tool, { args, result: { content: text(wide), details: details({ status: "command_failed" }) }, isError: true }, width);
    }
  });
});
