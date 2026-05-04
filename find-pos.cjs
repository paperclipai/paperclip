const fs = require('fs');

// Statement 3 from 0000_mature_masked_marvel.sql
const stmt3 = `CREATE TABLE "approvals" (
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
);`;

console.log('Statement 3 length:', stmt3.length, 'chars');
console.log('Position 1823 (1-indexed):', stmt3[1822]);
console.log('Chars 1815-1830:', JSON.stringify(stmt3.substring(1815, 1830)));

// Find all ')' positions
for (let i = 0; i < stmt3.length; i++) {
  if (stmt3[i] === ')') {
    console.log(`Position ${i+1} (1-indexed): ')' - context: ${JSON.stringify(stmt3.substring(Math.max(0,i-20), i+1))}`);
  }
}