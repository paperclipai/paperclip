import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { test, expect, type Browser, type Page } from "@playwright/test";

const BASE = process.env.PAPERCLIP_E2E_BASE_URL ?? "http://127.0.0.1:3105";
const DATA_DIR = process.env.PAPERCLIP_E2E_DATA_DIR ?? process.env.PAPERCLIP_HOME;
const CONFIG_PATH = process.env.PAPERCLIP_E2E_CONFIG_PATH ?? path.resolve(process.cwd(), ".paperclip/config.json");
const BOOTSTRAP_SCRIPT_PATH = path.resolve(process.cwd(), "packages/db/scripts/create-auth-bootstrap-invite.ts");
const OWNER_PASSWORD = "paperclip-owner-password";
const INVITED_PASSWORD = "paperclip-invited-password";

type HumanUser = {
  name: string;
  email: string;
  password: string;
};

type CompanySummary = {
  id: string;
  name: string;
  issuePrefix?: string | null;
};

type CompanyMember = {
  id: string;
  membershipRole: "owner" | "admin" | "operator" | "viewer";
  status: "pending" | "active" | "suspended";
  user: { id: string; email: string | null; name: string | null } | null;
};

type SessionJsonResponse<T> = {
  ok: boolean;
  status: number;
  text: string;
  json: T | null;
};

const runId = Date.now();
const companyName = `MU-Auth-${runId}`;
const ownerUser: HumanUser = {
  name: "Owner User",
  email: `owner-${runId}@paperclip.local`,
  password: OWNER_PASSWORD,
};
const invitedUser: HumanUser = {
  name: "Invited User",
  email: `invitee-${runId}@paperclip.local`,
  password: INVITED_PASSWORD,
};

