// The default loop: fight what is close, loot, heal, sell when the bag fills.
//
// This module is both the bundled default and the worked example of the decide() contract: the
// runner hands it the world state and executes whatever action it returns. Mount your own module
// and point BOT_LOOP at it to replace this without touching the image.

export { decide, DEFAULTS } from "../scripts/bot/loop.mjs";

export const meta = { name: "basic", description: "attack the nearest monster, loot, heal, sell, patrol" };
