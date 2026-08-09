SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "agent_ownership_grants" DROP CONSTRAINT IF EXISTS "agent_ownership_grants_source_check";--> statement-breakpoint
ALTER TABLE "agent_ownership_grants" ADD CONSTRAINT "agent_ownership_grants_source_check" CHECK ("agent_ownership_grants"."source" in (
        'agent_create',
        'agent_created_default',
        'agent_hire',
        'manual_grant',
        'transfer_accept',
        'instance_admin_override',
        'instance_admin_bootstrap'
      ));
