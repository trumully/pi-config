import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import { finishRegisteredRun, readNameRegistry, registerName } from "../pi-extension/subagents/session.ts";

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
