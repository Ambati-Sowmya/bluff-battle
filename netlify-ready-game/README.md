# Bluff Battle

A real-time multiplayer word-bluffing party game for 2–8 players. This repository maintains both the original stateful Node.js/WebSocket server (`server.js`) and a serverless architecture built with Netlify Functions + Netlify Blobs (`netlify/functions/game`).

## Architecture & Engineering Trade-offs

* **Stateful Baseline (`server.js`):** Uses in-memory room state over WebSockets for zero-latency local play, at the cost of single-instance memory constraints.
* **Serverless Production Target (`netlify/functions/game`):** Uses strongly consistent Netlify Blobs paired with **ETag conditional writes and bounded retries** to serialize concurrent player submissions and votes without distributed locks.
* **Deadline Advancement:** Room phase timers (submission, voting, reveal) are persisted as scheduled timestamps and evaluated deterministically during client 1-second polling requests, avoiding background cron workers.
* **Safe Code Reuse:** Rooms expire after 12 hours of inactivity; expired room codes are reclaimed via ETag-conditional replacement rather than unconditional deletes to prevent race conditions.

## Local Development

### Serverless Target (Netlify Dev)
1. Install Node.js 22 (matching `.nvmrc`) and npm.
2. Run `npm install`.
3. Run `npm run dev` and open [http://localhost:8888](http://localhost:8888).
4. Open two browser sessions to create a room and join with the 6-character code.

### Legacy WebSocket Server
1. Install Node.js 20+.
2. Run `npm install` and `npm start` (or `node server.js`).
3. Open [http://localhost:3000](http://localhost:3000).

## Testing & Build

* `npm test` — Runs both the legacy WebSocket test suite and the Netlify backend test suite (covering idempotent retries, concurrent action races, ETag conflict resolution, deadline transitions, scoring, host controls, expiry, and rematches).
* `npm run build` — Runs the local production build check.

## Deployment (Netlify)

1. Import this repository into Netlify and set the base directory to `netlify-ready-game` (if deploying from the monorepo root).
2. Confirm build settings from `netlify.toml`: publish directory `public`, functions directory `netlify/functions`, and Node.js 22.
3. Deploy and verify multi-device gameplay across a full 5-round session and rematch.

## Game Rules

* **5 Rounds:** Each round presents an obscure English word.
* **Bluff Submission (60s):** Each player submits one fake definition (4–150 characters); the real definition is shuffled into the choices.
* **Anonymous Voting (35s):** Players vote on definitions (self-voting blocked).
* **Scoring & Reveal (9s):** +1 point for finding the real definition; +2 points per vote fooled by your fake definition. Highest score after 5 rounds wins (ties shared).
* **Host Controls:** Host manages game start, early phase advancement, and rematch triggers.

## Current Word Bank

Petrichor, Apricity, Defenestration, Ultracrepidarian, Sonder, Susurrus, Mellifluous, Nudiustertian, Quincunx, Limerence, Crapulence, and Borborygmus.

## Planned Roadmap

* [ ] Expand word bank with categorized packs and non-repeating multi-game history
* [ ] Add configurable round timers and custom round counts in lobby settings
* [ ] Add host kick/transfer controls for disconnected players
* [ ] Add lightweight rate-limiting and payload sanitization hardening on function endpoints
