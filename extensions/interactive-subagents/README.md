# Interactive subagents

This repository contains a customized fork of [Eero Alvar's pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents), which is itself a fork of [HazAT's pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents).

Spawn Pi or Claude Code agents in Herdr while the parent session keeps working. Child results return to the parent asynchronously as steer messages. Use this when a task can run independently without blocking the parent.

## Requirements

This extension requires [Herdr](https://herdr.dev/). In `herdr-app`, start Pi in an app terminal with `hc` on PATH. The extension uses `HC_TERMINAL_ID` to link children to their parent. Children appear in the native agents list without changing focus; peek at a child or keep it as a pane from the app. Legacy Herdr remains supported through its `herdr` CLI and pane environment variables. Use it through this repository's Pi package or a local checkout; tailor enabled extensions with `pi config` or package filtering in the [root README](../../README.md#using). For an editable local checkout, use `/reload` after changing the extension or agent profiles.

The bundled `worker` and `researcher` profiles need Pi's `codemode` tool. The researcher uses it to batch web calls and filter structured results while retaining source URLs and checking returned errors. The bundled `worker` and `scout` profiles also need the local [`ast_grep` extension](../ast-grep/README.md). Neither backend needs tmux, psmux, or a Bash launch shell. The `hc` backend uses a Node launcher to apply each child's environment and supply its initial task without sending text to a booting agent. Pi reports its state through its built-in OSC 7501 support. Legacy Herdr's reporter is loaded explicitly for restricted children because `--no-extensions` disables global extension discovery. `HC_BIN_PATH` can select a different `hc` executable; `HERDR_BIN_PATH` selects the legacy CLI.

## Use it

Call `subagent({ agent, task, name?, model?, effort?, cwd? })` or run `/subagent <agent> <task>`. `model` overrides are allowed only for Pi profiles. Claude Code profiles always use their configured model; supplying any `model` argument for one is rejected before launch.

Supply `effort` only when the user explicitly requests an effort level, never based on task complexity. Omit it to use the profile default: `thinking` for Pi or `effort` for Claude Code. This explicit-request rule is agent guidance, not a runtime approval check. The override does not edit the profile and works with both legacy Herdr and herdr-app.

Pi accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, passed as `--thinking` independently of the model. Its saved loadout retains the chosen level for resume. Claude Code accepts `low`, `medium`, `high`, `xhigh`, and `max`, passed as `--effort`. Unsupported values are rejected before launch; the selected CLI/model may further restrict available levels.

For an explicit request to use high effort:

```ts
subagent({ agent: "scout", task: "Find the authentication entry points", effort: "high" })
subagent({ agent: "cc-worker", task: "Fix the scoped bug", effort: "high" })
```

Spawns are asynchronous. Names are unique within the parent session, including finished agents: omitted names get a unique default; explicit duplicates are rejected. Use `subagent_message({ name, message, intent? })` to steer a running agent or resume a finished one, and `subagents_list()` to list available profiles. A finished agent can resume only while its registered session exists; its saved tools, model, prompt, and working directory are reused.

`intent` may be `task`, `context`, or `reply`; omit it for the existing automatic steer/resume behavior. `task` replaces the child's current assignment in full (rather than accumulating corrections); `context` adds information and `reply` answers the child. Context and replies target a running child only, while a task can steer a running child or resume a finished one. For example, `subagent_message({ name: "api", message: "Implement the bounded API change and report files and checks.", intent: "task" })` assigns/replaces its brief; `subagent_message({ name: "api", message: "Use the existing response shape.", intent: "context" })` adds context, and `subagent_message({ name: "api", message: "Yes, that scope is approved.", intent: "reply" })` answers it. A saved brief is a record of the assignment, not proof that the child complied.

A message to a running child is normally queued until its next turn boundary. To replace an assignment immediately, send `subagent_message({ name, message, intent: "task", interrupt: true })`. `interrupt` requires `intent: "task"` and a running child, and works only in `herdr-app`. The extension reads the child's reported status through `hc`:

- If the child reports idle, the replacement is submitted without pressing any key.
- If it is working, `hc interrupt` presses the stop key (`esc` for status-reporting programs). Submission requires `hc` to report the turn `stopped`, a fresh idle status, and an idle-only conditional send.
- A done or error status is refused because `hc` cannot guard a send on those states. Use ordinary task messaging if no interruption is needed, or wait for normal completion and resume.
- If it is blocked on a permission, question or auth dialog, nothing is typed. Resolve the dialog in its pane first.
- If the stop outcome is `still_working`, `unknown` or `exited`, if `hc` errors, or if the program does not report status, the call fails without sending. A failed call leaves the saved brief unchanged and says whether the stop key was pressed.
- If `hc send` fails after the stop and it is unclear whether the text arrived, the call says so. Inspect the pane before retrying.

The status read and stop key are not atomic: if the child opens a dialog between them, the stop key may dismiss it. The extension never forces text into a blocked dialog and guards replacement submission with `--if idle`.

The acknowledgement (`replaced`) confirms idle at submission, not that the model has read or completed the replacement. It is not a result. The run stays registered and keeps its capacity slot, and its result, mailbox and questions are delivered as usual. Stopping a turn does not undo its side effects or prove that every process it started has stopped. Pi returns queued, unconsumed messages to its editor on abort, so they may be submitted together with the replacement. Legacy Herdr has no interrupt command that reports its effect, so `interrupt: true` is rejected there. Omit it to queue the message.

Completion notices and questions are recorded in a per-parent mailbox before delivery and acknowledged from the parent transcript. Pending notices replay after reload or idle retries without extra recap turns. Delivery is at-least-once, not exactly-once; stable delivery IDs suppress a replay when the parent transcript already contains the result. The extension persists versioned run metadata and reattaches observers to confirmed-live Herdr children after startup/reload. A run left in the middle of launch, an unreadable record, or an unavailable Herdr status remains UNKNOWN and cannot be resumed automatically; a single missing agent-list entry is not proof that a delayed launch has stopped. Existing registry records remain readable, but legacy running entries without metadata are not guessed back into watchers or resumed.

Pi child transcripts have an exclusive ownership sidecar before launch/resume. It remains in place while the child may still be alive, including when the parent shuts down; stale ownership is reclaimed only after the recorded owner is safely recoverable and Herdr confirms the child is absent. Registry updates are serialized across processes. A stale registry lock or uncertain ownership fails closed and may require manual inspection. If result storage fails, delivery falls back to a non-recoverable direct send and logs a warning. A child that disappears without a completion signal is reported as having an unconfirmed outcome.

The usage footer sums costs recorded in Pi child transcripts. It retains the original usage data in `<sessionFile>.recorded-usage.jsonl` during polling and at completion, so known amounts survive a missing or unreadable transcript. Retained-only usage is a subtotal, marked `+?`, not proof of the final bill. New forked sessions record inherited entry IDs to exclude parent usage even if the parent transcript disappears. A child with no recorded cost stays unknown; it is not assumed free. Claude Code list-price estimates remain separately labelled with `~`.

Children can use `ask_question()` to pause for a parent reply. In `herdr-app`, their work is available through the native agents list. Legacy Herdr uses tabs or nested splits. Inside a child, press Ctrl+Alt+O to show or hide its identity and available-tools panel; it starts hidden. In full mode, the parent widget can also show compact live counts: `↳ N` for a child's active direct children and `● C/T` for its non-deleted TODO tasks. These optional counts disappear when unavailable or stale; they do not replace the child's lifecycle status.

For reliable delegation, make each task self-contained: state the goal, bounded scope/ownership, relevant context, permissions, completion criteria, and concise return format. Before assigning work, compare its required actions with the agent's declared tools and stated limits. If part of the work does not fit, split it off or choose a suitable agent; preserve every permission and scope restriction. `subagents_list()` shows the launcher's tool behavior: for Pi agents, omitted or empty `tools` means the default toolset unless non-empty `subagent_agents` restricts the child to spawning and child-control tools; an explicit `tools` allowlist gains those tools when spawning is enabled. Claude Code agents use Claude Code's default toolset; Pi `tools` and `subagent_agents` settings are not applied to that CLI. Use short assignment names, echoed in findings when helpful. Run independent tasks in parallel; keep nesting shallow and avoid repeated status or review requests. Ask only about material scope, correctness, permission, or cost decisions; otherwise use reasonable scoped assumptions. Ask blocked agents for useful partial findings and the smallest next step. Children should distinguish completed, partial, blocked, or failed work and give concise evidence, check results, and any unverified or live-check status. For reviewable implementation work, use a ready-for-review handoff: the worker finishes, reports scope, files, checks, and limitations in its final response, then stops editing; wait for that completed handoff before assigning a reviewer, and avoid concurrent edits to the reviewed scope. If scope or files change, re-establish the handoff before relying on the review. This is a shared-worktree convention, not an enforced snapshot.

Children run with the tools allowed by their profile. `subagent_agents` controls which profiles a child may spawn. Only profiles that grant that access can spawn more agents.

## Agent profiles

Bundled profiles are `scout`, `worker`, `tasker`, `architect`, `writer`, `gh-scout`, `researcher`, `cc-worker`, and `cc-reviewer`. Project profiles in `.pi/agents/` override user profiles in `~/.pi/agent/agents/`, which override bundled profiles.

`subagents_list()` shows each effective profile's source and CLI alongside its model and tool behavior. Use `subagents_list({ name: "gh-scout" })` for the winning file path, shadowed files, profile thinking/effort, session mode, and question tool. Intentional CLI/model edits are supported; the launcher does not rewrite them. When switching CLIs, align the prompt with the chosen CLI's actual tools and question bridge. Pi tool grants are not Claude Code permissions. Editing a bundled file does not change a user or project override. The filename without `.md` is the launch name; detailed listing flags a differing frontmatter `name` instead of treating it as another profile's override.

| Profile | Default model | Purpose |
| --- | --- | --- |
| `scout` | `openai/gpt-6-luna` | Read-only local exploration and structural search |
| `worker` | `openai/gpt-6-luna` | Implementation, with `scout` as its only child profile |
| `tasker` | `openai/gpt-6-luna` | Tiny, well-specified edits, commands and lookups; low thinking, no children |
| `architect` | `openai/gpt-6-luna` | Read-only design decisions and actionable plans; no shell or children |
| `writer` | `openai/gpt-6-luna` | Scoped prose drafting/editing; no shell or children |
| `gh-scout` | `openai/gpt-6-luna` | Local Git and remote GitHub inspection without a general shell |
| `researcher` | `openai/gpt-6-luna` | Web research without local GitHub clones |
| `cc-worker` | `claude-opus-5-5` | Claude Code implementation |
| `cc-reviewer` | `claude-opus-5-5` | Read-only Claude Code review with triggering cases and refutation |

Set `githubClone.enabled` to `false` in the active `pi-web-access` `web-search.json` to disable local repository clones. Researchers ask the parent to delegate repository inspection to `gh-scout`. That profile has [`git_readonly`](../git-readonly/README.md) for local status, diffs, commits, and history, plus [`gh_readonly`](../gh-readonly/README.md) for GitHub. Both use shell-free, bounded operations; the profile cannot clone repositories or use general shell/file-editing tools. Local Git inspection needs Git 2.45+; install `gh` and authenticate outside the agent before accessing private GitHub repositories. Researcher returns cited findings; the parent handles saving local notes.

If a user or project `gh-scout` overrides the bundled profile, it keeps its existing tools and instructions until explicitly edited. To enable local Git there, add `git_readonly` to its Pi `tools` field and adopt the local-inspection guidance from the bundled profile. Preserve intentional CLI/model choices; Claude Code profiles do not receive Pi tool grants.

Use `tasker` for a small explicit job rather than a complex feature. `architect` returns a plan, not authorization to implement it. `writer` changes only authorized prose files and flags missing facts instead of inventing them. The new roles do not delegate; choose their use explicitly. Prompt adaptations and their upstream license are recorded in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Set `model` in profile frontmatter to choose its model. For Pi profiles only, the `model` argument can override it for one spawn. Claude Code model overrides are forbidden, even when the requested model matches the profile. For example:

```markdown
---
name: my-agent
description: Handles one task
tools: read, edit, safe_bash
model: openai/gpt-6-luna
subagent_agents: scout
auto-exit: true
---
Instructions for this agent.
```

`tools` is an allowlist. `subagent_agents` grants spawning access and limits which profiles can be spawned; omit it to prevent spawning. Other profile options include `cwd`, `thinking`, `skills`, `session-mode`, `system-prompt`, `auto-exit`, and `interactive`.

For a Claude Code profile, set `cli: claude`. Its `model` and optional `effort` fields are passed to Claude Code as `--model` and `--effort`; `thinking` applies to Pi profiles, not Claude Code. Claude Code documents effort values `low`, `medium`, `high`, `xhigh`, `max`, and `ultracode` (availability depends on the model; `ultracode` requires Claude Code v2.1.203 or later). See the [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference).

Claude Code children can receive `subagent_message` steers and return results. The bundled plugin also exposes `mcp__plugin_pi-auto-exit_pi__ask_question`, a freeform child-to-parent question bridge. It uses per-run sidecars and keeps the child open until the parent replies. The launch explicitly allows only this MCP tool; other actions still use Claude's `auto` permission mode. The plugin requires `uv` on `PATH`. The footer shows Claude Code's `cost.total_cost_usd` estimate live: Claude refreshes its status line at session start and after assistant messages (debounced), and the footer polls sidecars about once per second. Live snapshots report cost only; token/cache totals come from final `cost-state` records because status-line `current_usage` is not cumulative. The estimate is written atomically; after exit, a valid final `cost-state` replaces it, while an absent or unusable final record leaves the latest live estimate intact. If Claude explicitly reports an unknown model cost, the footer preserves that unknown result rather than showing an older number. These are Claude Code list-price estimates, not provider-billed charges. `/clear` resets Claude's session cost, so this per-launch sidecar does not preserve spend from before a manual clear. Claude Code launches use `--permission-mode auto` rather than bypassing permission prompts; availability depends on Claude Code's account, model, and organization settings. In `herdr-app`, initial Claude tasks over 8,000 characters are stored in a private temporary file and the CLI is instructed to read it, avoiding Windows command-line limits. The file remains available until the child exits or is closed.

## Configuration

Copy `config.json.example` to `config.json` in this extension directory. It is gitignored. The supported options are:

```json
{
  "status": { "enabled": true, "mode": "compact" },
  "limits": { "maxConcurrent": 4 },
  "proactiveCompaction": { "enabled": true, "thresholdPercent": 70 }
}
```

`limits.maxConcurrent` defaults to 4 and must be a positive integer. It caps one root parent's delegation tree, including startup, resumed children and nested launches. At capacity, launches fail clearly rather than queue; steering an existing child does not consume another slot. Unknown starts keep their slots until exit is confirmed, so a stale guard or unresolved run can require inspection. Existing children from before this change should be restarted to inherit the shared tree budget.

Status controls the agent-state display. `mode` defaults to `compact`: one borderless row per agent with name, role, elapsed time, and a short status. It has no heading or progress counters. Use `minimal` for a single summary line, or `full` for the original bordered widget with progress details. Existing explicit mode settings are preserved; change them to `compact` to use the new layout. `enabled` still controls status detail/notifications. Proactive compaction applies to Pi children, not the parent or Claude CLI agents. If compaction fails or is interrupted, the child stays open; send a follow-up to continue from its checkpoint.

## Tests

Run these from the repository root in a normal shell, not a restricted child session:

```sh
npm test             # Offline unit tests; no Herdr panes or model calls
npm run test:surface # Optional live Herdr pane and command tests; no model calls
```

No tests call a model. The live checks require Herdr and create real terminals. In `herdr-app`, they check parent links, environment, literal arguments, steering, output reads, focus preservation and cleanup. They also launch the installed Pi and Claude CLIs with `--version` only. The legacy checks create real tabs and panes instead. Run these explicitly when checking terminal integration. Full model-driven lifecycle behavior still needs manual verification when changed.

## License

MIT
