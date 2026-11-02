# Third-party notices

WoW Forever Assistant uses the components below. Runtime and development package versions are pinned in `package.json` and `bun.lock`; external datasets are updated independently at runtime.

## Bridge runtime dependencies

| Component | Version | License | Source |
|---|---|---|---|
| zod | 4.6.7 | MIT | https://github.com/colinhacks/zod |
| yauzl | 3.4.0 | MIT | https://github.com/thejoshwolfe/yauzl |
| pend (yauzl dependency) | 1.2.0 | MIT | https://github.com/andrewrk/node-pend |
| luaparse | 0.3.1 | MIT | https://github.com/fstirlitz/luaparse |
| @modelcontextprotocol/server | 2.4.0 | Apache-2.0 | https://github.com/modelcontextprotocol/typescript-sdk |
| @modelcontextprotocol/core | 2.4.0 | Apache-2.0 | https://github.com/modelcontextprotocol/typescript-sdk |

The full license texts are in each package's folder under `node_modules` after `bun install`.

## Bundled addon font

**Noto Sans Regular**, Copyright 2018 The Noto Project Authors, is distributed unmodified under the SIL Open Font License 1.1. It is used for player text, conversation titles and replies, including Cyrillic in English game clients. The font and full license are in `addon/ForeverAssistant/Fonts/`. Source: https://github.com/notofonts/noto-fonts/blob/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf. SHA-256: `b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5`.

## Development only (not needed to run the bridge)

| Component | Version | License | Use |
|---|---|---|---|
| TypeScript | 7.0.2 | Apache-2.0 | compiler |
| fengari | 0.1.5 | MIT | runs the Lua addon in tests |
| @types/bun, bun-types, @types/node, @types/yauzl, @types/luaparse | see `package.json` | MIT | type definitions |

## External programs and game addons

The programs, addons and databases below are not bundled or redistributed with this project; the assistant invokes their APIs or reads downloaded data at runtime.

- **Codex CLI** (OpenAI) — installed by the user; the bridge starts it as a separate process with the user's own subscription.
- **Auctionator** — the addon calls only its public `Auctionator.API.v1` functions in the game client. No Auctionator code is copied.
- **ForeverDB** — Data from [ForeverDB.net](https://foreverdb.net). The bridge downloads the current addon archive at runtime and statically reads selected data files from `ForeverDB` and `ForeverDB_Helper`; downloaded Lua is never executed and the database addons do not need to be installed in the game. The upstream archive, including `LICENSE.txt`, `NOTICE.txt` and `COPYING.txt`, is retained in the local cache. These files identify GPL-3.0 with an additional attribution term for ForeverDB's own material, separately attributed CMaNGOS Classic data, and client-derived material. Imported records retain their provenance; confirmation that an NPC was seen in Forever does not establish that every price or offer was observed there. The upstream database is not bundled in this repository. Offline tests and diagnostics generate synthetic format samples; they do not verify current game facts.
- **QuestieDB Forever** ([source](https://github.com/Questie/QuestieDB), [releases](https://github.com/Questie/QuestieDB/releases)) — the bridge downloads the latest stable `QuestieDB-Forever.zip` at runtime and statically decodes its packaged quest, NPC, item, object and map metadata. Lua from the archive is never executed, and QuestieDB does not need to be installed in the game. The upstream addon and database archive are not included in this repository. Credit: QuestieDB and Questie contributors. Upstream [LICENSE.md](https://github.com/Questie/QuestieDB/blob/master/LICENSE.md) documents GPLv3-covered contributions and unresolved licensing of historical contributions, with file-specific and subdirectory notices taking precedence; the entire dataset is not represented here as uniformly GPLv3-licensed. Imported Questie material retains its upstream licensing; see [PROVENANCE.md](https://github.com/Questie/QuestieDB/blob/master/PROVENANCE.md) and [Questie licensing](https://github.com/Questie/Questie/blob/master/LICENSE.md).
- **World of Warcraft** — the addon uses the documented client API. World of Warcraft is a trademark of Blizzard Entertainment, Inc.; this project is not affiliated with Blizzard.
