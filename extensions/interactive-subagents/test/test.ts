import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import { buildPromptAgentArgs } from "../pi-extension/subagents/herdr.ts";
import { herdrCore } from "../pi-extension/subagents/herdr-core.ts";
import { bindMailbox, createFileDeliveryStore, unbindMailbox } from "../pi-extension/subagents/delivery.ts";
import { finishRegisteredRun, readNameRegistry, readSubagentLoadout, registerName, summarizeSessionStats, writeSubagentLoadout, type SubagentLoadout } from "../pi-extension/subagents/session.ts";
import { collectSubagentUsage, readRunUsage } from "../pi-extension/subagents/usage.ts";
import {
  readClaudeCostEstimate,
  readClaudeUsageSidecar,
  reconcileClaudeCostEstimates,
  writeClaudeUsageSidecar,
} from "../pi-extension/subagents/claude-usage.ts";
import { formatUsageFooterLines, type UsageFooterSnapshot } from "../../usage-footer/format.ts";
import {
  createSubagentActivityRecorder,
  progressIndicators,
  readSubagentActivityFile,
  type SubagentActivityState,
} from "../pi-extension/subagents/activity.ts";
import { registerSubagentProgress } from "../pi-extension/subagents/progress.ts";
import { parseStatusConfig } from "../pi-extension/subagents/status.ts";
import { plainWidgetTheme, renderCompactWidgetRows } from "../pi-extension/subagents/widget.ts";

function createMockExtensionApi() {
  const registeredTools: any[] = [];
  const registeredCommands: any[] = [];
  const registeredMessageRenderers: any[] = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<{ message: any; options?: any }> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    api: {
      on() {},
      registerTool(tool: any) { registeredTools.push(tool); },
      registerCommand(name: string, command: any) { registeredCommands.push({ name, ...command }); },
      registerMessageRenderer(name: string, renderer: any) { registeredMessageRenderers.push({ name, renderer }); },
      registerShortcut() {},
      sendUserMessage(message: string) { sentUserMessages.push(message); },
      sendMessage(message: any, options?: any) { sentMessages.push({ message, options }); },
      getAllTools() { return []; },
    } as any,
  };
}

/**
 * Route herdr-app calls to an in-memory hc. `run` reports a live terminal and
 * starts nothing; `get`/`ls` answer from `terminals`. No model is called.
 * Inherited subagent and terminal variables are cleared for the test, so a
 * suite run inside a real subagent never reserves its parent's capacity.
 */
function useFakeHc(terminals: Map<string, Record<string, unknown>> = new Map()) {
  const testApi = (subagentsModule as any).__test__;
  const savedEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => /^(PI_SUBAGENT_|PI_CLAUDE_|HC_|HERDR_)/.test(key)));
  for (const key of Object.keys(savedEnv)) delete process.env[key];
  const savedCli = (herdrCore as any).cli;
  const before = new Set(testApi.runningSubagents.keys());
  const runs: string[][] = [];
  const notFound = () => { throw { stderr: JSON.stringify({ error: { kind: "not_found", message: "not found" } }) }; };
  const answer = (args: string[]): string => {
    if (args[0] === "--version") return "hc 0.0.0-test";
    if (args[0] === "get") return terminals.has(args[1]) ? JSON.stringify(terminals.get(args[1])) : notFound();
    if (args[0] === "ls") return JSON.stringify({ terminals: [...terminals.values()] });
    return notFound();
  };
  process.env.HC_TERMINAL_ID = "test-parent-terminal";
  (herdrCore as any).cli = {
    sync: answer,
    async async(args: string[]) {
      if (args[0] !== "run") return answer(args);
      runs.push(args);
      const name = args[args.indexOf("--name") + 1];
      return JSON.stringify({ address: `t-${name}`, name, state: "live" });
    },
  };
  return {
    runs,
    /** Runs this test registered, in insertion order. */
    started: () => [...testApi.runningSubagents.values()].filter((r: any) => !before.has(r.id)),
    restore() {
      for (const running of [...testApi.runningSubagents.values()]) {
        if (before.has(running.id)) continue;
        running.abortController?.abort();
        testApi.runningSubagents.delete(running.id);
        // Removes the fake launch's private descriptor directory.
        try { herdrCore.close(running.surface); } catch {}
      }
      for (const key of ["pi-subagents/widget-interval", "pi-subagents/status-interval"]) {
        clearInterval((globalThis as any)[Symbol.for(key)]);
      }
      (herdrCore as any).cli = savedCli;
      delete process.env.HC_TERMINAL_ID;
      Object.assign(process.env, savedEnv);
    },
  };
}

/** A parent session context rooted in `directory`. */
function parentContext(directory: string, sessionId = "parent-session") {
  const sessionDir = join(directory, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  return {
    cwd: directory,
    hasUI: false,
    sessionManager: {
      getSessionDir: () => sessionDir,
      getSessionId: () => sessionId,
      getSessionFile: () => join(sessionDir, `${sessionId}.jsonl`),
    },
    artifactDir: join(sessionDir, "artifacts", sessionId),
  };
}

/** One row rendered with fixed settings, independent of the local config file. */
function renderRunningRow(running: any): string {
  const testApi = (subagentsModule as any).__test__;
  const now = running.startTime + 5_000;
  const row = testApi.toWidgetRow(running, now, { icons: "unicode", profileIcons: true, statusEnabled: false });
  return renderCompactWidgetRows([row], 80, plainWidgetTheme, "unicode", now)[0];
}

function registerSubagents() {
  const harness = createMockExtensionApi();
  (subagentsModule as any).default(harness.api);
  return harness;
}

/** Emits real SGR sequences so width checks see styled text; records calls. */
function ansiTheme() {
  const calls: Array<{ method: string; color?: unknown; text: string }> = [];
  const colors = new Proxy({}, { get: (_target, token) => ({ kind: "rgb", r: 250, g: 250, b: 250, token }) });
  return {
    calls,
    colors,
    fg(color: string, text: string) { calls.push({ method: "fg", color, text }); return `\x1b[38;5;1m${text}\x1b[39m`; },
    bg(color: string, text: string) { calls.push({ method: "bg", color, text }); return `\x1b[48;5;1m${text}\x1b[49m`; },
    bold(text: string) { calls.push({ method: "bold", text }); return `\x1b[1m${text}\x1b[22m`; },
    style(text: string, options: any) { calls.push({ method: "style", color: options, text }); return `\x1b[1;48;5;2m${text}\x1b[0m`; },
  };
}

function widgetAgent(overrides: Record<string, unknown> = {}, state: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "widget-test", name: "WorkerName", agent: "worker", startTime: now - 96_000,
    startEntryCount: 0, sessionFile: "", ...overrides,
    statusState: {
      source: "pi", startTimeMs: now - 96_000, firstObservationAtMs: now - 20_000,
      lastActivityAtMs: now - 8_000, lastActivitySequence: 1, localOverrideAtMs: null,
      localOverrideSequence: null, activeNow: false, activeSinceMs: null, activeScope: null,
      waitingSinceMs: now - 8_000, phase: "waiting", latestEvent: null, activityLabel: null,
      snapshotState: "present", snapshotProblemSinceMs: null, snapshotError: null,
      currentKind: "waiting", ...state,
    },
  };
}

function createTheme() {
  return {
    fg(_color: string, text: string) { return text; },
    bg(color: string, text: string) { return `<${color}>${text}</${color}>`; },
    bold(text: string) { return `<bold>${text}</bold>`; },
  };
}

