import postgres from 'postgres';

const sql = postgres('postgres://paperclip:paperclip@127.0.0.1:54329/paperclip', {
  max: 1,
  onnotice: () => {},
  ssl: false,
  connect_timeout: 10,
  idle_timeout: 10,
});

async function main() {
  try {
    // Test the statement that causes error
    const result = await sql.unsafe(`CREATE TABLE "approvals" (
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
);`);
    console.log('SUCCESS! No error.');
    console.log('Result:', result);
  } catch (e) {
    console.log('ERROR:', e.message);
    console.log('Position:', e.position);
    console.log('Code:', e.code);
    console.log('Routine:', e.routine);
  }
  await sql.end();
}

main().catch(console.error);