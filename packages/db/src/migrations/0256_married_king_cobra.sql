DROP INDEX "chat_conversations_thread_uq";--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "session_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversations_thread_uq" ON "chat_conversations" USING btree ("endpoint_id","external_conversation_id","external_thread_id","session_generation");