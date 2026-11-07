# Stop the Boats — Operation Tidebreak

GitHub-ready source for the current browser game, including its canvas renderer, music, recorded sound effects, ending clips and leaderboard API. The existing Cloudflare D1 binding is preserved from your supplied project. The archive contains no account credentials, production leaderboard records or installed dependencies.

## Run locally (Windows, macOS or Linux)

Install **Node.js 22.13 or newer**, then open a terminal inside this folder:

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. The local leaderboard uses an emulated D1 database under `.wrangler/`; it does not need a Cloudflare account and never writes to the original game's leaderboard. `npm run dev` now applies outstanding local migrations automatically before starting. `npm start` does the same for the local production preview.

Music starts after a click or key press because browsers block unprompted audio. Music and SFX have separate saved mute controls.

## Phones and tablets

The game now includes simultaneous thumb movement and FIRE controls, touch sniper aiming, and separate portrait/landscape layouts. It also adapts rendering quality to the device, keeps controls clear of notches, and pauses safely when rotating during a run. Desktop keyboard and mouse controls still work.

See [MOBILE-UPDATE.md](MOBILE-UPDATE.md) for controls, changes and verification details. Deploy the updated source in the same way as the existing project; keep `public/mobile.css` alongside `public/game.html`. This remains the supplied Cloudflare/D1 project.

## Checks and production preview

```sh
npm test
npm run build
npm start
```

The test suite covers game regressions, isolated runtime checks, firearm audio routing, mute/clip behavior, rankings and the real leaderboard API against in-memory SQLite. The additional `test:leaderboard-db` check runs the actual API in workerd with an isolated, persistent local D1 database, applies all migrations and verifies records after a runtime restart. No production network calls are made by these tests. The runtime harness checks execution and state, not pixel appearance or subjective sound quality.

`npm start` previews the compiled application locally; build first. No Bash or GNU command-line tools are required by these npm scripts.

## Put the project on GitHub

1. Extract the ZIP and open the `stop-the-boats-mobile` folder.
2. Create an empty GitHub repository.
3. Upload the **contents of the folder**, including its configuration files and `.github` folder, rather than uploading the ZIP itself. GitHub Desktop is convenient on Windows.
4. The included GitHub Actions workflow runs installation, tests and a build. It does **not** deploy or require cloud credentials.

Do not commit `node_modules`, `dist`, `.wrangler`, `.env` files or `.dev.vars`. They are ignored. The lockfile is included for reproducible dependency versions; use `npm ci` rather than upgrading everything before the first build.

## Deploy with a working global leaderboard

This package targets **Cloudflare Workers with D1**. GitHub stores the source; GitHub Pages alone cannot run `/api/leaderboard`.

For an update to the existing game, keep the current **DB** binding and database ID in `wrangler.jsonc`. Do not create a replacement database: that would give you a separate, empty leaderboard.

From the project folder:

```sh
npm ci
npx wrangler login
npm run deploy
```

If already logged into the correct Cloudflare account, skip the login command. `npm run deploy` builds first, applies outstanding remote D1 migrations, then deploys the Worker. If a migration fails, deployment stops. Existing scores are retained by the supplied migrations; older statistics remain unknown until recorded by a new run.

For Cloudflare Git builds, use `npm run build` as the build command and `npm run db:migrate:remote && npx wrangler deploy` as the deploy command. Using `npx wrangler deploy` alone does not apply D1 migrations.

To check a deployed address without inserting any test scores:

```sh
npm run check:leaderboard -- https://your-game-address
```

Enter a unique callsign once in World Rankings. Completed personal bests then sync automatically. The game retains unsent bests on the device, retries temporary connection failures, and retries when the connection returns or rankings reopen. A callsign conflict needs a different name; it cannot be fixed by repeated uploads. A successful save is shown only after the server confirms the records.

Personal bests and player IDs are browser-local; they do not automatically transfer across devices or domains. If browser storage is blocked, identity remains stable for the current page session but cannot survive a full reload. Keep using the same deployment URL to retain existing device records.

For a deliberately separate new deployment, create your own D1 database and replace the ID with that new database's ID. This will create a separate leaderboard. This package runs its backend on Cloudflare Workers/D1; uploading static files to Vercel or GitHub Pages alone does not provide `/api/leaderboard`.

The exported game uses its **own origin** for `/api/leaderboard` and social share links. Opening an exported HTML directly with `file://` retains local personal bests but disables global submissions; run a server for the global board.

## Project map

| Path | Purpose |
| --- | --- |
| `public/game.html` | Game, rendering, controls, UI and audio playback |
| `public/mobile.css` | Responsive touch interface, safe areas and scrollable menus |
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
