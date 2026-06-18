import postgres from 'postgres';

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const sql = postgres(dbUrl);
  const companyId = "5c2551e8-cb65-4ab4-9fee-8e0001be2e41";
  const targetIssueId = "bb6d1d0f-2b04-4a4b-8371-416c84b96b38";

  // Document IDs we want to link
  const docIds = [
    "afd7a0b7-1ddc-4727-a9a5-7fd635f9f1ca", // Q3 Funded-Loan Velocity Plan & Quotas
    "9280379b-9b8e-4a38-9c26-b4085faf3c1c", // Q3 Velocity Plan — Filing Workflow
    "193a55ce-2e60-46f7-95ac-190a04db56fd", // Q3 Velocity Recovery — CEO Briefing
    "4ef8183c-a35d-473a-b996-cefc5062b7c5", // Velocity Dashboard
    "ce8f9ffe-33c7-4792-805b-bb6ba42021af", // Q3 Outcome Scenarios & Projections
    "902737bc-6627-4002-8797-c2f440ba9196"  // Q3 Velocity Tracking Dashboard
  ];

  try {
    for (const docId of docIds) {
      // Check if it already exists
      const existing = await sql`
        SELECT id FROM issue_documents
        WHERE issue_id = ${targetIssueId} AND document_id = ${docId}
      `;
      if (existing.length === 0) {
        await sql`
          INSERT INTO issue_documents (company_id, issue_id, document_id)
          VALUES (${companyId}, ${targetIssueId}, ${docId})
        `;
        console.log(`Linked document ${docId} to issue ${targetIssueId}`);
      } else {
        console.log(`Document ${docId} already linked to issue ${targetIssueId}`);
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    await sql.end();
  }
}

main();
