import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HerdrCoreBackend, type CoreCommands } from "../pi-extension/subagents/herdr-core.ts";

function notFound(): never {
  throw { stderr: JSON.stringify({ error: { kind: "not_found", message: "not found" } }) };
}

function harness(sync: CoreCommands["sync"] = () => "{}") {
  const calls: string[][] = [];
  let launch: any;
  let descriptor = "";
  const backend = new HerdrCoreBackend({
    sync(args) { calls.push(args); return sync(args); },
    async async(args) {
      calls.push(args);
      if (args[0] === "get") return sync(args);
      if (args[0] !== "run") return JSON.stringify({ terminals: [] });
      descriptor = args.at(-1)!;
      launch = JSON.parse(readFileSync(descriptor, "utf8"));
      return JSON.stringify({ address: "t42", name: args[args.indexOf("--name") + 1], state: "live" });
    },
  });
  return { backend, calls, get launch() { return launch; }, get descriptor() { return descriptor; } };
}

describe("herdr-app core backend", () => {
  it("reserves unprefixed unique names and preserves explicitly supplied legacy names", () => {
    const h = harness();
    const first = h.backend.createSurface("Scout").surface;
    const second = h.backend.createSurface("Scout").surface;
    const legacy = h.backend.createSurface("Scout", { runName: "sub-scout-existing" }).surface;
    try {
      assert.match(first, /^scout-[a-f0-9]{8}$/);
      assert.match(second, /^scout-[a-f0-9]{8}$/);
      assert.notEqual(first, second);
      assert.equal(legacy, "sub-scout-existing");
    } finally {
      for (const surface of [first, second, legacy]) h.backend.close(surface);
    }
    assert.deepEqual(h.calls, []);
  });

  for (const kind of ["pi", "claude"] as const) {
    it(`launches ${kind} with argv, environment, initial work and no startup send`, async () => {
      const h = harness(() => notFound());
      const task = `Inspect \"quoted\" $HOME & Unicode 日本語\n${"x".repeat(40_000)}`;
      const { surface } = h.backend.createSurface("child", {
        runName: "child-123", cwd: "C:/a folder/repo", env: { PI_SUBAGENT_SESSION: "C:/a folder/run.jsonl", EXAMPLE: "a=b; $HOME" },
      });
      assert.equal(surface, "child-123");
      assert.deepEqual(h.calls, [], "reserving an identity must not submit a launch");
      const originalArgvEntry = process.argv[1];
      if (kind === "pi") {
        process.argv[1] = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");
      }
      try {
        await h.backend.startAgent(surface, kind, surface, ["--model", "profile-model"], [task]);
        const args = h.calls[0];
        assert.equal(args[0], "run");
        assert.ok(args.includes("--bg"));
        assert.ok(args.includes("--no-notify"), "the plugin owns completion delivery");
        assert.ok(args.includes("--outlive-parent"));
        assert.ok(args.includes("pi.subagent=child-123"));
        assert.ok(args.includes("pi.session=C:/a folder/run.jsonl"));
        assert.equal(args[args.indexOf("--cwd") + 1], "C:/a folder/repo");
        assert.ok(args.join(" ").length < 4_000, "large tasks belong in the descriptor, not the Windows command line");
        assert.equal(h.launch.env.EXAMPLE, "a=b; $HOME");
        if (kind === "pi") {
          assert.deepEqual(h.launch.argv.slice(-4), ["--model", "profile-model", "--", task]);
          assert.equal(h.launch.moduleEntryPoint, process.argv[1]);
        } else {
          assert.equal(h.launch.argv[0], "claude");
          assert.deepEqual(h.launch.argv.slice(1, 3), ["--model", "profile-model"]);
          const taskFile = join(h.descriptor, "..", "task.md");
          assert.equal(readFileSync(taskFile, "utf8"), task);
          assert.ok(h.launch.argv.at(-1).includes("task.md"));
          assert.ok(h.launch.argv.join(" ").length < 8_000);
        }
        assert.ok(!h.calls.some((args) => args[0] === "send"));
      } finally {
        process.argv[1] = originalArgvEntry;
        h.backend.close(surface);
      }
      assert.equal(existsSync(h.descriptor), false);
    });
  }

  it("passes skills and task as separate initial Pi messages", async () => {
    const h = harness(() => notFound());
    const { surface } = h.backend.createSurface("skills");
    try {
      await h.backend.startAgent(surface, "pi", surface, [], ["/skill:tdd", "Do the task"]);
      assert.deepEqual(h.launch.argv.slice(-3), ["--", "/skill:tdd", "Do the task"]);
    } finally { h.backend.close(surface); }
  });

  it("steers without bypassing blocked-state protections", () => {
    const h = harness(() => { throw { stderr: '{"error":{"kind":"blocked","message":"permission needed"}}' }; });
    assert.throws(() => h.backend.prompt("child", "continue"), /permission needed/);
    assert.deepEqual(h.calls, [["send", "--json", "child", "continue"]]);
  });

  it("recovers a saved prefixed name by its own label, even without OSC status yet", async () => {
    const h = harness(() => JSON.stringify({ address: "t42", name: "sub-child-123", state: "live", labels: { "pi.subagent": "sub-child-123", "pi.session": "/run.jsonl" } }));
    assert.deepEqual(await h.backend.getRunningSurface("sub-child-123", { surface: "sub-child-123", sessionFile: "/run.jsonl" }), { surface: "sub-child-123" });
  });

  it("does not treat core failures or transcript mismatches as confirmed absence", async () => {
    const unavailable = harness(() => { throw new Error("connection lost"); });
    await assert.rejects(unavailable.backend.getRunningSurface("child"), /connection lost/);
    const mismatch = harness(() => JSON.stringify({ address: "t42", name: "child", state: "live", labels: { "pi.subagent": "child", "pi.session": "/other.jsonl" } }));
    await assert.rejects(mismatch.backend.getRunningSurface("child", { surface: "child", sessionFile: "/run.jsonl" }), /mismatch/);
    const unconfirmed = harness(() => JSON.stringify({ address: "t42", name: "child", state: "live", labels: {} }));
    await assert.rejects(unconfirmed.backend.getRunningSurface("child"), /Cannot confirm/);
  });

  it("recognizes finished and missing terminals as absent, but rejects legacy pane recovery", async () => {
    const h = harness(() => notFound());
    assert.equal(await h.backend.getRunningSurface("child", { surface: "child", sessionFile: "/run.jsonl" }), null);
    await assert.rejects(h.backend.getRunningSurface("child", { surface: "w1:p2", sessionFile: "/run.jsonl" }), /legacy Herdr/);
    const finished = harness(() => JSON.stringify({ address: "t42", name: "child", state: "finished" }));
    assert.equal(await finished.backend.getRunningSurface("child"), null);
  });

  it("closes by immutable address, and releases unused reservations without CLI calls", () => {
    const h = harness((args) => args[0] === "get" ? JSON.stringify({ address: "t42", name: "child", state: "live", labels: { "pi.subagent": "child" } }) : "{}");
    const { surface } = h.backend.createSurface("unused");
    h.backend.close(surface);
    assert.deepEqual(h.calls, []);
    h.backend.close("child");
    assert.deepEqual(h.calls, [["get", "child", "--json"], ["kill", "t42", "--json"], ["rm", "t42", "--json"]]);
  });

  it("refuses to close a terminal whose name was reused by unrelated work", () => {
    const h = harness(() => JSON.stringify({ address: "t43", name: "child", state: "live", labels: {} }));
    assert.throws(() => h.backend.close("child"), /Refusing to close unowned/);
    assert.deepEqual(h.calls, [["get", "child", "--json"]]);
  });

  it("imports Pi entry points in-process with large initial argv and the child environment", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-hc-import-test-"));
    const entry = join(directory, "entry.mjs");
    const launchDir = mkdtempSync(join(tmpdir(), "pi-hc-descriptor-test-"));
    const descriptor = join(launchDir, "launch.json");
    const literal = "x".repeat(40_000);
    const runner = fileURLToPath(new URL("../pi-extension/subagents/herdr-core-launcher.mjs", import.meta.url));
    writeFileSync(entry, "console.log(JSON.stringify({args:process.argv.slice(2),value:process.env.PI_HC_TEST}))");
    writeFileSync(descriptor, JSON.stringify({ argv: [process.execPath, entry, literal], env: { PI_HC_TEST: "child" }, moduleEntryPoint: entry }));
    try {
      const result = JSON.parse(execFileSync(process.execPath, [runner, descriptor], { encoding: "utf8" }));
      assert.deepEqual(result, { args: [literal], value: "child" });
      assert.equal(existsSync(launchDir), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(launchDir, { recursive: true, force: true });
    }
  });

  it("launcher preserves literal argv and env, deletes its descriptor, and returns the child exit code", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-hc-launcher-test-"));
    const descriptor = join(dir, "launch.json");
    const runner = fileURLToPath(new URL("../pi-extension/subagents/herdr-core-launcher.mjs", import.meta.url));
    const literal = 'quotes " & $HOME 日本語';
    writeFileSync(descriptor, JSON.stringify({
      argv: [process.execPath, "-e", "console.log(JSON.stringify({args:process.argv.slice(1),value:process.env.PI_HC_TEST}));process.exit(7)", literal],
      env: { PI_HC_TEST: literal },
    }));
    try {
      assert.throws(() => execFileSync(process.execPath, [runner, descriptor], { encoding: "utf8" }), (error: any) => {
        assert.equal(error.status, 7);
        assert.deepEqual(JSON.parse(error.stdout), { args: [literal], value: literal });
        return true;
      });
      assert.equal(existsSync(dir), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
