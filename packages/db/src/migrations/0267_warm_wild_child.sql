CREATE TABLE "chat_discord_command_owners" (
	"application_id" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_discord_command_owners_application_check" CHECK ("chat_discord_command_owners"."application_id" ~ '^[1-9][0-9]{16,19}$')
);
