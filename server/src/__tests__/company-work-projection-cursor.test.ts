import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import {
  decodeCompanyWorkProjectionCursor,
  encodeCompanyWorkProjectionCursor,
} from "../services/company-work-projection-cursor.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";

const secret = "synthetic-test-secret";

function cursor(companyId: string) {
  return {
    apiVersion: "paperclip.company-work-projection/v1" as const,
    schemaVersion: 1 as const,
    companyId,
    snapshotRevision: "7",
    issuedAt: "2026-08-14T20:00:00.000Z",
    expiresAt: "2026-08-14T20:05:00.000Z",
    afterRevision: "3",
    afterIssueId: randomUUID(),
    pageSize: 25,
  };
}

function expectCode(action: () => unknown, status: number, code: string) {
  try {
    action();
    throw new Error("expected cursor error");
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(status);
    expect((error as HttpError).details).toMatchObject({ code });
  }
}

function signRawPayload(payload: string, companyId: string) {
  const key = createHmac("sha256", secret)
    .update(`company-work-projection-cursor:v1:${resolvePaperclipInstanceId()}:${companyId}`)
    .digest();
  return createHmac("sha256", key).update(payload).digest("base64url");
}

describe("company work projection cursor", () => {
  it("round-trips and replays immutably across process-local state", () => {
    const companyId = randomUUID();
    const value = cursor(companyId);
    const token = encodeCompanyWorkProjectionCursor(value, secret);
    expect(decodeCompanyWorkProjectionCursor(token, companyId, new Date("2026-08-14T20:01:00Z"), secret))
      .toEqual(value);
    expect(encodeCompanyWorkProjectionCursor(value, secret)).toBe(token);
  });

  it("fails closed for tampering, company mismatch, expiration, and unknown versions", () => {
    const companyId = randomUUID();
    const value = cursor(companyId);
    const token = encodeCompanyWorkProjectionCursor(value, secret);
    expectCode(
      () => decodeCompanyWorkProjectionCursor(`${token}x`, companyId, new Date("2026-08-14T20:01:00Z"), secret),
      400,
      "WORK_PROJECTION_MALFORMED",
    );
    expectCode(
      () => decodeCompanyWorkProjectionCursor(token, randomUUID(), new Date("2026-08-14T20:01:00Z"), secret),
      400,
      "WORK_PROJECTION_MALFORMED",
    );
    expectCode(
      () => decodeCompanyWorkProjectionCursor(token, companyId, new Date("2026-08-14T20:05:00Z"), secret),
      410,
      "WORK_PROJECTION_SNAPSHOT_EXPIRED",
    );

    const [payload] = token.split(".");
    const incompatible = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
      schemaVersion: 2,
    })).toString("base64url");
    expectCode(
      () => decodeCompanyWorkProjectionCursor(
        `${incompatible}.${signRawPayload(incompatible, companyId)}`,
        companyId,
        new Date("2026-08-14T20:01:00Z"),
        secret,
      ),
      409,
      "WORK_PROJECTION_INCOMPATIBLE",
    );
  });

  it("accepts an outstanding five-minute cursor through one previous signing key only", () => {
    const companyId = randomUUID();
    const oldSecret = "synthetic-old-cursor-secret";
    const newSecret = "synthetic-new-cursor-secret";
    const value = cursor(companyId);
    const outstanding = encodeCompanyWorkProjectionCursor(value, oldSecret);
    expect(decodeCompanyWorkProjectionCursor(
      outstanding,
      companyId,
      new Date("2026-08-14T20:04:59Z"),
      newSecret,
      oldSecret,
    )).toEqual(value);
    expectCode(
      () => decodeCompanyWorkProjectionCursor(
        outstanding,
        companyId,
        new Date("2026-08-14T20:04:59Z"),
        newSecret,
      ),
      400,
      "WORK_PROJECTION_MALFORMED",
    );
    expectCode(
      () => decodeCompanyWorkProjectionCursor(
        outstanding,
        companyId,
        new Date("2026-08-14T20:05:00Z"),
        newSecret,
        oldSecret,
      ),
      410,
      "WORK_PROJECTION_SNAPSHOT_EXPIRED",
    );

    const overlong = encodeCompanyWorkProjectionCursor({
      ...value,
      expiresAt: "2026-08-14T20:05:00.001Z",
    }, newSecret);
    expectCode(
      () => decodeCompanyWorkProjectionCursor(
        overlong,
        companyId,
        new Date("2026-08-14T20:01:00Z"),
        newSecret,
      ),
      400,
      "WORK_PROJECTION_MALFORMED",
    );
  });
});
