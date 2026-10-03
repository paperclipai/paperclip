import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

export default defineConfig({
  ...base,
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    ...base.test,
    include: [
      "src/__tests__/cost-accounting-*.test.ts",
      "src/__tests__/budgets-service.test.ts",
      "src/__tests__/costs-service.test.ts",
      "src/__tests__/codex-pricing.test.ts",
      "src/__tests__/provider-billing-import.test.ts",
    ],
    coverage: {
      enabled: true,
      provider: "v8",
      reportOnFailure: true,
      reportsDirectory: "../coverage/accounting",
      reporter: ["text", "json", "json-summary", "html"],
      // Every module must retain its own floor; a well-covered helper cannot
      // hide a regression in ingestion, recovery, finance, or enforcement.
      thresholds: { perFile: true, lines: 98, branches: 90, functions: 96, statements: 96 },
      include: [
        "src/services/accounting-transaction.ts",
        "src/services/accounting-integrity.ts",
        "src/services/billing-reconciliation.ts",
        "src/services/budget-reservations.ts",
        "src/services/usage-receipts.ts",
        "src/services/receipt-fingerprint.ts",
        "src/services/cost-date-range.ts",
        "src/services/run-cost-accounting.ts",
        "src/services/costs.ts",
        "src/services/finance.ts",
        "src/services/budgets.ts",
        "src/services/codex-pricing.ts",
        "src/services/provider-billing-import.ts",
      ],
    },
  },
});
