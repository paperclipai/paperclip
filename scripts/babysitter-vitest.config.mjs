import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/paperclip-babysit-reconciliation.test.mjs", "scripts/paperclip-babysit-reconciliation-provenance.test.mjs"],
  },
});
