ALTER TABLE `leaderboard_scores` ADD `boats_stopped` integer;--> statement-breakpoint
ALTER TABLE `leaderboard_scores` ADD `best_chain` integer;--> statement-breakpoint
ALTER TABLE `leaderboard_scores` ADD `time_held` integer;--> statement-breakpoint
ALTER TABLE `leaderboard_scores` ADD `headshots` integer;--> statement-breakpoint
CREATE INDEX `leaderboard_boats_rank_idx` ON `leaderboard_scores` (`boats_stopped`,`updated_at`,`player_id`);--> statement-breakpoint
CREATE INDEX `leaderboard_chain_rank_idx` ON `leaderboard_scores` (`best_chain`,`updated_at`,`player_id`);--> statement-breakpoint
CREATE INDEX `leaderboard_time_rank_idx` ON `leaderboard_scores` (`time_held`,`updated_at`,`player_id`);--> statement-breakpoint
CREATE INDEX `leaderboard_headshots_rank_idx` ON `leaderboard_scores` (`headshots`,`updated_at`,`player_id`);