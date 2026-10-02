import assert from "node:assert/strict";
import test from "node:test";
import { truncateToWidth, visibleWidth } from "../interactive-subagents/node_modules/@earendil-works/pi-tui/dist/index.js";
import {
  createRunTimerState,
  formatElapsedDuration,
  formatSubagentFooterLine,
  formatUsageFooterLines,
  getProactiveBoundaryPercent,
  getProactiveHandoffStatus,
  getRunTimerLabel,
  resetRunTimerState,
  settleRunTimer,
  startRunTimer,
  type UsageFooterSnapshot,
} from "./usage-footer-format.ts";

const theme = { fg: (_color: unknown, text: string) => text };
const text = { visibleWidth, truncateToWidth };

function snapshot(overrides: Partial<UsageFooterSnapshot> = {}): UsageFooterSnapshot {
  return {
    cwd: "repo",
    model: "example-model",
    effort: "default",
    contextWindow: 200_000,
    contextPercent: 42,
    inputTokens: 12_000,
    outputTokens: 3_000,
    mainCost: 0.123,
    subagentCost: 0.045,
    showSubagentCost: true,
    proactiveCompactionEnabled: true,
    compactionCount: 0,
    proactiveStatus: null,
    proactiveBoundaryPercent: null,
    runDurationLabel: null,
    ...overrides,
  };
}

test("formats context as percentage over the current context window", () => {
  const lines = formatUsageFooterLines(snapshot(), 160, theme, text);
  const output = lines.join("\n");

  assert.match(output, /████░░░░░░ 42%\/200k/);

});

test("keeps usage, token, and cost details in the footer without a run timer", () => {
  const output = formatUsageFooterLines(snapshot(), 160, theme, text).join("\n");

  assert.match(output, /42%\/200k/);
  assert.match(output, /↑12k ↓3\.0k/);
  assert.match(output, /~\$0\.168/);
  assert.match(output, /main \$0\.123 · subagents \$0\.045/);
  assert.match(output, /↻ 0/);
  assert.doesNotMatch(output, /Running|Ran for/);
});

test("renders empty, full, and unknown context bars without losing the window size", () => {
  const empty = formatUsageFooterLines(snapshot({ contextPercent: 0 }), 160, theme, text).join("\n");
  const full = formatUsageFooterLines(snapshot({ contextPercent: 100 }), 160, theme, text).join("\n");
  const unknown = formatUsageFooterLines(
    snapshot({ contextPercent: null }),
    160,
    theme,
    text,
  ).join("\n");

  assert.match(empty, /░{10} 0%\/200k/);
  assert.match(full, /█{10} 100%\/200k/);
  assert.match(unknown, /░{10} \?\/200k/);
});

test("keeps unknown context values visible", () => {
  const unknown = formatUsageFooterLines(
    snapshot({ contextWindow: 0, contextPercent: null }),
    160,
    theme,
    text,
  ).join("\n");
  const missingPercent = formatUsageFooterLines(
    snapshot({ contextPercent: null }),
    160,
    theme,
    text,
  ).join("\n");

  assert.match(unknown, /░{10} \?\/\?/);
  assert.match(missingPercent, /░{10} \?\/200k/);
});

test("shows a configured proactive boundary only for eligible Pi children", () => {
  const enabled = { enabled: true, thresholdPercent: 65 };
  assert.equal(getProactiveBoundaryPercent(true, enabled), 65);
  assert.equal(getProactiveBoundaryPercent(false, enabled), null);
  assert.equal(getProactiveBoundaryPercent(true, { enabled: false, thresholdPercent: 65 }), null);
  assert.equal(getProactiveBoundaryPercent(true, null), null);

  const belowBoundary = formatUsageFooterLines(
    snapshot({ proactiveBoundaryPercent: 70 }),
    160,
    theme,
    text,
  ).join("\n");
  assert.ok(belowBoundary.includes("████░░│░░░ 42%/200k · compact ~70%"));

  const configuredBoundary = formatUsageFooterLines(
    snapshot({ proactiveBoundaryPercent: 65 }),
    160,
    theme,
    text,
  ).join("\n");
  assert.ok(configuredBoundary.includes("compact ~65%"));
  assert.ok(!configuredBoundary.includes("compact ~70%"));

  const aboveBoundary = formatUsageFooterLines(
    snapshot({ contextPercent: 85, proactiveBoundaryPercent: 70 }),
    160,
    theme,
    text,
  ).join("\n");
  assert.ok(aboveBoundary.includes("██████│██░ 85%/200k · compact ~70%"));
});

