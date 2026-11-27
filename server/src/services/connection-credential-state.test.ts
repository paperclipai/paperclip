import { describe, expect, it } from "vitest";
import { companySecrets, companySecretVersions, type Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { readConnectionGrantCredentialStates, type ConnectionGrantCredentialInput } from "./connection-credentials.js";

const input = (index = 0): ConnectionGrantCredentialInput => ({ connection: { id: "connection", companyId: "company" },
  grant: { id: `grant-${index}`, companyId: "company", connectionId: "connection", kind: "user", subjectUserId: "owner",
    credentialSecretRefs: [{ configPath: "oauth.access_token", secretId: `secret-${index}`, versionSelector: 1 }] } });
const metadata = (index = 0) => ({ secret: { id: `secret-${index}`, companyId: "company", scope: "user", ownerUserId: "owner",
  userSecretDefinitionId: `definition-${index}`, status: "active", deletedAt: null, latestVersion: 2, updatedAt: new Date(0) },
  definition: { id: `definition-${index}`, companyId: "company", status: "active", deletedAt: null, updatedAt: new Date(0) } });
const version = (index = 0) => ({ id: `version-${index}`, secretId: `secret-${index}`, version: 1, status: "previous", revokedAt: null as Date | null });
function metadataDb(rows = [metadata()], versions = [version()], onRead: () => void = () => {}) {
  return { select: (columns: Record<string, unknown>) => {
    onRead();
    for (const selected of [columns, columns.secret ?? {}, columns.definition ?? {}]) {
      expect(Object.keys(selected as object)).not.toEqual(expect.arrayContaining(["material"]));
      for (const name of ["valueSha256", "fingerprintSha256", "providerMetadata"]) expect(selected).not.toHaveProperty(name);
    }
    let table: unknown, params: unknown[] = [];
    const query = { from: (source: unknown) => { table = source; return query; }, leftJoin: () => query,
      where: (where: SQL) => { params = new PgDialect().sqlToQuery(where).params; return query; }, orderBy: () => query,
      limit: () => Promise.resolve(table === companySecrets ? rows.filter(row => params.includes(row.secret.id))
        : table === companySecretVersions ? versions.filter(row => params.includes(row.secretId) && params.includes(row.version)) : []) };
    return query;
  } } as unknown as Pick<Db, "select">;
}
describe("connection grant credential metadata", () => {
  it("accepts the exact non-revoked pinned previous version and also selects current latest", async () => {
    const request = input(), row = metadata(), saved = version();
    expect((await readConnectionGrantCredentialStates(metadataDb([row], [saved]), [request]))?.size).toBe(1);
    request.grant.credentialSecretRefs[0].versionSelector = "latest";
    expect(await readConnectionGrantCredentialStates(metadataDb([row], [saved]), [request])).toBeUndefined();
    saved.version = 2; saved.status = "current";
    expect((await readConnectionGrantCredentialStates(metadataDb([row], [saved]), [request]))?.size).toBe(1);
  });
  it("keeps revoked, disabled, destroyed, failed, absent and foreign metadata unproven", async () => {
    for (const status of ["disabled", "destroyed", "failed", "unknown"]) {
      const saved = { ...version(), status };
      expect(await readConnectionGrantCredentialStates(metadataDb([metadata()], [saved]), [input()])).toBeUndefined();
    }
    const revoked = { ...version(), revokedAt: new Date() };
    expect(await readConnectionGrantCredentialStates(metadataDb([metadata()], [revoked]), [input()])).toBeUndefined();
    expect(await readConnectionGrantCredentialStates(metadataDb([], []), [input()])).toBeUndefined();
    expect(await readConnectionGrantCredentialStates(metadataDb([metadata()], []), [input()])).toBeUndefined();
    for (const field of ["companyId", "ownerUserId", "userSecretDefinitionId"] as const) {
      const row = metadata(); row.secret[field] = "foreign";
      expect(await readConnectionGrantCredentialStates(metadataDb([row]), [input()])).toBeUndefined();
    }
    const row = metadata(); row.definition.status = "disabled";
    expect(await readConnectionGrantCredentialStates(metadataDb([row]), [input()])).toBeUndefined();
    const duplicate = input(); duplicate.grant.credentialSecretRefs.push({ ...duplicate.grant.credentialSecretRefs[0] });
    expect(await readConnectionGrantCredentialStates(metadataDb(), [duplicate])).toBeUndefined();
  });
  it("bounds1001 grants to four metadata reads and checks budget during collection", async () => {
    const inputs = Array.from({ length: 1001 }, (_, i) => input(i));
    let reads = 0;
    const db = metadataDb(inputs.map((_, i) => metadata(i)), inputs.map((_, i) => version(i)), () => { reads++; });
    expect((await readConnectionGrantCredentialStates(db, inputs))?.size).toBe(1001);
    expect(reads).toBe(4);
    let checks = 0;
    await expect(readConnectionGrantCredentialStates(db, inputs, () => {
      if (++checks > 3) throw new Error("budget exhausted");
    })).rejects.toThrow("budget exhausted");
  });
});
