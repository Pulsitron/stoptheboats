CREATE TABLE `leaderboard_scores` (
	`player_id` text PRIMARY KEY NOT NULL,
	`callsign` text NOT NULL,
	`score` integer NOT NULL,
	`wave` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `leaderboard_score_rank_idx` ON `leaderboard_scores` (`score`,`updated_at`,`player_id`);