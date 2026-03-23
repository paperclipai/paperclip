#!/usr/bin/env tsx
/**
 * PM Agent - Query Issues Script
 * Queries Paperclip database to get issues for PM monitoring
 */

import { createDb } from "../../../packages/db/src/client.js";
import { eq, and, sql, desc } from "drizzle-orm";
import * as schema from "../../../packages/db/src/schema/index.js";

const DB_URL = process.env.DATABASE_URL || "postgresql://paperclip:paperclip@localhost:5432/paperclip";
const COMPANY_ID = "dff1b8ed-06bc-4144-a489-2bb4f1088a77"; // QH Company
const PM_AGENT_ID = "39d9711f-1218-47b8-a31a-34a22930af81";

async function main() {
  const db = createDb(DB_URL);

  console.log("🔍 PM HEARTBEAT - QUERY ISSUES");
  console.log(`Company: ${COMPANY_ID}`);
  console.log(`PM Agent: ${PM_AGENT_ID}`);
  console.log("=" .repeat(60));

  // 1. Get all issues by status
  const allIssues = await db
    .select()
    .from(schema.issues)
    .where(eq(schema.issues.companyId, COMPANY_ID))
    .orderBy(desc(schema.issues.createdAt));

  const byStatus = {
    todo: allIssues.filter(i => i.status === "todo"),
    in_progress: allIssues.filter(i => i.status === "in_progress"),
    blocked: allIssues.filter(i => i.status === "blocked"),
    in_review: allIssues.filter(i => i.status === "in_review"),
    completed: allIssues.filter(i => i.status === "completed"),
  };

  console.log("\n📊 ISSUES BY STATUS:");
  console.log(`  TODO: ${byStatus.todo.length}`);
  console.log(`  IN PROGRESS: ${byStatus.in_progress.length}`);
  console.log(`  BLOCKED: ${byStatus.blocked.length}`);
  console.log(`  IN REVIEW: ${byStatus.in_review.length}`);
  console.log(`  COMPLETED: ${byStatus.completed.length}`);

  // 2. Check IN PROGRESS issues
  console.log("\n🔄 IN PROGRESS ISSUES:");
  for (const issue of byStatus.in_progress) {
    const ageHours = (Date.now() - new Date(issue.createdAt).getTime()) / (1000 * 60 * 60);
    const stale = ageHours > 24;

    console.log(`  ${issue.identifier || issue.id.slice(0, 8)}: ${issue.title}`);
    console.log(`    Assignee: ${issue.assigneeAgentId || "unassigned"}`);
    console.log(`    Age: ${ageHours.toFixed(1)}h ${stale ? "⚠️ STALE" : ""}`);
    console.log(`    Priority: ${issue.priority || "none"}`);
  }

  // 3. Check BLOCKED issues
  console.log("\n🚫 BLOCKED ISSUES:");
  for (const issue of byStatus.blocked) {
    console.log(`  ${issue.identifier || issue.id.slice(0, 8)}: ${issue.title}`);
    console.log(`    Assignee: ${issue.assigneeAgentId || "unassigned"}`);
    console.log(`    Priority: ${issue.priority || "none"}`);
  }

  // 4. Check TODO issues without acceptance criteria
  console.log("\n📝 TODO ISSUES (potential missing acceptance criteria):");
  for (const issue of byStatus.todo.slice(0, 10)) { // Show first 10
    console.log(`  ${issue.identifier || issue.id.slice(0, 8)}: ${issue.title}`);
    console.log(`    Assignee: ${issue.assigneeAgentId || "unassigned"}`);
    console.log(`    Priority: ${issue.priority || "none"}`);
  }

  // 5. Recent COMPLETED issues (since last heartbeat - last 2 hours)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const recentCompleted = byStatus.completed.filter(
    i => i.updatedAt && new Date(i.updatedAt) > twoHoursAgo
  );

  console.log(`\n✅ RECENTLY COMPLETED (last 2h): ${recentCompleted.length}`);
  for (const issue of recentCompleted) {
    console.log(`  ${issue.identifier || issue.id.slice(0, 8)}: ${issue.title}`);
    console.log(`    Completed: ${issue.updatedAt}`);
  }

  // 6. Issues assigned to PM
  const pmIssues = allIssues.filter(i => i.assigneeAgentId === PM_AGENT_ID);
  console.log(`\n🎯 MY ASSIGNED ISSUES: ${pmIssues.length}`);
  for (const issue of pmIssues) {
    console.log(`  ${issue.identifier || issue.id.slice(0, 8)}: ${issue.title}`);
    console.log(`    Status: ${issue.status}`);
    console.log(`    Priority: ${issue.priority || "none"}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("✅ Query complete");

  process.exit(0);
}

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});
