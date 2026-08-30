CREATE TABLE `provider_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` integer NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`api_key` text NOT NULL,
	`management_key` text,
	`notes` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT 'datetime(''now'')' NOT NULL,
	`updated_at` text DEFAULT 'datetime(''now'')' NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_provider_keys_lookup` ON `provider_keys` (`provider_id`,`enabled`,`priority`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_provider_cooldowns` (
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`key_id` text DEFAULT '' NOT NULL,
	`expiry` integer NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_error` text,
	PRIMARY KEY(`provider`, `model`, `key_id`)
);
--> statement-breakpoint
INSERT INTO `__new_provider_cooldowns`("provider", "model", "key_id", "expiry", "consecutive_failures", "created_at", "last_error") SELECT "provider", "model", "key_id", "expiry", "consecutive_failures", "created_at", "last_error" FROM `provider_cooldowns`;--> statement-breakpoint
DROP TABLE `provider_cooldowns`;--> statement-breakpoint
ALTER TABLE `__new_provider_cooldowns` RENAME TO `provider_cooldowns`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_cooldowns_expiry` ON `provider_cooldowns` (`expiry`);--> statement-breakpoint
ALTER TABLE `meter_snapshots` ADD `key_id` text;--> statement-breakpoint
CREATE INDEX `idx_meter_key_checked` ON `meter_snapshots` (`key_id`,`checked_at`);--> statement-breakpoint
ALTER TABLE `request_usage` ADD `selected_key_label` text;--> statement-breakpoint
CREATE INDEX `idx_request_usage_selected_key_label` ON `request_usage` (`selected_key_label`);