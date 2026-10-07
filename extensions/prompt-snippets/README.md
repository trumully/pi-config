# Prompt snippets

A local adaptation of the prompt-snippets extension in [Eero Alvar's pi-config](https://github.com/amosblomqvist/pi-config/tree/main/extensions/prompt-snippets), with local presentation, documentation, and snippet content. Use it through this repository's [Pi package](../../README.md#using) or a local checkout; tailor enabled extensions with `pi config` or package filtering. Reload Pi after code changes. Snippet files are rescanned when the menu opens and when you send. Toggle Markdown snippets to prepend or append to your next message. Open the menu with `Alt+S` or `/snippets`; use up/down to move, space to toggle, enter to apply, and escape to cancel. Press `Tab` to preview.

The editor widget shows active snippets. On send, Pi combines prepend snippets, your message, then append snippets. Snippets within each group sort by `order`; each part is separated by a blank line. Toggles reset after sending and at session start. The extension rescans files when the menu opens and when you send, so edits need no reload.

## Add a snippet

Create a Markdown file under `snippets/` beside `index.ts`:

```markdown
---
name: Concise
description: Keep answers short
placement: prepend
order: 10
---
Keep your response concise.
```

Frontmatter is optional. `name` defaults to the filename, `placement` to `append`, and `order` to `9999` (ties sort by name). `placement` accepts `prepend` or `append`; `description` appears in the menu.

## Included snippets

- **Ask questions** asks only about details that materially affect scope, correctness, permissions, or cost.
- **Approval before work** requires explicit approval before any task work, including research, delegation, or changes; clarification and a scope proposal are allowed to obtain approval.
- **Delegate exploration** delegates exploration only; handle later work directly as appropriate. It is a lighter alternative to Orchestrator mode.
- **Independent review** requests a proportionate review and focused checks for nontrivial changes.
- **Orchestrator mode** delegates exploration, implementation, and checks while the coordinator owns scope, decisions, and synthesis. It is broader than Delegate exploration; usually enable one, not both.
- **Concise** asks for the shortest complete answer.
