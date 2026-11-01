import { defineConfig } from "@playwright/test";

const baseURL = process.env.PAPERCLIP_COLLECTION_PERF_BASE_URL;
if (!baseURL) throw new Error("Set PAPERCLIP_COLLECTION_PERF_BASE_URL to a disposable local instance.");
const target = new URL(baseURL);
if (!["http:", "https:"].includes(target.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.pathname !== "/" || target.username || target.password || target.search || target.hash) {
  throw new Error("Collection tests create fixtures and only support a disposable loopback instance.");
}
export default defineConfig({
  testDir: ".", workers: 1, fullyParallel: false, timeout: 120_000,
  use: { baseURL, browserName: "chromium", headless: true, viewport: { width: 1440, height: 900 }, serviceWorkers: "block", trace: "retain-on-failure" },
  outputDir: "../../../test-results/collections/playwright", reporter: [["list"]],
});
