/** Drives a tool definition's renderers the way Pi's tool row does: call slot first, then result slot. */
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

export function loadTool(factory: (pi: any) => void): any {
  let definition: any;
  factory({ registerTool(def: any) { definition = def; } });
  assert.ok(definition, "extension registered no tool");
  return definition;
}

/** A theme that emits real ANSI escapes and records every call, so tests can see styling went through it. */
export function recordingTheme() {
  const calls: Array<{ method: string; color?: string; text: string }> = [];
  return {
    calls,
    fg(color: string, text: string) { calls.push({ method: "fg", color, text }); return `\x1b[38;5;3m${text}\x1b[39m`; },
    bold(text: string) { calls.push({ method: "bold", text }); return `\x1b[1m${text}\x1b[22m`; },
  };
}

export interface Row {
  args: any;
  result?: { content: any[]; details: any };
  expanded?: boolean;
  isPartial?: boolean;
  isError?: boolean;
  argsComplete?: boolean;
  durationMs?: number;
}

/** A persistent tool row; `show` re-renders it with new state, reusing slot components and shared state. */
export function toolRow(tool: any, theme: any = recordingTheme()) {
  const state: Record<string, unknown> = {};
  let callComponent: any;
  let resultComponent: any;
  return {
    theme,
    state,
    show(row: Row, width: number): string[] {
      const isPartial = row.isPartial ?? !row.result;
      const context = (lastComponent: unknown) => ({
        args: row.args, state, lastComponent, invalidate() {}, toolCallId: "call-1", cwd: process.cwd(),
        executionStarted: true, argsComplete: row.argsComplete ?? true, isPartial, expanded: row.expanded ?? false,
        showImages: false, isError: row.isError ?? false, durationMs: isPartial ? undefined : row.durationMs,
        outputPad: 1, keyText: () => "", keyHint: (_key: string, description: string) => description,
      });
      callComponent = tool.renderCall(row.args, theme, context(callComponent));
      const lines = [...callComponent.render(width)];
      if (row.result) {
        resultComponent = tool.renderResult({ content: row.result.content, details: row.result.details },
          { expanded: row.expanded ?? false, isPartial }, theme, context(resultComponent));
        lines.push(...resultComponent.render(width));
      }
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`);
      return lines.map((line) => stripTerminalSequences(line).trimEnd());
    },
  };
}

export function render(tool: any, row: Row, width = 100, theme?: any): string[] {
  return toolRow(tool, theme).show(row, width);
}

export const text = (value: string) => [{ type: "text", text: value }];
