CREATE TABLE "provider_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" integer NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"api_key" text NOT NULL,
	"management_key" text,
	"notes" text,
	"enabled" integer DEFAULT 1 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT 'now()' NOT NULL,
	"updated_at" text DEFAULT 'now()' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_cooldowns" ADD COLUMN "key_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_cooldowns" DROP CONSTRAINT "provider_cooldowns_provider_model_pk";
--> statement-breakpoint
ALTER TABLE "provider_cooldowns" ADD CONSTRAINT "provider_cooldowns_provider_model_key_id_pk" PRIMARY KEY("provider","model","key_id");
--> statement-breakpoint
ALTER TABLE "meter_snapshots" ADD COLUMN "key_id" text;
--> statement-breakpoint
ALTER TABLE "request_usage" ADD COLUMN "selected_key_label" text;
--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_provider_keys_lookup" ON "provider_keys" USING btree ("provider_id","enabled","priority");
--> statement-breakpoint
CREATE INDEX "idx_meter_key_checked" ON "meter_snapshots" USING btree ("key_id","checked_at");
--> statement-breakpoint
CREATE INDEX "idx_request_usage_selected_key_label" ON "request_usage" USING btree ("selected_key_label");
