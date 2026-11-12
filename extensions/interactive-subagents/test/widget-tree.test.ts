import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { displayableProfileIcon, plainWidgetTheme as plainTheme, renderCompactWidgetRows } from "../pi-extension/subagents/widget.ts";

function ansiTheme() {
  const calls: Array<{ method: string; color?: any; text: string }> = [];
  const colors = new Proxy({}, { get: (_target, token) => ({ kind: "rgb", r: 250, g: 250, b: 250, token }) });
  return {
    calls,
    colors,
    fg(color: string, text: string) { calls.push({ method: "fg", color, text }); return `\x1b[38;5;1m${text}\x1b[39m`; },
    bold(text: string) { calls.push({ method: "bold", text }); return `\x1b[1m${text}\x1b[22m`; },
    style(text: string, options: any) { calls.push({ method: "style", color: options, text }); return `\x1b[1;48;5;2m${text}\x1b[0m`; },
  };
}

const knownUsage = { inputTokens: 12345, outputTokens: 6789, cost: 0.123, costEstimated: false, costComplete: true };
const row = (overrides: Record<string, unknown> = {}): any => ({
  profile: "worker", name: "WorkerName", kind: "active", activity: "reading files", elapsed: "01:36",
  usage: knownUsage, ...overrides,
});

