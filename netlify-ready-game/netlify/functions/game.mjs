import { getStore } from "@netlify/blobs";
import { createGameHandler } from "../../src/game-api.mjs";

const store = getStore({ name: "bluff-battle-rooms", consistency: "strong" });
const handle = createGameHandler({ store });

export default async function game(request) {
  return handle(request);
}