import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";
const { chromium } = pw;
const log = [];
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 1400 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => log.push("pageerr:" + String(e).slice(0, 80)));
await page.goto("https://divinocigars.ch/", { waitUntil: "networkidle", timeout: 45000 }).catch((e) => log.push("goto:" + e));
await page.waitForTimeout(2500);

// pass the 18+ age gate
for (const txt of ["JA, ICH BIN 18+", "Ja, ich bin 18", "18+", "Yes", "Ja"]) {
  const g = page.getByRole("button", { name: txt, exact: false });
  if (await g.count().catch(() => 0)) { await g.first().click().catch(() => {}); log.push("ageGate:" + txt); break; }
}
await page.waitForTimeout(1500);

// dismiss cookie/consent if present
for (const txt of ["Akzeptieren", "Alle akzeptieren", "Accept", "Zustimmen", "OK"]) {
  const b = page.getByRole("button", { name: txt, exact: false });
  if (await b.count().catch(() => 0)) { await b.first().click().catch(() => {}); log.push("consent:" + txt); break; }
}
await page.waitForTimeout(1000);

// add an item to the cart
const add = page.getByText("In den Warenkorb", { exact: false });
const nAdd = await add.count().catch(() => 0);
log.push("addButtons:" + nAdd);
if (nAdd) { await add.first().scrollIntoViewIfNeeded().catch(() => {}); await add.first().click().catch((e) => log.push("addClick:" + e)); }
await page.waitForTimeout(1500);

// open the cart drawer — the floating "WARENKORB (n)" button
const cartBtn = page.getByRole("button", { name: /Warenkorb\s*\(/i });
if (await cartBtn.count().catch(() => 0)) { await cartBtn.first().click().catch(() => {}); log.push("clickedCartBtn"); }
else { const alt = page.getByText(/WARENKORB\s*\(/i); if (await alt.count().catch(() => 0)) { await alt.first().click().catch(() => {}); log.push("clickedCartText"); } }
await page.waitForTimeout(1500);
const opened = (await page.getByText(/Zwischensumme|Zur Kasse|Mit TWINT bezahlen|Lieferadresse|Ihr Warenkorb/i).count().catch(() => 0)) > 0;
log.push("cartOpened:" + opened);
await page.waitForTimeout(800);

// fill the customer form so the pay buttons enable (best-effort by placeholder)
const fills = [
  [/name/i, "Test Kunde"], [/mail/i, "test@example.ch"], [/(adress|strasse|street)/i, "Teststrasse 1"],
  [/(plz|zip|postal)/i, "8000"], [/(ort|city|stadt)/i, "Zürich"], [/(tel|phone)/i, "0791234567"],
];
for (const [re, val] of fills) {
  const inp = page.locator("input").filter({ hasText: "" });
  const all = await page.locator("input").all().catch(() => []);
  for (const i of all) {
    const ph = (await i.getAttribute("placeholder").catch(() => "")) || "";
    const nm = (await i.getAttribute("name").catch(() => "")) || "";
    if (re.test(ph) || re.test(nm)) { await i.fill(val).catch(() => {}); break; }
  }
}
await page.waitForTimeout(1200);
// scroll the payment buttons into view (TWINT + card) and screenshot the viewport
const pay = page.getByText(/Mit TWINT bezahlen|Pay with TWINT|Zur Kasse|bezahlen|Bezahl/i);
if (await pay.count().catch(() => 0)) { await pay.first().scrollIntoViewIfNeeded().catch(() => {}); log.push("payBtnFound"); }
await page.waitForTimeout(800);
// capture visible pay UI text for the record
const bodyTxt = (await page.locator("body").innerText().catch(() => "")) || "";
const payHints = ["TWINT", "Karte", "Card", "SumUp", "Payrexx", "Wallee", "Kasse", "Bezahl"].filter((k) => bodyTxt.includes(k));
log.push("payTextSeen:" + payHints.join(","));
await page.screenshot({ path: "/work/.ckshots/store-checkout.png", fullPage: false });
console.log(JSON.stringify({ url: page.url(), title: await page.title().catch(() => ""), log }, null, 0));
await browser.close();
