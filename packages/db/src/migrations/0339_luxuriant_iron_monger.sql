ALTER TABLE "company_secrets" DROP CONSTRAINT "company_secrets_scope_shape_check";--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN "owner_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN "owner_plugin_id" uuid;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_owner_plugin_id_plugins_id_fk" FOREIGN KEY ("owner_plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_company_id_owner_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","owner_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_secrets_instance_owner_key_uq" ON "company_secrets" USING btree ("company_id","owner_agent_id","owner_plugin_id","key") WHERE "company_secrets"."scope" = 'instance' and "company_secrets"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_scope_shape_check" CHECK ((
        "company_secrets"."scope" = 'company'
        and "company_secrets"."owner_user_id" is null
        and "company_secrets"."user_secret_definition_id" is null
        and "company_secrets"."owner_agent_id" is null and "company_secrets"."owner_plugin_id" is null
      ) or (
        "company_secrets"."scope" = 'user'
        and "company_secrets"."owner_user_id" is not null
        and "company_secrets"."user_secret_definition_id" is not null
        and "company_secrets"."owner_agent_id" is null and "company_secrets"."owner_plugin_id" is null
      ) or (
        "company_secrets"."scope" = 'instance'
        and "company_secrets"."owner_user_id" is null and "company_secrets"."user_secret_definition_id" is null
        and "company_secrets"."owner_agent_id" is not null and "company_secrets"."owner_plugin_id" is not null
      ));