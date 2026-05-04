const postgres = require('postgres');

async function main() {
  // Connect to embedded postgres
  const sql = postgres('postgres://localhost:54329?dbname=paperclip', {
    max: 1,
    onnotice: () => {},
    ssl: false
  });

  try {
    // Test statement 3 from 0000
    const result = await sql.unsafe(`
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"decision_note" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
`);
    console.log('SUCCESS! No error.');
  } catch (e) {
    console.log('ERROR:', e.message);
    console.log('Position:', e.position);
    console.log('Code:', e.code);
  }

  await sql.end();
}

main().catch(console.error);