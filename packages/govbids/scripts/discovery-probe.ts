import { discoverOpportunities, type DiscoveryTarget } from "../src/core/discovery-source.js";
const targets: DiscoveryTarget[] = [
  { url: "https://www.sussexwi.gov/Home/Components/RFP/RFP/90/93", agency: "Village of Sussex", state: "WI" },
  { url: "https://greenwoodcpw.com/about-us/active-bids/", agency: "Greenwood CPW", state: "SC" },
  { url: "https://its.ny.gov/current-open-procurement-opportunities", agency: "NY Office of IT Services", state: "NY" },
];
const apiKey = process.env.ANTHROPIC_API_KEY!;
const { opportunities, pagesFetched, pagesFailed } = await discoverOpportunities({
  apiKey, targets, throttleMs: 500,
  onProgress: (d,t)=>process.stdout.write(`\r  ${d}/${t} pages`),
});
console.log(`\n\nPages fetched: ${pagesFetched}, failed: ${pagesFailed}`);
console.log(`Discovered IT solicitations: ${opportunities.length}\n`);
for (const o of opportunities) {
  console.log(`  • ${o.title}`);
  console.log(`    agency=${o.agency} state=${o.state} due=${o.dueDate?.slice(0,10) ?? "—"}`);
  console.log(`    ${o.sourceUrl}`);
}
