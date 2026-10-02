/**
 * Integration tests for the Herdr pane surface.
 *
 * These tests exercise real pane creation, command submission, output reads,
 * focus preservation, and cleanup. They make no LLM calls.
 *
 * Run from a Herdr pane with `npm run test:surface`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createSubagentSurface,
  createTrackedSurface,
  getFocusedSurface,
  getSurfaceTab,
  getTabLabel,
  untrackSurface,
  sendCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  echoCommand,
  writeFileCommand,
  sleep,
  uniqueId,
  trackTempFile,
  waitForFile,
  waitForScreen,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();
if (backends.length === 0) {
  console.log("⚠️  Herdr is not available - skipping Herdr surface integration tests");
  console.log("   Run this test from a Pi process inside a Herdr pane.");
}

for (const backend of backends) {
  describe(`herdr-surface [${backend}]`, { timeout: 60_000 }, () => {
    let env: TestEnv;

    beforeEach(() => {
      env = createTestEnv();
    });

    afterEach(() => {
      cleanupTestEnv(env);
    });

    it("preserves focus while creating and targeting a subagent pane", async () => {
      const focusedBefore = getFocusedSurface();
      assert.ok(focusedBefore, "expected a focused pane before test setup");

      const surface = createTrackedSurface(env, "focus-child");
      await sleep(700);
      assert.equal(getFocusedSurface(), focusedBefore);

      const marker = uniqueId();
      sendCommand(surface, echoCommand(`FOCUS_${marker}`));
      const screen = await waitForScreen(surface, new RegExp(`FOCUS_${marker}`), 20_000, 50);
      assert.ok(screen.includes(`FOCUS_${marker}`));
      assert.equal(getFocusedSurface(), focusedBefore);
    });

    it("keeps nested panes grouped in the top-level agent tab", () => {
      const mainFocus = getFocusedSurface();
      const parent = createTrackedSurface(env, "branch-root");
      const parentTab = getSurfaceTab(parent);
      assert.ok(parentTab, "expected the top-level subagent to get its own tab");
      assert.equal(getTabLabel(parentTab), "branch-root");

      const previousSubagentId = process.env.PI_SUBAGENT_ID;
      const previousPaneId = process.env.HERDR_PANE_ID;
      let child: string;
      try {
        process.env.PI_SUBAGENT_ID = "test-parent";
        process.env.HERDR_PANE_ID = parent;
        const allocated = createSubagentSurface("branch-child", { cwd: env.dir });
        child = allocated.surface;
        env.surfaces.push(child);
        if (allocated.tabId) {
          env.tabs.push(allocated.tabId);
          env.surfaceTabs.set(child, allocated.tabId);
          assert.equal(getTabLabel(allocated.tabId), "branch-child");
        } else {
          env.surfaceTabs.set(child, parentTab);
          assert.equal(getSurfaceTab(child), parentTab);
        }
      } finally {
        if (previousSubagentId === undefined) delete process.env.PI_SUBAGENT_ID;
        else process.env.PI_SUBAGENT_ID = previousSubagentId;
        if (previousPaneId === undefined) delete process.env.HERDR_PANE_ID;
        else process.env.HERDR_PANE_ID = previousPaneId;
      }
      assert.equal(getFocusedSurface(), mainFocus);
    });

    it("opens an overflow child in its own tab when the branch runs out of room", () => {
      const mainFocus = getFocusedSurface();
      let source = createTrackedSurface(env, "layout-root");
      let overflowed = false;
      const previousSubagentId = process.env.PI_SUBAGENT_ID;
      const previousPaneId = process.env.HERDR_PANE_ID;
      try {
        process.env.PI_SUBAGENT_ID = "test-parent";
        for (let depth = 1; depth <= 16; depth++) {
          const sourceTab = getSurfaceTab(source);
          assert.ok(sourceTab);
          const name = `nested-${depth}`;
          process.env.HERDR_PANE_ID = source;
          const allocated = createSubagentSurface(name, { cwd: env.dir });
          env.surfaces.push(allocated.surface);

          if (allocated.tabId) {
            env.tabs.push(allocated.tabId);
            env.surfaceTabs.set(allocated.surface, allocated.tabId);
            assert.notEqual(allocated.tabId, sourceTab);
            assert.equal(getTabLabel(allocated.tabId), name);
            overflowed = true;
            break;
          }

          env.surfaceTabs.set(allocated.surface, sourceTab);
          assert.equal(getSurfaceTab(allocated.surface), sourceTab);
          source = allocated.surface;
        }
      } finally {
        if (previousSubagentId === undefined) delete process.env.PI_SUBAGENT_ID;
        else process.env.PI_SUBAGENT_ID = previousSubagentId;
        if (previousPaneId === undefined) delete process.env.HERDR_PANE_ID;
        else process.env.HERDR_PANE_ID = previousPaneId;
      }
      assert.ok(overflowed, "expected the branch to reach the minimum split size");
      assert.equal(getFocusedSurface(), mainFocus);
    });

    it("uses a suffix only when subagent tab names collide", () => {
      const first = createTrackedSurface(env, "same-name");
      const second = createTrackedSurface(env, "same-name");
      const firstTab = getSurfaceTab(first);
      const secondTab = getSurfaceTab(second);
      assert.ok(firstTab);
      assert.ok(secondTab);
      assert.equal(getTabLabel(firstTab), "same-name");
      assert.equal(getTabLabel(secondTab), "same-name (2)");
    });

    it("creates a pane, runs a command, reads output, and closes it", async () => {
      const surface = createTrackedSurface(env, "echo-test");
      await sleep(700);

      const marker = uniqueId();
      sendCommand(surface, echoCommand(`MARKER_${marker}`));
      const screen = await waitForScreen(surface, new RegExp(`MARKER_${marker}`), 15_000, 50);
      assert.ok(screen.includes(`MARKER_${marker}`));

      closeSurface(surface);
      untrackSurface(env, surface);
    });

    for (const commandCase of [
      {
        name: "preserves shell-special characters in command output",
        surfaceName: "escape-test",
        marker: "SPEC",
        command: (marker: string) => echoCommand(`${marker}_$HOME_\"quotes\"_done`),
        lines: 50,
        verify: (screen: string) => {
          assert.ok(screen.includes("$HOME"), "expected $HOME to remain literal");
        },
      },
      {
        name: "submits a long command without truncating it",
        surfaceName: "long-cmd-test",
        marker: "LONG",
        command: (marker: string) => echoCommand(`${marker}_${"X".repeat(500)}_END`),
        lines: 80,
        verify: (screen: string) => {
          assert.ok(screen.includes("_END"), "expected the full long output");
        },
      },
    ]) {
      it(commandCase.name, async () => {
        const surface = createTrackedSurface(env, commandCase.surfaceName);
        await sleep(700);

        const marker = `${commandCase.marker}_${uniqueId()}`;
        sendCommand(surface, commandCase.command(marker));
        const screen = await waitForScreen(surface, new RegExp(marker), 15_000, commandCase.lines);
        assert.ok(screen.includes(marker));
        commandCase.verify(screen);
      });
    }

    it("reads pane output asynchronously", async () => {
      const surface = createTrackedSurface(env, "async-read-test");
      await sleep(700);

      const marker = uniqueId();
      sendCommand(surface, echoCommand(`ASYNC_${marker}`));
      const screen = await waitForScreen(surface, new RegExp(`ASYNC_${marker}`), 15_000, 50);
      assert.ok(screen.includes(`ASYNC_${marker}`));
      assert.ok((await readScreenAsync(surface, 50)).includes(`ASYNC_${marker}`));
    });

    it("writes output to a file and verifies the command result", async () => {
      const surface = createTrackedSurface(env, "file-test");
      await sleep(700);

      const marker = uniqueId();
      const filePath = join(env.dir, `herdr-surface-${marker}.txt`);
      trackTempFile(env, filePath);
      sendCommand(surface, writeFileCommand(filePath, `FILE_${marker}`, `WRITTEN_${marker}`));

      await waitForScreen(surface, new RegExp(`WRITTEN_${marker}`), 15_000, 50);
      const content = await waitForFile(filePath, 15_000, new RegExp(`FILE_${marker}`));
      assert.ok(content.includes(`FILE_${marker}`));
    });
  });
}
