import { afterEach, describe, expect, it } from "vitest";
import { secretService } from "../services/secrets.js";

function makeSelectDb(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  } as any;
}

describe("secretService Slack webhook policy", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDeploymentMode = process.env.PAPERCLIP_DEPLOYMENT_MODE;
  const originalAllowFlag = process.env.ALLOW_INSECURE_WEBHOOK_URLS;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.PAPERCLIP_DEPLOYMENT_MODE = originalDeploymentMode;
    process.env.ALLOW_INSECURE_WEBHOOK_URLS = originalAllowFlag;
  });

  it("rejects insecure Slack webhook secrets by default", async () => {
    const svc = secretService({} as any);

    await expect(
      svc.create(
        "company-1",
        {
          name: "SLACK_WEBHOOK_URL",
          provider: "local_encrypted",
          value: "http://hooks.slack.com/services/T1/B2/C3",
        },
        { userId: "user-1" },
      ),
    ).rejects.toThrow("must use https://");
  });

  it("rejects non-Slack HTTPS hosts for Slack webhook secrets", async () => {
    const svc = secretService({} as any);

    await expect(
      svc.create(
        "company-1",
        {
          name: "SLACK_WEBHOOK_URL",
          provider: "local_encrypted",
          value: "https://example.com/services/T1/B2/C3",
        },
        { userId: "user-1" },
      ),
    ).rejects.toThrow("host is not allowed");
  });

  it("allows loopback http for Slack webhook secrets only in non-production with explicit flag", async () => {
    process.env.NODE_ENV = "development";
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "local_trusted";
    process.env.ALLOW_INSECURE_WEBHOOK_URLS = "true";

    const svc = secretService(makeSelectDb([
      {
        id: "secret-1",
        companyId: "company-1",
        name: "SLACK_WEBHOOK_URL",
      },
    ]));

    await expect(
      svc.create(
        "company-1",
        {
          name: "SLACK_WEBHOOK_URL",
          provider: "local_encrypted",
          value: "http://127.0.0.1:7777/webhook",
        },
        { userId: "user-1" },
      ),
    ).rejects.toThrow("Secret already exists");
  });
});
