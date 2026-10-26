import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isKeyRelease, isKeyRepeat, Key, matchesKey } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendTranscript, formatMicStatus } from "./text.ts";

const TOGGLE_KEY = Key.alt("m");
const CANCEL_KEY = Key.alt("n");
const STATUS_KEY = "whistle-dictate";
const FOCUS_WIDGET_KEY = "whistle-dictate-focus-hook";
const EXTENSION_PATH = fileURLToPath(new URL(".", import.meta.url));
const HELPER_PATH = fileURLToPath(new URL("./whistle_mic.py", import.meta.url));
const MAX_DIAGNOSTICS = 8_000;

interface HelperEvent {
	type: "loading" | "ready" | "level" | "transcript" | "done" | "error";
	message?: string;
	rms?: number;
	text?: string;
	pending?: string;
}

interface Dictation {
	child: ChildProcessWithoutNullStreams;
	ctx: ExtensionContext;
	tui: TUI;
	transcript: string;
	diagnostics: string;
	failure?: string;
	stopping: boolean;
	cancelled: boolean;
	done: boolean;
	finished: boolean;
}

interface TextEditorLike {
	getText(): string;
	setText(text: string): void;
}

let currentTui: TUI | undefined;
let currentContext: ExtensionContext | undefined;
let removeInputListener: (() => void) | undefined;
let dictation: Dictation | undefined;

function findTextEditor(value: unknown, depth = 0, visited = new Set<object>()): TextEditorLike | undefined {
	if (value === null || typeof value !== "object" || visited.has(value) || depth > 3) return undefined;
	visited.add(value);

	const candidate = value as Partial<TextEditorLike>;
	if (typeof candidate.getText === "function" && typeof candidate.setText === "function") {
		return candidate as TextEditorLike;
	}

	for (const key of ["editor", "input", "inputEditor", "editorComponent", "textInput"]) {
		const child = (value as Record<string, unknown>)[key];
		const editor = findTextEditor(child, depth + 1, visited);
		if (editor) return editor;
	}
	return undefined;
}

function injectIntoFocus(tui: TUI, transcript: string): boolean {
	const focused = tui.getFocusedComponent() as (Component & { handleInput?: (data: string) => void }) | null;
	if (!focused) return false;

	const editor = findTextEditor(focused);
	if (editor) {
		editor.setText(appendTranscript(editor.getText(), transcript));
		tui.requestRender();
		return true;
	}

	if (typeof focused.handleInput === "function") {
		// Text pasted into an opaque dialog must not turn a dictated newline into Enter.
		for (const character of transcript.replace(/[\r\n]+/gu, " ")) {
			focused.handleInput(character);
		}
		tui.requestRender();
		return true;
	}
	return false;
}

function tryClipboard(text: string): Promise<boolean> {
	const candidates: Array<[string, string[]]> =
		process.platform === "darwin"
			? [["pbcopy", []]]
			: process.platform === "win32"
				? [["clip", []]]
				: [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];

	return new Promise((resolve) => {
		let index = 0;
		const tryNext = () => {
			const candidate = candidates[index++];
			if (!candidate) return resolve(false);
			const [command, args] = candidate;
			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
			} catch {
				tryNext();
				return;
			}
			let settled = false;
			child.once("error", () => {
				if (settled) return;
				settled = true;
				tryNext();
			});
			child.once("close", (code) => {
				if (settled) return;
				settled = true;
				if (code === 0) resolve(true);
				else tryNext();
			});
			child.stdin?.end(text);
		};
		tryNext();
	});
}

function setStatus(state: Dictation, text: string | undefined): void {
	state.ctx.ui.setStatus(STATUS_KEY, text);
}

function closeState(state: Dictation): void {
	if (state.finished) return;
	state.finished = true;
	if (dictation === state) dictation = undefined;
	setStatus(state, undefined);
}

async function deliverTranscript(state: Dictation): Promise<void> {
	if (state.cancelled || state.finished) return;
	closeState(state);

	if (state.failure) {
		state.ctx.ui.notify(state.failure, "error");
		return;
	}
	if (!state.done) {
		const detail = state.diagnostics.trim();
		state.ctx.ui.notify(
			`Whistle stopped unexpectedly${detail ? `: ${detail.slice(-800)}` : ". Check that Python and cactus-needle are installed."}`,
			"error",
		);
		return;
	}

	const transcript = state.transcript.trim();
	if (!transcript) {
		state.ctx.ui.notify("Whistle did not detect speech.", "info");
		return;
	}

	if (injectIntoFocus(state.tui, transcript)) return;

	if (await tryClipboard(transcript)) {
		state.ctx.ui.notify("No text input is focused; dictation copied to the clipboard.", "warning");
		return;
	}
	state.ctx.ui.notify(`No text input is focused and clipboard copy failed. Transcript: ${transcript}`, "warning");
}

function handleHelperEvent(state: Dictation, event: HelperEvent): void {
	if (state.cancelled || state.finished) return;
	switch (event.type) {
		case "loading":
			setStatus(state, "Loading local Whistle model…");
			break;
		case "ready":
			setStatus(state, formatMicStatus(0));
			break;
		case "level":
			setStatus(state, formatMicStatus(event.rms ?? 0));
			break;
		case "transcript":
			// Whistle's `text` is the newly committed segment. `pending` is
			// provisional, so keep the same final-only insertion policy as pi-dictate.
			state.transcript += event.text ?? "";
			break;
		case "done":
			state.done = true;
			break;
		case "error":
			state.failure = event.message ?? "Whistle dictation failed.";
			break;
	}
}

