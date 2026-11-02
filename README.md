# WoW Forever Assistant

Requires Windows, Bun 1.4.4 and Codex CLI.

```sh
bun install --frozen-lockfile
bun run install:addon --addons "C:\path\to\WoW\Interface\AddOns"
bun run start
```

The installer saves the AddOns path. If Codex is not found automatically, set `codexPath` in `%LOCALAPPDATA%\ForeverAssistant\config.json`.

In WoW, run `/reload`, then `/fa` to open the assistant.

## Game window

The bridge reads the addon's messages from the pixels of the WoW window. The window can be behind other windows or on another monitor, but it must not be minimized: a minimized window is not drawn, so nothing can be read until it is restored, and the bridge logs `capture.status` with code `minimized`. Switch away with Alt+Tab instead of minimizing; if WoW minimizes itself on Alt+Tab (Fullscreen display mode), set the display mode to Windowed (Fullscreen). While WoW is in the foreground the bridge copies the frames from the screen, otherwise it reads them from the window itself; the `ok` status detail says which (`screen` or `window`).
