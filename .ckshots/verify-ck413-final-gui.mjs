import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";

const { chromium } = pw;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = [];

async function capture(name, viewport, url, assertions) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url, { waitUntil: "networkidle", timeout: 40_000 });
  await page.waitForTimeout(800);
  const values = await assertions(page);
  await page.screenshot({
    path: `/work/.ckshots/${name}.png`,
    fullPage: true,
  });
  results.push({ name, ...values, errors });
  await page.close();
}

await capture(
  "ck413-final-desktop",
  { width: 1440, height: 1000 },
  "http://127.0.0.1:3100/CK/issues/CK-413",
  async (page) => ({
    approveButtons: await page.getByRole("button", { name: "Approve & send", exact: true }).count(),
    holdButtons: await page.getByRole("button", { name: "Hold", exact: true }).count(),
    rejectedCards: await page.getByText("CONFIRMATION / REJECTED", { exact: false }).count(),
    testFeedback: await page.getByText("Workflow verification only", { exact: false }).count(),
    genericRecipient: await page.getByText("lenzburg@artcibar.ch", { exact: false }).count(),
  }),
);

await capture(
  "ck413-final-mobile",
  { width: 390, height: 844 },
  "http://127.0.0.1:3100/CK/issues/CK-413",
  async (page) => ({
    approveButtons: await page.getByRole("button", { name: "Approve & send", exact: true }).count(),
    holdButtons: await page.getByRole("button", { name: "Hold", exact: true }).count(),
    rejectedCards: await page.getByText("CONFIRMATION / REJECTED", { exact: false }).count(),
    testFeedback: await page.getByText("Workflow verification only", { exact: false }).count(),
    genericRecipient: await page.getByText("lenzburg@artcibar.ch", { exact: false }).count(),
  }),
);

await capture(
  "outreach-outbox-final-desktop",
  { width: 1440, height: 1000 },
  "http://127.0.0.1:3100/CK/ck-approvals",
  async (page) => ({
    pendingText: await page.getByText("Pending", { exact: false }).count(),
    artCigar: await page.getByText("ART CIGAR", { exact: false }).count(),
    lenzburg: await page.getByText("lenzburg@artcibar.ch", { exact: false }).count(),
    rejectedText: await page.getByText("Rejected", { exact: false }).count(),
  }),
);

console.log(JSON.stringify(results, null, 2));
await browser.close();