/** Render, check every row fits, and return plain text. */
function plain(rows: any[], width: number, icons: any = "unicode", theme = ansiTheme()) {
  const lines = renderCompactWidgetRows(rows, width, theme, icons, 0);
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`);
  return lines.map((line) => stripTerminalSequences(line));
}

describe("profile badge", () => {
  it("puts the progress glyph inside the badge and keeps name and state outside it", () => {
    const theme = ansiTheme();
    const [line] = plain([row()], 100, "unicode", theme);
    assert.match(line, /^ ⠋ worker  WorkerName · reading files +01:36  ↑12k ↓6\.8k  \$0\.1230$/);
    const badge = theme.calls.find((call) => call.method === "style");
    assert.equal(badge?.text, " ⠋ worker ");
  });

  it("shows the profile icon second, and only icons the configured set can draw", () => {
    const nerdIcon = "\u{F06A9}";
    const badgeOf = (icon: string, icons: string) => {
      const theme = ansiTheme();
      plain([row({ profileIcon: icon })], 100, icons, theme);
      return theme.calls.find((call) => call.method === "style")?.text;
    };
    assert.equal(badgeOf(nerdIcon, "nerd"), ` ${String.fromCodePoint(0xF0A9E)} ${nerdIcon} worker `);
    assert.equal(badgeOf(nerdIcon, "unicode"), " ⠋ worker ");
    assert.equal(badgeOf("⚙", "unicode"), " ⠋ ⚙ worker ");
    assert.equal(badgeOf("🤖", "nerd"), ` ${String.fromCodePoint(0xF0A9E)} 🤖 worker `);
    assert.equal(badgeOf("⚙", "ascii"), " | worker ");
    assert.equal(badgeOf("@", "ascii"), " | @ worker ");
  });

  it("omits unsafe icons but keeps the profile readable", () => {
    const hostile = ["\x1b[31mX", "\x1b]0;pwned\x07", "a\nb", "\t", " ", "ab", "⚙⚙", "‮", "‍", "", "́"];
    for (const icon of hostile) {
      for (const icons of ["unicode", "nerd", "ascii"]) {
        const [line] = plain([row({ profileIcon: icon })], 100, icons);
        assert.match(line, /^ \S worker  WorkerName [·-] reading files/u, `${icons} ${JSON.stringify(icon)}: ${JSON.stringify(line)}`);
      }
    }
    assert.equal(displayableProfileIcon("\x1b[31mX", "unicode"), undefined);
    assert.equal(displayableProfileIcon(undefined, "nerd"), undefined);
    assert.equal(displayableProfileIcon("\u{F06A9}", "unicode"), undefined);
    assert.equal(displayableProfileIcon("\u{F06A9}", "nerd"), "\u{F06A9}");
  });

  it("drops the decorative icon before elapsed time, tokens or cost", () => {
    const nested = row({ name: "Impl", activity: null, profileIcon: "⚙", treePrefix: "├─ " });
    assert.equal(plain([nested], 46)[0], "├─  ⠋ worker  Impl [active]  01:36  ↑12k ↓6.8k");
    assert.match(plain([nested], 60)[0], /^├─  ⠋ ⚙ worker  Impl \[active\] +01:36  ↑12k ↓6\.8k  \$0\.1230$/);
    assert.equal(displayableProfileIcon("👩‍💻", "unicode"), "👩‍💻");
  });
});

describe("in-progress spinner", () => {
  const nerdSlice = (n: number) => String.fromCodePoint(0xF0A9E + n);
  // Three consecutive frames per icon set, at that set's frame interval.
  const spinners = {
    unicode: { times: [0, 120, 240], frames: ["⠋", "⠙", "⠹"] },
    ascii: { times: [0, 150, 300], frames: ["|", "/", "-"] },
    nerd: { times: [0, 180, 360], frames: [nerdSlice(0), nerdSlice(1), nerdSlice(2)] },
  } as const;
  const badgeAt = (kind: string, icons: string, now: number) => {
    const theme = ansiTheme();
    const [line] = renderCompactWidgetRows([row({ kind })], 100, theme, icons as any, now);
    return { badge: theme.calls.find((call) => call.method === "style")?.text, width: visibleWidth(line) };
  };

  it("steps the badge glyph for active, running and starting agents on a fixed clock", () => {
    for (const [icons, { times, frames }] of Object.entries(spinners)) {
      for (const kind of ["active", "running", "starting"]) {
        const shown = times.map((now) => badgeAt(kind, icons, now));
        assert.deepEqual(shown.map((s) => s.badge), frames.map((frame) => ` ${frame} worker `), `${icons} ${kind}`);
        assert.equal(new Set(shown.map((s) => s.width)).size, 1, `${icons} ${kind}: width changes between frames`);
      }
    }
  });

  it("keeps waiting, stalled and finished glyphs still and distinct from the spinner", () => {
    const still = {
      unicode: { waiting: "○", stalled: "⟳", finished: "✓" },
      ascii: { waiting: "o", stalled: "!", finished: "-" },
      nerd: { waiting: "\u{F03E5}", stalled: "\u{F0159}", finished: "\u{F05E0}" },
    } as const;
    for (const [icons, { times }] of Object.entries(spinners)) {
      for (const [kind, glyph] of Object.entries(still[icons as keyof typeof still])) {
        for (const now of [...times, 1_000_000_007]) {
          assert.equal(badgeAt(kind, icons, now).badge, ` ${glyph} worker `, `${icons} ${kind} at ${now}`);
        }
      }
    }
  });
});

describe("activity in place of the active label", () => {
  const metrics = "01:36  ↑12k ↓6.8k  $0.1230";

  it("shows an active agent's activity right after its name, with the same metrics", () => {
    assert.equal(plain([row()], 80)[0], ` ⠋ worker  WorkerName · reading files${" ".repeat(17)}${metrics}`);
    assert.equal(plain([row()], 80, "ascii")[0], ` | worker  WorkerName - reading files${" ".repeat(12)}01:36  in 12k out 6.8k  $0.1230`);
    const nested = plain([row({ name: "Child", treePrefix: "└─ " })], 80)[0];
    assert.match(nested, /^└─  ⠋ worker  Child · reading files +01:36  ↑12k ↓6\.8k  \$0\.1230$/);
  });

  it("gives a long activity the columns the label used", () => {
    const long = row({ activity: "editing a very long file name that never ends" });
    assert.equal(plain([long], 80)[0], ` ⠋ worker  WorkerName · editing a very long file ...  ${metrics}`);
  });

  it("keeps the active label when there is no visible activity", () => {
    for (const activity of [null, "", "   ", "\n\t ", "\x1b[31m\x1b[0m", "\x1b]0;title\x07", "​"]) {
      const [line] = plain([row({ activity })], 80);
      assert.match(line, /^ ⠋ worker  WorkerName \[active\] +01:36  ↑12k ↓6\.8k  \$0\.1230$/, JSON.stringify(activity));
    }
  });

  it("keeps the active label when the activity does not fit", () => {
    assert.equal(plain([row()], 40)[0], " ⠋ worker  WorkerName [active]     01:36");
    assert.equal(plain([row()], 26)[0], " ⠋ worker  Wor... [active]");
  });

  it("keeps every other state's label beside its activity", () => {
    for (const kind of ["running", "starting", "waiting", "stalled", "finished"]) {
      const [line] = plain([row({ kind })], 100);
      assert.match(line, new RegExp(`^ \\S worker  WorkerName \\[${kind}\\] · reading files +01:36  ↑12k ↓6\\.8k  \\$0\\.1230$`), kind);
    }
  });
});

describe("truncation marker", () => {
  it("marks every cut with three periods in each icon set, and keeps an ellipsis the agent wrote", () => {
    const long = row({
      profile: "researcher-with-a-long-profile", name: "AnAgentWithAVeryLongName",
      activity: "reading a file whose path goes on and on", treePrefix: "│  └─ ",
    });
    for (const icons of ["unicode", "nerd", "ascii"]) {
      let cuts = 0;
      for (let width = 1; width <= 90; width++) {
        const [line] = plain([long, row({ kind: "starting" })], width, icons);
        assert.doesNotMatch(line, /…/, `${icons} width ${width}: ${JSON.stringify(line)}`);
        if (line.includes("...")) cuts++;
      }
      assert.ok(cuts > 0, `${icons}: no truncation was exercised`);
    }
    assert.equal(plain([row({ activity: "thinking…" })], 80)[0].match(/· (\S+)/)?.[1], "thinking…");
  });
});

describe("nested agent rows", () => {
  it("draws the tree prefix before the badge and keeps the root row's metrics", () => {
    const theme = ansiTheme();
    const [root, child, grandchild] = plain([
      row(),
      row({ name: "Child", treePrefix: "├─ " }),
      row({ name: "Grandchild", kind: "waiting", treePrefix: "│  └─" }),
    ], 100, "unicode", theme);
    assert.match(root, /^ ⠋ worker  WorkerName · reading files +01:36  ↑12k ↓6\.8k  \$0\.1230$/);
    assert.match(child, /^├─  ⠋ worker  Child · reading files +01:36  ↑12k ↓6\.8k  \$0\.1230$/);
    assert.match(grandchild, /^│  └─  ○ worker  Grandchild \[waiting\] · reading files +01:36  ↑12k ↓6\.8k  \$0\.1230$/);
    assert.ok(theme.calls.every((call) => !/[├└│]/.test(call.text) || call.method === "fg"), "tree prefix is outside the badge");
  });

  it("gives up indentation, glyph, badge and icon before the name and state", () => {
    const nested = row({ profile: "researcher", profileIcon: "⚙", name: "Grandchild", kind: "waiting", treePrefix: "│  └─ " });
    const at = (width: number, icons = "unicode") => plain([nested], width, icons)[0];
    for (let width = 16; width <= 62; width++) {
      const line = at(width);
      assert.match(line, /(\S{6,}) \[waiting\]/u, `width ${width}: ${JSON.stringify(line)}`);
      if (width >= 19) assert.match(line, /^(│  )?└─ /, `width ${width}: ${JSON.stringify(line)}`);
    }
    assert.equal(at(16), "Gra... [waiting]");
    assert.equal(at(19), "└─ Gra... [waiting]");
    assert.equal(at(21), "└─ ○ Gra... [waiting]");
    assert.equal(at(24), "│  └─ ○ Gra... [waiting]");
    assert.equal(at(42), "│  └─  ○ researcher  Grandchild [waiting]");
    assert.equal(at(43), "│  └─  ○ ⚙ researcher  Grandchild [waiting]");
    assert.equal(plain([{ ...nested, treePrefix: "|  `- " }], 21, "ascii")[0], "`- o Gra... [waiting]");
  });

  it("strips controls from the tree prefix and keeps every row within the width", () => {
    const hostile = row({
      profile: "日本語", profileIcon: "\u{F06A9}", name: "名前\x1b[31mEvil", treePrefix: "\x1b]0;pwned\x07│\t‮└─\n",
    });
    for (const icons of ["unicode", "nerd", "ascii"]) {
      for (let width = 1; width <= 60; width++) {
        const raw = renderCompactWidgetRows([hostile], width, ansiTheme(), icons as any, 0)[0];
        assert.ok(visibleWidth(raw) <= width, `${icons} width ${width}: ${JSON.stringify(raw)}`);
        assert.doesNotMatch(raw, /\x1b\]|\x1b\[31m|\x07|[\n\t‮]/, `${icons} width ${width}`);
      }
    }
    assert.match(plain([hostile], 80)[0], /^│ └─  ⠋ 日本語  名前Evil · reading files/);
  });

  it("keeps the glyph in a colored badge for agents without a profile", () => {
    const theme = ansiTheme();
    assert.match(plain([row({ profile: undefined, treePrefix: "└─" })], 64, "unicode", theme)[0], /^└─  ⠋  WorkerName · reading/);
    assert.equal(theme.calls.find((call) => call.method === "style")?.text, " ⠋ ");
  });

  it("shows a finished ancestor as a muted, still row without metrics", () => {
    const finished = row({ kind: "finished", activity: null, elapsed: "", usage: null });
    const child = row({ name: "Child", treePrefix: "└─ " });
    const theme = ansiTheme();
    const [ancestor, live] = plain([finished, child], 80, "unicode", theme);
    assert.equal(ancestor, " ✓ worker  WorkerName [finished]");
    assert.match(live, /^└─  ⠋ worker  Child · reading files +01:36  ↑12k ↓6\.8k  \$0\.1230$/);
    assert.ok(theme.calls.some((call) => call.method === "fg" && call.color === "muted" && call.text === "[finished]"));
    assert.equal(plain([finished], 60, "ascii")[0], " - worker  WorkerName [finished]");
    for (const now of [0, 180, 360]) {
      const nerd = renderCompactWidgetRows([finished], 60, plainTheme, "nerd", now)[0];
      assert.equal(nerd, ` ${String.fromCodePoint(0xF05E0)} worker  WorkerName [finished]`);
    }
  });
});
