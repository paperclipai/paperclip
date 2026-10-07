import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";
export const mutations = {
  deduplication: { file: "/services/costs.ts", from: "idempotencyKey: parsed.data.idempotencyKey ?? null,", to: "idempotencyKey: null,", test: "deduplicates a retried receipt" },
  company: { file: "/services/costs.ts", from: "const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];", to: "const conditions: ReturnType<typeof eq>[] = [sql`true`];", test: "isolates company reporting" },
  projection: { file: "/services/costs.ts", from: "+ ${delta}::numeric", to: "+ 0::numeric", test: "conserves agent projections" },
  threshold: { file: "/services/budgets.ts", from: "compareCents(observed.totalExact, policy.amount) >= 0", to: "compareCents(observed.totalExact, policy.amount) > 0", test: "stops at the exact budget boundary" },
};
const name = process.env.PAPERCLIP_ACCOUNTING_MUTATION;
if (name && !(name in mutations)) throw new Error(`Unknown accounting mutation: ${name}`);
const mutation = name ? mutations[name as keyof typeof mutations] : null;
export default defineConfig({
  ...base, root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [...(base.plugins ?? []), {
    name: "accounting-mutation-test-only", enforce: "pre",
    transform(code, id) {
      if (!mutation || !id.split("?")[0].endsWith(mutation.file)) return;
      if (!code.includes(mutation.from)) throw new Error(`Mutation anchor missing: ${name}`);
      // Replace precisely one site in Vite's in-memory module. Workspace source
      // stays untouched, including while another test process is running.
      console.error(`ACCOUNTING_MUTATION_APPLIED ${name}`);
      return code.replace(mutation.from, mutation.to);
    },
  }],
  test: { ...base.test, include: ["src/__tests__/cost-accounting-mutation-targets.test.ts"], coverage: { enabled: false } },
});
