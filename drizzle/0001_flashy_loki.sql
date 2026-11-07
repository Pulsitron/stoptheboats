-- Preserve existing scores before reserving callsigns. The highest-ranked row
-- keeps the original name; later duplicates receive a reserved suffix that the
-- normal callsign sanitizer cannot generate, so every row remains addressable.
WITH `ranked_callsigns` AS (
	SELECT
		`player_id`,
		`callsign`,
		ROW_NUMBER() OVER (
			PARTITION BY `callsign`
			ORDER BY `score` DESC, `updated_at` ASC, `player_id` ASC
		) AS `duplicate_rank`
	FROM `leaderboard_scores`
)
UPDATE `leaderboard_scores`
SET `callsign` = (
	SELECT
		substr(`ranked_callsigns`.`callsign`, 1, 15 - length(CAST(`ranked_callsigns`.`duplicate_rank` AS TEXT)))
		|| '~' || `ranked_callsigns`.`duplicate_rank`
	FROM `ranked_callsigns`
	WHERE `ranked_callsigns`.`player_id` = `leaderboard_scores`.`player_id`
)
WHERE `player_id` IN (
	SELECT `player_id`
	FROM `ranked_callsigns`
	WHERE `duplicate_rank` > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leaderboard_callsign_unique_idx` ON `leaderboard_scores` (`callsign`);
