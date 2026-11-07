import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Configure DB in wrangler.jsonc and apply the migrations described in README.md."
    );
  }

  return drizzle(env.DB, { schema });
}
