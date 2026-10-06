import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import { buildPromptAgentArgs } from "../pi-extension/subagents/herdr.ts";
import { finishRegisteredRun, readNameRegistry, registerName } from "../pi-extension/subagents/session.ts";
import {
  createSubagentActivityRecorder,
  progressIndicators,
  readSubagentActivityFile,
  type SubagentActivityState,
} from "../pi-extension/subagents/activity.ts";
import { registerSubagentProgress, replayTodoProgress, summarizeTodoDetails } from "../pi-extension/subagents/progress.ts";

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

function registerSubagents() {
  const harness = createMockExtensionApi();
  (subagentsModule as any).default(harness.api);
  return harness;
}

function createTheme() {
  return {
    fg(_color: string, text: string) { return text; },
    bg(color: string, text: string) { return `<${color}>${text}</${color}>`; },
    bold(text: string) { return `<bold>${text}</bold>`; },
  };
}

describe("compact subagent progress", () => {
  it("validates optional count summaries and keeps old activity files readable", () => {
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
      writeFileSync(file, JSON.stringify({ ...legacy, progress: { updatedAt: 10, activeChildren: 2, todos: { completed: 1, total: 3 } } }));
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

  it("summarizes only known, non-deleted todo tasks and clears empty snapshots", () => {
    assert.deepEqual(summarizeTodoDetails({ tasks: [
      { status: "completed" }, { status: "pending" }, { status: "in_progress" }, { status: "deleted" },
    ] }), { completed: 1, total: 3 });
    assert.deepEqual(summarizeTodoDetails({ tasks: [{ status: "deleted" }] }), { completed: 0, total: 0 });
    assert.deepEqual(summarizeTodoDetails({ tasks: [] }), { completed: 0, total: 0 });
    assert.equal(summarizeTodoDetails({ tasks: [{ status: "mystery" }] }), undefined);
    assert.equal(summarizeTodoDetails({ other: [] }), undefined);
    assert.equal(summarizeTodoDetails({ tasks: [null] }), undefined);
    assert.deepEqual(replayTodoProgress([
      { type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [{ status: "completed" }] } } },
      { type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [{ status: "deleted" }] } } },
    ]), { completed: 0, total: 0 });
    assert.equal(replayTodoProgress([
      { type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [{ status: "completed" }] } } },
      { type: "message", message: { role: "toolResult", toolName: "todo", details: {} } },
    ]), undefined);
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
      recorder.reportProgress(2, { completed: 1, total: 4 });
      const after = readSubagentActivityFile(file, "run-1");
      assert.equal(after.ok, true);
      if (!after.ok) return;
      assert.equal(after.activity.updatedAt, before.activity.updatedAt);
      assert.equal(after.activity.sequence, before.activity.sequence);
      assert.equal(after.activity.phase, before.activity.phase);
      assert.deepEqual(progressIndicators(after.activity.progress, 200), ["↳ 2", "● 1/4"]);
      assert.deepEqual(progressIndicators(after.activity.progress, 10_201), []);
      assert.deepEqual(progressIndicators({ updatedAt: 300, activeChildren: 1 }, 200), []);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("replays branches, bridges tool results, and clears the heartbeat interval at shutdown", () => {
    const handlers = new Map<string, Function[]>();
    const api = { on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); } } as any;
    const reports: Array<{ children: number; todos?: unknown }> = [];
    const recorder = { reportProgress(children: number, todos?: unknown) { reports.push({ children, todos }); } } as any;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let timerCallback: (() => void) | undefined;
    let cleared = 0;
    (globalThis as any).setInterval = (callback: () => void) => { timerCallback = callback; return 123; };
    (globalThis as any).clearInterval = (timer: unknown) => { if (timer === 123) cleared++; };
    try {
      registerSubagentProgress(api, recorder, () => 2);
      const ctx = { sessionManager: { getBranch: () => [
        { type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [{ status: "completed" }, { status: "pending" }] } } },
      ] } };
      handlers.get("session_start")![0]({}, ctx);
      assert.deepEqual(reports.at(-1), { children: 2, todos: { completed: 1, total: 2 } });
      handlers.get("session_tree")![0]({}, { sessionManager: { getBranch: () => [] } });
      assert.deepEqual(reports.at(-1), { children: 2, todos: undefined });
      handlers.get("tool_execution_end")![0]({ toolName: "todo", result: { details: { tasks: [{ status: "completed" }] } } });
      assert.deepEqual(reports.at(-1), { children: 2, todos: { completed: 1, total: 1 } });
      timerCallback!();
      assert.equal(reports.length, 4);
      // A repeated session_start replaces, rather than leaks, the old interval.
      handlers.get("session_start")![0]({}, ctx);
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

  it("renders fresh indicators only when both fit without displacing status or identity", () => {
    const testApi = (subagentsModule as any).__test__;
    const now = Date.now();
    const base = {
      id: "widget-progress", name: "WorkerName", agent: "worker", startTime: now - 1000,
      startEntryCount: 0, sessionFile: "", statusState: {
        source: "pi", startTimeMs: now - 1000, firstObservationAtMs: now - 1000,
        lastActivityAtMs: now - 1000, lastActivitySequence: 1, localOverrideAtMs: null,
        localOverrideSequence: null, activeNow: true, activeSinceMs: now - 1000,
        activeScope: "agent", waitingSinceMs: null, phase: "active", latestEvent: null,
        activityLabel: null, snapshotState: "present", snapshotProblemSinceMs: null,
        snapshotError: null, currentKind: "active",
      },
      activityRead: { ok: true }, activity: { phase: "active", progress: { updatedAt: now, activeChildren: 2, todos: { completed: 1, total: 3 } } },
    };
    const wide = testApi.renderSubagentWidgetLines([base], 100).join("\n");
    assert.match(wide, /WorkerName/);
    assert.match(wide, /↳ 2/);
    assert.match(wide, /● 1\/3/);
    assert.match(wide, /active/);
    const narrow = testApi.renderSubagentWidgetLines([base], 60).join("\n");
    assert.match(narrow, /WorkerName/);
    assert.match(narrow, /↳ 2/);
    assert.doesNotMatch(narrow, /●/);
    assert.match(narrow, /active/);
    const stale = { ...base, activity: { phase: "active", progress: { updatedAt: now - 20_000, activeChildren: 2, todos: { completed: 1, total: 3 } } } };
    assert.doesNotMatch(testApi.renderSubagentWidgetLines([stale], 100).join("\n"), /↳|●/);
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

  it("loads bundled community extensions and grants workers the todo tool", () => {
    const testApi = (subagentsModule as any).__test__;
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const entry of manifest.pi.extensions) {
      assert.ok(existsSync(resolve(root, entry)), `Missing extension: ${entry}`);
    }
    for (const [tool, entry] of Object.entries({
      todo: "@juicesharp/rpiv-todo/index.ts",
      ask_user_question: "@juicesharp/rpiv-ask-user-question/index.ts",
      web_search: "pi-web-access/dist/index.js",
      source_check: "pi-web-access/dist/index.js",
      fetch_content: "pi-web-access/dist/index.js",
      get_search_content: "pi-web-access/dist/index.js",
    })) {
      assert.equal(testApi.getToolExtensionPath(tool), join(root, "node_modules", entry));
    }
    const worker = readFileSync(join(root, "extensions/interactive-subagents/agents/worker.md"), "utf8");
    assert.match(worker, /^tools:.*\btodo\b/m);
  });

  it("passes Claude auto-exit behavior to the stop hook", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.deepEqual(testApi.buildClaudeLaunchEnv("/tmp/claude-done", true), {
      PI_CLAUDE_SENTINEL: "/tmp/claude-done",
      PI_CLAUDE_AUTO_EXIT: "1",
      PI_CLAUDE_ASK_FILE: "/tmp/claude-done.ask",
      PI_CLAUDE_PENDING_FILE: "/tmp/claude-done.pending",
    });
    assert.deepEqual(testApi.buildClaudeLaunchEnv("/tmp/claude-done", false), {
      PI_CLAUDE_SENTINEL: "/tmp/claude-done",
      PI_CLAUDE_AUTO_EXIT: "0",
      PI_CLAUDE_ASK_FILE: "/tmp/claude-done.ask",
      PI_CLAUDE_PENDING_FILE: "/tmp/claude-done.pending",
    });
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
      }), [
        "--permission-mode", "auto",
        "--plugin-dir", "/claude-plugin",
        "--allowedTools", "mcp__plugin_pi-auto-exit_pi__ask_question",
        "--model", "claude-opus-5-5",
        "--effort", "high",
        "--append-system-prompt-file", systemPromptFile,
      ]);
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
      const output = execFileSync("uv", ["run", "--no-project", "python", server], {
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
    try {
      const testApi = (subagentsModule as any).__test__;
      testApi.deliverPendingQuestion({
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
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps an auto-exit Claude worker open while its question is pending", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-question-pending-"));
    const transcript = join(directory, "transcript.jsonl");
    const sentinel = join(directory, "done");
    const pending = `${sentinel}.pending`;
    const hook = resolve(dirname(fileURLToPath(import.meta.url)), "../pi-extension/subagents/plugin/hooks/on-stop.sh");
    writeFileSync(transcript, [
      JSON.stringify({ type: "user", message: { role: "user", content: "initial task" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "parent reply" } }),
    ].join("\n"));
    writeFileSync(pending, "q1");
    try {
      execFileSync("bash", [hook], {
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
      execFileSync("uv", ["run", "--no-project", "python", hook], {
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

  it("returns Claude results after parent steering in auto-exit sessions", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-stop-hook-"));
    const transcript = join(directory, "transcript.jsonl");
    const sentinel = join(directory, "done");
    const hook = resolve(dirname(fileURLToPath(import.meta.url)), "../pi-extension/subagents/plugin/hooks/on-stop.sh");
    writeFileSync(transcript, [
      JSON.stringify({ type: "user", message: { role: "user", content: "initial task" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "working" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "parent steering" } }),
    ].join("\n"));

    try {
      execFileSync("bash", [hook], {
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
    const hook = resolve(dirname(fileURLToPath(import.meta.url)), "../pi-extension/subagents/plugin/hooks/on-stop.sh");
    writeFileSync(transcript, [
      JSON.stringify({ type: "user", message: { role: "user", content: "initial task" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "follow-up" } }),
    ].join("\n"));

    try {
      execFileSync("bash", [hook], {
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
    const resumePrompt = testApi.formatResumeTaskPrompt("C:\\tasks\\latest review.md");
    assert.match(resumePrompt, /Read and execute the instructions.*current follow-up assignment/);
    assert.match(resumePrompt, /Treat prior conversation as background only/);
    assert.match(resumePrompt, /@"C:\\tasks\\latest review\.md"/);
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

  it("keeps usage metrics out of the compact widget while preserving status and profile", () => {
    const testApi = (subagentsModule as any).__test__;
    const directory = mkdtempSync(join(tmpdir(), "subagent-widget-"));
    const sessionFile = join(directory, "session.jsonl");
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "usage", id: "usage-1", usage: { input: 12345, output: 6789, cost: { total: 0.123 } } }),
      JSON.stringify({ type: "compaction", id: "compaction-1" }),
    ].join("\n"));

    try {
      const now = Date.now();
      const rendered = testApi.renderSubagentWidgetLines([{
        id: "widget-test",
        name: "extension-readmes",
        agent: "worker",
        startTime: now - 96_000,
        startEntryCount: 0,
        sessionFile,
        statusState: {
          source: "pi",
          startTimeMs: now - 96_000,
          firstObservationAtMs: now - 20_000,
          lastActivityAtMs: now - 8_000,
          lastActivitySequence: 1,
          localOverrideAtMs: null,
          localOverrideSequence: null,
          activeNow: false,
          activeSinceMs: null,
          activeScope: null,
          waitingSinceMs: now - 8_000,
          phase: "waiting",
          latestEvent: null,
          activityLabel: null,
          snapshotState: "present",
          snapshotProblemSinceMs: null,
          snapshotError: null,
          currentKind: "waiting",
        },
      }], 120).join("\n");

      assert.match(rendered, /extension-readmes \(worker\)/);
      assert.match(rendered, /\d\d:\d\d/);
      assert.match(rendered, /waiting 8s/);
      assert.doesNotMatch(rendered, /tokens|cost|compaction|12\.3k|6\.8k|0\.123/i);
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
