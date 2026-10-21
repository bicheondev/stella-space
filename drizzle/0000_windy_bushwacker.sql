CREATE TABLE `collector_entries` (
	`key` text PRIMARY KEY NOT NULL,
	`payload` text,
	`next_poll_at` integer DEFAULT 0 NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`lease_token` text DEFAULT '' NOT NULL,
	`last_started_at` integer DEFAULT 0 NOT NULL,
	`fetch_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_error` text
);
