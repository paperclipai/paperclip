import { BraveClient, looksLikeProcurementUrl } from "../src/core/brave-client.js";
const b = new BraveClient({ apiKey: process.env.BRAVE_API_KEY! });
const r = await b.search("Celina TX city bids RFP procurement information technology", 5);
console.log(`Brave returned ${r.length} results:`);
for (const x of r) console.log(`  ${looksLikeProcurementUrl(x.url)?"✅":"  "} ${x.url}`);
