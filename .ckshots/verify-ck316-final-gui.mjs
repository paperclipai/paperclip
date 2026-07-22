import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";

const { chromium } = pw;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = [];

async function capture(name, viewport, url, inspect) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url, { waitUntil: "networkidle", timeout: 40_000 });
  await page.waitForTimeout(800);
  const values = await inspect(page);
  await page.screenshot({ path: `/work/.ckshots/${name}.png`, fullPage: true });
  results.push({ name, ...values, errors });
  await page.close();
}

for (const [name, viewport] of [
  ["ck316-final-desktop", { width: 1440, height: 1000 }],
  ["ck316-final-mobile", { width: 390, height: 844 }],
]) {
  await capture(
    name,
    viewport,
    "http://127.0.0.1:3100/CK/issues/CK-316",
    async (page) => ({
      approveButtons: await page.getByRole("button", { name: "Approve & send", exact: true }).count(),
      holdButtons: await page.getByRole("button", { name: "Hold", exact: true }).count(),
      rejectedCards: await page.getByText("CONFIRMATION / REJECTED", { exact: false }).count(),
      incorrectNationality: await page.getByText(/maison dominicaine|entreprise dominicaine/i).count(),
      englishCigars: await page.getByText(/\bcigars\b/i).count(),
      samplePromise: await page.getByText(/faire parvenir un échantillon/i).count(),
      swissCompany: await page.getByText("entreprise suisse", { exact: false }).count(),
      fullSignature: await page.getByText(/Alan Christopherson\s+Tres Hermanos/i).count(),
    }),
  );
}

await capture(
  "outreach-outbox-clean-desktop",
  { width: 1440, height: 1000 },
  "http://127.0.0.1:3100/CK/ck-approvals",
  async (page) => ({
    pendingOne: await page.getByText("1", { exact: true }).count(),
    hangar41: await page.getByText("Hangar41 Sàrl", { exact: true }).count(),
    artCigar: await page.getByText("ART CIGAR", { exact: false }).count(),
    incorrectNationality: await page.getByText(/maison dominicaine|entreprise dominicaine/i).count(),
    englishCigars: await page.getByText(/\bcigars\b/i).count(),
    samplePromise: await page.getByText(/faire parvenir un échantillon/i).count(),
    swissCompany: await page.getByText("entreprise suisse", { exact: false }).count(),
  }),
);

console.log(JSON.stringify(results, null, 2));
await browser.close();
