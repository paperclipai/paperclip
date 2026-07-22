// SPC filter self-test: grade spc.ts against its golden set (spc.golden.ts). No DB, no LLM.
// Eval-first proof of the load-bearing function — run BEFORE building anything downstream.
//   cd /work/packages/db && node_modules/.bin/tsx \
//     ../plugins/plugin-ck-office/src/meeting/spc.selftest.ts
import { spcClassify } from "./spc.js";
import { SPC_GOLDEN } from "./spc.golden.js";

let pass = 0;
let fail = 0;
const failures: string[] = [];

console.log("# SPC filter golden-set self-test\n");
for (const c of SPC_GOLDEN) {
  const r = spcClassify({ series: c.series, direction: c.direction });
  let ok = r.classification === c.expect;
  if (ok && c.expectRule) ok = r.rulesFired.includes(c.expectRule);
  const mark = ok ? "PASS" : "FAIL";
  if (ok) pass++;
  else {
    fail++;
    failures.push(c.key);
  }
  const detail =
    r.classification === "insufficient_data"
      ? "(insufficient)"
      : `mean=${r.mean.toFixed(2)} σ=${r.sigmaHat.toFixed(2)} [${r.lcl.toFixed(1)},${r.ucl.toFixed(1)}] cur=${r.current}`;
  console.log(
    `  ${mark}  ${c.key.padEnd(28)} expect=${c.expect.padEnd(18)} got=${r.classification.padEnd(18)} ` +
      `rules=[${r.rulesFired.join(",")}] ${detail}`,
  );
  if (!ok) console.log(`        ^ MISMATCH — why: ${c.why}`);
}

console.log(`\n══════════ SPC GOLDEN: ${pass}/${pass + fail} passed ══════════`);
if (fail) {
  console.log(`❌ FAILURES: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("✅ SPC filter proven against its golden set (no false-signal, no missed-signal).");
process.exit(0);
