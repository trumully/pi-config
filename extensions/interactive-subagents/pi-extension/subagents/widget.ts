import {
  colorToRgb,
  replaceControlCharacters,
  rgbColor,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Color,
} from "@earendil-works/pi-tui";
import type { StatusIconSet, SubagentStatusKind } from "./status.ts";
import type { RunUsage } from "./usage.ts";

/** The parts of Pi's Theme the widget uses. */
export interface WidgetTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  style?(text: string, options: { fg?: string | Color; bg?: string | Color; bold?: boolean }): string;
  colors?: Readonly<Record<string, Color>>;
}

export const plainWidgetTheme: WidgetTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

/** One running agent, already reduced to display data. */
export interface WidgetRow {
  profile: string | undefined;
  name: string;
  kind: SubagentStatusKind;
  activity: string | null;
  elapsed: string;
  usage: RunUsage | null;
}

export function formatWidgetTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

interface GlyphSet {
  status(kind: SubagentStatusKind, now: number): string;
  input: string;
  output: string;
  separator: string;
  ellipsis: string;
}

// Nerd Font Material Design circle slices 1-8, stepped every 180 ms, plus
// pause-circle and close-circle icons. These choices follow pi-subagent-manager
// (MIT); see THIRD-PARTY-NOTICES.md.
const NERD_LOADER_START = 0xf0a9e;
const NERD_LOADER_FRAMES = 8;
const NERD_FRAME_MS = 180;
const NERD_WAITING = "\u{F03E5}";
const NERD_STALLED = "\u{F0159}";

const GLYPHS: Record<StatusIconSet, GlyphSet> = {
  unicode: {
    status: (kind) => (kind === "waiting" || kind === "starting" ? "○" : "⟳"),
    input: "↑",
    output: "↓",
    separator: " · ",
    ellipsis: "…",
  },
  nerd: {
    status(kind, now) {
      if (kind === "waiting") return NERD_WAITING;
      if (kind === "stalled") return NERD_STALLED;
      if (kind === "starting") return String.fromCodePoint(NERD_LOADER_START);
      return String.fromCodePoint(NERD_LOADER_START + (Math.floor(now / NERD_FRAME_MS) % NERD_LOADER_FRAMES));
    },
    input: "↑",
    output: "↓",
    separator: " · ",
    ellipsis: "…",
  },
  ascii: {
    status: (kind) => ({ active: "*", running: "*", waiting: "o", starting: ".", stalled: "!" })[kind],
    input: "in ",
    output: "out ",
    separator: " - ",
    ellipsis: "...",
  },
};

function usageParts(usage: RunUsage | null, glyphs: GlyphSet): string[] {
  if (!usage) return [];
  const parts: string[] = [];
  const tokens = [
    usage.inputTokens === null ? null : `${glyphs.input}${formatWidgetTokens(usage.inputTokens)}`,
    usage.outputTokens === null ? null : `${glyphs.output}${formatWidgetTokens(usage.outputTokens)}`,
  ].filter((part) => part !== null);
  if (tokens.length > 0) parts.push(tokens.join(" "));
  if (usage.cost !== null) {
    parts.push(`${usage.costEstimated ? "~" : ""}$${usage.cost.toFixed(4)}${usage.costComplete ? "" : "+?"}`);
  }
  return parts;
}

function kindColor(kind: SubagentStatusKind): string {
  if (kind === "stalled") return "error";
  if (kind === "waiting" || kind === "starting") return "muted";
  return "accent";
}

const ROLE_COLORS = ["accent", "success", "mdHeading", "mdLink", "syntaxKeyword", "syntaxFunction", "syntaxType", "syntaxString"];

/** Deterministic presentation color for a profile name. */
export function profileColor(profile: string): string {
  let hash = 0;
  for (const char of profile) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return ROLE_COLORS[hash % ROLE_COLORS.length];
}

function contrastColor(background: Color): Color {
  const { r, g, b } = colorToRgb(background);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55 ? rgbColor(0, 0, 0) : rgbColor(255, 255, 255);
}

function badge(theme: WidgetTheme, label: string, color: string): string {
  const background = theme.colors?.[color];
  if (theme.style && background) {
    return theme.style(label, { bg: background, fg: contrastColor(background), bold: true });
  }
  return theme.bold(theme.fg(color, label));
}

export function renderCompactWidgetRows(
  rows: WidgetRow[],
  width: number,
  theme: WidgetTheme = plainWidgetTheme,
  icons: StatusIconSet = "unicode",
  now = Date.now(),
): string[] {
  if (width <= 0) return [];
  return rows.map((row) => renderCompactRow(row, width, theme, GLYPHS[icons], now));
}

/** Make agent-supplied text safe to style: no escape sequences, controls, or line breaks. */
export function sanitizeDisplayText(text: string): string {
  return replaceControlCharacters(stripTerminalSequences(text)).replace(/\s+/g, " ").trim();
}

/**
 * Truncate sanitized text by columns. Unlike truncateToWidth, adds no style
 * resets, so the caller's color covers the ellipsis too.
 */
function truncatePlain(text: string, width: number, ellipsis: string): string {
  if (visibleWidth(text) <= width) return text;
  const room = width - visibleWidth(ellipsis);
  if (room <= 0) return sliceByColumn(text, 0, width, true);
  return `${sliceByColumn(text, 0, room, true)}${ellipsis}`;
}

const GAP = "  ";
/** Show activity only when at least this many of its columns fit. */
const MIN_ACTIVITY_WIDTH = 4;
/** Columns of name kept before the glyph or badge get space. */
const MIN_NAME_WIDTH = 6;
/** Shortest profile text worth showing in a shortened badge. */
const MIN_BADGE_LABEL_WIDTH = 3;

