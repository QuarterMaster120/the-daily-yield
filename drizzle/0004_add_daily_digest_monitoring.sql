CREATE TABLE `daily_digest_runs` (
  `run_date` text PRIMARY KEY NOT NULL,
  `status` text NOT NULL,
  `subscriber_count` integer NOT NULL DEFAULT 0,
  `sent_count` integer NOT NULL DEFAULT 0,
  `skipped_count` integer NOT NULL DEFAULT 0,
  `failed_count` integer NOT NULL DEFAULT 0,
  `error_code` text,
  `started_at` text NOT NULL,
  `finished_at` text,
  `updated_at` text NOT NULL
);
