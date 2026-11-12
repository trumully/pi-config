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

/**
 * A row's state. "finished" is display-only: a finished ancestor shown
 * because a descendant still runs.
 */
export type WidgetStatusKind = SubagentStatusKind | "finished";

/** One agent in the widget, already reduced to display data. */
export interface WidgetRow {
  profile: string | undefined;
  name: string;
  kind: WidgetStatusKind;
  activity: string | null;
  /** Empty when unknown; the row then shows no elapsed time. */
  elapsed: string;
  usage: RunUsage | null;
  /** Decorative profile glyph, already chosen for the icon set. Unsafe or undrawable icons are omitted. */
  profileIcon?: string;
  /** Tree connector drawn before the badge for nested agents, such as "│  └─ ". Empty for roots. */
  treePrefix?: string;
}

const PRIVATE_USE = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;
// Controls, unassigned and surrogate code points, separators and whitespace.
// Format characters (such as bidi overrides) are allowed only as the joiner
// inside an emoji sequence.
const UNSAFE_ICON = /[\p{Cc}\p{Cs}\p{Cn}\p{Z}\s]|(?!\u200D)\p{Cf}/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Return the icon if it is one safe glyph, at most two columns wide, that
 * the icon set can draw: Nerd Font private-use glyphs need "nerd", and
 * "ascii" draws only printable ASCII. Otherwise return undefined.
 */
export function displayableProfileIcon(icon: string | undefined, icons: StatusIconSet): string | undefined {
  if (!icon || UNSAFE_ICON.test(icon) || stripTerminalSequences(icon) !== icon) return undefined;
  if ([...graphemes.segment(icon)].length !== 1) return undefined;
  const width = visibleWidth(icon);
  if (width < 1 || width > 2) return undefined;
  if (icons === "ascii" && !/^[\x21-\x7e]$/.test(icon)) return undefined;
  if (icons !== "nerd" && PRIVATE_USE.test(icon)) return undefined;
  return icon;
}

export function formatWidgetTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Agents still at work: their glyph is an animated spinner. */
export function isAnimatedWidgetKind(kind: WidgetStatusKind): boolean {
  return kind === "active" || kind === "running" || kind === "starting";
}

interface GlyphSet {
  /** Spinner frames for animated kinds, one-column glyphs shown in order. */
  spinner: readonly string[];
  /** Milliseconds each spinner frame shows. */
  frameMs: number;
  /** Still glyphs for the kinds that do not animate. */
  still: Record<Exclude<WidgetStatusKind, "active" | "running" | "starting">, string>;
  input: string;
  output: string;
  separator: string;
}

/** The mark the widget adds where it cuts text, in every icon set. */
const ELLIPSIS = "...";

// Nerd Font Material Design circle slices 1-8, plus pause-circle and
// close-circle icons. These choices follow pi-subagent-manager (MIT); see
// THIRD-PARTY-NOTICES.md.
const NERD_LOADER_START = 0xf0a9e;
const NERD_LOADER_FRAMES = 8;
const NERD_WAITING = "\u{F03E5}";
const NERD_STALLED = "\u{F0159}";
// Material Design check-circle-outline.
const NERD_FINISHED = "\u{F05E0}";

const GLYPHS: Record<StatusIconSet, GlyphSet> = {
  unicode: {
    spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    frameMs: 120,
    still: { waiting: "○", stalled: "⟳", finished: "✓" },
    input: "↑",
    output: "↓",
    separator: " · ",
  },
  nerd: {
    spinner: Array.from({ length: NERD_LOADER_FRAMES }, (_, i) => String.fromCodePoint(NERD_LOADER_START + i)),
    frameMs: 180,
    still: { waiting: NERD_WAITING, stalled: NERD_STALLED, finished: NERD_FINISHED },
    input: "↑",
    output: "↓",
    separator: " · ",
  },
  ascii: {
    spinner: ["|", "/", "-", "\\"],
    frameMs: 150,
    still: { waiting: "o", stalled: "!", finished: "-" },
    input: "in ",
    output: "out ",
    separator: " - ",
  },
};

/** The status glyph at time `now`. Spinner frames depend only on the clock. */
function statusGlyph(glyphs: GlyphSet, kind: WidgetStatusKind, now: number): string {
  if (!isAnimatedWidgetKind(kind)) return glyphs.still[kind as keyof GlyphSet["still"]];
  const frames = glyphs.spinner;
  const step = Math.floor(now / glyphs.frameMs) % frames.length;
  return frames[(step + frames.length) % frames.length];
}

/** Milliseconds between spinner frames for an icon set. */
export function widgetSpinnerFrameMs(icons: StatusIconSet): number {
  return GLYPHS[icons].frameMs;
}

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

function kindColor(kind: WidgetStatusKind): string {
  if (kind === "stalled") return "error";
  if (kind === "waiting" || kind === "starting" || kind === "finished") return "muted";
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
  return rows.map((row) => renderCompactRow(row, width, theme, icons, now));
}

