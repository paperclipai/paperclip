import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  completePaperclipCloudConnectorEnrollment,
  loadPaperclipCloudConnectorIdentity,
  paperclipCloudConnectorEnrollmentStatus,
  paperclipCloudConnectorIdentityPath,
  startPaperclipCloudConnectorEnrollment,
} from "./paperclip-cloud-connector-enrollment.js";
import { paperclipCloudConnectorConfigFromEnv } from "./paperclip-cloud-connector.js";
import { reconcilePaperclipCloudConnectorEnrollmentStatus } from "./paperclip-cloud-connector-status.js";

describe("Paperclip Cloud self-host enrollment", () => {
  let root = "";
  let previousHome: string | undefined;
  let previousInstance: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "paperclip-cloud-connector-"));
    previousHome = process.env.PAPERCLIP_HOME;
    previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = root;
    process.env.PAPERCLIP_INSTANCE_ID = "connector-test";
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps private keys owner-only and activates only the matching one-time callback", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });
      if (url.endsWith("/v1/connector/enrollments")) {
        return Response.json({
          enrollmentId: "enroll-test",
          verificationUrl: "https://my.example.test/connections/enroll?id=enroll-test",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }, { status: 201 });
      }
      const token = String(body.request);
      const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
      expect(claims).toMatchObject({
        iss: loadPaperclipCloudConnectorIdentity()?.instanceId,
        aud: "https://my.example.test/v1/connector/enrollment-claims",
        env: "development",
        op: "enroll",
      });
      expect(typeof claims.ah).toBe("string");
      return Response.json({
        id: loadPaperclipCloudConnectorIdentity()?.instanceId,
        environment: "development",
        origins: ["https://private.example.test"],
      });
    });

    const pending = await startPaperclipCloudConnectorEnrollment({
      origin: "https://private.example.test",
      env: {
        PAPERCLIP_CLOUD_CONNECTOR_BASE_URL: "https://my.example.test",
        PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT: "development",
      },
      request: request as typeof fetch,
    });
    expect(pending.status).toBe("pending");
    expect(pending.verificationUrl).toBe("https://my.example.test/connections/enroll?id=enroll-test");
    expect(statSync(path.dirname(paperclipCloudConnectorIdentityPath())).mode & 0o777).toBe(0o700);
    expect(statSync(paperclipCloudConnectorIdentityPath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(paperclipCloudConnectorIdentityPath(), "utf8")).not.toContain("approval-code");

    await expect(completePaperclipCloudConnectorEnrollment({
      enrollmentId: "enroll-test",
      approvalCode: "approval-code",
      state: "wrong-state",
      request: request as typeof fetch,
    })).rejects.toThrow(/Invalid or expired/);

    const state = loadPaperclipCloudConnectorIdentity()?.pending?.returnState;
    const active = await completePaperclipCloudConnectorEnrollment({
      enrollmentId: "enroll-test",
      approvalCode: "approval-code",
      state: state!,
      request: request as typeof fetch,
    });
    expect(active).toMatchObject({ configured: true, status: "active", origins: ["https://private.example.test"] });
    const config = paperclipCloudConnectorConfigFromEnv({});
    expect(config).toMatchObject({ baseUrl: "https://my.example.test", environment: "development" });
    expect(requests).toHaveLength(2);

    const statusRequest = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://my.example.test/v1/connector/instance-status");
      return Response.json({ active: false, status: "suspended" });
    });
    await expect(reconcilePaperclipCloudConnectorEnrollmentStatus({}, statusRequest as typeof fetch)).resolves.toMatchObject({
      configured: false,
      status: "suspended",
      instanceId: active.instanceId,
    });
  });

  it("rejects non-loopback plain HTTP destinations before creating keys", async () => {
    await expect(startPaperclipCloudConnectorEnrollment({
      origin: "http://private.example.test",
      request: vi.fn() as typeof fetch,
    })).rejects.toThrow(/requires HTTPS/);
    expect(paperclipCloudConnectorEnrollmentStatus().status).toBe("not_configured");
  });

  it("serializes overlapping starts and reuses one unexpired enrollment", async () => {
    let releaseBroker!: () => void;
    const brokerMayRespond = new Promise<void>((resolve) => {
      releaseBroker = resolve;
    });
    const request = vi.fn(async () => {
      await brokerMayRespond;
      return Response.json({
        enrollmentId: "enroll-shared",
        verificationUrl: "https://my.example.test/connections/enroll?id=enroll-shared",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }, { status: 201 });
    });
    const values = {
      origin: "https://private.example.test",
      companyId: "company-test",
      initiatedBy: "user:admin-test",
      env: {
        PAPERCLIP_CLOUD_CONNECTOR_BASE_URL: "https://my.example.test",
        PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT: "development",
      },
      request: request as typeof fetch,
    };

    const first = startPaperclipCloudConnectorEnrollment(values);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const second = startPaperclipCloudConnectorEnrollment(values);
    releaseBroker();

    const [firstStatus, secondStatus] = await Promise.all([first, second]);
    expect(request).toHaveBeenCalledOnce();
    expect(firstStatus).toMatchObject({ status: "pending", verificationUrl: expect.stringContaining("enroll-shared") });
    expect(secondStatus).toEqual(firstStatus);
    expect(loadPaperclipCloudConnectorIdentity()?.pending).toMatchObject({
      enrollmentId: "enroll-shared",
      companyId: "company-test",
      initiatedBy: "user:admin-test",
    });
    await expect(startPaperclipCloudConnectorEnrollment({
      ...values,
      initiatedBy: "user:another-admin",
    })).rejects.toThrow(/another administrator/);
    await expect(startPaperclipCloudConnectorEnrollment({
      ...values,
      companyId: "another-company",
    })).rejects.toThrow(/another company/);
    expect(request).toHaveBeenCalledOnce();
  });

  it("defaults an enrollment to the environment of the standard Cloud broker", () => {
    expect(paperclipCloudConnectorEnrollmentStatus({})).toMatchObject({
      brokerBaseUrl: "https://my.paperclip.app",
      environment: "production",
    });
    expect(paperclipCloudConnectorEnrollmentStatus({
      PAPERCLIP_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app",
    })).toMatchObject({ environment: "staging" });
  });

  it("does not treat legacy Paperclip ID keys as a Cloud enrollment", () => {
    expect(paperclipCloudConnectorEnrollmentStatus({
      PAPERCLIP_ID_CONNECTOR_INSTANCE_ID: "legacy-instance",
      PAPERCLIP_ID_CONNECTOR_SIGN_PRIVATE_KEY: "legacy-signing-key",
      PAPERCLIP_ID_CONNECTOR_SEAL_PRIVATE_KEY: "legacy-sealing-key",
      PAPERCLIP_ID_CONNECTOR_ENVIRONMENT: "production",
      PAPERCLIP_ID_CONNECTOR_BASE_URL: "https://id.paperclip.app",
    })).toMatchObject({
      configured: false,
      status: "not_configured",
      brokerBaseUrl: "https://my.paperclip.app",
      instanceId: null,
    });
  });
});