describe("compact subagent progress", () => {
  it("validates child-count progress and keeps old activity files readable", () => {
    const directory = mkdtempSync(join(tmpdir(), "subagent-progress-schema-"));
    const file = join(directory, "activity.json");
    const legacy: SubagentActivityState = {
      version: 1, runningChildId: "run-1", createdAt: 1, updatedAt: 2, sequence: 3,
      latestEvent: "agent_start", phase: "active", agentActive: true, turnActive: false,
      providerActive: false, toolActive: false,
    };
    try {
      writeFileSync(file, JSON.stringify(legacy));
      assert.equal(readSubagentActivityFile(file, "run-1").ok, true);
      writeFileSync(file, JSON.stringify({ ...legacy, progress: { updatedAt: 10, activeChildren: 2 } }));
      assert.equal(readSubagentActivityFile(file, "run-1").ok, true);
      writeFileSync(file, JSON.stringify({ ...legacy, progress: { updatedAt: 10, activeChildren: -1 } }));
      const badSummary = readSubagentActivityFile(file, "run-1");
      assert.equal(badSummary.ok, true);
      if (badSummary.ok) {
        assert.equal(badSummary.activity.phase, "active");
        assert.equal(badSummary.activity.progress, undefined);
      }
      writeFileSync(file, JSON.stringify({ ...legacy, progress: { updatedAt: 10, activeChildren: 1 } }));
      assert.equal(readSubagentActivityFile(file, "other-run").reason, "wrong-id");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps progress heartbeat separate from lifecycle freshness and hides stale counts", () => {
    const directory = mkdtempSync(join(tmpdir(), "subagent-progress-heartbeat-"));
    let clock = 100;
    const file = join(directory, "activity.json");
    const recorder = createSubagentActivityRecorder({ runningChildId: "run-1", activityFile: file, now: () => clock });
    try {
      recorder.sessionStart();
      recorder.agentStart();
      const before = readSubagentActivityFile(file, "run-1");
      assert.equal(before.ok, true);
      if (!before.ok) return;
      clock = 200;
      recorder.reportProgress(2);
      const after = readSubagentActivityFile(file, "run-1");
      assert.equal(after.ok, true);
      if (!after.ok) return;
      assert.equal(after.activity.updatedAt, before.activity.updatedAt);
      assert.equal(after.activity.sequence, before.activity.sequence);
      assert.equal(after.activity.phase, before.activity.phase);
      assert.deepEqual(progressIndicators(after.activity.progress, 200), ["↳ 2"]);
      assert.deepEqual(progressIndicators(after.activity.progress, 10_201), []);
      assert.deepEqual(progressIndicators({ updatedAt: 300, activeChildren: 1 }, 200), []);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("still records done when another process briefly holds the activity file open", async () => {
    // On Windows, replacing a file that another process has open fails with EPERM.
    // The parent polls this file every second, so a burst of child events can hit
    // one read; the recorder must not give up and lose the final "done".
    const directory = mkdtempSync(join(tmpdir(), "subagent-activity-lock-"));
    const file = join(directory, "activity.json");
    const recorder = createSubagentActivityRecorder({ runningChildId: "run-1", activityFile: file });
    try {
      recorder.sessionStart();
      const holder = spawn(process.execPath, ["-e", [
        `const fs = require("fs");`,
        `const fd = fs.openSync(process.argv[1], "r");`,
        `process.stdout.write("held\\n");`,
        `setTimeout(() => fs.closeSync(fd), 100);`,
      ].join(" "), file], { stdio: ["ignore", "pipe", "inherit"] });
      const exited = once(holder, "exit");
      await new Promise<void>((resolveHeld, rejectHeld) => {
        holder.stdout!.once("data", () => resolveHeld());
        holder.once("error", rejectHeld);
      });
      recorder.agentStart();
      recorder.toolExecutionStart("call-1", "read");
      recorder.toolExecutionEnd("call-1", "read");
      recorder.agentEndDone();
      await exited;
      const read = readSubagentActivityFile(file, "run-1");
      assert.equal(read.ok, true);
      if (read.ok) assert.equal(read.activity.phase, "done");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("publishes direct-child counts and clears the heartbeat interval at shutdown", () => {
    const handlers = new Map<string, Function[]>();
    const api = { on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); } } as any;
    const reports: number[] = [];
    const recorder = { reportProgress(children: number) { reports.push(children); } } as any;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let timerCallback: (() => void) | undefined;
    let cleared = 0;
    let children = 2;
    (globalThis as any).setInterval = (callback: () => void) => { timerCallback = callback; return 123; };
    (globalThis as any).clearInterval = (timer: unknown) => { if (timer === 123) cleared++; };
    try {
      registerSubagentProgress(api, recorder, () => children);
      handlers.get("session_start")![0]();
      assert.equal(reports.at(-1), 2);
      children = 1;
      handlers.get("session_tree")![0]();
      assert.equal(reports.at(-1), 1);
      handlers.get("tool_execution_end")![0]();
      assert.equal(reports.at(-1), 1);
      timerCallback!();
      assert.equal(reports.length, 4);
      // A repeated session_start replaces, rather than leaks, the old interval.
      handlers.get("session_start")![0]();
      assert.equal(cleared, 1);
      handlers.get("session_shutdown")![0]();
      assert.equal(cleared, 2);
      timerCallback!();
      assert.equal(reports.length, 5);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it("shows named children under their parent instead of a child count", () => {
    const testApi = (subagentsModule as any).__test__;
    const directory = mkdtempSync(join(tmpdir(), "widget-tree-progress-"));
    const now = Date.now();
    const parentSession = join(directory, "parent.jsonl");
    const childSession = join(directory, "child.jsonl");
    writeFileSync(parentSession, JSON.stringify({ type: "session", id: "parent-session" }));
    writeFileSync(childSession, JSON.stringify({ type: "session", id: "child-session" }));
    registerName(join(directory, "artifacts", "parent-session"), "find-docs", {
      sessionFile: childSession, sessionId: "child-session", running: true, runId: "run-child",
      runMetadata: {
        version: 1, state: "running", parentSessionId: "parent-session", runId: "run-child",
        herdrAgentName: "h", surface: "s", sessionFile: childSession, transcriptOffset: 1,
        profile: "scout", task: "task", startTime: now - 5000, cli: "pi",
      },
    });
    const base = {
      id: "widget-progress", name: "WorkerName", agent: "worker", startTime: now - 1000,
      startEntryCount: 0, sessionFile: parentSession, statusState: {
        source: "pi", startTimeMs: now - 1000, firstObservationAtMs: now - 1000,
        lastActivityAtMs: now - 1000, lastActivitySequence: 1, localOverrideAtMs: null,
        localOverrideSequence: null, activeNow: true, activeSinceMs: now - 1000,
        activeScope: "agent", waitingSinceMs: null, phase: "active", latestEvent: null,
        activityLabel: null, snapshotState: "present", snapshotProblemSinceMs: null,
        snapshotError: null, currentKind: "active",
      },
      activityRead: { ok: true }, activity: { phase: "active", progress: { updatedAt: now, activeChildren: 1 } },
    };
    try {
      testApi.refreshSubagentTree([base], now);
      const lines = testApi.renderSubagentWidgetLines([base], 100, undefined, now);
      assert.deepEqual([lines.length, lines.at(-1)], [3, ""]); // two rows and the bottom spacer
      assert.match(lines[0], /WorkerName/);
      // No activity file yet: the child shows as starting, not finished or hidden.
      assert.match(lines[1], /^└─ .*scout.*find-docs.*starting/);
      assert.doesNotMatch(lines.join("\n"), /↳/);
    } finally {
      testApi.refreshSubagentTree([], now);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("interactive subagents smoke tests", () => {
  it("resolves package sibling extensions before the classic global fallback", () => {
    const testApi = (subagentsModule as any).__test__;
    const bundled = testApi.getBundledSiblingPath("ast-grep/index.ts");
    assert.equal(testApi.getToolExtensionPath("ast_grep"), bundled);
    const extensionsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    assert.equal(testApi.getBundledSiblingPath("usage-footer/index.ts"), join(extensionsDir, "usage-footer", "index.ts"));

    const directory = mkdtempSync(join(tmpdir(), "subagent-extension-path-"));
    const absent = join(directory, "missing.ts");
    const fallback = join(directory, "extensions", "usage-footer.ts");
    try {
      assert.equal(testApi.resolveBundledOrGlobalPath(absent, fallback), fallback);
      writeFileSync(absent, "");
      assert.equal(testApi.resolveBundledOrGlobalPath(absent, fallback), absent);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads bundled community extensions", () => {
    const testApi = (subagentsModule as any).__test__;
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const entry of manifest.pi.extensions) {
      assert.ok(existsSync(resolve(root, entry)), `Missing extension: ${entry}`);
    }
    for (const [tool, entry] of Object.entries({
      ask_user_question: "@juicesharp/rpiv-ask-user-question/index.ts",
      web_search: "pi-web-access/dist/index.js",
      source_check: "pi-web-access/dist/index.js",
      fetch_content: "pi-web-access/dist/index.js",
      get_search_content: "pi-web-access/dist/index.js",
    })) {
      assert.equal(testApi.getToolExtensionPath(tool), join(root, "node_modules", entry));
    }
  });

  it("grants the bundled researcher codemode without shell, files, or spawning tools", () => {
    const profilePath = resolve(dirname(fileURLToPath(import.meta.url)), "../agents/researcher.md");
    const profile = readFileSync(profilePath, "utf8");
    const tools = profile.match(/^tools: (.+)$/m)?.[1].split(",").map((tool) => tool.trim());
    assert.deepEqual(tools, ["codemode", "web_search", "source_check", "fetch_content", "get_search_content"]);
    assert.doesNotMatch(profile, /^subagent_agents:/m);
    assert.match(profile, /Check these error fields even when the call resolves/);
    assert.match(profile, /Return source URLs with the relevant excerpts/);
  });

  it("passes Claude auto-exit behavior to the stop hook", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.deepEqual(testApi.buildClaudeLaunchEnv("/tmp/claude-done", true), {
      PI_CLAUDE_SENTINEL: "/tmp/claude-done",
      PI_CLAUDE_AUTO_EXIT: "1",
      PI_CLAUDE_ASK_FILE: "/tmp/claude-done.ask",
      PI_CLAUDE_PENDING_FILE: "/tmp/claude-done.pending",
      PI_CLAUDE_USAGE_FILE: "/tmp/claude-done.usage.json",
    });
    assert.deepEqual(testApi.buildClaudeLaunchEnv("/tmp/claude-done", false), {
      PI_CLAUDE_SENTINEL: "/tmp/claude-done",
      PI_CLAUDE_AUTO_EXIT: "0",
      PI_CLAUDE_ASK_FILE: "/tmp/claude-done.ask",
      PI_CLAUDE_PENDING_FILE: "/tmp/claude-done.pending",
      PI_CLAUDE_USAGE_FILE: "/tmp/claude-done.usage.json",
    });
  });

  it("reads an optional literal profile icon and drops unsafe ones", () => {
    const testApi = (subagentsModule as any).__test__;
    const parse = (icon: string) => testApi.parseAgentDefinition(`---\nname: x\nicon: ${icon}\n---\nBody.`, "x").icon;
    assert.equal(parse("\u{F0AD}"), "\u{F0AD}");
    assert.equal(parse('"✎"'), "✎");
    assert.equal(parse("two"), undefined);
    assert.equal(testApi.parseAgentDefinition("---\nname: x\n---\nBody.", "x").icon, undefined);
  });

  it("keeps the profile and icon when a finished Pi agent resumes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-resume-icon-"));
    const hc = useFakeHc();
    try {
      const ctx = parentContext(directory);
      const childSession = join(directory, "child.jsonl");
      writeFileSync(childSession, `${JSON.stringify({ type: "session", id: "child-session" })}\n`);
      writeSubagentLoadout(childSession, {
        agent: "writer", toolAllowlist: "read", model: null, thinking: null, systemPromptMode: null,
        identity: null, spawnable: null, autoExit: true, cwd: directory, agentDir: null,
      });
      registerName(ctx.artifactDir, "draft", {
        sessionFile: childSession, sessionId: "child-session", running: false, runId: "r-old",
        runMetadata: {
          version: 1, state: "finished", parentSessionId: "parent-session", runId: "r-old",
          herdrAgentName: "draft-r-old", surface: "draft-r-old", sessionFile: childSession,
          transcriptOffset: 1, profile: "writer", icon: "✎", task: "Draft it.", startTime: 1, cli: "pi",
        },
      });

      const tool = registerSubagents().registeredTools.find((t: any) => t.name === "subagent_message");
      const result = await tool.execute("resume", { name: "draft", message: "Continue the draft." }, undefined, undefined, ctx);
      assert.equal(result.details.status, "started", result.content[0].text);
      assert.equal(hc.runs.length, 1, "one fake hc launch");

      const [running] = hc.started();
      assert.deepEqual({ agent: running.agent, icon: running.icon }, { agent: "writer", icon: "✎" });
      assert.equal(readNameRegistry(ctx.artifactDir).draft.runMetadata?.icon, "✎");
      assert.match(renderRunningRow(running), /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ✎ writer  draft \[running\]/);
    } finally {
      hc.restore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("carries a profile icon from Pi and Claude launches into the record, metadata and row", async () => {
    const directory = mkdtempSync(join(tmpdir(), "launch-icon-"));
    const agentDir = join(directory, "agent");
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "icon-pi.md"), "---\nname: icon-pi\nicon: \"✎\"\ntools: read\n---\nPi body.\n");
    writeFileSync(join(agentDir, "agents", "icon-cc.md"), "---\nname: icon-cc\ncli: claude\nicon: \"◆\"\n---\nClaude body.\n");
    const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const hc = useFakeHc();
    try {
      const ctx = parentContext(directory);
      const tool = registerSubagents().registeredTools.find((t: any) => t.name === "subagent");
      for (const [agent, name, icon] of [["icon-pi", "pi-run", "✎"], ["icon-cc", "cc-run", "◆"]]) {
        const result = await tool.execute(name, { agent, name, task: "Probe." }, undefined, undefined, ctx);
        assert.ok(!result.isError, result.content[0].text);
        const running = hc.started().find((r: any) => r.name === name);
        assert.deepEqual({ agent: running.agent, icon: running.icon }, { agent, icon });
        assert.equal(readNameRegistry(ctx.artifactDir)[name].runMetadata?.icon, icon);
        assert.match(renderRunningRow(running), new RegExp(`^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ${icon} ${agent}  ${name} \\[running\\]`));
      }
      assert.equal(hc.runs.length, 2);
    } finally {
      for (const running of hc.started()) if (running.sentinelFile) rmSync(running.sentinelFile, { force: true });
      hc.restore();
      if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the profile and icon when a finished Claude agent resumes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-resume-icon-"));
    const hc = useFakeHc();
    try {
      const ctx = parentContext(directory);
      const transcript = join(directory, "claude-transcript.jsonl");
      writeFileSync(transcript, "{}\n");
      registerName(ctx.artifactDir, "review", {
        sessionFile: transcript, sessionId: null, running: false, runId: "r-old",
        runMetadata: {
          version: 1, state: "finished", parentSessionId: "parent-session", runId: "r-old",
          herdrAgentName: "review-r-old", surface: "review-r-old", sessionFile: transcript,
          transcriptOffset: 0, profile: "cc-reviewer", icon: "◆", task: "Review it.", startTime: 1, cli: "claude",
        },
        claude: {
          launch: { cwd: directory, model: null, effort: null, systemPromptFile: null, plugin: false },
          sessionId: "claude-session", transcriptPath: transcript,
        },
      });
      const tool = registerSubagents().registeredTools.find((t: any) => t.name === "subagent_message");
      const result = await tool.execute("resume", { name: "review", message: "Check again." }, undefined, undefined, ctx);
      assert.equal(result.details.status, "started", result.content[0].text);
      const [running] = hc.started();
      assert.deepEqual({ agent: running.agent, icon: running.icon, cli: running.cli }, { agent: "cc-reviewer", icon: "◆", cli: "claude" });
      assert.equal(readNameRegistry(ctx.artifactDir).review.runMetadata?.icon, "◆");
      assert.match(renderRunningRow(running), /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ◆ cc-reviewer  review \[running\]/);
    } finally {
      for (const running of hc.started()) if (running.sentinelFile) rmSync(running.sentinelFile, { force: true });
      hc.restore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restores the profile and icon of a live run after the parent reloads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "restore-icon-"));
    const childSession = join(directory, "child.jsonl");
    writeFileSync(childSession, `${JSON.stringify({ type: "session", id: "child-session" })}\n`);
    const hc = useFakeHc(new Map([["draft-r-live", {
      address: "t-draft", name: "draft-r-live", state: "live",
      labels: { "pi.subagent": "draft-r-live", "pi.session": childSession },
    }]]));
    try {
      const ctx = parentContext(directory);
      registerName(ctx.artifactDir, "draft", {
        sessionFile: childSession, sessionId: "child-session", running: true, runId: "r-live",
        runMetadata: {
          version: 1, state: "running", launchConfirmed: true, parentSessionId: "parent-session", runId: "r-live",
          herdrAgentName: "draft-r-live", surface: "draft-r-live", sessionFile: childSession,
          transcriptOffset: 1, profile: "writer", icon: "✎", task: "Draft it.", startTime: Date.now() - 1000, cli: "pi",
        },
      });
      const { api } = registerSubagents();
      const testApi = (subagentsModule as any).__test__;
      await testApi.reconcileParentRuns(api, ctx, "parent-session", ctx.artifactDir, () => true);
      const [running] = hc.started();
      assert.deepEqual({ id: running?.id, agent: running?.agent, icon: running?.icon }, { id: "r-live", agent: "writer", icon: "✎" });
      assert.match(renderRunningRow(running), /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ✎ writer  draft \[running\]/);
    } finally {
      hc.restore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("forwards a Claude profile's effort to Claude Code launch arguments", () => {
    const testApi = (subagentsModule as any).__test__;
    const directory = mkdtempSync(join(tmpdir(), "claude-agent-profile-"));
    const agentsDirectory = join(directory, "agents");
    mkdirSync(agentsDirectory);
    writeFileSync(join(agentsDirectory, "cc-worker.md"), [
      "---",
      "name: cc-worker",
      "cli: claude",
      "model: claude-opus-5-5",
      "effort: high",
      "---",
      "Worker instructions.",
    ].join("\n"));

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    try {
      const profile = testApi.loadAgentDefaults("cc-worker");
      assert.ok(profile);
      assert.equal(profile.effort, "high");
      const systemPromptFile = testApi.writeClaudeSystemPromptFile(directory, "test-run", profile.body);
      assert.equal(readFileSync(systemPromptFile, "utf8"), "Worker instructions.");
      assert.deepEqual(testApi.buildClaudeCliArgs({
        pluginDir: "/claude-plugin",
        model: profile.model,
        effort: profile.effort,
        systemPromptFile,
        usageFile: "C:\\Users\\Example\\AppData\\Local\\Temp\\done.usage.json",
        statuslineScript: "C:\\Program Files\\pi-config\\statusline.py",
      }), [
        "--permission-mode", "auto",
        "--plugin-dir", "/claude-plugin",
        "--allowedTools", "mcp__plugin_pi-auto-exit_pi__ask_question",
        "--settings", JSON.stringify({ statusLine: {
          type: "command",
          command: `uv run --no-project ${testApi.quoteClaudeShellPath("C:\\Program Files\\pi-config\\statusline.py", process.platform === "win32" ? "win32" : "posix")}`,
        } }),
        "--model", "claude-opus-5-5",
        "--effort", "high",
        "--append-system-prompt-file", systemPromptFile,
      ]);
      assert.equal(
        testApi.quoteClaudeShellPath("C:\\Users\\Example\\Claude Tools\\statusline.py", "win32"),
        '"C:/Users/Example/Claude Tools/statusline.py"',
      );
      assert.equal(
        testApi.quoteClaudeShellPath("/tmp/Claude Tools/o'hare.py", "posix"),
        "'/tmp/Claude Tools/o'\\''hare.py'",
      );
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exposes the Claude ask_question MCP tool and writes an atomic question signal", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-ask-mcp-"));
    const askFile = join(directory, "question.ask");
    const pendingFile = join(directory, "question.pending");
    const server = resolve(dirname(fileURLToPath(import.meta.url)), "../pi-extension/subagents/plugin/mcp/ask_question.py");
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_question", arguments: { question: "Which option should I use?" } } },
    ];
    try {
      const output = execFileSync("uv", ["run", "--no-project", server], {
        input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
        env: { ...process.env, PI_CLAUDE_ASK_FILE: askFile, PI_CLAUDE_PENDING_FILE: pendingFile },
        timeout: 15_000,
        windowsHide: true,
      });
      const responses = output.toString("utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
      assert.equal(responses[0].result.protocolVersion, "2025-11-25");
      assert.equal(responses[1].result.tools[0].name, "ask_question");
      assert.match(responses[2].result.content[0].text, /sent to the Pi orchestrator/i);
      assert.equal(JSON.parse(readFileSync(askFile, "utf8")).question, "Which option should I use?");
      assert.equal(existsSync(pendingFile), true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("delivers Claude question sidecars through the parent watcher", () => {
    const harness = registerSubagents();
    const directory = mkdtempSync(join(tmpdir(), "claude-ask-watcher-"));
    const askFile = join(directory, "question.ask");
    writeFileSync(askFile, JSON.stringify({ id: "q1", question: "Need a decision?" }));
    bindMailbox({
      parentSessionId: "ask-test-parent",
      store: createFileDeliveryStore(join(directory, "mailbox")),
      send: (item) => harness.api.sendMessage(
        { customType: item.customType, content: item.content, display: true, details: item.details },
        { triggerTurn: true, deliverAs: "steer" },
      ),
      getEntries: () => [],
      isIdle: () => true,
    });
    try {
      const testApi = (subagentsModule as any).__test__;
      testApi.deliverPendingQuestion({
        id: "ask-test-run",
        parentSessionId: "ask-test-parent",
        name: "ClaudeWorker",
        agent: "cc-worker",
        startTime: Date.now() - 1000,
        sessionFile: join(directory, "nonexistent-pi-session.jsonl"),
        askFile,
      });
      assert.equal(existsSync(askFile), false);
      assert.equal(harness.sentMessages.length, 1);
      assert.match(harness.sentMessages[0].message.content, /Need a decision\?/);
      assert.equal(harness.sentMessages[0].options?.triggerTurn, true);
      assert.equal(harness.sentMessages[0].options?.deliverAs, "steer");
    } finally {
      unbindMailbox();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps an auto-exit Claude worker open while its question is pending", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-question-pending-"));
    const transcript = join(directory, "transcript.jsonl");
    const sentinel = join(directory, "done");
    const pending = `${sentinel}.pending`;
    const hook = resolve(dirname(fileURLToPath(import.meta.url)), "../pi-extension/subagents/plugin/hooks/on-stop.py");
    writeFileSync(transcript, [
      JSON.stringify({ type: "user", message: { role: "user", content: "initial task" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "parent reply" } }),
    ].join("\n"));
    writeFileSync(pending, "q1");
    try {
      execFileSync("uv", ["run", "--no-project", hook], {
        input: JSON.stringify({ stop_hook_active: false, transcript_path: transcript, last_assistant_message: "WAITING" }),
        env: { ...process.env, PI_CLAUDE_SENTINEL: sentinel, PI_CLAUDE_AUTO_EXIT: "1", PI_CLAUDE_PENDING_FILE: pending },
        timeout: 10_000,
        windowsHide: true,
      });
      assert.equal(existsSync(sentinel), false);
      assert.equal(existsSync(`${sentinel}.transcript`), true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("clears the question-pending marker when Claude receives the parent's reply", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-question-reply-"));
    const pending = join(directory, "done.pending");
    const hook = resolve(dirname(fileURLToPath(import.meta.url)), "../pi-extension/subagents/plugin/hooks/on-user-prompt.py");
    writeFileSync(pending, "q1");
    try {
      execFileSync("uv", ["run", "--no-project", hook], {
        input: JSON.stringify({ prompt: "The user decision" }),
        env: { ...process.env, PI_CLAUDE_PENDING_FILE: pending },
        timeout: 10_000,
        windowsHide: true,
      });
      assert.equal(existsSync(pending), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("parses Claude cost-state as an estimate and aggregates its sidecar", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-cost-state-"));
    const transcript = join(directory, "transcript.jsonl");
    const usageFile = join(directory, "child.usage.json");
    const artifactDir = join(directory, "artifacts", "parent");
    writeFileSync(transcript, [
      JSON.stringify({ type: "user", message: { content: "private task text" } }),
      JSON.stringify({
        type: "cost-state",
        sessionId: "claude-session-1",
        totalCostUSD: 0.1234,
        hasUnknownModelCost: false,
        modelUsage: {
          "model-a": { inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 2, cacheCreationInputTokens: 3 },
          "model-b": { inputTokens: 6, outputTokens: 5, cacheReadInputTokens: 1, cacheCreationInputTokens: 2 },
        },
      }),
    ].join("\n"));
    try {
      const estimate = readClaudeCostEstimate(transcript);
      assert.deepEqual(estimate, {
        estimated: true,
        cost: 0.1234,
        costAvailable: true,
        inputTokens: 16,
        outputTokens: 9,
        cacheReadTokens: 3,
        cacheWriteTokens: 5,
        sessionId: "claude-session-1",
      });
      writeClaudeUsageSidecar(usageFile, estimate);
      registerName(artifactDir, "ClaudeWorker", {
        sessionFile: join(directory, "not-a-pi-session.jsonl"),
        sessionId: null,
        usageFile,
        running: false,
      });
      assert.deepEqual(collectSubagentUsage(artifactDir), {
        sessionCount: 1,
        runningCount: 0,
        inputTokens: 16,
        outputTokens: 9,
        cacheReadTokens: 3,
        cacheWriteTokens: 5,
        cost: 0.1234,
        costAvailable: true,
        costComplete: true,
        costEstimated: true,
      });

      const partialTranscript = join(directory, "partial.jsonl");
      writeFileSync(partialTranscript, JSON.stringify({
        type: "cost-state",
        totalCostUSD: 0.05,
        hasUnknownModelCost: true,
        modelUsage: { "unknown-model": { inputTokens: 2, outputTokens: 1 } },
      }));
      assert.deepEqual(readClaudeCostEstimate(partialTranscript), {
        estimated: true,
        cost: null,
        costAvailable: false,
        inputTokens: 2,
        outputTokens: 1,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        sessionId: null,
        costExplicitlyUnknown: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("updates the footer from status-line snapshots and reconciles final Claude cost", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-live-cost-"));
    const usageFile = join(directory, "child.usage.json");
    const artifactDir = join(directory, "artifacts", "parent");
    const script = resolve(dirname(fileURLToPath(import.meta.url)), "../pi-extension/subagents/plugin/statusline.py");
    const runStatusLine = (payload: string, targetUsageFile = usageFile) => execFileSync("uv", ["run", "--no-project", script], {
      input: payload,
      env: { ...process.env, PI_CLAUDE_USAGE_FILE: targetUsageFile },
      timeout: 15_000,
      windowsHide: true,
    });

    try {
      registerName(artifactDir, "ClaudeWorker", {
        sessionFile: join(directory, "not-a-pi-session.jsonl"),
        sessionId: null,
        usageFile,
        running: true,
      });
      for (const cost of [0.05, 0.137]) {
        runStatusLine(JSON.stringify({
          session_id: "claude-live-1",
          transcript_path: "must not be persisted",
          cost: { total_cost_usd: cost },
          current_usage: { input_tokens: 999 },
        }));
        const snapshot = readClaudeUsageSidecar(usageFile);
        assert.equal(snapshot?.cost, cost);
        assert.deepEqual([
          snapshot?.inputTokens,
          snapshot?.outputTokens,
          snapshot?.cacheReadTokens,
          snapshot?.cacheWriteTokens,
        ], [null, null, null, null]);
        const record = JSON.parse(readFileSync(usageFile, "utf8"));
        assert.equal(record.source, "claude-code-statusline");
        assert.equal("transcript_path" in record, false);
        assert.equal("current_usage" in record, false);
        const totals = collectSubagentUsage(artifactDir);
        assert.equal(totals.cost, cost, "snapshots replace the previous cumulative amount");
        assert.equal(totals.costAvailable, true);
        assert.equal(totals.costComplete, true, "a known live estimate is currently complete");
        assert.equal(totals.runningCount, 1);
      }

      for (const invalid of ["not json", JSON.stringify({ session_id: "s", cost: { total_cost_usd: -1 } }),
        JSON.stringify({ session_id: "s", cost: { total_cost_usd: "0.2" } }),
        JSON.stringify({ session_id: "s", cost: { total_cost_usd: null } }),
        '{"session_id":"s","cost":{"total_cost_usd":NaN}}']) {
        runStatusLine(invalid);
        assert.equal(readClaudeUsageSidecar(usageFile)?.cost, 0.137, "bad input leaves the last valid snapshot intact");
      }
      // A filesystem failure is swallowed by the status-line helper and never
      // becomes a failed child command or damages the prior valid snapshot.
      runStatusLine(JSON.stringify({ session_id: "s", cost: { total_cost_usd: 0.5 } }), directory);
      assert.equal(readClaudeUsageSidecar(usageFile)?.cost, 0.137);

      const live = readClaudeUsageSidecar(usageFile)!;
      assert.deepEqual(reconcileClaudeCostEstimates(live, null), live);
      const finalFile = join(directory, "final.jsonl");
      writeFileSync(finalFile, JSON.stringify({
        type: "cost-state", sessionId: "claude-live-1", totalCostUSD: 0.2,
        hasUnknownModelCost: false,
        modelUsage: { model: { inputTokens: 12, outputTokens: 4, cacheReadInputTokens: 5, cacheCreationInputTokens: 3 } },
      }));
      const finalEstimate = readClaudeCostEstimate(finalFile)!;
      const final = reconcileClaudeCostEstimates(live, finalEstimate)!;
      assert.equal(final.cost, 0.2);
      assert.equal(final.inputTokens, 12);
      writeClaudeUsageSidecar(usageFile, final, "cost-state");
      assert.equal(JSON.parse(readFileSync(usageFile, "utf8")).source, "claude-code-cost-state");
      assert.equal(collectSubagentUsage(artifactDir).cost, 0.2);

      const unknownFile = join(directory, "unknown-final.jsonl");
      writeFileSync(unknownFile, JSON.stringify({
        type: "cost-state", sessionId: "claude-live-1", totalCostUSD: 0.137,
        hasUnknownModelCost: true,
        modelUsage: { model: { inputTokens: 99, outputTokens: 7 } },
      }));
      const unknown = reconcileClaudeCostEstimates(live, readClaudeCostEstimate(unknownFile))!;
      assert.equal(unknown.cost, null, "explicit unknown-model final cost must not inherit the live amount");
      assert.equal(unknown.costAvailable, false);
      assert.equal(unknown.inputTokens, 99);
      writeClaudeUsageSidecar(usageFile, unknown, "cost-state");
      assert.equal(JSON.parse(readFileSync(usageFile, "utf8")).source, "claude-code-cost-state");
      assert.equal(collectSubagentUsage(artifactDir).costComplete, false);

      const otherSessionFile = join(directory, "other-session.jsonl");
      writeFileSync(otherSessionFile, JSON.stringify({
        type: "cost-state", sessionId: "claude-live-2", totalCostUSD: 0.01,
        hasUnknownModelCost: false, modelUsage: { model: { inputTokens: 2 } },
      }));
      const other = reconcileClaudeCostEstimates(live, readClaudeCostEstimate(otherSessionFile))!;
      assert.equal(other.sessionId, "claude-live-2");
      assert.equal(other.cost, 0.01);
      assert.equal(other.inputTokens, 2, "do not merge tokens across different Claude sessions");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("marks missing Claude cost unavailable and labels known child cost estimated", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-cost-unknown-"));
    const artifactDir = join(directory, "artifacts", "parent");
    const usageFile = join(directory, "unknown.usage.json");
    const sessionFile = join(directory, "unknown-session.jsonl");
    try {
      writeClaudeUsageSidecar(usageFile, null);
      registerName(artifactDir, "UnknownClaude", { sessionFile, sessionId: null, usageFile, running: false });
      assert.equal(collectSubagentUsage(artifactDir).costComplete, false);

      const snapshot: UsageFooterSnapshot = {
        cwd: "/project",
        gitBranch: null,
        model: "main-model",
        effort: "medium",
        contextWindow: 200_000,
        contextPercent: 20,
        inputTokens: 100,
        outputTokens: 50,
        mainCost: 0.3,
        subagentCost: 0.125,
        subagentCostEstimated: true,
        showSubagentCost: true,
        proactiveCompactionEnabled: false,
        compactionCount: null,
        proactiveStatus: null,
        proactiveBoundaryPercent: null,
        runDurationLabel: null,
      };
      const footer = formatUsageFooterLines(snapshot, 160, { fg: (_color, text) => text }, {
        visibleWidth: (text) => text.length,
        truncateToWidth: (text, width) => text.slice(0, width),
      }).join("\n");
      assert.match(footer, /~\$0\.425 \(main \$0\.300 \+ sub ~\$0\.125\)/);
      assert.doesNotMatch(footer, /est\./);

      const knownFooter = formatUsageFooterLines({ ...snapshot, subagentCostEstimated: false }, 160, { fg: (_color, text) => text }, {
        visibleWidth: (text) => text.length,
        truncateToWidth: (text, width) => text.slice(0, width),
      }).join("\n");
      assert.match(knownFooter, /\(main \$0\.300 \+ sub \$0\.125\)/);

      const partialFooter = formatUsageFooterLines({ ...snapshot, mainCost: null }, 160, { fg: (_color, text) => text }, {
        visibleWidth: (text) => text.length,
        truncateToWidth: (text, width) => text.slice(0, width),
      }).join("\n");
      assert.match(partialFooter, /~\?\+~\$0\.125/);

      const unknownFooter = formatUsageFooterLines({ ...snapshot, subagentCost: null, subagentCostEstimated: false }, 160, { fg: (_color, text) => text }, {
        visibleWidth: (text) => text.length,
        truncateToWidth: (text, width) => text.slice(0, width),
      }).join("\n");
      assert.match(unknownFooter, /\$0\.300\+\?/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns Claude results after parent steering in auto-exit sessions", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-stop-hook-"));
    const transcript = join(directory, "transcript.jsonl");
    const sentinel = join(directory, "done");
    const hook = resolve(dirname(fileURLToPath(import.meta.url)), "../pi-extension/subagents/plugin/hooks/on-stop.py");
    writeFileSync(transcript, [
      JSON.stringify({ type: "user", message: { role: "user", content: "initial task" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "working" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "parent steering" } }),
    ].join("\n"));

    try {
      execFileSync("uv", ["run", "--no-project", hook], {
        input: JSON.stringify({
          stop_hook_active: false,
          transcript_path: transcript,
          last_assistant_message: "FINAL_RESULT",
        }),
        env: { ...process.env, PI_CLAUDE_SENTINEL: sentinel, PI_CLAUDE_AUTO_EXIT: "1" },
        timeout: 10_000,
        windowsHide: true,
      });
      assert.equal(readFileSync(sentinel, "utf8").trim(), "FINAL_RESULT");
      assert.equal(readFileSync(`${sentinel}.transcript`, "utf8").trim(), transcript);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects every Claude model override before checking the terminal or reserving a run", async () => {
    const tool = registerSubagents().registeredTools.find((tool: any) => tool.name === "subagent");
    for (const agent of ["cc-worker", "cc-reviewer"]) {
      for (const model of ["other-model", "claude-opus-5-5", ""]) {
        const result = await tool.execute("cc-override", { agent, task: "Do not launch", model, effort: "high" }, undefined, undefined, {});
        assert.equal(result.isError, true);
        assert.equal(result.details.error, "Claude model override forbidden");
        assert.match(result.content[0].text, /Omit model/);
      }
    }
    assert.match(tool.description, /Never supply a model override for a Claude Code profile/);
    assert.match(tool.promptSnippet, /model argument is Pi-only/);
    assert.match(tool.parameters.properties.model.description, /Forbidden for Claude Code/);
  });

  it("overrides Claude effort for one launch and otherwise preserves the profile default", () => {
    const testApi = (subagentsModule as any).__test__;
    const profile = { cli: "claude", model: "claude-opus-5-5", effort: "medium" };
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const args = testApi.buildClaudeCliArgs({
        model: profile.model,
        effort: testApi.resolveSubagentEffort({ effort }, profile),
      });
      assert.deepEqual(args, ["--permission-mode", "auto", "--model", "claude-opus-5-5", "--effort", effort]);
    }
    assert.equal(profile.effort, "medium", "a launch override must not change the profile");
    assert.equal(testApi.resolveSubagentEffort({}, profile), "medium");
    const noEffort = testApi.resolveSubagentEffort({}, { cli: "claude" });
    assert.equal(noEffort, undefined);
    assert.deepEqual(testApi.buildClaudeCliArgs({ effort: noEffort }), ["--permission-mode", "auto"]);
  });

  it("maps Pi effort to thinking independently of the model and retains it for resume", () => {
    const testApi = (subagentsModule as any).__test__;
    const directory = mkdtempSync(join(tmpdir(), "pi-effort-override-"));
    const sessionFile = join(directory, "child.jsonl");
    const profile = { thinking: "low" };
    try {
      for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
        for (const model of [null, "provider/model:low"]) {
          const loadout: SubagentLoadout = {
            agent: "scout", toolAllowlist: null, model,
            thinking: testApi.resolveSubagentEffort({ effort }, profile),
            systemPromptMode: null, identity: null, spawnable: null,
            autoExit: true, cwd: null, agentDir: null,
          };
          writeSubagentLoadout(sessionFile, loadout);
          const restored = readSubagentLoadout(sessionFile);
          assert.ok(restored);
          for (const snapshot of [loadout, restored]) {
            const args: string[] = [];
            testApi.applySandboxToParts(args, snapshot, { artifactDir: directory, name: "scout" });
            assert.ok(args.includes("--thinking"));
            assert.equal(args[args.indexOf("--thinking") + 1], effort);
            if (model) assert.equal(args[args.indexOf("--model") + 1], model);
            else assert.ok(!args.includes("--model"));
          }
        }
      }
      assert.equal(profile.thinking, "low");
      assert.equal(testApi.resolveSubagentEffort({}, profile), "low");
      assert.equal(testApi.resolveSubagentEffort({}, null), undefined);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects invalid effort overrides before checking the terminal or reserving a run", async () => {
    const tool = registerSubagents().registeredTools.find((tool: any) => tool.name === "subagent");
    for (const agent of ["scout", "cc-worker"]) {
      const invalid = ["", "HIGH", "invalid", null, 3, ...(agent === "cc-worker" ? ["off", "minimal"] : [])];
      for (const effort of invalid) {
        const result = await tool.execute("effort-override", { task: "Do not launch", agent, effort }, undefined, undefined, {});
        assert.equal(result.isError, true);
        assert.equal(result.details.error, "invalid effort override");
        assert.match(result.content[0].text, agent === "scout" ? /Invalid Pi effort/ : /Invalid Claude Code effort/);
      }
    }
    const schema = tool.parameters.properties.effort;
    assert.deepEqual(schema.anyOf.map((variant: any) => variant.const), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    for (const guidance of [tool.description, tool.promptSnippet, schema.description]) {
      assert.match(guidance, /only when the user explicitly requests/i);
    }
  });

  it("waits for Claude to start processing the initial prompt", () => {
    assert.deepEqual(buildPromptAgentArgs("sub-cc-worker", "Do the task", true), [
      "agent", "prompt", "sub-cc-worker", "Do the task",
      "--wait", "--until", "working", "--timeout", "10000",
    ]);
  });

  it("does not auto-finish an interactive Claude session after follow-up input", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-stop-hook-interactive-"));
    const transcript = join(directory, "transcript.jsonl");
    const sentinel = join(directory, "done");
    const hook = resolve(dirname(fileURLToPath(import.meta.url)), "../pi-extension/subagents/plugin/hooks/on-stop.py");
    writeFileSync(transcript, [
      JSON.stringify({ type: "user", message: { role: "user", content: "initial task" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "follow-up" } }),
    ].join("\n"));

    try {
      execFileSync("uv", ["run", "--no-project", hook], {
        input: JSON.stringify({ stop_hook_active: false, transcript_path: transcript, last_assistant_message: "RESULT" }),
        env: { ...process.env, PI_CLAUDE_SENTINEL: sentinel, PI_CLAUDE_AUTO_EXIT: "0" },
        timeout: 10_000,
        windowsHide: true,
      });
      assert.equal(existsSync(sentinel), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves a stalled initial prompt pane open and reports its identifiers", () => {
    const testApi = (subagentsModule as any).__test__;
    const closeCalls: Array<{ surface: string; tabId?: string }> = [];
    assert.throws(
      () => testApi.handleClaudeLaunchError(
        new Error("agent_prompt_stalled: no working or blocked activity was observed"),
        "sub-cc-worker",
        "w2:pC",
        "tab-3",
        (surface: string, tabId?: string) => closeCalls.push({ surface, tabId }),
      ),
      /prompt did not start.*sub-cc-worker.*w2:pC.*left open/i,
    );
    assert.deepEqual(closeCalls, []);
  });

  it("leaves Claude startup-block panes open and reports their identifiers", () => {
    const testApi = (subagentsModule as any).__test__;
    const closeCalls: Array<{ surface: string; tabId?: string }> = [];
    const blockedError = new Error(
      "agent sub-cc-worker is blocked during startup and is not ready for prompts",
    );

    assert.throws(
      () => testApi.handleClaudeLaunchError(
        blockedError,
        "sub-cc-worker",
        "w2:pA",
        "tab-1",
        (surface: string, tabId?: string) => closeCalls.push({ surface, tabId }),
      ),
      /blocked during startup.*sub-cc-worker.*w2:pA.*left open/i,
    );
    assert.deepEqual(closeCalls, []);

    const unrelatedError = new Error("Claude executable not found");
    assert.throws(
      () => testApi.handleClaudeLaunchError(
        unrelatedError,
        "sub-cc-worker",
        "w2:pB",
        "tab-2",
        (surface: string, tabId?: string) => closeCalls.push({ surface, tabId }),
      ),
      /Claude executable not found/,
    );
    assert.deepEqual(closeCalls, [{ surface: "w2:pB", tabId: "tab-2" }]);
  });

  it("updates the task brief only after delivery and warns when persistence fails", () => {
    const testApi = (subagentsModule as any).__test__;
    const directory = mkdtempSync(join(tmpdir(), "subagent-task-delivery-"));
    const running: any = { id: "run-1", name: "Worker", task: "old task" };
    const delivered = { content: [{ type: "text", text: "delivered" }], details: { name: "Worker", status: "steered" } };
    try {
      registerName(directory, "Worker", { sessionFile: "worker.jsonl", sessionId: "s1", runId: "run-1", taskBrief: "old task" });
      const notDelivered = { content: [], details: { error: "send failed" } };
      testApi.persistDeliveredTaskBrief(running, directory, "not sent", notDelivered, false, {}, () => { throw new Error("must not persist"); });
      assert.equal(running.task, "old task");
      assert.equal(readNameRegistry(directory).Worker.taskBrief, "old task");

      const result = testApi.persistDeliveredTaskBrief(running, directory, "new assignment", delivered, true, {}, () => { throw new Error("disk full"); });
      assert.equal(running.task, "new assignment");
      assert.equal(result.details.status, "steered");
      assert.match(result.details.warning, /delivered.*could not be saved.*disk full/i);
      assert.equal(readNameRegistry(directory).Worker.taskBrief, "old task");

      const unregistered: any = { id: "run-2", name: "Missing", task: "before" };
      const missing = testApi.persistDeliveredTaskBrief(unregistered, directory, "delivered", delivered, true);
      assert.match(missing.details.warning, /no registry entry/i);
      assert.equal(unregistered.task, "delivered");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps legacy registry records valid and preserves the current brief", () => {
    const directory = mkdtempSync(join(tmpdir(), "subagent-brief-registry-"));
    try {
      registerName(directory, "Legacy", { sessionFile: "legacy.jsonl", sessionId: null });
      assert.equal(readNameRegistry(directory).Legacy.taskBrief, undefined);
      registerName(directory, "Explicit", { sessionFile: "explicit.jsonl", sessionId: null, taskBrief: "replacement assignment" });
      assert.equal(readNameRegistry(directory).Explicit.taskBrief, "replacement assignment");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });


  it("does not let a stale run mark a newer registry run finished", () => {
    const directory = mkdtempSync(join(tmpdir(), "subagent-registry-"));
    try {
      registerName(directory, "Worker", {
        sessionFile: join(directory, "new.jsonl"),
        sessionId: "new-session",
        running: true,
        runId: "new-run",
      });

      assert.equal(finishRegisteredRun(directory, "Worker", "old-run"), false);
      assert.equal(readNameRegistry(directory).Worker.running, true);
      assert.equal(finishRegisteredRun(directory, "Worker", "new-run"), true);
      assert.equal(readNameRegistry(directory).Worker.running, false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("generates Herdr names without a sub prefix while retaining unique run suffixes", () => {
    const { herdrAgentNameFor } = (subagentsModule as any).__test__;
    assert.equal(herdrAgentNameFor("Scout", "a1b2c3d4"), "scout-a1b2c3d4");
    assert.equal(herdrAgentNameFor("Scout", "e5f6a7b8"), "scout-e5f6a7b8");
    assert.equal(herdrAgentNameFor("  API / Review!  ", "a1b2c3d4"), "api-review-a1b2c3d4");
    assert.equal(herdrAgentNameFor("???", "a1b2c3d4"), "agent-a1b2c3d4");
    const longName = herdrAgentNameFor("a".repeat(100), "a1b2c3d4");
    assert.match(longName, /^[a-z0-9_-]{1,32}$/);
    assert.ok(longName.endsWith("-a1b2c3d4"));
  });

  it("rejects parallel explicit duplicate names before the second launch", async () => {
    const testApi = (subagentsModule as any).__test__;
    const name = "parallel-name-test";
    let release!: () => void;
    const pendingLaunch = new Promise<void>((resolve) => { release = resolve; });
    let launches = 0;
    const launch = async (requestedName: string) => {
      const reservation = testApi.reserveSubagentName("worker", requestedName, new Set());
      if ("error" in reservation) throw new Error(reservation.error);
      try {
        launches++;
        await pendingLaunch;
        return reservation.name;
      } finally {
        testApi.reservedNames.delete(reservation.name);
      }
    };

    try {
      const first = launch(` ${name} `);
      const duplicate = launch(name);
      assert.equal(launches, 1);
      assert.ok(testApi.reservedNames.has(name));
      release();
      const results = await Promise.allSettled([first, duplicate]);
      assert.deepEqual(results[0], { status: "fulfilled", value: name });
      assert.equal(results[1].status, "rejected");
      if (results[1].status === "rejected") {
        assert.match(results[1].reason.message, /already in use.*subagent_message/);
      }
      assert.equal(testApi.reservedNames.has(name), false);
    } finally {
      release();
      testApi.reservedNames.delete(name);
    }
  });

  it("rejects registered names whether running or finished without overwriting them", () => {
    const testApi = (subagentsModule as any).__test__;
    const directory = mkdtempSync(join(tmpdir(), "subagent-names-"));
    const name = "registered-name-test";
    try {
      for (const running of [true, false]) {
        const entry = { sessionFile: join(directory, "original.jsonl"), sessionId: "original-session", running, runId: "original-run" };
        registerName(directory, name, entry);
        const result = testApi.reserveSubagentName("worker", name, new Set(Object.keys(readNameRegistry(directory))));
        assert.match(result.error, /already in use.*subagent_message/);
        assert.deepEqual(readNameRegistry(directory)[name], entry);
        assert.equal(testApi.reservedNames.has(name), false);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects names held by running agents even without a registry entry", () => {
    const testApi = (subagentsModule as any).__test__;
    const id = "running-name-test";
    testApi.runningSubagents.set(id, { id, name: id });
    try {
      const result = testApi.reserveSubagentName("worker", id, new Set());
      assert.match(result.error, /already in use/);
      assert.equal(testApi.reservedNames.has(id), false);
    } finally {
      testApi.runningSubagents.delete(id);
    }
  });

  it("keeps default names unique against explicit reservations and finished names", () => {
    const testApi = (subagentsModule as any).__test__;
    const base = "default-name-test";
    const registryNames = new Set([`${base}-2`]);
    try {
      assert.deepEqual(testApi.reserveSubagentName("worker", base, registryNames), { name: base });
      assert.deepEqual(testApi.reserveSubagentName(base, undefined, registryNames), { name: `${base}-3` });
      assert.deepEqual(testApi.reserveSubagentName(base, "  ", registryNames), { name: `${base}-4` });
    } finally {
      for (const name of [base, `${base}-3`, `${base}-4`]) testApi.reservedNames.delete(name);
    }
  });

  it("turns /subagent into a spawn request", async () => {
    const { api, registeredCommands, sentUserMessages } = registerSubagents();
    const command = registeredCommands.find((entry) => entry.name === "subagent");
    assert.ok(command);

    await command.handler("scout map the auth code", { ui: { notify() {} } });

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /agent: "scout"/);
    assert.match(sentUserMessages[0], /map the auth code/);
  });

  it("keeps the spawn and message tool contracts small and required", () => {
    const { api, registeredTools } = registerSubagents();
    const spawn = registeredTools.find((tool) => tool.name === "subagent");
    const message = registeredTools.find((tool) => tool.name === "subagent_message");
    assert.ok(spawn);
    assert.ok(message);
    assert.deepEqual([...spawn.parameters.required].sort(), ["agent", "task"]);
    assert.deepEqual([...message.parameters.required].sort(), ["message", "name"]);
    assert.ok(message.parameters.properties.intent, "intent is optional but supported");
    assert.deepEqual((message.parameters.properties.intent as any).anyOf.map((variant: any) => variant.const).sort(), ["context", "reply", "task"]);
    const testApi = (subagentsModule as any).__test__;
    assert.equal(testApi.finishedIntentError("context") !== null, true);
    assert.equal(testApi.finishedIntentError("reply") !== null, true);
    assert.equal(testApi.finishedIntentError("task"), null);
    assert.match(testApi.formatSubagentMessage("task", "Worker", "new assignment"), /Complete replacement assignment.*full current task/);
    assert.match(testApi.formatSubagentMessage(undefined, "Worker", "follow up", "old task"), /background context only, not an instruction to repeat it/);
    // Resume prompts are typed into a running pane, where `@path` is not expanded,
    // so a child without `read` (gh-scout, researcher) must still get the text.
    const followUp = testApi.formatSubagentMessage(undefined, "gh-scout", "check PR 12 reviews", "old task");
    const resumePrompt = testApi.formatResumeTaskPrompt(followUp);
    assert.match(resumePrompt, /Execute the follow-up below as your current assignment/);
    assert.match(resumePrompt, /Treat prior conversation as background only/);
    assert.ok(resumePrompt.endsWith(followUp), "follow-up text is inlined verbatim");
    assert.doesNotMatch(resumePrompt, /@"/, "no file reference the child may be unable to read");
  });

  it("rejects a spawn without an agent or a nonblank task", async () => {
    const { api, registeredTools } = registerSubagents();
    const spawn = registeredTools.find((tool) => tool.name === "subagent");
    const result = await spawn.execute("call-1", { name: "worker", task: "do it" });
    assert.equal(result.details.error, "agent required");

    const blankTask = await spawn.execute("call-2", { agent: "worker", task: " \t\n " });
    assert.equal(blankTask.details.error, "task required");
    assert.equal(blankTask.isError, true);
    assert.match(blankTask.content[0].text, /task is required and must not be blank/);
  });

  it("shows this run's tokens and cost in the compact widget after status and profile", () => {
    const testApi = (subagentsModule as any).__test__;
    const directory = mkdtempSync(join(tmpdir(), "subagent-widget-"));
    const sessionFile = join(directory, "session.jsonl");
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "usage", id: "usage-1", usage: { input: 12345, output: 6789, cost: { total: 0.123 } } }),
    ].join("\n"));

    try {
      const agent = widgetAgent({ name: "extension-readmes", sessionFile });
      testApi.refreshWidgetUsage(agent);
      const lines = testApi.renderSubagentWidgetLines([agent], 120, ansiTheme());
      assert.deepEqual([lines.length, lines.at(-1)], [2, ""]); // one row and the bottom spacer
      assert.ok(visibleWidth(lines[0]) <= 120);
      const plain = stripTerminalSequences(lines[0]);
      assert.match(plain, /^ \S worker  extension-readmes \[waiting\] +01:36  ↑12k ↓6\.8k  \$0\.1230$/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("delivers a steer to the named running subagent", () => {
    const testApi = (subagentsModule as any).__test__;
    const running = { id: "a1", name: "Worker", herdrAgentName: "sub-worker-a1" };
    let sentSurface = "";
    let sentText = "";

    const result = testApi.steerSubagent(running, "do this\nthen that", (surface: string, text: string) => {
      sentSurface = surface;
      sentText = text;
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(sentSurface, "sub-worker-a1");
    assert.equal(sentText, "do this then that");
  });

  it("reports a failed steer delivery", () => {
    const testApi = (subagentsModule as any).__test__;
    const result = testApi.steerSubagent(
      { id: "a1", name: "Worker", herdrAgentName: "sub-worker-a1" },
      "continue",
      () => { throw new Error("Herdr unavailable"); },
    );
    assert.match(result.error, /Failed to deliver message/);
  });

  it("delivers the full result to the model and keeps the transcript compact until expanded", () => {
    const testApi = (subagentsModule as any).__test__;
    const { api, sentMessages, registeredMessageRenderers } = registerSubagents();
    const body = "Sub-agent completed.\n\nFull result text.";
    testApi.sendSubagentResult(api, body, { name: "Worker", exitCode: 0, stats: { inputTokens: 5000 } });

    const sent = sentMessages[0];
    assert.equal(sent.message.display, true);
    assert.equal(sent.message.content, body);
    assert.deepEqual(sent.options, { triggerTurn: true, deliverAs: "steer" });
    assert.match(JSON.stringify(convertToLlm([{ role: "custom", ...sent.message, timestamp: 1 }])), /Full result text/);

    const renderer = registeredMessageRenderers.find((entry) => entry.name === "subagent_result");
    assert.ok(renderer);
    const message = { content: body, details: sent.message.details };
    const collapsed = renderer.renderer(message, { expanded: false }, createTheme()).render(80).join("\n");
    assert.ok(collapsed.includes("✓ <bold>Worker</bold> - completed"));
    assert.doesNotMatch(collapsed, /Full result text|tokens|cost/);

    const expanded = renderer.renderer(message, { expanded: true }, createTheme()).render(80).join("\n");
    assert.match(expanded, /Full result text/);
  });

  it("labels fresh and resumed results by outcome, keeping resume acknowledgement distinct", () => {
    const { api, registeredTools, registeredMessageRenderers } = registerSubagents();
    const renderer = registeredMessageRenderers.find((entry) => entry.name === "subagent_result");

    for (const resumed of [false, true]) {
      for (const failed of [false, true]) {
        const rendered = renderer.renderer({
          content: "result",
          details: {
            name: "Worker",
            resumed,
            exitCode: failed ? 1 : 0,
            ...(failed ? { errorMessage: "provider failed" } : {}),
          },
        }, { expanded: false }, createTheme()).render(80).join("\n");
        assert.ok(rendered.includes(`${failed ? "✗" : "✓"} <bold>Worker</bold> - ${failed ? "failed" : "completed"}`));
        assert.match(rendered, new RegExp(failed ? "toolErrorBg" : "toolSuccessBg"));
        assert.doesNotMatch(rendered, /- resumed/);
      }
    }

    const messageTool = registeredTools.find((tool) => tool.name === "subagent_message");
    const acknowledgement = messageTool.renderResult(
      { content: [{ type: "text", text: "Session resumed" }], details: { name: "Worker", status: "started" } },
      {},
      createTheme(),
    ).render(80).join("\n");
    assert.ok(acknowledgement.includes("⟳ <bold>Worker</bold> - resumed"));
  });

  it("does not present an interrupted checkpoint as a completed result", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation({
      exitCode: 1,
      elapsed: 10,
      summary: "intermediate checkpoint text must not leak",
      sessionFile: "/tmp/child.jsonl",
      handoffInterrupted: true,
      handoffPhase: "compacting",
    }, "Worker");
    assert.match(presentation, /NOT complete/);
    assert.doesNotMatch(presentation, /intermediate checkpoint text/);
  });
});

describe("subagent-status widget", () => {
  it("defaults status icons to portable Unicode and accepts only unicode, nerd, or ascii", () => {
    assert.equal(parseStatusConfig({ status: { enabled: true } }).icons, "unicode");
    assert.equal(parseStatusConfig({ status: { enabled: true, icons: "nerd" } }).icons, "nerd");
    assert.equal(parseStatusConfig({ status: { enabled: true, icons: "ascii" } }).icons, "ascii");
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, icons: "emoji" } }, "cfg.json"),
      /Invalid subagent status config in cfg\.json: status\.icons must be "unicode", "nerd", or "ascii"/,
    );
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, glyphs: "nerd" } }, "cfg.json"),
      /unsupported key\(s\): glyphs/,
    );
  });
});

describe("per-run widget usage", () => {
  const usageLine = (id: string, input: number, output: number, cost?: number) => JSON.stringify({
    type: "usage", id, usage: { input, output, ...(cost === undefined ? {} : { cost: { total: cost } }) },
  });

  it("counts only this run's Pi usage, excluding pre-run and inherited entries", () => {
    const directory = mkdtempSync(join(tmpdir(), "run-usage-"));
    const sessionFile = join(directory, "session.jsonl");
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", id: "header", inheritedEntryIds: ["inherited-1"] }),
      usageLine("before-run", 9000, 9000, 9),
      usageLine("inherited-1", 7000, 7000, 7),
      usageLine("run-1", 1200, 300, 0.5),
      usageLine("run-2", 34, 0, 0.25),
    ].join("\n"));
    try {
      assert.deepEqual(readRunUsage({ sessionFile, startEntryCount: 2 }).usage, {
        inputTokens: 1234, outputTokens: 300, cost: 0.75, costEstimated: false, costComplete: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports no Pi usage before the run records any, and a known zero as zero", () => {
    const directory = mkdtempSync(join(tmpdir(), "run-usage-"));
    const sessionFile = join(directory, "session.jsonl");
    writeFileSync(sessionFile, [JSON.stringify({ type: "session", id: "header" }), usageLine("old", 5, 5, 1)].join("\n"));
    try {
      assert.equal(readRunUsage({ sessionFile, startEntryCount: 2 }).usage, null);
      writeFileSync(sessionFile, [JSON.stringify({ type: "session", id: "header" }), usageLine("zero", 0, 0, 0)].join("\n"));
      assert.deepEqual(readRunUsage({ sessionFile, startEntryCount: 1 }).usage, {
        inputTokens: 0, outputTokens: 0, cost: 0, costEstimated: false, costComplete: true,
      });
      assert.equal(readRunUsage({ sessionFile: join(directory, "missing.jsonl"), startEntryCount: 0 }).usage, null);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps missing Pi cost unknown and marks partly costed runs incomplete", () => {
    const directory = mkdtempSync(join(tmpdir(), "run-usage-"));
    const sessionFile = join(directory, "session.jsonl");
    writeFileSync(sessionFile, usageLine("no-cost", 10, 2));
    try {
      assert.deepEqual(readRunUsage({ sessionFile, startEntryCount: 0 }).usage, {
        inputTokens: 10, outputTokens: 2, cost: null, costEstimated: false, costComplete: false,
      });
      writeFileSync(sessionFile, [usageLine("no-cost", 10, 2), usageLine("costed", 1, 1, 0.5)].join("\n"));
      assert.deepEqual(readRunUsage({ sessionFile, startEntryCount: 0 }).usage, {
        inputTokens: 11, outputTokens: 3, cost: 0.5, costEstimated: false, costComplete: false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats tool results and summaries without usage as no spend, but not assistant turns", () => {
    const directory = mkdtempSync(join(tmpdir(), "run-usage-"));
    const sessionFile = join(directory, "session.jsonl");
    const assistant = (id: string, usage?: Record<string, unknown>) => JSON.stringify({
      type: "message", id, message: {
        role: "assistant", model: "m",
        content: [{ type: "toolCall", id: `${id}-call`, name: "read", arguments: { path: "a.ts" } }],
        ...(usage ? { usage } : {}),
      },
    });
    const costed = (input: number, cost: number) => ({ input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10, cost: { total: cost } });
    const realistic = [
      JSON.stringify({ type: "session", id: "header" }),
      assistant("a1", costed(100, 0.25)),
      JSON.stringify({ type: "message", id: "r1", message: { role: "toolResult", toolCallId: "a1-call", toolName: "read", content: [{ type: "text", text: "ok" }] } }),
      JSON.stringify({ type: "compaction", id: "c1", summary: "earlier work", firstKeptEntryId: "a1", tokensBefore: 5000 }),
      JSON.stringify({ type: "branch_summary", id: "b1", summary: "abandoned branch", fromId: "a1" }),
      assistant("a2", costed(200, 0.5)),
    ];
    writeFileSync(sessionFile, realistic.join("\n"));
    try {
      assert.deepEqual(readRunUsage({ sessionFile, startEntryCount: 1 }).usage, {
        inputTokens: 300, outputTokens: 20, cost: 0.75, costEstimated: false, costComplete: true,
      });
      // Footer and result accounting keep their stricter default.
      assert.equal(summarizeSessionStats(sessionFile)?.costComplete, false);
      writeFileSync(sessionFile, [...realistic, assistant("a3")].join("\n"));
      assert.equal(readRunUsage({ sessionFile, startEntryCount: 1 }).usage?.costComplete, false, "assistant turn without usage");
      writeFileSync(sessionFile, [...realistic, assistant("a4", { input: 5, output: 5 })].join("\n"));
      assert.equal(readRunUsage({ sessionFile, startEntryCount: 1 }).usage?.costComplete, false, "usage without cost.total");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reuses the cached read until the transcript changes and keeps the last value through a partial write", () => {
    const directory = mkdtempSync(join(tmpdir(), "run-usage-"));
    const sessionFile = join(directory, "session.jsonl");
    writeFileSync(sessionFile, usageLine("a", 100, 10, 0.5));
    try {
      const first = readRunUsage({ sessionFile, startEntryCount: 0 });
      assert.equal(readRunUsage({ sessionFile, startEntryCount: 0 }, first), first);
      writeFileSync(sessionFile, [usageLine("a", 100, 10, 0.5), "{\"type\":\"usa"].join("\n"));
      const partial = readRunUsage({ sessionFile, startEntryCount: 0 }, first);
      assert.deepEqual(partial.usage, first.usage);
      writeFileSync(sessionFile, [usageLine("a", 100, 10, 0.5), usageLine("b", 50, 5, 0.25)].join("\n"));
      assert.equal(readRunUsage({ sessionFile, startEntryCount: 0 }, partial).usage?.inputTokens, 150);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads Claude live estimates without inventing token counts", () => {
    const directory = mkdtempSync(join(tmpdir(), "run-usage-"));
    const usageFile = join(directory, "child.usage.json");
    const sessionFile = join(directory, "not-pi.jsonl");
    try {
      assert.equal(readRunUsage({ sessionFile, startEntryCount: 0, usageFile }).usage, null);
      writeClaudeUsageSidecar(usageFile, {
        estimated: true, cost: 0.42, costAvailable: true, inputTokens: null, outputTokens: null,
        cacheReadTokens: null, cacheWriteTokens: null, sessionId: null,
      }, "statusline");
      assert.deepEqual(readRunUsage({ sessionFile, startEntryCount: 0, usageFile }).usage, {
        inputTokens: null, outputTokens: null, cost: 0.42, costEstimated: true, costComplete: true,
      });
      writeClaudeUsageSidecar(usageFile, {
        estimated: true, cost: null, costAvailable: false, inputTokens: 16, outputTokens: 9,
        cacheReadTokens: null, cacheWriteTokens: null, sessionId: null,
      });
      assert.deepEqual(readRunUsage({ sessionFile, startEntryCount: 0, usageFile }).usage, {
        inputTokens: 16, outputTokens: 9, cost: null, costEstimated: true, costComplete: false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("compact widget layout", () => {
  const knownUsage = { inputTokens: 12345, outputTokens: 6789, cost: 0.123, costEstimated: false, costComplete: true };
  const row = (overrides: Record<string, unknown> = {}) => ({
    profile: "worker", name: "WorkerName", kind: "active", activity: "reading files", elapsed: "01:36",
    usage: knownUsage, ...overrides,
  });
  const plainRows = (rows: any[], width: number, icons = "unicode") => {
    const lines = renderCompactWidgetRows(rows, width, ansiTheme(), icons, 0);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`);
    return lines.map((line: string) => stripTerminalSequences(line));
  };

  it("drops activity and metrics before profile, name, or status on narrow terminals", () => {
    assert.match(plainRows([row()], 120)[0], /^ ⠋ worker  WorkerName · reading files +01:36  ↑12k ↓6\.8k  \$0\.1230$/);
    assert.match(plainRows([row()], 40)[0], /^ ⠋ worker  WorkerName \[active\] +01:36$/);
    const tiny = plainRows([row()], 26)[0];
    assert.match(tiny, /^ ⠋ worker  Wor\.\.\. \[active\]$/);
    assert.doesNotMatch(tiny, /01:36|↑|\$/);
  });

  it("keeps the full state and a useful name ahead of a long profile badge", () => {
    const researcher = (overrides: Record<string, unknown> = {}) => row({ profile: "researcher", ...overrides });
    // Room to spare: full badge, glyph, name and state.
    assert.match(plainRows([researcher()], 34)[0], /^ ⠋ researcher  WorkerName \[active\]/);
    for (const kind of ["active", "starting", "stalled", "waiting"]) {
      for (const width of [20, 22, 24, 26, 28]) {
        const line = plainRows([researcher({ kind })], width)[0];
        assert.ok(line.endsWith(` [${kind}]`), `width ${width} ${kind}: ${JSON.stringify(line)}`);
        const name = line.match(/(\S+) \S+$/)![1];
        assert.ok(visibleWidth(name) >= 6, `width ${width} ${kind}: name ${JSON.stringify(name)}`);
      }
    }
    assert.match(plainRows([researcher()], 20)[0], /^⠋ Worker\.\.\. \[active\]$/);
    assert.match(plainRows([researcher()], 22)[0], /^⠋ WorkerName \[active\]/);
    assert.match(plainRows([researcher({ kind: "starting" })], 20)[0], /^⠋ Work\.\.\. \[starting\]$/);
    // Without room for the full badge, the name comes first and the badge is shortened.
    assert.match(plainRows([researcher()], 29)[0], /^ ⠋ re\.\.\.  WorkerName \[active\]$/);
    // Wide names keep a useful prefix.
    assert.match(plainRows([researcher({ name: "日本語の名前です" })], 20)[0], /^⠋ 日本語\.\.\. \[active\]$/);
    // Impossible widths degrade deterministically, state first.
    assert.equal(plainRows([researcher({ kind: "starting" })], 15)[0], "W... [starting]");
    assert.equal(plainRows([researcher({ kind: "starting" })], 10)[0], "[starting]");
    assert.equal(plainRows([researcher({ kind: "starting" })], 5)[0], "[s...");
  });

  it("strips terminal controls from agent text and keeps wide text within the width", () => {
    const hostile = row({ profile: "日本語", name: "\x1b[31mEvil\x1b[0m\nName", activity: "\x1b]0;pwned\x07tool\tcall" });
    for (const width of [60, 20, 12, 5]) {
      const raw = renderCompactWidgetRows([hostile], width, ansiTheme(), "unicode", 0)[0];
      assert.ok(visibleWidth(raw) <= width, `width ${width}: ${JSON.stringify(raw)}`);
      assert.doesNotMatch(raw, /\x1b\]|\x1b\[31m|\x07|[\n\t]/);
    }
    assert.match(stripTerminalSequences(renderCompactWidgetRows([hostile], 80, ansiTheme(), "unicode", 0)[0]), /^ ⠋ 日本語  Evil Name · tool call +01:36/);
  });

  it("draws status glyphs from the configured icon set", () => {
    const kinds = ["active", "running", "waiting", "starting", "stalled"].map((kind) => row({ kind, activity: "tool call" }));
    const privateUse = /[\u{F0000}-\u{FFFFD}\u{E000}-\u{F8FF}]/u;

    const unicode = plainRows(kinds, 120, "unicode");
    assert.deepEqual(unicode.map((line) => line.split(" ")[1]), ["⠋", "⠋", "○", "⠋", "⟳"]);
    for (const line of unicode) assert.doesNotMatch(line, privateUse);

    const ascii = plainRows(kinds, 120, "ascii");
    assert.deepEqual(ascii.map((line) => line.split(" ")[1]), ["|", "|", "o", "|", "!"]);
    assert.match(ascii[0], /WorkerName - tool call +01:36  in 12k out 6\.8k  \$0\.1230$/);
    assert.match(ascii[1], /WorkerName \[running\] - tool call +01:36/);
    for (const line of [...ascii, ...plainRows(kinds, 24, "ascii")]) assert.match(line, /^[\x20-\x7e]*$/);

    const nerd = plainRows(kinds, 120, "nerd").map((line) => line.split(" ")[1].codePointAt(0)!);
    for (const active of nerd.slice(0, 2)) assert.ok(active >= 0xF0A9E && active <= 0xF0AA5, active.toString(16));
    assert.deepEqual(nerd.slice(2), [0xF03E5, 0xF0A9E, 0xF0159]);
  });

  it("styles the widget through the theme Pi passes to the widget factory", () => {
    const testApi = (subagentsModule as any).__test__;
    const agent = widgetAgent();
    const forwarded = ansiTheme();
    const component = testApi.subagentWidgetFactory(() => [agent])(undefined, forwarded);
    assert.ok(component.render(100).length > 0);
    assert.ok(forwarded.calls.length > 0, "the factory theme was not used");

    const direct = ansiTheme();
    const output = testApi.renderSubagentWidgetLines([agent], 100, direct).join("\n");
    assert.doesNotMatch(output, /\x1b\[38;2;/, "the widget uses hard-coded colors");
    assert.ok(direct.calls.length > 0, "the widget ignored the theme");

    const theme = ansiTheme();
    renderCompactWidgetRows([row({ kind: "stalled" })], 100, theme, "unicode");
    const badge: any = theme.calls.find((call) => call.method === "style");
    assert.equal(badge.text, " ⟳ worker ");
    assert.equal(typeof badge.color.bg.token, "string", "badge background comes from theme.colors");
    assert.deepEqual(badge.color.fg, { kind: "rgb", r: 0, g: 0, b: 0 }, "dark text on a light badge");
    assert.equal(badge.color.bold, true);
    assert.ok(theme.calls.some((call) => call.method === "fg" && call.color === "error" && call.text === "[stalled]"));
  });

  it("leaves one blank line below a nonempty widget, and none otherwise", () => {
    const testApi = (subagentsModule as any).__test__;
    const agents = [widgetAgent(), widgetAgent({ id: "agent-2", name: "Second" })];
    const direct = (list: any[], width: number) => testApi.renderSubagentWidgetLines(list, width, ansiTheme());
    const mounted = (list: any[], width: number) => {
      const component = testApi.subagentWidgetFactory(() => list)(undefined, ansiTheme());
      try { return component.render(width); } finally { component.dispose?.(); }
    };
    for (const [label, render] of [["wrapper", direct], ["mounted factory", mounted]] as const) {
      for (const list of [agents.slice(0, 1), agents]) {
        const lines = render(list, 100);
        assert.equal(lines.length, list.length + 1, `${label}: ${JSON.stringify(lines)}`);
        assert.equal(lines.at(-1), "", `${label}: last line is not blank`);
        for (const line of lines.slice(0, -1)) assert.match(stripTerminalSequences(line), /\S/, `${label}: blank data row`);
      }
      assert.deepEqual(render([], 100), [], `${label}: phantom spacer without agents`);
      assert.deepEqual(render(agents, 0), [], `${label}: spacer at zero width`);
      assert.deepEqual(render(agents, -5), [], `${label}: spacer at negative width`);
    }
    assert.equal(renderCompactWidgetRows([row()], 100, ansiTheme(), "unicode").length, 1, "data rows stay free of the spacer");
  });

  describe("spinner animation in the mounted widget", () => {
    /** Mount the widget the way Pi does, with a TUI that renders it on request. */
    function mount(getAgents: () => any[]) {
      const testApi = (subagentsModule as any).__test__;
      const glyphs: string[] = [];
      let component: any;
      const tui = {
        requestRender() {
          const lines = component.render(100).map((line: string) => stripTerminalSequences(line));
          glyphs.push(lines[0]?.split(" ")[1] ?? "");
        },
      };
      component = testApi.subagentWidgetFactory(getAgents)(tui, ansiTheme());
      component.render(100);
      return { component, glyphs };
    }
    /** Advance the fake clock in small steps so timers set by earlier timers also fire. */
    const advance = (t: any, ms: number) => { for (let i = 0; i < ms; i += 10) t.mock.timers.tick(10); };
    // Claude runs always render as "running", whatever the local status config says.
    const runningAgent = () => widgetAgent({}, { source: "claude" });

    it("redraws a running agent several times a second with changing frames, without reading usage", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
      const agent: any = runningAgent();
      const { component, glyphs } = mount(() => [agent]);
      advance(t, 1000);
      assert.ok(glyphs.length >= 5, `only ${glyphs.length} redraws in one second`);
      assert.ok(new Set(glyphs).size >= 3, `frames did not change: ${JSON.stringify(glyphs)}`);
      assert.equal(agent.usageCheckedAt, undefined, "animation must not re-read usage");
      component.dispose();
    });

    it("stops redrawing once disposed", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
      const { component, glyphs } = mount(() => [runningAgent()]);
      advance(t, 500);
      assert.ok(glyphs.length > 0);
      component.dispose();
      component.dispose();
      const before = glyphs.length;
      advance(t, 5000);
      assert.equal(glyphs.length, before);
    });

    it("stops redrawing when no agent is left to animate", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
      let agents: any[] = [runningAgent()];
      const { component, glyphs } = mount(() => agents);
      advance(t, 500);
      agents = [];
      advance(t, 500);
      const before = glyphs.length;
      advance(t, 5000);
      assert.equal(glyphs.length, before);
      component.dispose();
    });

    it("renders without a TUI and never schedules a redraw", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
      const testApi = (subagentsModule as any).__test__;
      const component = testApi.subagentWidgetFactory(() => [runningAgent()])(undefined, ansiTheme());
      assert.ok(component.render(100).length > 0);
      advance(t, 5000);
      component.dispose();
    });
  });

  it("re-reads a running agent's usage at most every five seconds", () => {
    const testApi = (subagentsModule as any).__test__;
    const directory = mkdtempSync(join(tmpdir(), "subagent-widget-"));
    const sessionFile = join(directory, "session.jsonl");
    const line = (id: string, input: number) => JSON.stringify({ type: "usage", id, usage: { input, output: 1, cost: { total: 0.5 } } });
    writeFileSync(sessionFile, line("a", 100));
    try {
      const agent: any = widgetAgent({ sessionFile });
      testApi.refreshWidgetUsage(agent, 10_000);
      assert.equal(agent.usage.usage.inputTokens, 100);
      writeFileSync(sessionFile, [line("a", 100), line("b", 50)].join("\n"));
      testApi.refreshWidgetUsage(agent, 14_999);
      assert.equal(agent.usage.usage.inputTokens, 100);
      testApi.refreshWidgetUsage(agent, 15_000);
      assert.equal(agent.usage.usage.inputTokens, 150);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("registers subagent display only under the existing subagent-status widget", () => {
    const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "../pi-extension/subagents");
    const keys = ["index.ts", "widget.ts"].flatMap((file) =>
      [...readFileSync(join(sourceDir, file), "utf8").matchAll(/setWidget\(\s*("[^"]*"|'[^']*'|[^,)]+)/g)].map((match) => match[1]));
    assert.ok(keys.length > 0);
    assert.deepEqual([...new Set(keys)], ['"subagent-status"']);
  });

  it("shows zero usage as zero, marks estimates and gaps, and never shows unknown cost as $0", () => {
    const usage = (overrides: Record<string, unknown>) => ({ ...knownUsage, ...overrides });
    const tail = (u: any) => plainRows([row({ usage: u, activity: null })], 100)[0].replace(/^.*01:36/, "01:36");
    assert.equal(tail(usage({ inputTokens: 0, outputTokens: 0, cost: 0 })), "01:36  ↑0 ↓0  $0.0000");
    assert.equal(tail(usage({ inputTokens: null, outputTokens: null, cost: 0.42, costEstimated: true })), "01:36  ~$0.4200");
    assert.equal(tail(usage({ cost: null, costComplete: false })), "01:36  ↑12k ↓6.8k");
    assert.equal(tail(usage({ cost: 0.5, costComplete: false })), "01:36  ↑12k ↓6.8k  $0.5000+?");
    assert.equal(tail(null), "01:36");
  });

  it("truncates names and activity without inserting style resets", () => {
    for (const icons of ["unicode", "ascii"]) {
      const theme = ansiTheme();
      const long = row({ name: "a-very-long-agent-name", activity: "editing a long file name", usage: null });
      renderCompactWidgetRows([long], 30, theme, icons); // name truncated
      renderCompactWidgetRows([long], 64, theme, icons); // activity truncated
      const truncated = theme.calls.filter((call) => call.method === "fg" && /…|\.\.\./.test(call.text));
      assert.equal(truncated.length, 2, icons);
      for (const call of truncated) assert.doesNotMatch(call.text, /\x1b/, `${icons}: ${JSON.stringify(call.text)}`);
    }
  });
});
