import path from "node:path";

const output = path.resolve(
  process.env.PAPERCLIP_RUNNER_E2E_MERGED_REPORT_DIR ??
    "runner-e2e-merged-report",
);

export default {
  testDir: ".",
  reporter: [
    ["html", { open: "never", outputFolder: path.join(output, "html") }],
    ["junit", { outputFile: path.join(output, "playwright-junit.xml") }],
  ],
};
