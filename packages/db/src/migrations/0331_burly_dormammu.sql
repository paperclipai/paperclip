CREATE TABLE "tool_govna_authority_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invocation_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"operation_id" text NOT NULL,
	"host_context_id" text NOT NULL,
	"local_policy_revision" text NOT NULL,
	"connection_generation" integer NOT NULL,
	"request_hash" text NOT NULL,
	"signed_arguments" text NOT NULL,
	"authority_binding" jsonb NOT NULL,
	"reservation_id" text NOT NULL,
	"approval_url" text NOT NULL,
	"safe_summary" text NOT NULL,
	"ticket_generation" integer,
	"local_claim_id" text,
	"approval_expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_govna_authority_operations_state_check" CHECK ("tool_govna_authority_operations"."state" in ('pending', 'approved', 'dispatch_claimed', 'succeeded', 'failed', 'outcome_unknown', 'denied', 'expired', 'revoked', 'cancelled')),
	CONSTRAINT "tool_govna_authority_operations_generation_check" CHECK ("tool_govna_authority_operations"."connection_generation" > 0),
	CONSTRAINT "tool_govna_authority_operations_ticket_generation_check" CHECK ("tool_govna_authority_operations"."ticket_generation" is null or "tool_govna_authority_operations"."ticket_generation" > 0),
	CONSTRAINT "tool_govna_authority_operations_claim_shape_check" CHECK (("tool_govna_authority_operations"."state" in ('dispatch_claimed', 'succeeded', 'failed', 'outcome_unknown') and "tool_govna_authority_operations"."local_claim_id" is not null and "tool_govna_authority_operations"."claimed_at" is not null) or ("tool_govna_authority_operations"."state" not in ('dispatch_claimed', 'succeeded', 'failed', 'outcome_unknown') and "tool_govna_authority_operations"."local_claim_id" is null and "tool_govna_authority_operations"."claimed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "tool_govna_authority_operations" ADD CONSTRAINT "tool_govna_authority_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_govna_authority_operations" ADD CONSTRAINT "tool_govna_authority_operations_invocation_id_tool_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."tool_invocations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_govna_authority_operations" ADD CONSTRAINT "tool_govna_authority_operations_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_govna_authority_operations_invocation_uq" ON "tool_govna_authority_operations" USING btree ("invocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_govna_authority_operations_company_operation_uq" ON "tool_govna_authority_operations" USING btree ("company_id","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_govna_authority_operations_company_reservation_uq" ON "tool_govna_authority_operations" USING btree ("company_id","reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_govna_authority_operations_company_claim_uq" ON "tool_govna_authority_operations" USING btree ("company_id","local_claim_id");--> statement-breakpoint
CREATE INDEX "tool_govna_authority_operations_company_state_idx" ON "tool_govna_authority_operations" USING btree ("company_id","state");
--> statement-breakpoint
CREATE FUNCTION "lock_tool_policy_mutation"() RETURNS trigger AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(hashtextextended('paperclip:tool-policy:global', 0));
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "tool_policies_mutation_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "tool_policies"
FOR EACH STATEMENT EXECUTE FUNCTION "lock_tool_policy_mutation"();
