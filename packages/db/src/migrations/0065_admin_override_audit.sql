CREATE TABLE IF NOT EXISTS "admin_override_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"override_jwt_jti" text NOT NULL,
	"principal_user_id" uuid NOT NULL,
	"origin_ip" inet NOT NULL,
	"user_agent" text,
	"reason" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"old_status" text NOT NULL,
	"new_status" text NOT NULL,
	"request_id" text NOT NULL,
	"jwt_iat" timestamp with time zone NOT NULL,
	"jwt_exp" timestamp with time zone NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_override_audit_override_jwt_jti_unique" UNIQUE("override_jwt_jti"),
	CONSTRAINT "admin_override_reason_min_length" CHECK (char_length("reason") >= 20),
	CONSTRAINT "admin_override_exp_gt_iat" CHECK ("jwt_exp" > "jwt_iat"),
	CONSTRAINT "admin_override_ttl_max" CHECK ("jwt_exp" - "jwt_iat" <= interval '5 minutes')
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_override_audit_issue_id_issues_id_fk') THEN
  ALTER TABLE "admin_override_audit" ADD CONSTRAINT "admin_override_audit_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_override_audit_ts_idx" ON "admin_override_audit" USING btree ("ts");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_override_audit_principal_ts_idx" ON "admin_override_audit" USING btree ("principal_user_id","ts");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_override_audit_issue_ts_idx" ON "admin_override_audit" USING btree ("issue_id","ts");
--> statement-breakpoint
COMMENT ON TABLE "admin_override_audit" IS 'AKS-1597/AKS-1509 §7.2a REV-A: atomic audit + replay store for CEO admin-override JWTs. Rows are inserted in the same transaction as the issues.status UPDATE; unique_violation on override_jwt_jti is the replay guard.';
