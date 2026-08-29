#!/usr/bin/env tsx
import postgres from "postgres";
import { resolveDatabaseTarget } from "../src/runtime-config.js";

const HUMAN_GATE_TITLE_PATTERN = /\bhuman[-\s]?gate\b/i;
const DEFAULT_HUMAN_GATE_ASSIGNEE_USER_ID = "2oOBvLZFtR89lYt0VPuyXz5bWBybx2wU";
const CLOSED_STATUSES = new Set(["done", "cancelled"]);

type IssueRow = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assignee_user_id: string | null;
  assignee_agent_id: string | null;
  updated_at: Date;
};

function humanGateAssigneeUserId() {
  return process.env.PAPERCLIP_HUMAN_GATE_ASSIGNEE_USER_ID?.trim() || DEFAULT_HUMAN_GATE_ASSIGNEE_USER_ID;
}

function isMalformedHumanGate(row: IssueRow, expectedAssigneeUserId: string) {
  return row.assignee_user_id !== expectedAssigneeUserId || row.assignee_agent_id !== null;
}

function formatIssue(row: IssueRow) {
  return [
    row.identifier ?? row.id,
    row.status,
    `assigneeUserId=${row.assignee_user_id ?? "null"}`,
    `assigneeAgentId=${row.assignee_agent_id ?? "null"}`,
    `updatedAt=${row.updated_at.toISOString()}`,
    `title=${JSON.stringify(row.title)}`,
  ].join(" | ");
}

async function main() {
  const target = resolveDatabaseTarget();
  const connectionString = target.mode === "postgres"
    ? target.connectionString
    : `postgres://paperclip:paperclip@127.0.0.1:${target.port}/paperclip`;
  const companyId = process.env.PAPERCLIP_COMPANY_ID?.trim() || null;
  const expectedAssigneeUserId = humanGateAssigneeUserId();
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

  try {
    const rows = companyId
      ? await sql<IssueRow[]>`
          select id, identifier, title, status, assignee_user_id, assignee_agent_id, updated_at
          from issues
          where hidden_at is null
            and company_id = ${companyId}
            and title ~* ${HUMAN_GATE_TITLE_PATTERN.source}
          order by updated_at desc, identifier asc nulls last, id asc
        `
      : await sql<IssueRow[]>`
          select id, identifier, title, status, assignee_user_id, assignee_agent_id, updated_at
          from issues
          where hidden_at is null
            and title ~* ${HUMAN_GATE_TITLE_PATTERN.source}
          order by updated_at desc, identifier asc nulls last, id asc
        `;

    const malformed = rows.filter((row) => isMalformedHumanGate(row, expectedAssigneeUserId));
    const openMalformed = malformed.filter((row) => !CLOSED_STATUSES.has(row.status));
    const closedHistoricalMalformed = malformed.filter((row) => CLOSED_STATUSES.has(row.status));

    console.log("Human-gate assignment detector");
    console.log(`Expected supported payload: assigneeUserId=${expectedAssigneeUserId}, assigneeAgentId=null`);
    console.log(`Scope: ${companyId ? `company ${companyId}` : "all companies"}`);
    console.log("");

    console.log(`Open malformed human gates (${openMalformed.length})`);
    if (openMalformed.length === 0) {
      console.log("- none");
    } else {
      for (const row of openMalformed) console.log(`- ${formatIssue(row)}`);
    }

    console.log("");
    console.log(`Closed historical malformed human gates (${closedHistoricalMalformed.length})`);
    console.log("These are audit evidence only; do not treat historical closure as human-authenticated.");
    if (closedHistoricalMalformed.length === 0) {
      console.log("- none");
    } else {
      for (const row of closedHistoricalMalformed) console.log(`- ${formatIssue(row)}`);
    }

    if (openMalformed.length > 0) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
