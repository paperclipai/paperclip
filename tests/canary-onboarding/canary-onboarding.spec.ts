import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { listenOnFetchAllowedPort } from "../e2e/fetch-allowed-port.js";

const expectedVersion = process.env.PAPERCLIPAI_VERSION!;
const companyName = `Canary Smoke ${Date.now()}`;
const agentName = "Canary Smoke Lead";

async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const response = await request.get(url);
  expect(response.ok()).toBe(true);
  return (await response.json()) as T;
}

test("the exact published canary installs and reaches Connect a model", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // Browser storage is scoped to the Paperclip origin, not to a data directory.
  // A customer can therefore start a freshly installed server with an existing
  // onboarding draft. Creating the organization invalidates the company list;
  // this release check must prove that a refetch does not remount the wizard
  // from that old draft and leave the customer on the name screen.
  await page.addInitScript(() => {
    localStorage.setItem("paperclip-onboarding-state", JSON.stringify({
      step: 1,
      companyName: "",
      createdCompanyId: null,
    }));
  });
  let delayCompanyListRefetch = false;
  await page.route("**/api/companies", async (route) => {
    if (delayCompanyListRefetch && route.request().method() === "GET") {
      // Make the invalidation window observable. The previous implementation
      // unmounted the live wizard for this entire request.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await route.continue();
  });

  const health = await getJson<{
    status: string;
    version: string;
    serverVersion: string;
  }>(page.request, "/api/health");
  expect(health.status).toBe("ok");
  expect(health.version).toBe(expectedVersion);
  expect(health.serverVersion).toBe(expectedVersion);

  await page.goto("/onboarding");
  await expect(
    page.getByRole("heading", { name: "What is the name of your organization?" }),
  ).toBeVisible();
  await page.getByRole("textbox").fill(companyName);
  delayCompanyListRefetch = true;
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  const agentNameField = page.locator("#onboarding-agent-name");
  await expect(agentNameField).toBeVisible({ timeout: 30_000 });

  const companies = await getJson<Array<{ id: string; name: string }>>(
    page.request,
    "/api/companies",
  );
  const company = companies.find((candidate) => candidate.name === companyName);
  expect(company, `organization ${companyName} should exist through the API`).toBeTruthy();

  expect(
    await getJson<Array<{ id: string }>>(
      page.request,
      `/api/companies/${company!.id}/agents`,
    ),
  ).toEqual([]);
  expect(
    await getJson<Array<{ id: string }>>(
      page.request,
      `/api/companies/${company!.id}/issues`,
    ),
  ).toEqual([]);

  await agentNameField.fill(agentName);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();

  // Stop before Connect: a public-repository gate must not require a Claude or
  // Codex credential, and reaching this screen has not hired an agent or made
  // a first task.
  expect(
    await getJson<Array<{ id: string }>>(
      page.request,
      `/api/companies/${company!.id}/agents`,
    ),
  ).toEqual([]);
  expect(
    await getJson<Array<{ id: string }>>(
      page.request,
      `/api/companies/${company!.id}/issues`,
    ),
  ).toEqual([]);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

/**
 * The import credential mode, out of a published install.
 *
 * A fresh install reaches "Connect a model" offering a subscription and an API
 * key. The third mode reads the operator's own `~/.claude/settings.json`,
 * confirms what it found, and hires against a connection whose endpoint is the
 * gateway that file names. A recording gateway stands in for the third-party
 * one: the request header the import sends is then observable rather than
 * assumed, and the endpoint left in the connection is a value Paperclip
 * canonicalized rather than one an operator happened to type.
 *
 * What this case needs from whoever runs it, none of which the suite can
 * establish by itself:
 *
 * - `PAPERCLIPAI_VERSION` must name a published canary that already carries the
 *   two import routes. A canary published before them offers no import mode and
 *   the walk fails at the mode link, which is the correct signal.
 * - `PAPERCLIP_CANARY_SMOKE_HOME` must name a scratch directory: the config
 *   makes it the server process's `HOME`, and the fixture settings file is
 *   written into it. The case refuses to guess, because writing a real
 *   `~/.claude/settings.json` would destroy the configuration of whoever ran the
 *   command.
 * - The hire that follows the import is not driven here. Onboarding gates it on
 *   an adapter environment test, which runs the `claude` CLI against the gateway
 *   and needs a gateway that answers a real turn — a fixture returning
 *   `{ data: [] }` cannot. The assertions below cover the header, the canonical
 *   endpoint and the folded ladder instead.
 */
const importHome = process.env.PAPERCLIP_CANARY_SMOKE_HOME?.trim();

/** Long enough that its mask keeps a prefix and a suffix to recognize. */
const gatewayKey = "fixture-gateway-key-3f9a";
const maskedGatewayKey = "fixtur…3f9a";
const importedTier = "claude-opus-4-6";
const otherTier = "claude-sonnet-4-6";

type AnthropicKeyVariable = "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN";

type CapturedProbe = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
};

/**
 * A gateway that records what reaches it, the way the repo's other connection
 * fixtures do. Fetch blocks a fixed list of ports, so the address comes from the
 * shared helper rather than an ephemeral assignment.
 */
async function startRecordingGateway() {
  const captures: CapturedProbe[] = [];
  const server: Server = createServer((req, res) => {
    captures.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  const port = await listenOnFetchAllowedPort(server);
  return {
    // Written into the fixture with its `/v1` segment, the way an operator's own
    // file usually carries one: stripping it is one of the assertions below.
    address: `http://127.0.0.1:${port}/v1`,
    endpoint: `http://127.0.0.1:${port}`,
    captures,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Write the operator's settings file the import reads, keeping whatever the
 * scratch home already had so the case is not destructive even when it points at
 * a directory someone cares about.
 */
async function stageOperatorSettings(
  home: string,
  gatewayAddress: string,
  keyVariable: AnthropicKeyVariable,
) {
  const file = path.join(home, ".claude", "settings.json");
  const previous = await readFile(file, "utf8").catch(() => null);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: gatewayAddress,
          [keyVariable]: gatewayKey,
          ANTHROPIC_DEFAULT_OPUS_MODEL: importedTier,
          ANTHROPIC_DEFAULT_SONNET_MODEL: otherTier,
          // Dropped by the import: none of these belong in an agent's run
          // environment.
          API_TIMEOUT_MS: "60000",
          CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "4",
        },
      },
      null,
      2,
    ),
  );
  return async () => {
    if (previous === null) await rm(file, { force: true });
    else await writeFile(file, previous);
  };
}

/** Walk a fresh onboarding run to the connect step, on a company of its own. */
async function startOnboarding(page: Page, company: string, agent: string) {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/onboarding");
  await expect(
    page.getByRole("heading", { name: "What is the name of your organization?" }),
  ).toBeVisible();
  await page.getByRole("textbox").fill(company);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator("#onboarding-agent-name")).toBeVisible({ timeout: 30_000 });
  await page.locator("#onboarding-agent-name").fill(agent);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  return pageErrors;
}