function createBootstrapInvite() {
  if (!DATA_DIR) {
    throw new Error("PAPERCLIP_E2E_DATA_DIR or PAPERCLIP_HOME is required for authenticated bootstrap tests");
  }
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Authenticated bootstrap config not found at ${CONFIG_PATH}`);
  }
  if (!existsSync(BOOTSTRAP_SCRIPT_PATH)) {
    throw new Error(`Authenticated bootstrap helper not found at ${BOOTSTRAP_SCRIPT_PATH}`);
  }

  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  return execFileSync(
    pnpmCommand,
    [
      "--filter",
      "@paperclipai/db",
      "exec",
      "tsx",
      BOOTSTRAP_SCRIPT_PATH,
      "--config",
      CONFIG_PATH,
      "--base-url",
      BASE,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        PAPERCLIP_HOME: DATA_DIR,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  ).trim();
}

async function signUp(page: Page, user: HumanUser) {
  await page.goto(`${BASE}/auth`);
  await expect(page.getByRole("heading", { name: "Sign in to Paperclip" })).toBeVisible();
  await page.getByRole("button", { name: "Create one" }).click();
  await expect(page.getByRole("heading", { name: "Create your Paperclip account" })).toBeVisible();
  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
}

async function acceptBootstrapInvite(page: Page, inviteUrl: string) {
  await page.goto(inviteUrl);
  await expect(page.getByRole("heading", { name: "Bootstrap your Paperclip instance" })).toBeVisible();
  await page.getByRole("button", { name: "Accept bootstrap invite" }).click();
  await expect(page.getByRole("heading", { name: "Bootstrap complete" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("link", { name: "Open board" }).click();
}

async function createCompanyForSession(page: Page, nextCompanyName: string) {
  const createRes = await sessionJsonRequest<CompanySummary>(page, `${BASE}/api/companies`, {
    method: "POST",
    data: { name: nextCompanyName },
  });
  expect(createRes.ok).toBe(true);
  expect(createRes.json).toBeTruthy();
  return createRes.json!;
}

async function createAuthenticatedInvite(page: Page, companyPrefix: string) {
  await page.goto(`${BASE}/${companyPrefix}/company/settings`);
  await expect(page.getByTestId("company-settings-invites-section")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("company-settings-human-invite-role").selectOption("operator");
  await page.getByTestId("company-settings-create-human-invite").click();
  const inviteField = page.getByTestId("company-settings-human-invite-url");
  await expect(inviteField).toBeVisible({ timeout: 20_000 });
  return (await inviteField.inputValue()).trim();
}

async function signUpFromInvite(page: Page, inviteUrl: string, user: HumanUser) {
  await page.goto(inviteUrl);
  await expect(page.getByText("Sign in or create an account before submitting a human join request.")).toBeVisible();
  await page.getByRole("link", { name: "Sign in / Create account" }).click();
  await expect(page).toHaveURL(/\/auth\?next=/);
  await expect(page.getByRole("heading", { name: "Sign in to Paperclip" })).toBeVisible();
  await page.getByRole("button", { name: "Create one" }).click();
  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).toHaveURL(new RegExp(`/invite/[^/]+$`), { timeout: 20_000 });
}

async function acceptHumanInvite(page: Page) {
  await expect(page.getByRole("button", { name: "Join company" })).toBeEnabled();
  await page.getByRole("button", { name: "Join company" }).click();
  await expect(page.getByRole("heading", { name: "You joined the company" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("link", { name: "Open board" }).click();
}

async function sessionJsonRequest<T>(
  page: Page,
  url: string,
  options: {
    method?: string;
    data?: unknown;
  } = {}
) {
  return page.evaluate(
    async ({ url: targetUrl, method, data }) => {
      const response = await fetch(targetUrl, {
        method,
        credentials: "include",
        headers: data === undefined ? undefined : { "Content-Type": "application/json" },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const text = await response.text();
      let json: unknown = null;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return {
        ok: response.ok,
        status: response.status,
        text,
        json,
      };
    },
    {
      url,
      method: options.method ?? "GET",
      data: options.data,
    }
  ) as Promise<SessionJsonResponse<T>>;
}

async function waitForMember(page: Page, companyId: string, email: string) {
  let member: CompanyMember | null = null;
  await expect
    .poll(
      async () => {
        const membersRes = await sessionJsonRequest<{ members: CompanyMember[] }>(
          page,
          `${BASE}/api/companies/${companyId}/members`
        );
        expect(membersRes.ok).toBe(true);
        const body = membersRes.json;
        if (!body) return null;
        member = body.members.find((entry) => entry.user?.email === email) ?? null;
        return member;
      },
      {
        timeout: 20_000,
        intervals: [500, 1_000, 2_000],
      }
    )
    .toMatchObject({
      status: "active",
      membershipRole: "operator",
      user: { email },
    });
  return member!;
}

async function waitForMemberRole(
  page: Page,
  companyId: string,
  memberId: string,
  membershipRole: CompanyMember["membershipRole"]
) {
  await expect
    .poll(
      async () => {
        const membersRes = await sessionJsonRequest<{ members: CompanyMember[] }>(
          page,
          `${BASE}/api/companies/${companyId}/members`
        );
        expect(membersRes.ok).toBe(true);
        const body = membersRes.json;
        if (!body) return null;
        return body.members.find((member) => member.id === memberId) ?? null;
      },
      {
        timeout: 20_000,
        intervals: [500, 1_000, 2_000],
      }
    )
    .toMatchObject({
      id: memberId,
      membershipRole,
    });
}

async function newPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

test.describe("Multi-user: authenticated mode", () => {
  test("authenticated humans can bootstrap, invite, join, and respect viewer restrictions", async ({
    browser,
    page,
  }) => {
    test.setTimeout(180_000);

    const healthRes = await page.request.get(`${BASE}/api/health`);
    expect(healthRes.ok()).toBe(true);
    const health = (await healthRes.json()) as {
      deploymentMode?: string;
      bootstrapStatus?: string;
    };
    expect(health.deploymentMode).toBe("authenticated");

    await signUp(page, ownerUser);
    await acceptBootstrapInvite(page, createBootstrapInvite());

    const company = await createCompanyForSession(page, companyName);
    const companyPrefix = company.issuePrefix ?? company.id;
    await page.goto(`${BASE}/${companyPrefix}/dashboard`);
    await expect(page.getByTestId("layout-account-menu-trigger")).toContainText(ownerUser.name);
    await page.getByTestId("layout-account-menu-trigger").click();
    await expect(page.getByText(ownerUser.email)).toBeVisible();
    const inviteUrl = await createAuthenticatedInvite(page, companyPrefix);

    const invited = await newPage(browser);
    try {
      await signUpFromInvite(invited.page, inviteUrl, invitedUser);
      await acceptHumanInvite(invited.page);
      await expect(invited.page).not.toHaveURL(/\/auth/, { timeout: 10_000 });

      const joinedMember = await waitForMember(page, company.id, invitedUser.email);

      await page.goto(`${BASE}/${companyPrefix}/company/settings`);
      const roleSelect = page.getByTestId(`company-settings-member-role-${joinedMember.id}`);
      await expect(roleSelect).toBeVisible({ timeout: 20_000 });
      await roleSelect.selectOption("viewer");
      await expect(roleSelect).toHaveValue("viewer");
      await waitForMemberRole(page, company.id, joinedMember.id, "viewer");

      await invited.page.goto(`${BASE}/${companyPrefix}/company/settings`);
      await expect(
        invited.page.getByText("Your current company role cannot create human invites.")
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        invited.page.getByTestId("company-settings-create-human-invite")
      ).toHaveCount(0);

      const forbiddenInviteRes = await sessionJsonRequest(
        invited.page,
        `${BASE}/api/companies/${company.id}/invites`,
        {
          method: "POST",
          data: {
            allowedJoinTypes: "human",
            humanRole: "viewer",
          },
        }
      );
      expect(forbiddenInviteRes.status).toBe(403);
    } finally {
      await invited.context.close();
    }
  });
});
