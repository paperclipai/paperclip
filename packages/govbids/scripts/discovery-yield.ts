import { discoverBySearch } from "../src/core/discovery-source.js";
import { UNICORN_TARGETS } from "../src/core/discovery-targets.js";
import { applyHardFilters } from "../src/core/hard-filter.js";
const n = parseInt(process.argv[2] ?? "40", 10);
const targets = UNICORN_TARGETS.slice(0, n);
const { opportunities, pagesFetched, pagesFailed } = await discoverBySearch({
  anthropicKey: process.env.ANTHROPIC_API_KEY!, braveKey: process.env.BRAVE_API_KEY!,
  targets, resultsPerTarget: 6, pagesPerTarget: 2, throttleMs: 300,
  onProgress:(d,t,l)=>process.stdout.write(`\r  ${d}/${t} ${l.padEnd(26)}`),
});
const { kept } = applyHardFilters(opportunities);
console.log(`\n\nTargets ${targets.length} | own-site pages ${pagesFetched} (failed ${pagesFailed}) | extracted ${opportunities.length} | after hard-filter ${kept.length}`);
for(const o of opportunities) console.log(`  [${o.state}] ${o.agency}: ${o.title.slice(0,48)} | due ${o.dueDate?.slice(0,10)??"—"}`);
