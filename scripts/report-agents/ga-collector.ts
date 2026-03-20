import { fetchGA4Metrics } from "./lib/ga4-client.js";
import { findOrCreateDailyIssue, addComment } from "./lib/paperclip-api.js";

async function main() {
  const agentId = process.env.PAPERCLIP_AGENT_ID;
  if (!agentId) throw new Error("Missing PAPERCLIP_AGENT_ID");

  console.log("GA Collector: fetching GA4 metrics...");
  const metrics = await fetchGA4Metrics();

  console.log("GA Collector: writing comment...");
  const issue = await findOrCreateDailyIssue(agentId);
  const comment = `<!-- source:ga -->\n${JSON.stringify(metrics, null, 2)}`;
  await addComment(issue.id, comment);

  console.log("GA Collector: done ✓");
}

main().catch((err) => {
  console.error("GA Collector failed:", err);
  process.exit(1);
});
