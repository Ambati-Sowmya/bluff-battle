# Bluff Battle

A room-code party game for 2–8 players. This folder preserves the original Node.js/WebSocket app (`server.js`) and adds a Netlify Functions + Netlify Blobs version for public hosting.

## Local original server

1. Install Node.js 20 or newer.
2. In this folder, run `npm install` and then `npm start` (or `node server.js`).
3. Open [http://localhost:3000](http://localhost:3000).

This starts the original in-memory WebSocket implementation. It remains useful as a baseline, but it is not the Netlify deployment target.

## Netlify local development

1. Install Node.js 22 (the version in `.nvmrc`) and npm.
2. Run `npm install` in this folder.
3. Run `npm run dev` and open [http://localhost:8888](http://localhost:8888).
4. Test with two browser profiles: create a room in one and join its six-character code in the other.

The Netlify version serves `public/` and calls `/.netlify/functions/game` directly. Netlify Blobs is configured with strong consistency. The function uses ETag conditional writes and bounded retries to serialize concurrent actions; room deadlines are persisted and advanced during clients' one-second polling requests. A room stops accepting actions after 12 hours without activity. An expired code can be safely reused by replacing its record with an ETag-conditional write, avoiding an unsafe unconditional delete. Local function tests use an in-memory Blobs-compatible store, so they do not prove the configured Netlify account or a public deployment is working.

## Tests and build

Run `npm test` to execute both the unchanged legacy game test and the Netlify backend suite. Run `npm run build` to run the Netlify production build locally. The tests cover room creation, idempotent retries, joining, synchronized state, action races, anonymous voting, deadlines, scoring, five rounds, winner selection, host controls, expiry, and rematch.

## Deploy to Netlify

1. Put this project folder in a GitHub repository (or use the ZIP as the source for a repository). Keep `netlify.toml`, `package.json`, and `package-lock.json` at the repository root.
2. In Netlify, choose **Add new site → Import an existing project**, connect the repository, and select this folder as the base directory if the repository contains other projects.
3. Use the detected settings from `netlify.toml`: publish directory `public`, functions directory `netlify/functions`, and the configured build command. Set the Node version to 22 if Netlify does not detect `.nvmrc`.
4. Deploy. The function code is bundled and deployed with the site; uploading only `public/` would omit the backend.
5. Open the assigned `https://…netlify.app` URL on two separate devices. Create a room on one, join from the other, then complete all five rounds and test rematch. Confirm the function is successfully deployed and Blobs access works in the Netlify site before sharing the URL.

No public deployment has been performed from this workspace. The local automated tests do not verify multi-device behavior on a live Netlify URL.

## Rules

- 5 rounds; each round presents an unusual word.
- Each player may submit one fake definition (4–150 characters); the real definition is shuffled into the vote list.
- Players vote anonymously and cannot select their own fake.
- Correctly selecting the real definition earns 1 point. Each vote for a player's fake earns that player 2 points. An incorrect voter earns no points.
- Submission timer: 60 seconds; voting timer: 35 seconds; reveal timer: 9 seconds. Completing a phase early advances immediately. A later poll applies elapsed deadlines from their scheduled timestamps.
- The host controls game start, early round advance, and rematch. Highest score after round 5 wins; ties are shared.

## Included words

Petrichor, Apricity, Defenestration, Ultracrepidarian, Sonder, Susurrus, Mellifluous, Nudiustertian, Quincunx, Limerence, Crapulence, and Borborygmus.
