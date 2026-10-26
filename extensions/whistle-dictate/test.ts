import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import { appendTranscript, formatMicStatus } from "./text.ts";

test("appendTranscript appends with a word boundary", () => {
	assert.equal(appendTranscript("Fix the", "bug"), "Fix the bug");
	assert.equal(appendTranscript("Fix the ", "bug"), "Fix the bug");
	assert.equal(appendTranscript("Fix the", ", please"), "Fix the, please");
});

test("appendTranscript handles an empty editor", () => {
	assert.equal(appendTranscript("", "Hello"), "Hello");
});

test("formatMicStatus always shows a six-cell meter", () => {
	assert.match(formatMicStatus(0), /^● ▁{6} listening…$/u);
	assert.match(formatMicStatus(1), /^● ▇{6} listening…$/u);
});

test("registers toggle, cancel, command, and lifecycle hooks", () => {
	const shortcuts: string[] = [];
	const commands: string[] = [];
	const events: string[] = [];
	const pi = {
		registerShortcut: (key: string) => shortcuts.push(key),
		registerCommand: (name: string) => commands.push(name),
		on: (event: string) => events.push(event),
	} as unknown as ExtensionAPI;

	extension(pi);
	assert.deepEqual(shortcuts, ["alt+m", "alt+n"]);
	assert.deepEqual(commands, ["whistle"]);
	assert.deepEqual(events, ["session_start", "session_before_switch", "session_shutdown"]);
});
