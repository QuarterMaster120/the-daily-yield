CREATE TABLE `rate_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series` text NOT NULL,
	`observed_on` text NOT NULL,
	`rate` real NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_observations_series_date_unique` ON `rate_observations` (`series`,`observed_on`);--> statement-breakpoint
CREATE TABLE `subscribers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscribers_email_unique` ON `subscribers` (`email`);