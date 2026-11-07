# Stop the Boats — Operation Tidebreak

GitHub-ready source for the current browser game, including its canvas renderer, music, recorded sound effects, ending clips and leaderboard API. This is a portable export: it contains no original hosting identity, account credentials, production leaderboard records or installed dependencies.

## Run locally (Windows, macOS or Linux)

Install **Node.js 22.13 or newer**, then open a terminal inside this folder:

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Open the local URL printed by Vite. The local leaderboard uses an emulated D1 database under `.wrangler/`; it does not need a Cloudflare account and never writes to the original game's leaderboard. The placeholder database UUID in `wrangler.jsonc` is sufficient for local development.

Music starts after a click or key press because browsers block unprompted audio. Music and SFX have separate saved mute controls.

## Checks and production preview

```sh
npm test
npm run build
npm start
```

The test suite covers game regressions, isolated runtime checks, firearm audio routing, mute/clip behavior, rankings and the real leaderboard API against in-memory SQLite. No production network calls are made by these tests. The runtime harness checks execution and state, not pixel appearance or subjective sound quality.

`npm start` previews the compiled application locally; build first. No Bash or GNU command-line tools are required by these npm scripts.

## Put the project on GitHub

1. Extract the ZIP and open the `stop-the-boats` folder.
2. Create an empty GitHub repository.
3. Upload the **contents of the folder**, including its configuration files and `.github` folder, rather than uploading the ZIP itself. GitHub Desktop is convenient on Windows.
4. The included GitHub Actions workflow runs installation, tests and a build. It does **not** deploy or require cloud credentials.

Do not commit `node_modules`, `dist`, `.wrangler`, `.env` files or `.dev.vars`. They are ignored. The lockfile is included for reproducible dependency versions; use `npm ci` rather than upgrading everything before the first build.

## Deploy with a working global leaderboard

This package targets **Cloudflare Workers with D1**. GitHub stores the source; GitHub Pages alone cannot run `/api/leaderboard`.

Authenticate to your own Cloudflare account and create a new database:

```sh
npx wrangler login
npx wrangler d1 create stop-the-boats-leaderboard
```

Copy the returned `database_id` into the existing D1 entry in `wrangler.jsonc`, replacing `00000000-0000-4000-8000-000000000000`. Keep the binding named **DB** and `migrations_dir` set to **drizzle**. You can change the Worker `name` to a name available in your account.

Then initialize your new remote database and publish:

```sh
npm run db:migrate:remote
npm run deploy
```

These commands use your account and may create billable resources under your Cloudflare plan. The ZIP does not deploy anything automatically. Remote migrations must be applied to your own selected database, not an unrelated existing database.

The new leaderboard starts empty. It retains each player's independent best score, boats stopped, best chain, time held and headshots, and prevents normalized callsign duplicates. Personal bests and player IDs are browser-local; they do not automatically transfer across devices or to a new domain. No old leaderboard records are included.

The exported game uses its **own origin** for `/api/leaderboard` and social share links. Opening an exported HTML directly with `file://` retains local personal bests but disables global submissions; run a server for the global board.

## Project map

| Path | Purpose |
| --- | --- |
| `public/game.html` | Game, rendering, controls, UI and audio playback |
| `public/audio/` | Supplied music, recorded SFX, credits and provenance |
| `public/media/` | Ending clips, posters and held final frames |
| `app/` | Web shell and `/api/leaderboard` |
| `worker/index.ts` | Cloudflare Worker entry point |
| `wrangler.jsonc` | Your deployment and D1 configuration |
| `drizzle/` | Versioned leaderboard SQL migrations |
| `tests/` | Game and API tests |
| `scripts/export-standalone.mjs` | Embed all audio and video in one HTML file |

For a standalone export, pass an **absolute output path** to `node scripts/export-standalone.mjs`. Its parent folder must already exist. A standalone file is not a replacement for the leaderboard server.

## Audio and media rights

Recorded SFX source links, creators, licences and edits are listed in [audio credits](public/audio/CREDITS.md) and the provenance JSON files beside them. The supplied music is **Triumphal Fanfare** for title/leaderboard and **Untitled** for gameplay. These user-provided music tracks and the ending videos are not claimed to be CC0; confirm you have the necessary rights before publicly redistributing them. No blanket licence is applied to the full project by this export.

## Security and competitive scores

The current arcade leaderboard accepts client-reported results and uses a browser-generated player ID; it is not server-authoritative anti-cheat or a secured player-account system. Do not attach prizes, payments or sensitive account privileges without adding authentication, abuse controls and server-side run verification. The included tests verify consistency and validation, not resistance to a modified game client.

## References

- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Vinext](https://github.com/cloudflare/vinext)

The project is pinned to the included lockfile; newer documentation may describe newer framework APIs.
