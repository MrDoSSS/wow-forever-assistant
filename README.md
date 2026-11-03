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

The default `pixels` transport reads the addon's messages from the pixels of the WoW window. The window can be behind other windows or on another monitor, but it must not be minimized: a minimized window is not drawn, so nothing can be read until it is restored, and the bridge logs `capture.status` with code `minimized`. Switch away with Alt+Tab instead of minimizing; if WoW minimizes itself on Alt+Tab (Fullscreen display mode), set the display mode to Windowed (Fullscreen). While WoW is in the foreground the bridge copies the frames from the screen, otherwise it reads them from the window itself; the `ok` status detail says which (`screen` or `window`).

## Optional silent Windows transport

`silent_voice` replaces the pixel field and LoD delivery polling with a Windows SAPI 5 voice. It exchanges protocol text and bookmark events without synthesizing speech. It also filters the default UI's completion chime for the assistant's own utterances. Normal narration events and sound settings are preserved. This mode does not capture the game window or consume delivery slots.

Build the voice with the .NET Framework 4 compiler included in Windows:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bridge\voice\Build-Voice.ps1
```

Register it from an administrator PowerShell window so WoW can enumerate the voice:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bridge\voice\Register-Voice.ps1 -Machine
```

Registration adds `Forever Assistant Silent Bridge 3`; it does not change the Windows default voice. The versioned voice token avoids reusing an older cached engine. Keep the built DLL at its registered path. After rebuilding a registered engine, restart WoW to load the new assembly.

Add these fields to the existing `%LOCALAPPDATA%\ForeverAssistant\config.json`, preserving the AddOns path and model settings:

```json
{
  "transport": "silent_voice",
  "voicePort": 19745
}
```

Run `bun run install:addon` again to pass the selected transport to the addon, restart the bridge with `bun run start`, then use `/reload` and `/fa` in WoW. The installer keeps the legacy slot folders for switching back; this transport does not read or write them. If the voice is not listed after `/reload`, restart WoW once.

The registered voice uses an authenticated HTTP hop bound to `127.0.0.1`. Its generated capability file is written beside the DLL and in the data directory, so packaged launchers with redirected AppData can share the same endpoint. The files are ignored by Git and removed on a clean bridge shutdown. Incoming packets are parsed as data, never executed as Lua. Idle polling continues with unique request numbers, and reconnects automatically after bridge outages.

To test the registered voice without playing audio, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bridge\voice\Test-Voice.ps1`. It checks the returned bookmark and verifies zero-valued PCM samples in a memory stream. Live game validation must additionally check reply delivery and absence of completion chimes.

To switch back, set `transport` to `pixels`, rerun the addon installer, restart the bridge, and use `/reload`. After switching back, an administrator can unregister the voice with `Register-Voice.ps1 -Machine -Uninstall`.

## Claude Code CLI

The bridge can also use the Claude Code CLI with your claude.ai login (`claude auth login`) or an Anthropic API key. Add to `%LOCALAPPDATA%\ForeverAssistant\config.json`:

```json
{
  "modelAdapter": "claude",
  "claudeModel": "sonnet"
}
```

`claudeModel` is a CLI alias (`haiku`, `sonnet`, `opus`) or a full model name; `null` keeps the CLI default. Optional: `claudeEffort` (`low` … `max`), `claudePath` if `claude.exe` is not in `%USERPROFILE%\.local\bin` or on PATH, and `claudeApiKey` (otherwise the CLI login or `ANTHROPIC_API_KEY` is used). The CLI runs in restricted mode without your settings, hooks, plugins, skills or other MCP servers; its only tools are the forever tools and web search, and the bridge stops a run whose CLI offers anything else. Chats are CLI sessions of the working directory `%LOCALAPPDATA%\ForeverAssistant\run\claude`. `bun run diagnose` shows the CLI path and login.

## OpenRouter

Instead of Codex, the bridge can use any OpenRouter model that supports tools and structured outputs. Add to `%LOCALAPPDATA%\ForeverAssistant\config.json`:

```json
{
  "modelAdapter": "openrouter",
  "openrouterModel": "google/gemini-3.8-flash",
  "openrouterApiKey": "sk-or-..."
}
```

Without `openrouterApiKey` the bridge reads the `OPENROUTER_API_KEY` environment variable. Optional settings: `openrouterReasoningEffort` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; `null` keeps the model default) and `openrouterWebSearch` (`true` by default; the model decides when to search, and each search is billed on top of tokens). Chat history is kept in `%LOCALAPPDATA%\ForeverAssistant\sessions`; every model round and tool call is logged as `openrouter.round` and `openrouter.tool`, token usage and cost per question as `openrouter.usage`. A question gets at most 20 model rounds and 3 minutes of tool calls; then the model answers with what it has.
