# WoW Forever Assistant

Requires Windows, Bun 1.4.4 and Codex CLI.

```sh
bun install --frozen-lockfile
bun run install:addon --addons "C:\path\to\WoW\Interface\AddOns"
bun run start
```

The installer saves the AddOns path. If Codex is not found automatically, set `codexPath` in `%LOCALAPPDATA%\ForeverAssistant\config.json`.

In WoW, run `/reload`, then `/fa` to open the assistant.
