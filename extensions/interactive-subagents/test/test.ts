import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

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
  });

  it("rejects a spawn without an agent", async () => {
    const { api, registeredTools } = registerSubagents();
    const spawn = registeredTools.find((tool) => tool.name === "subagent");
    const result = await spawn.execute("call-1", { name: "worker", task: "do it" });
    assert.equal(result.details.error, "agent required");
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
