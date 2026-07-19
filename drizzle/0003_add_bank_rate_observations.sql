CREATE TABLE `bank_rate_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bank` text NOT NULL,
	`zip_code` text NOT NULL,
	`term_months` integer NOT NULL,
	`term` text NOT NULL,
	`apy` real NOT NULL,
	`observed_at` text NOT NULL,
	`observed_on` text NOT NULL,
	`source` text NOT NULL,
	`retrieval` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_rate_observations_market_term_date_unique` ON `bank_rate_observations` (`bank`,`zip_code`,`term_months`,`observed_on`);