ALTER TABLE "chat_conversations" DROP CONSTRAINT "chat_conversations_company_resource_fk";
--> statement-breakpoint
ALTER TABLE "chat_deliveries" DROP CONSTRAINT "chat_deliveries_company_conversation_fk";
--> statement-breakpoint
ALTER TABLE "chat_deliveries" DROP CONSTRAINT "chat_deliveries_company_principal_fk";
--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_resource_id_chat_endpoint_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."chat_endpoint_resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_company_resource_fk" FOREIGN KEY ("company_id","resource_id") REFERENCES "public"."chat_endpoint_resources"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_principal_id_chat_external_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."chat_external_principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_company_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."chat_conversations"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_company_principal_fk" FOREIGN KEY ("company_id","principal_id") REFERENCES "public"."chat_external_principals"("company_id","id") ON DELETE no action ON UPDATE no action;