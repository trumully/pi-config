/**
 * Compact display for the read-only tools. UI only: renderers read the result Pi already holds and
 * never change what the model receives. Not a Pi extension entry; tools import it by relative path.
 */
import { stripTerminalSequences, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface ResultLike {
  content?: ReadonlyArray<{ type: string; text?: string }>;
  details?: { status?: string; exitCode?: number | null; truncated?: boolean; durationMs?: number } | undefined;
}

interface ContextLike {
  args?: unknown;
  isPartial: boolean;
  expanded: boolean;
  isError?: boolean;
  durationMs?: number;
}

export interface CompactToolView<Args> {
  /** Tool name shown at the start of the row. */
  title: string;
  /** One-line description of the call; may be empty while arguments stream. */
  summarize(args: Args | undefined): string;
  /** Complete description of the call for the expanded view; wraps instead of clipping. */
  describe(args: Args | undefined): string;
}

/** Quote an argument for display when a shell would split or interpret it. Display only. */
export function quoteArg(arg: string): string {
  const safe = displaySafe(arg);
  return /^[\w./:=,@%+-]+$/.test(safe) ? safe : `'${safe.replace(/'/g, "'\\''")}'`;
}

/** Builds its text at layout time so the row always fits the width Pi gives it. */
class FittedText extends Text {
  build: (width: number) => string = () => "";
  override render(width: number): string[] {
    if (width <= 0) return [];
    this.setText(this.build(width));
    return super.render(width);
  }
}

function fitted(last: unknown, build: (width: number) => string): FittedText {
  const component = last instanceof FittedText ? last : new FittedText("", 0, 0);
  component.build = build;
  return component;
}

/**
 * Make text safe to print: drop escape sequences, other control characters, and bidi controls that could
 * hide or reorder what the user sees. Returns a new string; the tool result itself is never changed.
 */
export function displaySafe(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f‎‏‪-‮⁦-⁩]/g, "");
}

function oneLine(text: string): string {
  return displaySafe(text).replace(/\n/g, " ");
}

