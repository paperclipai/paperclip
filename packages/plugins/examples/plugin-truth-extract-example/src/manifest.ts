import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip.truth-extract-example";
export const PLUGIN_VERSION = "0.2.0";
export const PAGE_ROUTE = "/truth-extract";

export const SLOT_IDS = {
  page: "truth-extract-page",
  dashboardWidget: "truth-extract-widget",
} as const;

export const EXPORT_NAMES = {
  page: "TruthExtractPage",
  dashboardWidget: "TruthExtractWidget",
} as const;

/**
 * Action keys mirror the proposal-forge Layer B command chain. Each step is
 * its own action so the UI surfaces where the chain is, and human gates
 * (atom review, claim review) are explicit rather than hidden.
 *
 * Non-goals: this plugin does NOT re-implement Layer B and does NOT
 * auto-invoke the Layer A extractor agent. Layer A is a precondition — the
 * caller attaches `ledger.json` to the issue before the forge chain starts.
 *
 * See skills/paperclip-truth-extract/references/thin-binding.md for the
 * full binding contract.
 */
export const ACTION_KEYS = {
  createRun: "create-run",
  forgeImport: "forge-import",
  forgeBulkAcceptAtoms: "forge-bulk-accept-atoms",
  forgeAttestAtomReview: "forge-attest-atom-review",
  forgeSynthesizeClaims: "forge-synthesize-claims",
  forgeAttestClaimReview: "forge-attest-claim-review",
  forgeSynthesizeBrief: "forge-synthesize-brief",
  forgeFreezeExport: "forge-freeze-export",
  getReceipt: "get-receipt",
  listRuns: "list-runs",
} as const;

export const STREAM_CHANNELS = {
  progress: "truth-extract.progress",
} as const;

export const RECEIPT_DOC_KEY = "proposal-forge.receipt.json";
export const TRANSCRIPT_DOC_KEY = "transcript.input.json";
export const LEDGER_DOC_KEY = "ledger.json";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Truth Extract (Example)",
  description:
    "Thin binding from Paperclip to proposal-forge's Layer B truth pipeline. Paperclip does not re-author truth generation — it invokes proposal-forge artisan commands via PAPERCLIP_TRUTH_FORGE_PATH and records hashes, run IDs, export IDs, and artifact paths as proposal-forge.receipt.json on the issue.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "issue.documents.read",
    "issue.documents.write",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "ui.page.register",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Truth Extract",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Truth Extract",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
    ],
  },
};

export default manifest;