function startDictation(ctx: ExtensionContext): void {
	const tui = currentTui;
	if (ctx.mode !== "tui" || !ctx.hasUI || !tui) {
		ctx.ui.notify("Whistle dictation is available in Pi's interactive terminal UI.", "warning");
		return;
	}
	if (!tui.getFocusedComponent()) {
		ctx.ui.notify("Focus a Pi input first, then start dictation.", "warning");
		return;
	}

	const uv = process.env.WHISTLE_UV || "uv";
	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawn(uv, ["run", "--project", EXTENSION_PATH, "--locked", "python", HELPER_PATH], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
	} catch (error) {
		ctx.ui.notify(`Could not start uv (${uv}). Install uv or set WHISTLE_UV: ${String(error)}`, "error");
		return;
	}

	const state: Dictation = {
		child,
		ctx,
		tui,
		transcript: "",
		diagnostics: "",
		stopping: false,
		cancelled: false,
		done: false,
		finished: false,
	};
	dictation = state;
	setStatus(state, "Starting local Whistle dictation with uv…");

	let outputBuffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		outputBuffer += chunk;
		let newline = outputBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = outputBuffer.slice(0, newline).trim();
			outputBuffer = outputBuffer.slice(newline + 1);
			if (line) {
				try {
					handleHelperEvent(state, JSON.parse(line) as HelperEvent);
				} catch {
					state.diagnostics = `${state.diagnostics}${line}\n`.slice(-MAX_DIAGNOSTICS);
				}
			}
			newline = outputBuffer.indexOf("\n");
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		state.diagnostics = `${state.diagnostics}${chunk}`.slice(-MAX_DIAGNOSTICS);
	});
	child.once("error", (error) => {
		state.failure = `Could not start uv-managed Whistle helper (${uv}): ${error.message}`;
		void deliverTranscript(state);
	});
	child.once("close", (code) => {
		if (outputBuffer.trim()) {
			try {
				handleHelperEvent(state, JSON.parse(outputBuffer.trim()) as HelperEvent);
			} catch {
				state.diagnostics = `${state.diagnostics}${outputBuffer}`.slice(-MAX_DIAGNOSTICS);
			}
		}
		if (code !== 0 && !state.failure) {
			state.failure = state.diagnostics.trim()
				? `Whistle helper failed: ${state.diagnostics.trim().slice(-800)}`
				: "Whistle helper failed. Check the Python and microphone setup.";
		}
		void deliverTranscript(state);
	});
}

function stopDictation(): void {
	const state = dictation;
	if (!state || state.stopping) return;
	state.stopping = true;
	setStatus(state, "⠋ finalizing Whistle transcript…");
	try {
		state.child.stdin.write('{"type":"stop"}\n');
		state.child.stdin.end();
	} catch (error) {
		state.failure = `Could not stop Whistle cleanly: ${String(error)}`;
		state.child.kill();
	}
}

function cancelDictation(): void {
	const state = dictation;
	if (!state) return;
	state.cancelled = true;
	closeState(state);
	state.child.kill();
}

function toggleDictation(ctx: ExtensionContext): void {
	if (dictation) stopDictation();
	else startDictation(ctx);
}

function installInputHooks(ctx: ExtensionContext): void {
	removeInputListener?.();
	removeInputListener = undefined;
	if (currentContext?.mode === "tui") currentContext.ui.setWidget(FOCUS_WIDGET_KEY, undefined);
	currentTui = undefined;
	currentContext = undefined;

	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	currentContext = ctx;
	ctx.ui.setWidget(
		FOCUS_WIDGET_KEY,
		(tui) => {
			currentTui = tui;
			const invisibleWidget: Component = { render: () => [], invalidate: () => {} };
			return invisibleWidget;
		},
		{ placement: "belowEditor" },
	);
	removeInputListener = ctx.ui.onTerminalInput((data) => {
		const toggle = matchesKey(data, TOGGLE_KEY);
		const cancel = matchesKey(data, CANCEL_KEY);
		if (!toggle && !cancel) return undefined;
		if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
		if (toggle) toggleDictation(ctx);
		else cancelDictation();
		return { consume: true };
	});
}

export default function (pi: ExtensionAPI): void {
	pi.registerShortcut(TOGGLE_KEY, {
		description: "Toggle local Whistle dictation",
		handler: (ctx) => toggleDictation(ctx),
	});
	pi.registerShortcut(CANCEL_KEY, {
		description: "Cancel Whistle dictation",
		handler: () => cancelDictation(),
	});
	pi.registerCommand("whistle", {
		description: "Toggle local Whistle dictation (use /whistle cancel to discard)",
		handler: (args, ctx) => {
			if (args.trim().toLowerCase() === "cancel") cancelDictation();
			else toggleDictation(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => installInputHooks(ctx));
	pi.on("session_before_switch", () => cancelDictation());
	pi.on("session_shutdown", (_event, ctx) => {
		cancelDictation();
		removeInputListener?.();
		removeInputListener = undefined;
		if (ctx.mode === "tui" && ctx.hasUI) {
			ctx.ui.setWidget(FOCUS_WIDGET_KEY, undefined);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
		currentTui = undefined;
		currentContext = undefined;
	});
}
