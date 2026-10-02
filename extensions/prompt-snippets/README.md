# Prompt snippets

Toggle Markdown snippets to prepend or append to your next message. Open the menu with `Alt+S` or `/snippets`; use up/down to move, space to toggle, enter to apply, and escape to cancel. Press `Tab` to preview.

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

- **Ask questions** pauses for clarification and confirmation. Use it to gather information without starting work.
- **Delegate exploration** outsources codebase exploration, then asks Pi to verify critical parts.
- **Orchestrator mode** outsources exploration, code reading, and implementation to subagents.
- **Concise** asks for the shortest complete answer.
