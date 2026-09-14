// Run from the repo: node --import ./cli/node_modules/tsx/dist/loader.mjs ui/storybook/scripts/generate-runtime-preview-pages.mjs
import { writeFile } from "node:fs/promises";
import { previewPage } from "../../../server/src/services/runtime-services/preview-pages.ts";

const boardURL = "https://foo.paperclip.example.invalid/runtime-services/review";
const stoppedMessage = "Open Paperclip to start this service explicitly or review its status.";
const cases = {
  starting: { status: 200, title: "Starting your preview", message: "Your files are retained. The app will open here when it is ready.", boardURL, poll: true },
  sleeping: { status: 503, title: "Preview is sleeping", message: stoppedMessage, boardURL },
  stopped: { status: 503, title: "Preview is stopped", message: stoppedMessage, boardURL },
  failed: { status: 503, title: "Preview needs attention", message: stoppedMessage, boardURL },
  unavailable: { status: 502, title: "Preview is unavailable", message: "The app could not be reached. Retry shortly, or check its status in Paperclip." },
  notFound: { status: 404, title: "Preview not found", message: "Preview not found" },
  accessRequired: { status: 403, title: "Preview access required", message: "Your account does not have access to this preview. Ask a company administrator for access.", boardURL },
  signIn: { status: 401, title: "Sign in to open this preview", message: "Sign in to Paperclip to continue to this preview.", boardURL },
  shareUnavailable: { status: 404, title: "Share link unavailable", message: "This link has expired, was revoked, or no longer points to an available preview." },
};
const output = {};
for (const [key, input] of Object.entries(cases)) {
  const response = { status() { return this; }, set() { return this; }, type() { return this; }, send(html) { output[key] = html.replace(/nonce="[^"]+"/g, 'nonce="storybook-fixture"'); } };
  previewPage(response, input);
}
await writeFile(new URL("../fixtures/runtimePreviewPages.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