/** Make agent-supplied text safe to style: no escape sequences, controls, or line breaks. */
export function sanitizeDisplayText(text: string): string {
  return replaceControlCharacters(stripTerminalSequences(text)).replace(/\s+/g, " ").trim();
}

/**
 * Make a tree prefix safe to draw. Unlike display text, leading spaces are
 * indentation and stay; trailing space goes because the row adds its own gap.
 */
export function sanitizeTreePrefix(prefix: string): string {
  return replaceControlCharacters(stripTerminalSequences(prefix))
    .replace(/\p{Cf}/gu, "")
    .replace(/\s/g, " ")
    .trimEnd();
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
// Each minimum keeps a few real characters ahead of the ellipsis.
/** Show activity only when at least this many of its columns fit. */
const MIN_ACTIVITY_WIDTH = 6;
/** Columns of name kept before the glyph or badge get space. */
const MIN_NAME_WIDTH = 6;
/** Shortest profile text worth showing in a shortened badge. */
const MIN_BADGE_LABEL_WIDTH = 5;

/**
 * The lifecycle label, bracketed so it reads as a status rather than part of
 * the name. Claude agents report less detail than Pi agents, so "[running]"
 * marks a state the widget knows only coarsely.
 */
function lifecycleLabel(kind: WidgetStatusKind): string {
  return `[${kind}]`;
}

interface Identity {
  tree: string;
  badgeText: string;
  glyph: string;
  name: string;
  state: string;
}

/**
 * Fit the left side: [tree] [badge: glyph icon profile] name state. The full
 * lifecycle state and a short name come first, then the tree connector, the
 * glyph, the tree indentation, and the full badge. Without room for the full
 * badge, the name grows to full length and the badge gets what is left: a
 * shortened profile, the glyph alone, or nothing, leaving the glyph outside.
 * The profile icon shows only beside the full name. When even state and a
 * short name do not fit, the name shrinks, then goes, then the state is
 * truncated.
 */
function fitIdentity(
  row: { profile: string; profileIcon: string; treePrefix: string; name: string; kind: WidgetStatusKind },
  fullWidth: number,
  glyphs: GlyphSet,
  now: number,
): Identity {
  const state = lifecycleLabel(row.kind);
  const stateWidth = visibleWidth(state);
  const fullNameWidth = visibleWidth(row.name);
  const minName = Math.min(fullNameWidth, MIN_NAME_WIDTH);
  const nameAndState = (nameWidth: number) => nameWidth + (nameWidth > 0 ? 1 : 0) + stateWidth;
  const shortName = (room: number) =>
    room >= fullNameWidth ? row.name : truncatePlain(row.name, room, ELLIPSIS);

  if (nameAndState(minName) > fullWidth) {
    const room = fullWidth - stateWidth - 1;
    // A name narrower than one character plus the ellipsis says nothing.
    if (row.name && room >= 1 + visibleWidth(ELLIPSIS)) {
      return { tree: "", badgeText: "", glyph: "", name: shortName(room), state };
    }
    return { tree: "", badgeText: "", glyph: "", name: "", state: truncatePlain(state, fullWidth, ELLIPSIS) };
  }

  const kindGlyph = statusGlyph(glyphs, row.kind, now);
  // The glyph alone, outside any badge, plus the gap after it.
  const glyphWidth = visibleWidth(kindGlyph) + 1;

  // The tree connector comes next, then the glyph, then the indentation
  // before the connector. Widths include the gap after the prefix.
  const treeWidth = (text: string) => (text ? visibleWidth(text) + 1 : 0);
  const connector = row.treePrefix.split(" ").at(-1) ?? "";
  const base = nameAndState(minName);
  let tree = base + treeWidth(connector) <= fullWidth ? connector : "";
  const glyphRoom = base + treeWidth(tree) + glyphWidth <= fullWidth ? glyphWidth : 0;
  if (tree && base + treeWidth(row.treePrefix) + glyphRoom <= fullWidth) tree = row.treePrefix;
  const width = fullWidth - treeWidth(tree);

  let glyph = nameAndState(minName) + glyphWidth <= width ? kindGlyph : "";

  // The badge holds the glyph first, then the profile. Its width counts the
  // gap after it.
  let badgeText = "";
  if (glyph) {
    const badgeFor = (label: string) => ` ${[kindGlyph, label].filter(Boolean).join(" ")} `;
    const fits = (text: string, nameWidth: number) => visibleWidth(text) + 1 + nameAndState(nameWidth) <= width;
    const iconBadge = badgeFor([row.profileIcon, row.profile].filter(Boolean).join(" "));
    const fullBadge = badgeFor(row.profile);
    // The decorative icon never costs the name any columns.
    if (row.profileIcon && fits(iconBadge, fullNameWidth)) {
      badgeText = iconBadge;
    } else if (row.profile && fits(fullBadge, minName)) {
      badgeText = fullBadge;
    } else if (row.profile) {
      // Glyph badge without a label, plus one space before the label.
      const labelRoom = width - visibleWidth(badgeFor("")) - 2 - nameAndState(fullNameWidth);
      const minLabel = Math.min(visibleWidth(row.profile), MIN_BADGE_LABEL_WIDTH);
      if (labelRoom >= minLabel) badgeText = badgeFor(truncatePlain(row.profile, labelRoom, ELLIPSIS));
    }
    if (!badgeText && fits(badgeFor(""), fullNameWidth)) badgeText = badgeFor("");
    if (badgeText) glyph = "";
  }

  const used = badgeText ? visibleWidth(badgeText) + 1 : glyph ? glyphWidth : 0;
  const nameRoom = width - used - stateWidth - (row.name ? 1 : 0);
  return { tree, badgeText, glyph, name: row.name ? shortName(nameRoom) : "", state };
}

/**
 * Lay out one row. The identity comes first (see fitIdentity). Elapsed
 * time, tokens and cost are added right-aligned, in that order, while they
 * fit beside it, ahead of the decorative profile icon. Activity fills what
 * remains, so it drops first.
 */
function renderCompactRow(
  untrusted: WidgetRow,
  width: number,
  theme: WidgetTheme,
  icons: StatusIconSet,
  now: number,
): string {
  const glyphs = GLYPHS[icons];
  const row = {
    ...untrusted,
    profile: untrusted.profile ? sanitizeDisplayText(untrusted.profile) : "",
    profileIcon: displayableProfileIcon(untrusted.profileIcon, icons) ?? "",
    treePrefix: untrusted.treePrefix ? sanitizeTreePrefix(untrusted.treePrefix) : "",
    name: sanitizeDisplayText(untrusted.name),
    activity: untrusted.activity ? sanitizeDisplayText(untrusted.activity) : "",
  };
  const color = row.profile ? profileColor(row.profile) : "accent";
  const stateColor = kindColor(row.kind);
  const metrics = [row.elapsed, ...usageParts(row.usage, glyphs)].filter(Boolean);
  const layout = (identity: Identity) => {
    const leftWidth =
      (identity.tree ? visibleWidth(identity.tree) + 1 : 0) +
      (identity.badgeText ? visibleWidth(identity.badgeText) + 1 : 0) +
      (identity.glyph ? visibleWidth(identity.glyph) + 1 : 0) +
      visibleWidth(identity.name) +
      (identity.name && identity.state ? 1 : 0) +
      visibleWidth(identity.state);
    let right = "";
    let shown = 0;
    for (const part of metrics) {
      const candidate = right ? `${right}${GAP}${part}` : part;
      if (leftWidth + GAP.length + visibleWidth(candidate) > width) break;
      right = candidate;
      shown++;
    }
    return { identity, leftWidth, right, shown };
  };
  let fitted = layout(fitIdentity(row, width, glyphs, now));
  if (row.profileIcon) {
    // The decorative icon never costs the row a metric.
    const withoutIcon = layout(fitIdentity({ ...row, profileIcon: "" }, width, glyphs, now));
    if (withoutIcon.shown > fitted.shown) fitted = withoutIcon;
  }
  const { identity: { tree, badgeText, glyph, name }, right } = fitted;
  let { identity: { state }, leftWidth } = fitted;
  const rightWidth = right ? GAP.length + visibleWidth(right) : 0;

  let activity = "";
  const separatorWidth = visibleWidth(glyphs.separator);
  let activityRoom = width - leftWidth - rightWidth - separatorWidth;
  const hasActivity = visibleWidth(row.activity) > 0;
  if (hasActivity && activityRoom >= MIN_ACTIVITY_WIDTH) {
    // The spinner already says "active"; the activity says what it is doing.
    // The layout above reserved the label, so the activity shows exactly when
    // the label would have fit beside it, and it takes the label's columns.
    if (row.kind === "active" && state === lifecycleLabel("active") && name) {
      const labelWidth = visibleWidth(state) + 1;
      state = "";
      leftWidth -= labelWidth;
      activityRoom += labelWidth;
    }
    activity = truncatePlain(row.activity, activityRoom, ELLIPSIS);
  }
  const activityWidth = activity ? separatorWidth + visibleWidth(activity) : 0;

  const pad = right ? width - leftWidth - activityWidth - visibleWidth(right) : 0;
  const line = [
    tree ? `${theme.fg("muted", tree)} ` : "",
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
  return visibleWidth(line) > width ? truncateToWidth(line, width, ELLIPSIS) : line;
}

/** A themed status glyph for the full widget mode. */
export function widgetStatusIcon(
  kind: WidgetStatusKind,
  theme: WidgetTheme,
  icons: StatusIconSet,
  now: number,
): string {
  return theme.fg(kindColor(kind), statusGlyph(GLYPHS[icons], kind, now));
}
