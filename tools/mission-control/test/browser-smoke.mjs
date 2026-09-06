import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { chromium } from "@playwright/test";
import { createServer as createMissionControlServer } from "../src/server.mjs";

const COMPANY_ID = "company-smoke";
const FIXTURE_STATE = Object.freeze({
  company: { id: COMPANY_ID, name: "BrainPulse Ventures LLC" },
  heartbeat: "2026-08-31T15:00:00Z",
  agents: [
    {
      id: "chief-of-staff",
      name: "Chief of Staff",
      role: "ceo",
      model: "fixture-model",
      status: "idle",
      health: "unknown",
      link: "/agents/chief-of-staff",
    },
    {
      id: "ops-engineer",
      name: "Ops Engineer",
      model: "fixture-model",
      status: "idle",
      health: "healthy",
      link: "/agents/ops-engineer",
    },
  ],
  routines: [{ id: "routine-1", title: "Daily operations brief", status: "active", link: "/routines/routine-1", triggers: [] }],
  decisions: [{ id: "approval-1", title: "Ops change approval", status: "pending", protected: true, link: "/approvals/approval-1" }],
  timeline: [{ id: "issue-1", identifier: "PAP-1", title: "Mission Control smoke", status: "completed", link: "/issues/PAP-1" }],
  generatedAt: "2026-08-31T15:00:00Z",
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function main() {
  const fixture = createHttpServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/fixture/state") {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "NOT_FOUND" }));
      return;
    }
    const body = JSON.stringify(FIXTURE_STATE);
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
  });

  let sidecar;
  let browser;
  try {
    const fixturePort = await listen(fixture);
    const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
    sidecar = createMissionControlServer({
      baseUrl: fixtureUrl,
      client: {
        async readCompanyState(companyId) {
          assert.equal(companyId, COMPANY_ID);
          const response = await fetch(`${fixtureUrl}/fixture/state`);
          assert.equal(response.status, 200);
          return response.json();
        },
      },
    });
    const sidecarPort = await listen(sidecar);
    const sidecarUrl = `http://127.0.0.1:${sidecarPort}`;

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${sidecarUrl}/?companyId=${encodeURIComponent(COMPANY_ID)}`, { waitUntil: "networkidle" });

    const landmarks = page.locator("main section[aria-labelledby]");
    assert.equal(await landmarks.count(), 4, "exactly four main landmark sections should be rendered");

    const landmarkNames = ["Company overview", "Agent graph", "Decision rail", "Operations timeline"];
    for (const name of landmarkNames) {
      const landmark = page.getByRole("region", { name, exact: true }).and(landmarks);
      assert.equal(await landmark.count(), 1, `${name} landmark should be rendered once`);
      assert.equal(await landmark.isVisible(), true, `${name} landmark should be visible`);
    }

    assert.equal(await page.locator(".site-header").getByText("Paperclip / Operations", { exact: true }).isVisible(), true, "legal masthead should be visible");
    assert.equal(await page.getByText("Read-only Mission Control", { exact: true }).isVisible(), true, "read-only label should be visible");
    assert.equal(await page.locator(".agent-lane .status-healthy").count(), 1, "one healthy lane should be visible");
    assert.equal(await page.locator(".decision-card:not(.decision-empty)").count(), 1, "one approval card should be visible");
    assert.equal(await page.locator(".decision-card a.source-link").count(), 1, "the approval should expose one source link");
    assert.match(await page.locator(".decision-card a.source-link").getAttribute("href"), new RegExp(`^${fixtureUrl}/approvals/approval-1$`));

    console.log("PASS browser smoke: four zones, masthead, read-only label, healthy lane, approval card, source link");
  } finally {
    if (browser) await browser.close();
    if (sidecar) await close(sidecar);
    await close(fixture);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