test("shows proactive handoff status only for persisted child handoff phases", () => {
  assert.equal(getProactiveHandoffStatus(false, "compacting"), null);
  assert.equal(getProactiveHandoffStatus(true, "compacting")?.label, "proactive compaction");
  assert.equal(getProactiveHandoffStatus(true, "requested")?.label, "checkpoint requested");
  assert.equal(getProactiveHandoffStatus(true, "compacted")?.label, "checkpoint saved");
  assert.equal(getProactiveHandoffStatus(true, "resume-pending")?.label, "resuming");
  assert.equal(getProactiveHandoffStatus(true, "resumed")?.label, "resumed from checkpoint");
  assert.equal(getProactiveHandoffStatus(true, "failed")?.color, "error");
  assert.equal(getProactiveHandoffStatus(true, "completed"), null);

  const parentAtThreshold = formatUsageFooterLines(
    snapshot({ contextPercent: 75 }),
    160,
    theme,
    text,
  ).join("\n");
  assert.doesNotMatch(parentAtThreshold, /checkpoint|compacting|resum/i);

  const childCompacting = formatUsageFooterLines(
    snapshot({ proactiveStatus: getProactiveHandoffStatus(true, "compacting") }),
    160,
    theme,
    text,
  ).join("\n");
  assert.match(childCompacting, /↻ proactive compaction/);
});

test("shows running and settled duration labels across continuation starts", () => {
  const timer = createRunTimerState();
  startRunTimer(timer, 1_000);
  assert.equal(getRunTimerLabel(timer, 84_000), "Running 1m 23s");

  // A further agent_start during an automatic continuation must not reset the run.
  startRunTimer(timer, 40_000);
  assert.equal(getRunTimerLabel(timer, 84_000), "Running 1m 23s");

  settleRunTimer(timer, 84_000);
  assert.equal(getRunTimerLabel(timer, 100_000), "Ran for 1m 23s");

  startRunTimer(timer, 100_000);
  assert.equal(getRunTimerLabel(timer, 101_000), "Running 1s");
});

test("resets timer state at a new session or shutdown", () => {
  const timer = createRunTimerState();
  timer.sessionId = "old-session";
  startRunTimer(timer, 1_000);
  settleRunTimer(timer, 5_000);

  resetRunTimerState(timer, "new-session");
  assert.equal(timer.sessionId, "new-session");
  assert.equal(getRunTimerLabel(timer, 10_000), null);

  resetRunTimerState(timer);
  assert.equal(timer.sessionId, null);
  assert.equal(getRunTimerLabel(timer, 10_000), null);
});

test("hides unsupported footer costs and compaction counts", () => {
  const noSpawn = formatUsageFooterLines(snapshot({ showSubagentCost: false, mainCost: 0.123, subagentCost: 0 }), 160, theme, text).join("\n");
  assert.match(noSpawn, /~\$0\.123/);
  assert.doesNotMatch(noSpawn, /subagents/);

  const unknownSpawnCost = formatUsageFooterLines(snapshot({ mainCost: 0.123, subagentCost: null }), 160, theme, text).join("\n");
  assert.doesNotMatch(unknownSpawnCost, /~\$|main \$|subagents/);

  const disabled = formatUsageFooterLines(snapshot({ proactiveCompactionEnabled: false, compactionCount: null }), 160, theme, text).join("\n");
  assert.doesNotMatch(disabled, /↻/);
});

test("formats compact subagent status lines and omits unavailable metrics", () => {
  const complete = formatSubagentFooterLine({ name: "Scout", status: "completed", inputTokens: 1_200, outputTokens: 420, cost: 0.02, compactionCount: 2 }, 120, theme, text);
  assert.match(complete, /Scout · completed · ↑1\.2k · ↓420 · \$0\.020 · ↻ 2/);
  const unavailable = formatSubagentFooterLine({ name: "Claude", status: "running" }, 120, theme, text);
  assert.equal(unavailable, "Claude · running");
  const narrow = formatSubagentFooterLine({ name: "A very long subagent name", status: "running" }, 8, theme, text);
  assert.ok(visibleWidth(narrow) <= 8);
});

test("renders running and settled timer labels in the footer", () => {
  assert.equal(formatElapsedDuration(0), "0s");
  assert.equal(formatElapsedDuration(83_999), "1m 23s");

  const running = formatUsageFooterLines(
    snapshot({ runDurationLabel: "Running 1m 23s" }),
    160,
    theme,
    text,
  );
  const settled = formatUsageFooterLines(
    snapshot({ runDurationLabel: "Ran for 1m 23s" }),
    160,
    theme,
    text,
  );
  assert.match(running.join("\n"), /Running 1m 23s/);
  assert.match(settled.join("\n"), /Ran for 1m 23s/);

  const narrow = formatUsageFooterLines(
    snapshot({
      cwd: "项目/工程/very-long-working-directory",
      model: "模型-with-a-long-name",
      runDurationLabel: "Running 1m 23s",
    }),
    12,
    { fg: (_color, value) => `\u001b[31m${value}\u001b[39m` },
    text,
  );
  assert.ok(narrow.every((line) => visibleWidth(line) <= 12));
  assert.ok(narrow.some((line) => line.includes("\u001b[31m")));
  assert.ok(narrow.some((line) => line.includes("…")));
});
