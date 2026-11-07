import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const leaderboardScores = sqliteTable(
  "leaderboard_scores",
  {
    playerId: text("player_id").primaryKey(),
    callsign: text("callsign").notNull(),
    score: integer("score").notNull(),
    wave: integer("wave").notNull(),
    // NULL means an older client never recorded this metric, not a zero result.
    boatsStopped: integer("boats_stopped"),
    bestChain: integer("best_chain"),
    timeHeld: integer("time_held"),
    headshots: integer("headshots"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("leaderboard_score_rank_idx").on(
      table.score,
      table.createdAt,
      table.playerId
    ),
    index("leaderboard_boats_rank_idx").on(table.boatsStopped, table.createdAt, table.playerId),
    index("leaderboard_chain_rank_idx").on(table.bestChain, table.createdAt, table.playerId),
    index("leaderboard_time_rank_idx").on(table.timeHeld, table.createdAt, table.playerId),
    index("leaderboard_headshots_rank_idx").on(table.headshots, table.createdAt, table.playerId),
    uniqueIndex("leaderboard_callsign_unique_idx").on(table.callsign),
  ]
);
