# WoW Forever Assistant

An in-game assistant for WoW Forever: a Lua addon and a local Bun bridge. It answers questions using character snapshots, ForeverMaster, QuestieDB Forever, crafting calculations and Auctionator prices. Codex provides AI answers; a fixed response mode is available for testing.

## Run

Requires Windows for game capture, Bun 1.4.4 and Codex CLI for AI answers.

```sh
bun install --frozen-lockfile
bun run install:addon --addons "C:\path\to\WoW\Interface\AddOns"
bun run start
```

The installer saves the AddOns path. Codex is the default model adapter. In `%LOCALAPPDATA%\ForeverAssistant\config.json`, set `codexPath` if Codex is not found automatically, or `"modelAdapter": "fixed"` to use test responses without calling AI. Override the data directory with `FOREVER_ASSISTANT_HOME`.

ForeverMaster and the latest stable QuestieDB Forever release download automatically on startup and check for updates every 24 hours. The last working snapshots remain available offline and when an update fails. QuestieDB does not need to be installed in the game.

In WoW, run `/reload`, then `/fa` to open the chat or `/fa settings` to configure the addon. Stop the bridge with Ctrl+C.

For development on macOS, install SQLite >= 3.45 (`brew install sqlite`). A custom library path can be set with `FOREVER_ASSISTANT_SQLITE`.
