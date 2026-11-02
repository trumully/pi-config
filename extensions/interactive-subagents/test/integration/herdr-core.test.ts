/** Opt-in live hc checks. No prompts are sent to Pi/Claude and no models are called. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrCoreBackend } from "../../pi-extension/subagents/herdr-core.ts";

const core = new HerdrCoreBackend();
const execAsync = promisify(execFile);
const hc = process.env.HC_BIN_PATH?.trim() || "hc";
const options = { encoding: "utf8" as const, timeout: 20_000, windowsHide: true };
async function wait(surface: string) {
  return JSON.parse((await execAsync(hc, ["wait", surface, "--timeout", "15", "--json"], options)).stdout);
}
function get(surface: string) {
  return JSON.parse(execFileSync(hc, ["get", surface, "--json"], options));
}

describe("herdr-app live terminals", { skip: !core.isAvailable(), timeout: 60_000 }, () => {
  it("preserves child environment, argv, parent identity, steering, reads and cleanup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-hc-live-"));
    const output = join(directory, "result.json");
    const literal = 'literal 日本語 $HOME & "quoted"';
    const { surface } = core.createSurface("live-probe", { cwd: directory, env: { PI_HC_TEST: literal, PI_SUBAGENT_SESSION: output } });
    let originalFocus: string | undefined;
    try { originalFocus = JSON.parse(execFileSync("herdr-app", ["status"], options)).focused_pane; } catch {}
    try {
      await core.startProgram(surface, [process.execPath, "-e", `
        const fs = require("node:fs");
        fs.writeFileSync(process.argv[1], JSON.stringify({cwd:process.cwd(),value:process.env.PI_HC_TEST,args:process.argv.slice(2)}));
        process.stdin.on("data", (data) => {
          console.log("STEER_RECEIVED " + data.toString());
          process.exit(0);
        });
        process.stdout.write('\\x1b]7501;state=idle:app=pi-test\\x07');
      `, output, literal]);
      const ready = await wait(surface);
      assert.equal(ready.status, "idle");
      assert.equal(get(surface).parent, process.env.HC_TERMINAL_ID);
      assert.deepEqual(await core.getRunningSurface(surface, { surface, sessionFile: output }), { surface });
      const result = JSON.parse(readFileSync(output, "utf8"));
      assert.equal(result.value, literal);
      assert.deepEqual(result.args, [literal]);
      assert.equal(result.cwd.replace(/\\/g, "/").toLowerCase(), directory.replace(/\\/g, "/").toLowerCase());
      core.prompt(surface, "test-steer");
      const ended = await wait(surface);
      assert.equal(ended.exit_code, 0);
      assert.match(await core.readAsync(surface, 50), /STEER_RECEIVED/);
      assert.equal(await core.getRunningSurface(surface), null);
      if (originalFocus) {
        assert.equal(JSON.parse(execFileSync("herdr-app", ["status"], options)).focused_pane, originalFocus);
      }
    } finally {
      core.close(surface);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const kind of ["pi", "claude"] as const) {
    it(`starts the real ${kind} CLI without making a model call`, async (t) => {
      if (kind === "claude") {
        try { execFileSync("claude", ["--version"], options); } catch { t.skip("Claude CLI not installed"); return; }
      }
      const { surface } = core.createSurface(`${kind}-version`);
      try {
        await core.startAgent(surface, kind, surface, ["--version"]);
        const result = await wait(surface);
        assert.equal(result.exit_code, 0);
        assert.match(core.read(surface, 20), /\d+\.\d+/);
      } finally { core.close(surface); }
    });
  }
});
