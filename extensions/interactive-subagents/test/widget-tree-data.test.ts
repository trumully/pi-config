import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getSubagentActivityFile } from "../pi-extension/subagents/activity.ts";
import { writeClaudeUsageSidecar } from "../pi-extension/subagents/claude-usage.ts";
import { parseStatusConfig, SNAPSHOT_STALLED_AFTER_MS } from "../pi-extension/subagents/status.ts";
import type { WidgetRow } from "../pi-extension/subagents/widget.ts";
import {
  buildTreePrefix,
  DEFAULT_PROFILE_ICONS,
  MAX_TREE_DEPTH,
  parseProfileIcon,
  resolveProfileIcon,
  SubagentTreeCollector,
  TREE_USAGE_REFRESH_MS,
} from "../pi-extension/subagents/widget-tree.ts";

describe("status settings", () => {
  it("accepts legacy display modes as ignored values and drops mode from the parsed config", () => {
    for (const mode of [undefined, "compact", "full", "minimal"]) {
      const config = parseStatusConfig({ status: { enabled: true, ...(mode ? { mode } : {}), icons: "nerd" } });
      assert.deepEqual(config, { enabled: true, icons: "nerd", profileIcons: true, lineLimit: 4 });
    }
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, mode: "tree" } }, "cfg.json"),
      /status\.mode is deprecated/,
    );
  });

  it("turns role glyphs off only with an explicit boolean", () => {
    assert.equal(parseStatusConfig({ status: { enabled: true, profileIcons: false } }).profileIcons, false);
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, profileIcons: "no" } }, "cfg.json"),
      /status\.profileIcons must be a boolean/,
    );
  });
});

const T0 = 1_700_000_000_000;
const NOW = T0 + 90_000;
const OPTIONS = { icons: "unicode" as const, profileIcons: true, statusEnabled: true };

type Phase = "starting" | "active" | "waiting" | "done";

/** Synthetic sessions, registries and activity files in a temp directory. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "widget-tree-"));
  const usageLine = (id: string, input: number, output: number, cost: number) =>
    JSON.stringify({ type: "usage", id, usage: { input, output, cost: { total: cost } } });

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    /** Session file whose header id is `id`, followed by one usage line per tuple. */
    session(id: string, usage: Array<[number, number, number]> = []): string {
      const file = join(dir, `${id}.jsonl`);
      const lines = [JSON.stringify({ type: "session", id }), ...usage.map(([i, o, c], n) => usageLine(`${id}-${n}`, i, o, c))];
      writeFileSync(file, lines.join("\n"));
      return file;
    },
    artifactDir: (sessionFile: string, id: string) => join(dirname(sessionFile), "artifacts", id),
    registry(sessionFile: string, id: string, entries: Record<string, unknown>): string {
      const artifactDir = join(dirname(sessionFile), "artifacts", id);
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, "subagent-registry.json"), JSON.stringify(entries));
      return artifactDir;
    },
    activity(artifactDir: string, runId: string, phase: Phase, extra: Record<string, unknown> = {}): void {
      const file = getSubagentActivityFile(artifactDir, runId);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({
        version: 1, runningChildId: runId, createdAt: T0, updatedAt: NOW - 1000, sequence: 3,
        latestEvent: phase === "active" ? "tool_call" : "agent_end", phase,
        agentActive: phase === "active", turnActive: phase === "active", providerActive: false,
        toolActive: phase === "active",
        ...(phase === "active" ? { activeScope: "tool", activeSince: NOW - 2000, toolName: "bash" } : {}),
        ...(phase === "waiting" ? { waitingSince: NOW - 5000 } : {}),
        ...extra,
      }));
    },
  };
}

