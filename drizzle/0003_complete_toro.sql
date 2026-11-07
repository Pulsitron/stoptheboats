DROP INDEX `leaderboard_score_rank_idx`;--> statement-breakpoint
DROP INDEX `leaderboard_boats_rank_idx`;--> statement-breakpoint
DROP INDEX `leaderboard_chain_rank_idx`;--> statement-breakpoint
DROP INDEX `leaderboard_time_rank_idx`;--> statement-breakpoint
DROP INDEX `leaderboard_headshots_rank_idx`;--> statement-breakpoint
CREATE INDEX `leaderboard_score_rank_idx` ON `leaderboard_scores` (`score`,`created_at`,`player_id`);--> statement-breakpoint
CREATE INDEX `leaderboard_boats_rank_idx` ON `leaderboard_scores` (`boats_stopped`,`created_at`,`player_id`);--> statement-breakpoint
CREATE INDEX `leaderboard_chain_rank_idx` ON `leaderboard_scores` (`best_chain`,`created_at`,`player_id`);--> statement-breakpoint
CREATE INDEX `leaderboard_time_rank_idx` ON `leaderboard_scores` (`time_held`,`created_at`,`player_id`);--> statement-breakpoint
CREATE INDEX `leaderboard_headshots_rank_idx` ON `leaderboard_scores` (`headshots`,`created_at`,`player_id`);