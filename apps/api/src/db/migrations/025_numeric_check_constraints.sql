-- Migration 025: defense-in-depth CHECK constraints for numeric columns that
-- are currently only bounded by zod validation at the API layer (drives,
-- groups, settings, speed cameras, vehicles, fuel logs). None of these are
-- functional bugs today, but a bad row from a script, a future API version,
-- or a zod regression would otherwise sail straight into the DB.
--
-- Verified before writing this migration that no existing row in the live DB
-- violates any of the constraints below (all counts were 0), so this is
-- safe to apply without a NOT VALID / VALIDATE CONSTRAINT split.

-- drive_history: distanceM/durationS/memberCount are all
-- z.number().int().min(...)-guarded in drives/drives.routes.ts but have no
-- DB-level floor.
ALTER TABLE drive_history ADD CONSTRAINT drive_history_distance_m_nonneg CHECK (distance_m >= 0);
ALTER TABLE drive_history ADD CONSTRAINT drive_history_duration_s_nonneg CHECK (duration_s >= 0);
ALTER TABLE drive_history ADD CONSTRAINT drive_history_avg_speed_nonneg CHECK (avg_speed_kph IS NULL OR avg_speed_kph >= 0);
ALTER TABLE drive_history ADD CONSTRAINT drive_history_top_speed_nonneg CHECK (top_speed_kph IS NULL OR top_speed_kph >= 0);
ALTER TABLE drive_history ADD CONSTRAINT drive_history_member_count_positive CHECK (member_count >= 1);

-- convoy_groups: gapThresholdM / pttMaxSeconds are zod-bounded in
-- groups/groups.routes.ts (min 50-100 / 5) with no DB-level floor.
ALTER TABLE convoy_groups ADD CONSTRAINT convoy_groups_gap_threshold_positive CHECK (gap_threshold_m > 0);
ALTER TABLE convoy_groups ADD CONSTRAINT convoy_groups_ptt_max_seconds_positive CHECK (ptt_max_seconds > 0);

-- user_settings: same fields, zod-bounded in settings/settings.routes.ts,
-- no DB-level floor.
ALTER TABLE user_settings ADD CONSTRAINT user_settings_hazard_alert_distance_positive CHECK (hazard_alert_distance_m > 0);
ALTER TABLE user_settings ADD CONSTRAINT user_settings_ptt_max_seconds_positive CHECK (ptt_max_seconds > 0);
ALTER TABLE user_settings ADD CONSTRAINT user_settings_tile_cache_limit_positive CHECK (tile_cache_limit_mb > 0);

-- speed_cameras: speedLimitKph/direction are zod-bounded in
-- speed-cameras/speed-cameras.routes.ts; upvotes/downvotes are only ever
-- incremented by the app but have no DB-level floor either.
ALTER TABLE speed_cameras ADD CONSTRAINT speed_cameras_speed_limit_positive CHECK (speed_limit_kph IS NULL OR speed_limit_kph > 0);
ALTER TABLE speed_cameras ADD CONSTRAINT speed_cameras_direction_range CHECK (direction IS NULL OR (direction >= 0 AND direction < 360));
ALTER TABLE speed_cameras ADD CONSTRAINT speed_cameras_upvotes_nonneg CHECK (upvotes >= 0);
ALTER TABLE speed_cameras ADD CONSTRAINT speed_cameras_downvotes_nonneg CHECK (downvotes >= 0);

-- vehicles: year is zod-bounded (1885-2100) in vehicles/vehicles.routes.ts
-- with no DB-level floor/ceiling.
ALTER TABLE vehicles ADD CONSTRAINT vehicles_year_range CHECK (year IS NULL OR (year >= 1885 AND year <= 2100));

-- fuel_logs: mpg has NO validation at all today, not even at the API layer
-- (fuel/fuel.routes.ts only checks gallons/pricePerGallon > 0 before insert)
-- -- this is the one column here with zero existing guard of any kind.
ALTER TABLE fuel_logs ADD CONSTRAINT fuel_logs_mpg_positive CHECK (mpg IS NULL OR mpg > 0);