/** A current registry entry with matching run metadata. */
function entry(params: {
  sessionFile: string; sessionId?: string; runId: string; profile?: string; startTime?: number;
  running?: boolean; cli?: "pi" | "claude"; icon?: string; transcriptOffset?: number; usageFile?: string;
}) {
  return {
    sessionFile: params.sessionFile,
    sessionId: params.sessionId ?? null,
    running: params.running ?? true,
    runId: params.runId,
    ...(params.usageFile ? { usageFile: params.usageFile } : {}),
    runMetadata: {
      version: 1, state: "running", parentSessionId: "parent", runId: params.runId, herdrAgentName: "h",
      surface: "s", sessionFile: params.sessionFile, transcriptOffset: params.transcriptOffset ?? 1,
      profile: params.profile, task: "task body", startTime: params.startTime ?? T0, cli: params.cli ?? "pi",
      ...(params.icon ? { icon: params.icon } : {}),
    },
  };
}

const summary = (rows: WidgetRow[]) => rows.map((row) => `${row.treePrefix}${row.name} ${row.kind}`);
const listFiles = (dir: string) => readdirSync(dir, { recursive: true }).map(String).sort();

describe("subagent tree collector", () => {
  it("nests siblings and grandchildren under their exact parent, each with its own time and usage", () => {
    const f = fixture();
    try {
      const root = f.session("root");
      const scout = f.session("scout", [[100, 20, 0.1]]);
      const worker = f.session("worker", [[9000, 9000, 9], [300, 40, 0.3]]);
      const grand = f.session("grand", [[50, 5, 0.05]]);
      const usageFile = join(f.dir, "cc.usage.json");
      writeClaudeUsageSidecar(usageFile, {
        estimated: true, cost: 0.42, costAvailable: true, inputTokens: null, outputTokens: null,
        cacheReadTokens: null, cacheWriteTokens: null, sessionId: null,
      }, "statusline");
      const rootDir = f.registry(root, "root", {
        "find-docs": entry({ sessionFile: scout, sessionId: "scout", runId: "r-scout", profile: "scout", startTime: T0 + 1000 }),
        "build-it": entry({ sessionFile: worker, sessionId: "worker", runId: "r-worker", profile: "worker", startTime: T0 + 3000, transcriptOffset: 2 }),
        review: entry({ sessionFile: join(f.dir, "cc.jsonl"), runId: "r-cc", profile: "cc-reviewer", cli: "claude", startTime: T0 + 2000, usageFile }),
      });
      f.activity(rootDir, "r-scout", "active");
      f.activity(rootDir, "r-worker", "waiting");
      const workerDir = f.registry(worker, "worker", {
        // Same name as the root's child: names are scoped to their spawner.
        "find-docs": entry({ sessionFile: grand, sessionId: "grand", runId: "r-grand", profile: "scout", startTime: T0 + 4000 }),
      });
      f.activity(workerDir, "r-grand", "active");

      const collector = new SubagentTreeCollector();
      collector.refresh([{ id: "root", sessionFile: root }], NOW);
      const rows = collector.rowsFor("root", NOW, OPTIONS);

      assert.deepEqual(summary(rows), [
        "├─ find-docs active",
        "├─ review running",
        "└─ build-it waiting",
        "   └─ find-docs active",
      ]);
      assert.deepEqual(rows.map((row) => row.elapsed), ["01:29", "01:28", "01:27", "01:26"]);
      assert.deepEqual(rows.map((row) => row.profile), ["scout", "cc-reviewer", "worker", "scout"]);
      assert.equal(rows[0].activity, "bash");
      assert.deepEqual(rows[0].usage, { inputTokens: 100, outputTokens: 20, cost: 0.1, costEstimated: false, costComplete: true });
      // Claude: honest unknown tokens, estimated cost.
      assert.deepEqual(rows[1].usage, { inputTokens: null, outputTokens: null, cost: 0.42, costEstimated: true, costComplete: true });
      // Only entries after this run's transcript offset count.
      assert.deepEqual(rows[2].usage, { inputTokens: 300, outputTokens: 40, cost: 0.3, costEstimated: false, costComplete: true });
      assert.deepEqual(rows[3].usage, { inputTokens: 50, outputTokens: 5, cost: 0.05, costEstimated: false, costComplete: true });

      assert.deepEqual(
        collector.rowsFor("root", NOW, { ...OPTIONS, icons: "ascii" }).map((row) => row.treePrefix),
        ["|- ", "|- ", "`- ", "   `- "],
      );
    } finally {
      f.cleanup();
    }
  });

  it("draws a continuing pipe below a parent that has later siblings", () => {
    assert.equal(buildTreePrefix([], "unicode"), "");
    assert.equal(buildTreePrefix([false, true], "nerd"), "│  └─ ");
    assert.equal(buildTreePrefix([true, false, true], "unicode"), "   │  └─ ");
    assert.equal(buildTreePrefix([false, false], "ascii"), "|  |- ");
  });

  it("drops finished runs but keeps a finished parent of a live run, and treats missing data as not done", () => {
    const f = fixture();
    try {
      const root = f.session("root");
      const doneParent = f.session("done-parent");
      const rootDir = f.registry(root, "root", {
        old: entry({ sessionFile: f.session("done"), sessionId: "done", runId: "r-done", running: false }),
        legacy: { sessionFile: f.session("legacy"), sessionId: "legacy" },
        lead: entry({ sessionFile: doneParent, sessionId: "done-parent", runId: "r-lead", profile: "worker", running: false, startTime: T0 + 1 }),
        "no-file": entry({ sessionFile: f.session("nofile"), runId: "r-missing", startTime: T0 + 2 }),
        broken: entry({ sessionFile: f.session("broken"), runId: "r-broken", startTime: T0 + 3 }),
        "other-run": entry({ sessionFile: f.session("other"), runId: "r-other", startTime: T0 + 4 }),
        "fresh-no-file": entry({ sessionFile: f.session("freshnofile"), runId: "r-fresh", startTime: NOW - 5000 }),
      });
      f.activity(rootDir, "r-done", "active"); // running:false outranks a lagging activity file
      writeFileSync(getSubagentActivityFile(rootDir, "r-broken"), "{not json");
      f.activity(rootDir, "r-other", "active", { runningChildId: "r-previous" });
      f.registry(doneParent, "done-parent", {
        child: entry({ sessionFile: f.session("live"), sessionId: "live", runId: "r-live", startTime: T0 + 10 }),
      });
      f.activity(f.artifactDir(doneParent, "done-parent"), "r-live", "active");

      const collector = new SubagentTreeCollector();
      collector.refresh([{ id: "root", sessionFile: root }], NOW);
      const rows = collector.rowsFor("root", NOW, OPTIONS);

      // Missing, unreadable or wrong-run activity is not proof of exit: the
      // row stays, first as starting, then stalled once the window passes.
      assert.deepEqual(summary(rows), [
        "├─ lead finished",
        "│  └─ child active",
        "├─ no-file starting",
        "├─ broken starting",
        "├─ other-run starting",
        "└─ fresh-no-file starting",
      ]);
      const later = NOW + SNAPSHOT_STALLED_AFTER_MS;
      collector.refresh([{ id: "root", sessionFile: root }], later);
      assert.deepEqual(summary(collector.rowsFor("root", later, OPTIONS)).slice(2), [
        "├─ no-file stalled",
        "├─ broken stalled",
        "├─ other-run stalled",
        "└─ fresh-no-file stalled",
      ]);
      assert.deepEqual(
        { activity: rows[0].activity, elapsed: rows[0].elapsed, usage: rows[0].usage, profile: rows[0].profile },
        { activity: null, elapsed: "", usage: null, profile: "worker" },
      );
    } finally {
      f.cleanup();
    }
  });

  it("trusts a finished spawner's child that reported done over its stale running flag", () => {
    const f = fixture();
    try {
      // R (live root) -> C (watcher saw it exit) -> G (C's watcher died with C,
      // so G's registry still says running, but G's own activity says done).
      const root = f.session("root");
      const c = f.session("c");
      const g = f.session("g");
      const rootDir = f.registry(root, "root", {
        c: entry({ sessionFile: c, sessionId: "c", runId: "r-c", running: false }),
      });
      f.activity(rootDir, "r-c", "done");
      const cDir = f.registry(c, "c", { g: entry({ sessionFile: g, sessionId: "g", runId: "r-g", running: true }) });
      f.activity(cDir, "r-g", "done");

      const collector = new SubagentTreeCollector();
      const roots = [{ id: "root", sessionFile: root }];
      collector.refresh(roots, NOW);
      assert.deepEqual(summary(collector.rowsFor("root", NOW, OPTIONS)), [], "no live descendant, so no context rows");

      // The same finished spawner with a child still working keeps both rows.
      f.activity(cDir, "r-g", "active");
      collector.refresh(roots, NOW);
      assert.deepEqual(summary(collector.rowsFor("root", NOW, OPTIONS)), ["└─ c finished", "   └─ g active"]);

      // Missing, unreadable or wrong-run activity is not proof of exit either.
      for (const write of [
        () => rmSync(getSubagentActivityFile(cDir, "r-g")),
        () => writeFileSync(getSubagentActivityFile(cDir, "r-g"), "{not json"),
        () => f.activity(cDir, "r-g", "done", { runningChildId: "r-older" }),
      ]) {
        write();
        const fresh = new SubagentTreeCollector();
        fresh.refresh(roots, NOW);
        assert.deepEqual(summary(fresh.rowsFor("root", NOW, OPTIONS)), ["└─ c finished", "   └─ g starting"]);
      }

      // A Claude child writes no activity file, so nothing proves it done.
      f.registry(c, "c", {
        cc: entry({ sessionFile: join(f.dir, "cc.jsonl"), runId: "r-cc", cli: "claude", running: true }),
      });
      const claude = new SubagentTreeCollector();
      claude.refresh(roots, NOW);
      assert.deepEqual(summary(claude.rowsFor("root", NOW, OPTIONS)), ["└─ c finished", "   └─ cc running"]);
    } finally {
      f.cleanup();
    }
  });

  it("does not trust running flags below an agent kept only by its own stale flag", () => {
    const f = fixture();
    try {
      // R (live) -> C (finished) -> G (stale running:true, no usable activity)
      // -> H (stale running:true, its own activity says done).
      const root = f.session("root");
      const c = f.session("c");
      const g = f.session("g");
      const h = f.session("h");
      const rootDir = f.registry(root, "root", { c: entry({ sessionFile: c, sessionId: "c", runId: "r-c", running: false }) });
      f.activity(rootDir, "r-c", "done");
      const cDir = f.registry(c, "c", { g: entry({ sessionFile: g, sessionId: "g", runId: "r-g", running: true }) });
      const gDir = f.registry(g, "g", { h: entry({ sessionFile: h, sessionId: "h", runId: "r-h", running: true }) });
      f.activity(gDir, "r-h", "done");
      const roots = [{ id: "root", sessionFile: root }];

      // G's watcher cannot be confirmed, so H's done record wins.
      const gFile = getSubagentActivityFile(cDir, "r-g");
      const writeInvalid = () => { mkdirSync(dirname(gFile), { recursive: true }); writeFileSync(gFile, "{not json"); };
      for (const gActivity of [() => {}, writeInvalid]) {
        gActivity();
        const collector = new SubagentTreeCollector();
        collector.refresh(roots, NOW);
        assert.deepEqual(summary(collector.rowsFor("root", NOW, OPTIONS)), ["└─ c finished", "   └─ g starting"]);
      }

      // An active G is running its watcher, so H's flag outranks H's activity again.
      f.activity(cDir, "r-g", "active");
      const collector = new SubagentTreeCollector();
      collector.refresh(roots, NOW);
      const rows = collector.rowsFor("root", NOW, OPTIONS);
      assert.deepEqual(rows.map((row) => row.name), ["c", "g", "h"]);
      assert.equal(rows[2].kind === "finished", false);
    } finally {
      f.cleanup();
    }
  });

  it("keeps a live spawner's running flag authoritative while its watcher catches up", () => {
    const f = fixture();
    try {
      const root = f.session("root");
      const c = f.session("c");
      const g = f.session("g");
      const rootDir = f.registry(root, "root", { c: entry({ sessionFile: c, sessionId: "c", runId: "r-c" }) });
      f.activity(rootDir, "r-c", "done");
      const cDir = f.registry(c, "c", { g: entry({ sessionFile: g, sessionId: "g", runId: "r-g" }) });
      f.activity(cDir, "r-g", "done");

      const collector = new SubagentTreeCollector();
      collector.refresh([{ id: "root", sessionFile: root }], NOW);
      const rows = collector.rowsFor("root", NOW, OPTIONS);
      assert.deepEqual(rows.map((row) => row.name), ["c", "g"]);
      assert.ok(rows.every((row) => row.kind !== "finished"));
    } finally {
      f.cleanup();
    }
  });

  it("treats only a boolean running flag as authoritative", () => {
    const f = fixture();
    try {
      const root = f.session("root");
      const rootDir = f.registry(root, "root", {
        "says-false-active": { ...entry({ sessionFile: f.session("a"), runId: "r-a", startTime: T0 + 1 }), running: "false" },
        "says-true-done": { ...entry({ sessionFile: f.session("b"), runId: "r-b", startTime: T0 + 2 }), running: "true" },
        "says-one-no-file": { ...entry({ sessionFile: f.session("c"), runId: "r-c", startTime: T0 + 3 }), running: 1 },
      });
      f.activity(rootDir, "r-a", "active");
      f.activity(rootDir, "r-b", "done");

      const collector = new SubagentTreeCollector();
      collector.refresh([{ id: "root", sessionFile: root }], NOW);
      // A malformed flag falls back to the run's own activity; with none, no
      // liveness is invented from a truthy value.
      assert.deepEqual(summary(collector.rowsFor("root", NOW, OPTIONS)), ["└─ says-false-active active"]);
    } finally {
      f.cleanup();
    }
  });

  it("never routes metadata with an unknown CLI as Pi or trusts its time and usage", () => {
    const f = fixture();
    try {
      const root = f.session("root");
      const child = f.session("child", [[100, 10, 1]]);
      const rootDir = f.registry(root, "root", {
        odd: (() => {
          const e = entry({ sessionFile: child, sessionId: "child", runId: "r-odd", profile: "scout" });
          return { ...e, runMetadata: { ...e.runMetadata, cli: "codex" } };
        })(),
        "bad-time": (() => {
          const e = entry({ sessionFile: f.session("t", [[5, 5, 5]]), sessionId: "t", runId: "r-t", startTime: T0 + 1 });
          return { ...e, runMetadata: { ...e.runMetadata, startTime: "yesterday", transcriptOffset: -1 } };
        })(),
      });
      f.activity(rootDir, "r-odd", "active");
      f.activity(rootDir, "r-t", "active");
      // A subtree below the unknown-CLI child must not be read as a Pi registry.
      const childDir = f.registry(child, "child", { hidden: entry({ sessionFile: f.session("h"), sessionId: "h", runId: "r-h" }) });
      f.activity(childDir, "r-h", "active");

      const collector = new SubagentTreeCollector();
      collector.refresh([{ id: "root", sessionFile: root }], NOW);
      const rows = collector.rowsFor("root", NOW, OPTIONS);
      const view = (row: WidgetRow) => ({ name: row.name, kind: row.kind, profile: row.profile, elapsed: row.elapsed, usage: row.usage });
      assert.deepEqual(rows.map(view), [
        // Any malformed field makes this run's metadata unusable: no start
        // time, transcript offset or routing is guessed from it.
        { name: "bad-time", kind: "starting", profile: undefined, elapsed: "", usage: null },
        // Unknown CLI: no activity read, no Pi usage, no subtree; still shown
        // because the spawner says it is running.
        { name: "odd", kind: "starting", profile: undefined, elapsed: "", usage: null },
      ]);
    } finally {
      f.cleanup();
    }
  });

  it("ignores metadata from another run instead of guessing its time and usage", () => {
    const f = fixture();
    try {
      const root = f.session("root");
      const child = f.session("child", [[100, 10, 1]]);
      const old = entry({ sessionFile: child, sessionId: "child", runId: "r-old", profile: "scout" });
      const rootDir = f.registry(root, "root", { child: { ...old, runId: "r-new" } });
      f.activity(rootDir, "r-new", "waiting");

      const collector = new SubagentTreeCollector();
      collector.refresh([{ id: "root", sessionFile: root }], NOW);
      const [row] = collector.rowsFor("root", NOW, OPTIONS);
      assert.deepEqual(
        { kind: row.kind, profile: row.profile, elapsed: row.elapsed, usage: row.usage },
        { kind: "waiting", profile: undefined, elapsed: "", usage: null },
      );
    } finally {
      f.cleanup();
    }
  });

  it("shows each session once and stops at cycles and the depth limit", () => {
    const f = fixture();
    try {
      const root = f.session("root");
      const a = f.session("a");
      const rootDir = f.registry(root, "root", {
        a: entry({ sessionFile: a, sessionId: "a", runId: "r-a", startTime: T0 + 1 }),
        "a-again": entry({ sessionFile: a, sessionId: "a", runId: "r-a2", startTime: T0 + 2 }),
        self: entry({ sessionFile: root, sessionId: "root", runId: "r-self" }),
      });
      f.activity(rootDir, "r-a", "active");
      f.activity(rootDir, "r-a2", "active");
      f.registry(a, "a", {
        "back-to-root": entry({ sessionFile: root, sessionId: "root", runId: "r-back" }),
        "back-to-a": entry({ sessionFile: a, sessionId: "a", runId: "r-back-a" }),
      });

      // A chain deeper than the limit, below a second root.
      const deepRoot = f.session("deep-0");
      let parent = deepRoot;
      for (let depth = 1; depth <= MAX_TREE_DEPTH + 3; depth++) {
        const child = f.session(`deep-${depth}`);
        const dir = f.registry(parent, `deep-${depth - 1}`, {
          [`d${depth}`]: entry({ sessionFile: child, sessionId: `deep-${depth}`, runId: `r-d${depth}` }),
        });
        f.activity(dir, `r-d${depth}`, "waiting");
        parent = child;
      }

      const collector = new SubagentTreeCollector();
      collector.refresh([{ id: "root", sessionFile: root }, { id: "deep", sessionFile: deepRoot }], NOW);
      assert.deepEqual(summary(collector.rowsFor("root", NOW, OPTIONS)), ["└─ a active"]);
      const deep = collector.rowsFor("deep", NOW, OPTIONS);
      assert.equal(deep.length, MAX_TREE_DEPTH);
      assert.equal(deep.at(-1)?.name, `d${MAX_TREE_DEPTH}`);
    } finally {
      f.cleanup();
    }
  });

  it("rebuilds the same rows after a reload, and renders from cache without touching files", () => {
    const f = fixture();
    try {
      const root = f.session("root");
      const child = f.session("child", [[100, 10, 0.5]]);
      const rootDir = f.registry(root, "root", {
        child: entry({ sessionFile: child, sessionId: "child", runId: "r-child", profile: "writer", icon: "✎" }),
      });
      f.activity(rootDir, "r-child", "active");
      const before = listFiles(f.dir);

      const first = new SubagentTreeCollector();
      first.refresh([{ id: "root", sessionFile: root }], NOW);
      const rows = first.rowsFor("root", NOW, OPTIONS);
      assert.equal(rows[0].profileIcon, "✎");
      assert.deepEqual(listFiles(f.dir), before, "refresh writes nothing");

      const reloaded = new SubagentTreeCollector();
      reloaded.refresh([{ id: "root", sessionFile: root }], NOW);
      assert.deepEqual(reloaded.rowsFor("root", NOW, OPTIONS), rows);

      rmSync(f.dir, { recursive: true, force: true });
      assert.deepEqual(first.rowsFor("root", NOW, OPTIONS), rows, "render reads only the cache");
      assert.deepEqual(first.rowsFor("unknown-root", NOW, OPTIONS), []);
    } finally {
      f.cleanup();
    }
  });

  it("re-reads a run's usage at most every five seconds", () => {
    const f = fixture();
    try {
      const root = f.session("root");
      const child = f.session("child", [[100, 10, 0.5]]);
      const rootDir = f.registry(root, "root", {
        child: entry({ sessionFile: child, sessionId: "child", runId: "r-child" }),
      });
      f.activity(rootDir, "r-child", "active");
      const collector = new SubagentTreeCollector();
      const roots = [{ id: "root", sessionFile: root }];
      const input = () => collector.rowsFor("root", NOW, OPTIONS)[0].usage?.inputTokens;

      collector.refresh(roots, NOW);
      f.session("child", [[100, 10, 0.5], [50, 5, 0.1]]);
      collector.refresh(roots, NOW + TREE_USAGE_REFRESH_MS - 1);
      assert.equal(input(), 100);
      collector.refresh(roots, NOW + TREE_USAGE_REFRESH_MS);
      assert.equal(input(), 150);
    } finally {
      f.cleanup();
    }
  });

  it("skips Claude roots and shows plain running rows when status is off", () => {
    const f = fixture();
    try {
      const root = f.session("root");
      const rootDir = f.registry(root, "root", {
        child: entry({ sessionFile: f.session("child"), sessionId: "child", runId: "r-child" }),
      });
      f.activity(rootDir, "r-child", "active");
      const collector = new SubagentTreeCollector();
      collector.refresh([{ id: "pi", sessionFile: root }, { id: "cc", sessionFile: root, cli: "claude" }], NOW);
      assert.deepEqual(collector.rowsFor("cc", NOW, OPTIONS), []);
      const [row] = collector.rowsFor("pi", NOW, { ...OPTIONS, statusEnabled: false });
      assert.deepEqual({ kind: row.kind, activity: row.activity }, { kind: "running", activity: null });
    } finally {
      f.cleanup();
    }
  });
});

