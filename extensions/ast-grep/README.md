# ast_grep

Read-only structural code search for Pi. The `ast_grep` tool takes a structural `pattern` and ast-grep `language`. Optional `path` defaults to the current working directory; `limit` defaults to 20 and accepts 1–50 matches.

Install the pinned `@ast-grep/cli` 0.41.0 dependency from this directory:

```sh
npm ci --ignore-scripts --omit=peer
```

Load the extension directly with `pi --extension ./extensions/ast-grep`, or add it to a Pi package. It resolves the platform-specific binary from the local dependency and runs it without a shell. Searches use ast-grep's hidden-file and ignore-file defaults.
