import { discoverOpportunities, type DiscoveryTarget } from "../src/core/discovery-source.js";
const targets: DiscoveryTarget[] = [
  { url: "https://meridiancity.org/finance/procurement/", agency: "City of Meridian", state: "ID" },
  { url: "https://www.celina-tx.gov/Bids.aspx", agency: "City of Celina", state: "TX" },
  { url: "https://www.sussexwi.gov/Home/Components/RFP/RFP/90/93", agency: "Village of Sussex", state: "WI" },
];
const { opportunities, pagesFetched, pagesFailed } = await discoverOpportunities({
  apiKey: process.env.ANTHROPIC_API_KEY!, targets, throttleMs: 500,
  onProgress: (d,t)=>process.stdout.write(`\r  ${d}/${t}`),
});
console.log(`\nPages fetched: ${pagesFetched}/${targets.length} (our browser-UA fetcher), failed: ${pagesFailed}`);
console.log(`IT solicitations extracted: ${opportunities.length}`);
for (const o of opportunities) console.log(`  • [${o.state}] ${o.agency}: ${o.title} (due ${o.dueDate?.slice(0,10)??"—"})`);
