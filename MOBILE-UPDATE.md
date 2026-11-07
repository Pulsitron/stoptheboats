# Phone and tablet update

## Using the controls

- Hold the left/right arrow with one thumb and FIRE with the other. Both work together.
- Dragging the battlefield still moves the soldier and fires the rifle.
- Tap SNIPER, drag the view to aim precisely, and hold FIRE to shoot as the rifle reloads. Tap RIFLE to return.
- Tap FLARE or DASH. Stored sea mines, mortar volleys and air strikes remain separate buttons.
- Rotating the device preserves the operation and pauses it. Tap **Resume operation** when ready.
- Switching apps, opening help/rankings/audio, or losing focus safely releases held controls.

## What changed

- Larger thumb controls and at least 44 CSS-pixel action targets.
- Phone portrait, short landscape and tablet layouts with space above the controls for the soldier.
- Safe-area handling for notches and home indicators, including the embedded game shell.
- Scrollable title screen, help, rankings and audio dialogs; larger text entry fields.
- Independent multi-touch ownership, so lifting one finger does not stop another action.
- Fine relative touch aiming in the sniper scope; no accidental shot when starting an aiming drag.
- Live world remapping during resize: boats retain their progress, and projectiles, mines, flares and support targets follow the new viewport.
- Bounded canvas resolution on high-density displays. Economy mode now lowers the backing-store resolution and rebuilds cached scenery, in addition to reducing effects.
- Paused scenes redraw less frequently; hidden pages skip simulation and drawing.
- The standalone exporter embeds the mobile CSS with the existing audio/video.

## Install / deploy

Replace the old source with this folder's contents, then use the commands in README.md. Do not upload node_modules or old build caches; use `npm ci` and `npm run build` for a fresh build.

The hosting target, leaderboard API, game rules, music and videos are retained. The archive contains source files, assets, the dependency lockfile and tests. It does not include installed dependencies, local database contents or stale compiled builds.

## Verification

- Unit and game/API regression suites.
- Isolated runtime checks for multi-touch, cancellation, pause/resume, rotation, viewport changes and adaptive resolution.
- Five simulated hardware/viewport profiles: 320×568, 667×375, 844×390, 768×1024 and 1366×1024.
- Browser layout review at phone and tablet dimensions, including menus and touch-target geometry.
- Production build and standalone asset embedding check.

These checks target current iOS/iPadOS and Android browsers, alongside desktop browsers. They are browser and simulated-device checks, not a physical-device certification. Older browsers, embedded webviews and hardware with very limited memory may still behave differently. A real iPhone/iPad and Android check is recommended before release.

Run `npm test` for the complete suite, or `npm run test:mobile` for the device profiles.

## Leaderboard follow-up

The Field Manual's Music & sound credits accordion has been removed. Audio licence/provenance files remain with the assets.

Completed records now upload when a callsign is chosen, retry temporary failures, and recover on reconnect or reopening rankings. The UI only confirms a save when the server returns the matching saved record. Local records and existing player IDs are preserved.

The supplied project uses Cloudflare Workers with D1. To activate the server-side setup fix, deploy using `npm run deploy`; this now applies outstanding database migrations before publishing. The configured database ID is preserved, so an update can retain the existing board. Do not replace it with a fresh database when updating the same game. See README.md for local, CLI and Cloudflare Git-build instructions.

Saving was verified against an isolated real local D1 database, including a server restart. The remote production database could not be inspected from this environment.