/**
 * Scoped to this group, so an operator who has not named a scratch home loses
 * only these two cases and not the onboarding walkthrough above.
 */
test.describe("importing this machine's Claude configuration", () => {
  test.skip(
    !importHome,
    "Set PAPERCLIP_CANARY_SMOKE_HOME to a scratch directory for the published server's HOME",
  );

  for (const keyVariable of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const) {
    test(`a published install imports ${keyVariable} from this machine's Claude configuration`, async ({
      page,
    }) => {
      const company = `Import Canary ${keyVariable} ${Date.now()}`;
      const gateway = await startRecordingGateway();
      const restoreSettings = await stageOperatorSettings(
        importHome!,
        gateway.address,
        keyVariable,
      );
      try {
        const pageErrors = await startOnboarding(page, company, "Imported Gateway Lead");
        const connect = page.getByRole("button", { name: "Connect", exact: true });

        // One cycling control, whose sentence names where the next press goes, so
        // the walk reads what it says rather than counting presses.
        await page.getByRole("button", { name: /Use API key instead/ }).click();
        await page.getByRole("button", { name: /Use import from Claude config instead/ }).click();
        // The tile press is what answers the row and mounts the card the read
        // lands in; before it the step's own button has nothing to do.
        await page.getByRole("radio", { name: /Claude/ }).first().click();

        await expect(page.locator('[aria-label="Connection name"]')).toBeVisible({
          timeout: 30_000,
        });
        // Nothing to press until the card has produced a connection: this is the
        // step that must not hire an agent with no credential to run on.
        await expect(connect).toBeDisabled();
        await expect(page.locator('[aria-label="Connection name"]')).toHaveValue(
          "Imported from Claude config",
        );
        // The key travels as a mask and nothing else, whichever variable held it.
        await expect(page.getByText(`${keyVariable} · ${maskedGatewayKey}`)).toBeVisible();
        await expect(page.getByText(gatewayKey)).toHaveCount(0);
        // The tier ladder the read folded is the model this agent runs on, and it
        // is the card's initial answer rather than a question asked again.
        await expect(page.locator('[aria-label="Model"]')).toContainText(importedTier);
        await expect(page.getByText(`Also configured: ${otherTier}`)).toBeVisible();

        await page.getByRole("button", { name: "Import", exact: true }).click();
        // The probe succeeded and the connection exists: the step's own button is
        // what has been waiting for it.
        await expect(connect).toBeEnabled({ timeout: 60_000 });

        // The header the credential actually travelled under. This is the whole
        // point of remembering which variable the key came from: the two
        // Anthropic variables authenticate differently, and a gateway that
        // accepts one rejects the other with a 401.
        const probe = gateway.captures.find((capture) => capture.url === "/v1/models");
        expect(probe, JSON.stringify(gateway.captures)).toBeTruthy();
        expect(probe!.method).toBe("GET");
        if (keyVariable === "ANTHROPIC_AUTH_TOKEN") {
          expect(probe!.headers.authorization).toBe(`Bearer ${gatewayKey}`);
          expect(probe!.headers["x-api-key"]).toBeUndefined();
        } else {
          expect(probe!.headers["x-api-key"]).toBe(gatewayKey);
          expect(probe!.headers["anthropic-version"]).toBe("2023-06-01");
        }

        const companies = await getJson<Array<{ id: string; name: string }>>(
          page.request,
          "/api/companies",
        );
        const created = companies.find((candidate) => candidate.name === company);
        expect(created, `organization ${company} should exist through the API`).toBeTruthy();
        const list = await getJson<{
          connections: Array<{
            name: string;
            baseUrl?: string;
            keyVariable?: string;
            models?: { default: string; alternatives: string[] };
          }>;
        }>(page.request, `/api/companies/${created!.id}/ai-connections`);
        const connection = list.connections.find(
          (candidate) => candidate.name === "Imported from Claude config",
        );
        expect(connection, JSON.stringify(list.connections)).toBeTruthy();
        // Canonical: the `/v1` the operator's file carried is not in the stored
        // value, because the Claude CLI appends `/v1/messages` itself and a
        // doubled segment would break every run.
        expect(connection!.baseUrl).toBe(gateway.endpoint);
        expect(connection!.keyVariable).toBe(keyVariable);
        expect(connection!.models).toEqual({
          default: importedTier,
          alternatives: [otherTier],
        });
        expect(pageErrors, pageErrors.join("\n")).toEqual([]);
      } finally {
        await restoreSettings();
        await gateway.close();
      }
    });
  }
});