interface Identity {
  badgeText: string;
  glyph: string;
  name: string;
  state: string;
}

/**
 * Fit the left side: [badge] [glyph] name state. The full lifecycle state
 * and a short name come first, then the glyph, then the full badge. Without
 * room for the full badge, the name grows to full length and the badge gets
 * what is left, shortened or dropped. When even state and a short name do
 * not fit, the name shrinks, then goes, then the state is truncated.
 */
function fitIdentity(
  row: { profile: string; name: string; kind: SubagentStatusKind },
  width: number,
  glyphs: GlyphSet,
  now: number,
): Identity {
  const state = row.kind;
  const stateWidth = visibleWidth(state);
  const fullNameWidth = visibleWidth(row.name);
  const minName = Math.min(fullNameWidth, MIN_NAME_WIDTH);
  const nameAndState = (nameWidth: number) => nameWidth + (nameWidth > 0 ? 1 : 0) + stateWidth;
  const shortName = (room: number) =>
    room >= fullNameWidth ? row.name : truncatePlain(row.name, room, glyphs.ellipsis);

  if (nameAndState(minName) > width) {
    const room = width - stateWidth - 1;
    // A name narrower than one character plus the ellipsis says nothing.
    if (row.name && room >= 1 + visibleWidth(glyphs.ellipsis)) {
      return { badgeText: "", glyph: "", name: shortName(room), state };
    }
    return { badgeText: "", glyph: "", name: "", state: truncatePlain(state, width, glyphs.ellipsis) };
  }

  const statusGlyph = glyphs.status(row.kind, now);
  const glyphWidth = visibleWidth(statusGlyph) + 1;
  const glyph = nameAndState(minName) + glyphWidth <= width ? statusGlyph : "";
  const prefix = glyph ? glyphWidth : 0;

  let badgeText = "";
  if (row.profile) {
    const fullBadge = ` ${row.profile} `;
    const fullBadgeWidth = visibleWidth(fullBadge) + 1;
    if (prefix + fullBadgeWidth + nameAndState(minName) <= width) {
      badgeText = fullBadge;
    } else {
      // Badge padding (2) plus the gap after it (1).
      const labelRoom = width - prefix - nameAndState(fullNameWidth) - 3;
      const minLabel = Math.min(visibleWidth(row.profile), MIN_BADGE_LABEL_WIDTH);
      if (labelRoom >= minLabel) badgeText = ` ${truncatePlain(row.profile, labelRoom, glyphs.ellipsis)} `;
    }
  }

  const badgeWidth = badgeText ? visibleWidth(badgeText) + 1 : 0;
  const nameRoom = width - prefix - badgeWidth - stateWidth - (row.name ? 1 : 0);
  return { badgeText, glyph, name: row.name ? shortName(nameRoom) : "", state };
}

/**
 * Lay out one row. The identity comes first (see fitIdentity). Elapsed
 * time, tokens and cost are added right-aligned, in that order, while they
 * fit beside it. Activity fills what remains, so it drops first.
 */
function renderCompactRow(
  untrusted: WidgetRow,
  width: number,
  theme: WidgetTheme,
  glyphs: GlyphSet,
  now: number,
): string {
  const row = {
    ...untrusted,
    profile: untrusted.profile ? sanitizeDisplayText(untrusted.profile) : "",
    name: sanitizeDisplayText(untrusted.name),
    activity: untrusted.activity ? sanitizeDisplayText(untrusted.activity) : "",
  };
  const color = row.profile ? profileColor(row.profile) : "accent";
  const stateColor = kindColor(row.kind);
  const { badgeText, glyph, name, state } = fitIdentity(row, width, glyphs, now);
  const leftWidth =
    (badgeText ? visibleWidth(badgeText) + 1 : 0) +
    (glyph ? visibleWidth(glyph) + 1 : 0) +
    visibleWidth(name) +
    (name && state ? 1 : 0) +
    visibleWidth(state);

  let right = "";
  for (const part of [row.elapsed, ...usageParts(row.usage, glyphs)]) {
    const candidate = right ? `${right}${GAP}${part}` : part;
    if (leftWidth + GAP.length + visibleWidth(candidate) > width) break;
    right = candidate;
  }
  const rightWidth = right ? GAP.length + visibleWidth(right) : 0;

  let activity = "";
  const separatorWidth = visibleWidth(glyphs.separator);
  const activityRoom = width - leftWidth - rightWidth - separatorWidth;
  if (row.activity && activityRoom >= MIN_ACTIVITY_WIDTH) {
    activity = truncatePlain(row.activity, activityRoom, glyphs.ellipsis);
  }
  const activityWidth = activity ? separatorWidth + visibleWidth(activity) : 0;

  const pad = right ? width - leftWidth - activityWidth - visibleWidth(right) : 0;
  const line = [
    badgeText ? `${badge(theme, badgeText, color)} ` : "",
    glyph ? `${theme.fg(stateColor, glyph)} ` : "",
    name ? theme.fg(color, name) : "",
    name && state ? " " : "",
    theme.fg(stateColor, state),
    activity ? theme.fg("dim", `${glyphs.separator}${activity}`) : "",
    " ".repeat(Math.max(0, pad)),
    right ? theme.fg("muted", right) : "",
  ].join("");
  // Guards widths too small for the profile badge and status together.
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

/** A themed status glyph for the full widget mode. */
export function widgetStatusIcon(
  kind: SubagentStatusKind,
  theme: WidgetTheme,
  icons: StatusIconSet,
  now: number,
): string {
  return theme.fg(kindColor(kind), GLYPHS[icons].status(kind, now));
}
