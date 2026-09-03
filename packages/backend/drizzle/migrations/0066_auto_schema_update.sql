PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_provider_keys` (
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
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_provider_keys`("id", "provider_id", "label", "api_key", "management_key", "notes", "enabled", "priority", "created_at", "updated_at") SELECT "id", "provider_id", "label", "api_key", "management_key", "notes", "enabled", "priority", "created_at", "updated_at" FROM `provider_keys`;--> statement-breakpoint
DROP TABLE `provider_keys`;--> statement-breakpoint
ALTER TABLE `__new_provider_keys` RENAME TO `provider_keys`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_provider_keys_lookup` ON `provider_keys` (`provider_id`,`enabled`,`priority`);