describe("profile icons", () => {
  it("reads one literal glyph from frontmatter and drops anything unsafe", () => {
    assert.equal(parseProfileIcon(undefined), undefined);
    assert.equal(parseProfileIcon("\u{F0AD}"), "\u{F0AD}");
    assert.equal(parseProfileIcon('"✎"'), "✎");
    assert.equal(parseProfileIcon("'R'"), "R");
    for (const bad of ["", "ab", "\x1b[31mX", "‮x", '"✎']) {
      assert.equal(parseProfileIcon(bad), undefined, JSON.stringify(bad));
    }
  });

  it("prefers a drawable custom icon, falls back to Nerd defaults, and turns off entirely", () => {
    assert.equal(resolveProfileIcon("worker", undefined, "nerd", true), DEFAULT_PROFILE_ICONS.worker);
    assert.equal(resolveProfileIcon("worker", undefined, "unicode", true), undefined);
    assert.equal(resolveProfileIcon("worker", "✎", "unicode", true), "✎");
    assert.equal(resolveProfileIcon("worker", "✎", "ascii", true), undefined);
    assert.equal(resolveProfileIcon("worker", "W", "ascii", true), "W");
    // Without Nerd Fonts a custom Nerd glyph cannot draw, and no default applies.
    assert.equal(resolveProfileIcon("worker", "\u{F0E8}", "unicode", true), undefined);
    assert.equal(resolveProfileIcon("custom-profile", undefined, "nerd", true), undefined);
    assert.equal(resolveProfileIcon("toString", undefined, "nerd", true), undefined);
    assert.equal(resolveProfileIcon("worker", "✎", "nerd", false), undefined);
  });
});
