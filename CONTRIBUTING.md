# Contributing to Aevum

Aevum is a browser RTS (Three.js, plain ES modules, no build step) with a small Node server for multiplayer.
Contributions are welcome: bug fixes, balance, AI, maps, performance, translations.

## Run it

- Node.js 20+. No `npm install` needed.
- `node server.js`, then open http://localhost:5173.
- Three.js loads from a CDN, so the first start needs internet.
- On localhost the new-game screen offers **Developer mode** (map revealed, endless resources, age switching).
  On other hosts add `?dev=1` to the URL (`?dev=0` turns it off again).

## Accounts and Firebase

Playing requires a Google sign-in through Firebase (Auth + Firestore, free Spark plan).

- The official game uses the project in `src/cloud/config.js`. That web config is public by design; access to the
  data is limited by Firestore security rules (every player can only write their own data).
- Contributors never get access to the official Firebase console or data, and don't need it.
- To test accounts and cloud saves against your own backend, create a free Firebase project with Google sign-in
  and Firestore, put its web config in `src/cloud/config.js` (don't commit that change), and start the server with
  `AEVUM_FIREBASE_PROJECT=<your-project-id> node server.js`.
- For offline tests the server accepts `AEVUM_NO_AUTH=1` (local only, never in production).
- Never commit keys, service-account files (`*firebase-sa*.json`, `*-adminsdk-*.json`) or `.env` files.

## Server boundaries

See [static files, logging and SSE deployment notes](docs/sunucu-siniri.md).

## Tests

Plain Node scripts in `test/`, no framework:

    node test/sim-smoke.mjs
    node test/determinism-test.mjs

Run those two plus the suites your change touches (for example `path-test.mjs` for pathing, `net-test.mjs` for
multiplayer). The simulation must stay deterministic: multiplayer is lockstep, so no `Math.random()`, `Date.now()`
or floating-point order differences inside `src/sim/`.

## Pull requests

- Fork the repo, work on a branch, open a PR against `main`. `main` deploys the live game, so every PR is reviewed.
- Keep a PR to one topic. Describe what changed and how you tested it; add a screenshot for visual changes.
- Code and comments in English. In-game text is Turkish.
- Assets: only add files you have the right to share (CC0 / CC BY are ideal) and list the source and licence
  (see `assets/sfx/LICENSES.md`). No AI-generated sound.

## Licence of contributions

By opening a pull request you agree that:

1. your contribution is your own work (or you have the right to submit it), and
2. it is licensed under the project's licences (code: AGPL-3.0-or-later; assets: as listed in `assets/LICENSE.md`),
   and you grant the project owner the right to also release it under other licence terms in the future.

## Name

"Aevum" and its logo are not licensed. Forks are welcome but must use another name.