function outputText(result: ResultLike): string {
  return displaySafe((result.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n"));
}

/**
 * Returned lines, blank ones included, without the truncation notice. A final newline ends the last line
 * rather than starting another. The tools' placeholder for empty output counts as zero lines.
 */
function outputLines(text: string): string[] {
  if (text === "" || text === "(no output)") return [];
  const lines = text.split("\n").filter((line) => !isNotice(line));
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Pi's own abort results carry no tool details: a direct abort, or an abort during retries. */
function isPiAbort(output: string): boolean {
  const message = output.trim();
  return message === "Operation aborted" || /^Aborted after \d+ retry attempts?\b/.test(message);
}

/** The bracketed notice the tools append when they clip output. */
function isNotice(line: string): boolean {
  return /^\[Output truncated by \w+\./.test(line);
}

function seconds(ms: number | undefined): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(1)}s` : undefined;
}

/** First meaningful line of a failure; a "failed (code)." header gets the stderr line after it. */
function diagnostic(output: string): string {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  return / failed \([^)]*\)\.$/.test(first) && lines[1] ? `${first} ${lines[1]}` : first;
}

const FAILURE_LABELS: Record<string, string> = {
  command_failed: "failed", timeout: "timed out", output_limit: "output limit", missing_executable: "executable not found",
  authentication: "authentication failed", spawn_failed: "spawn failed",
};

/** Thrown errors (validation rejections) reach the renderer without a status. */
function failureLabel(status: string | undefined): string {
  return (status && FAILURE_LABELS[status]) ?? "error";
}

export function compactRenderers<Args>(view: CompactToolView<Args>) {
  return {
    renderCall(args: Args, theme: ThemeLike, context: ContextLike & { lastComponent?: unknown }) {
      return fitted(context.lastComponent, (width) => {
        if (!context.isPartial && !context.expanded) return "";
        const title = theme.fg("toolTitle", theme.bold(view.title));
        if (context.expanded) return `${title} ${theme.fg("accent", displaySafe(view.describe(args)))}`;
        return truncateToWidth(`${title} ${theme.fg("accent", oneLine(view.summarize(args)))}`, width, "…");
      });
    },
    renderResult(result: ResultLike, options: { expanded: boolean; isPartial: boolean }, theme: ThemeLike, context: ContextLike & { lastComponent?: unknown }) {
      return fitted(context.lastComponent, (width) => {
        const output = outputText(result);
        const details = result.details ?? {};
        const failed = context.isError === true || (details.status !== undefined && details.status !== "success");
        const cancelled = details.status === "cancelled" || (details.status === undefined && isPiAbort(output));
        const mark = failed ? (cancelled ? "⊘" : "✗") : "✓";
        const tone = failed ? (cancelled ? "muted" : "error") : "success";
        const lines = outputLines(output).length;
        const exitCode = details.exitCode;
        const duration = seconds(context.durationMs ?? details.durationMs);
        // [text, color] pairs, joined by dim separators.
        const lineStat: [string, string] = [lines === 0 ? "no output" : `${lines} ${lines === 1 ? "line" : "lines"}`, "dim"];
        const stats: Array<[string, string]> = [];
        if (!failed) stats.push(lineStat);
        if (details.truncated === true) stats.push(["truncated", "warning"]);
        if (duration) stats.push([duration, "dim"]);
        const join = (parts: Array<[string, string]>) => parts.map(([part, color]) => theme.fg(color, part)).join(theme.fg("dim", " · "));
        const tail = stats.length > 0 ? `${theme.fg("dim", " · ")}${join(stats)}` : "";
        // The call row stays visible while running, so this row only reports progress.
        if (options.isPartial && !options.expanded) {
          return truncateToWidth(join([["running", "muted"], ...(lines > 0 ? [lineStat] : [])]), width, "…");
        }
        if (options.expanded) {
          const label: Array<[string, string]> = failed
            ? [[cancelled ? "cancelled" : failureLabel(details.status), tone], ...(typeof exitCode === "number" ? [[`exit ${exitCode}`, "dim"] as [string, string]] : [])]
            : [];
          const status = options.isPartial
            ? join([["running", "muted"], ...stats])
            : `${theme.fg(tone, mark)} ${join([...label, ...stats])}`;
          // Drop only the final newline, so the body shows the same lines the count reports.
          const body = output.replace(/\n$/, "").split("\n")
            .map((line) => theme.fg(isNotice(line) ? "warning" : failed ? tone : "toolOutput", line));
          return [truncateToWidth(status, width, "…"), ...body].join("\n");
        }
        const title = theme.fg("toolTitle", theme.bold(view.title));
        const call = oneLine(view.summarize(context.args as Args));
        if (failed) {
          const head = `${title} ${theme.fg(tone, mark)} `;
          const room = Math.max(0, width - visibleWidth(head) - visibleWidth(tail));
          // The diagnostic outranks the call: when both cannot fit, the call shrinks to a third of the row.
          const why = diagnostic(output);
          const callRoom = Math.max(room - 3 - visibleWidth(why), Math.min(12, room), Math.floor(room / 3));
          const summary = truncateToWidth(call, Math.max(0, callRoom), "…");
          const message = truncateToWidth(why, Math.max(0, room - visibleWidth(summary) - 3), "…");
          return truncateToWidth(`${head}${theme.fg("accent", summary)}${theme.fg("dim", " — ")}${theme.fg(tone, message)}${tail}`, width, "…");
        }
        const head = `${title} ${theme.fg(tone, mark)} `;
        const room = Math.max(0, width - visibleWidth(head) - visibleWidth(tail));
        const summary = truncateToWidth(call, room, "…");
        return truncateToWidth(`${head}${theme.fg("accent", summary)}${tail}`, width, "…");
      });
    },
  };
}
