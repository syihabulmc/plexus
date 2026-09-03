ALTER TABLE "provider_keys" DROP CONSTRAINT "provider_keys_provider_id_providers_id_fk";
--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;