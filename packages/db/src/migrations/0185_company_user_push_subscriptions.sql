CREATE TABLE "company_user_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "company_user_push_subscriptions" ADD CONSTRAINT "company_user_push_subscriptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_user_push_subscriptions_company_idx" ON "company_user_push_subscriptions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "company_user_push_subscriptions_user_idx" ON "company_user_push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_user_push_subscriptions_endpoint_uq" ON "company_user_push_subscriptions" USING btree ("endpoint");
