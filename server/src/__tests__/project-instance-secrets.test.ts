import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  companySecrets,
  companySecretVersions,
  pluginCompanySettings,
  pluginConfig,
  pluginLifecycleAcknowledgments,
  plugins,
  projects,
  projectWorkspaces,
  createDb,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  projectInstanceSecretService,
  validateProjectInstanceSecretChanges,
} from "../services/project-instance-secrets.js";
import { pluginLifecycleInbox } from "../services/plugin-lifecycle-inbox.js";
import { recordResourceCreationEvent } from "../services/resource-lifecycle-events.js";
import { secretService } from "../services/secrets.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import * as activity from "../services/activity-log.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "project instance secrets reuse native tenant storage",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,
      db: Db;
    const companyId = randomUUID(),
      pluginId = randomUUID();
    const value = "fixture-private-mount-grant";
    beforeAll(async () => {
      vi.stubEnv(
        "PAPERCLIP_SECRETS_MASTER_KEY",
        randomBytes(32).toString("base64"),
      );
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-project-instance-secrets-",
      );
      db = createDb(database.connectionString);
      await db.insert(companies).values({
        id: companyId,
        name: "Project credentials fixture",
        issuePrefix: "PCI",
      });
      await db.insert(plugins).values({
        id: pluginId,
        pluginKey: pluginId,
        packageName: "project-instance-fixture",
        version: "1.0.0",
        status: "ready",
        manifestJson: {
          resourceLifecycle: ["project"],
          capabilities: ["events.subscribe", "projects.instance-secrets"],
        } as never,
      });
      await db
        .insert(pluginConfig)
        .values({ pluginId, companyId, configJson: {} });
    }, 90_000);
    afterAll(async () => {
      await database?.cleanup();
      vi.unstubAllEnvs();
    });
    async function fixture() {
      const [project] = await db
        .insert(projects)
        .values({ companyId, name: "Credential owner" })
        .returning();
      await db.transaction((tx) =>
        recordResourceCreationEvent(
          tx as unknown as Db,
          companyId,
          "project",
          project.id,
        ),
      );
      const inbox = pluginLifecycleInbox(db, pluginId);
      const event = (await inbox.list(companyId, 100)).find(
        (e) => e.resourceId === project.id,
      )!;
      const service = projectInstanceSecretService(db, pluginId);
      return {
        project,
        event,
        inbox,
        service,
        prepare: () => service.prepare(event),
        async commit(changes: unknown) {
          const { snapshot } = await service.prepare(event);
          await inbox.acknowledge(companyId, event.id, { snapshot, changes });
        },
      };
    }
    it("encrypts native versions, survives restart, isolates owners, and hides values from catalogs and events", async () => {
      const f = await fixture();
      expect((await f.prepare()).instanceSecrets).toEqual({});
      await f.commit({ mount_grants: value });
      const [row] = await db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.ownerProjectId, f.project.id));
      expect(row).toMatchObject({
        scope: "instance",
        ownerAgentId: null,
        ownerPluginId: pluginId,
        latestVersion: 1,
        provider: "local_encrypted",
      });
      const versions = await db
        .select()
        .from(companySecretVersions)
        .where(eq(companySecretVersions.secretId, row.id));
      expect(versions).toHaveLength(1);
      expect(JSON.stringify(versions)).not.toContain(value);
      expect(
        await projectInstanceSecretService(
          createDb(database.connectionString),
          pluginId,
        ).read(companyId, f.project.id),
      ).toEqual({ mount_grants: value });
      const native = secretService(db);
      expect(
        await native.projectInstance.read({
          companyId: randomUUID(),
          projectId: f.project.id,
          pluginId,
        }),
      ).toEqual({});
      expect(
        await native.projectInstance.read({
          companyId,
          projectId: randomUUID(),
          pluginId,
        }),
      ).toEqual({});
      expect(
        await native.projectInstance.read({
          companyId,
          projectId: f.project.id,
          pluginId: randomUUID(),
        }),
      ).toEqual({});
      expect(
        await native.agentInstance.read({
          companyId,
          agentId: f.project.id,
          pluginId,
        }),
      ).toEqual({});
      expect(JSON.stringify(await native.list(companyId))).not.toContain(
        row.id,
      );
      const logs = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.entityId, f.project.id));
      expect(logs).toHaveLength(1);
      expect(logs[0].details).toEqual({ key: "mount_grants" });
      expect(JSON.stringify(logs)).not.toContain(value);
      expect(JSON.stringify(await f.inbox.list(companyId, 100))).not.toContain(
        value,
      );
      await expect(
        native.resolveSecretValue(companyId, row.id, "latest"),
      ).rejects.toThrow();
    });
    it("commits credentials before publication and acknowledgment; duplicate late replies cannot overwrite them", async () => {
      const f = await fixture();
      const before = await f.prepare();
      const published = vi
        .spyOn(activity, "publishActivity")
        .mockImplementation(() => {});
      try {
        await f.inbox.acknowledge(companyId, f.event.id, {
          snapshot: before.snapshot,
          changes: { mount_grants: value },
        });
        expect(published).toHaveBeenCalledTimes(1);
        expect(await f.service.read(companyId, f.project.id)).toEqual({
          mount_grants: value,
        });
        await f.inbox.acknowledge(companyId, f.event.id, {
          snapshot: before.snapshot,
          changes: { mount_grants: "late" },
        });
        expect(await f.service.read(companyId, f.project.id)).toEqual({
          mount_grants: value,
        });
        expect(published).toHaveBeenCalledTimes(1);
      } finally {
        published.mockRestore();
      }
    });
    it("rolls back partial native writes and acknowledgment on provider failure, then safely retries", async () => {
      const f = await fixture(),
        before = await f.prepare();
      const prepare = localEncryptedProvider.createSecret.bind(
        localEncryptedProvider,
      );
      const spy = vi
        .spyOn(localEncryptedProvider, "createSecret")
        .mockImplementationOnce(prepare)
        .mockRejectedValueOnce(new Error(value));
      try {
        await expect(
          f.inbox.acknowledge(companyId, f.event.id, {
            snapshot: before.snapshot,
            changes: { first: value, second: value },
          }),
        ).rejects.toThrow("Project instance secret storage unavailable");
      } finally {
        spy.mockRestore();
      }
      expect(await f.service.read(companyId, f.project.id)).toEqual({});
      expect(
        (await f.inbox.list(companyId, 100)).some((e) => e.id === f.event.id),
      ).toBe(true);
      expect(
        await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.entityId, f.project.id)),
      ).toEqual([]);
      await f.commit({ mount_grants: value });
      expect(await f.service.read(companyId, f.project.id)).toEqual({
        mount_grants: value,
      });
    });
    for (const change of [
      "project",
      "workspace",
      "configuration",
      "disabled",
      "secret-version",
    ] as const)
      it(`rejects stale callback after ${change} changes`, async () => {
        const f = await fixture(),
          before = await f.prepare();
        try {
          if (change === "project")
            await db
              .update(projects)
              .set({ name: "Changed" })
              .where(eq(projects.id, f.project.id));
          if (change === "workspace")
            await db.insert(projectWorkspaces).values({
              companyId,
              projectId: f.project.id,
              name: "Source",
              repoUrl: "https://github.com/fixture/project",
            });
          if (change === "configuration")
            await db
              .update(pluginConfig)
              .set({ configJson: { changed: true } })
              .where(eq(pluginConfig.pluginId, pluginId));
          if (change === "disabled")
            await db
              .insert(pluginCompanySettings)
              .values({ pluginId, companyId, enabled: false });
          if (change === "secret-version")
            await secretService(db).projectInstance.set(
              { companyId, projectId: f.project.id, pluginId },
              "mount_grants",
              "newer",
            );
          await expect(
            f.inbox.acknowledge(companyId, f.event.id, {
              snapshot: before.snapshot,
              changes: { mount_grants: value },
            }),
          ).rejects.toThrow();
          expect(
            await db
              .select()
              .from(pluginLifecycleAcknowledgments)
              .where(
                and(
                  eq(pluginLifecycleAcknowledgments.pluginId, pluginId),
                  eq(
                    pluginLifecycleAcknowledgments.eventId,
                    Number(f.event.id),
                  ),
                ),
              ),
          ).toEqual([]);
        } finally {
          if (change === "disabled")
            await db
              .delete(pluginCompanySettings)
              .where(eq(pluginCompanySettings.pluginId, pluginId));
          if (change === "configuration")
            await db
              .update(pluginConfig)
              .set({ configJson: {} })
              .where(eq(pluginConfig.pluginId, pluginId));
        }
      });
    it("rotates native versions, removes credentials without an encryption key, and cascades project deletion", async () => {
      const f = await fixture();
      const native = secretService(db);
      const scope = { companyId, projectId: f.project.id, pluginId };
      await native.projectInstance.set(scope, "mount_grants", value);
      await native.projectInstance.set(scope, "mount_grants", "replacement");
      const [row] = await db
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.ownerProjectId, f.project.id));
      expect(row.latestVersion).toBe(2);
      const key = process.env.PAPERCLIP_SECRETS_MASTER_KEY!;
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "invalid");
      try {
        await native.projectInstance.set(scope, "mount_grants", null);
      } finally {
        vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", key);
      }
      expect(await native.projectInstance.read(scope)).toEqual({});
      await native.projectInstance.set(scope, "mount_grants", value);
      await db.delete(projects).where(eq(projects.id, f.project.id));
      expect(await native.projectInstance.read(scope)).toEqual({});
      expect(
        await db
          .select()
          .from(companySecretVersions)
          .where(eq(companySecretVersions.secretId, row.id)),
      ).toEqual([]);
      const deleted = await f.prepare();
      await expect(
        f.inbox.acknowledge(companyId, f.event.id, {
          snapshot: deleted.snapshot,
          changes: { mount_grants: value },
        }),
      ).rejects.toThrow("active project");
      await f.inbox.acknowledge(companyId, f.event.id, {
        snapshot: deleted.snapshot,
        changes: { mount_grants: null },
      });
    });
    it("can acknowledge archival removal when the encryption key is unavailable", async () => {
      const f = await fixture();
      await secretService(db).projectInstance.set(
        { companyId, projectId: f.project.id, pluginId },
        "mount_grants",
        value,
      );
      await db
        .update(projects)
        .set({ archivedAt: new Date("2020-01-01") })
        .where(eq(projects.id, f.project.id));
      const key = process.env.PAPERCLIP_SECRETS_MASTER_KEY!;
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "invalid");
      try {
        const prepared = await f.prepare();
        expect(prepared.instanceSecrets).toEqual({});
        await f.inbox.acknowledge(companyId, f.event.id, {
          snapshot: prepared.snapshot,
          changes: { mount_grants: null },
        });
        expect(
          await db
            .select()
            .from(companySecrets)
            .where(eq(companySecrets.ownerProjectId, f.project.id)),
        ).toEqual([]);
      } finally {
        vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", key);
      }
    });
    it("enforces project ownership in the database and rejects archived reads and new credentials", async () => {
      const f = await fixture();
      const otherCompany = randomUUID();
      await db
        .insert(companies)
        .values({
          id: otherCompany,
          name: "Other fixture",
          issuePrefix: "PCO",
        });
      await expect(
        db
          .insert(companySecrets)
          .values({
            companyId: otherCompany,
            scope: "instance",
            ownerProjectId: f.project.id,
            ownerPluginId: pluginId,
            key: "CREDENTIAL",
            name: "credential",
          }),
      ).rejects.toThrow();
      await expect(
        db
          .insert(companySecrets)
          .values({
            companyId,
            scope: "company",
            ownerProjectId: f.project.id,
            key: "INVALID",
            name: "invalid",
          }),
      ).rejects.toThrow();
      await db
        .update(projects)
        .set({ archivedAt: new Date("2020-01-01") })
        .where(eq(projects.id, f.project.id));
      await expect(f.service.read(companyId, f.project.id)).rejects.toThrow(
        "unavailable",
      );
      const { snapshot } = await f.prepare();
      await expect(
        f.inbox.acknowledge(companyId, f.event.id, {
          snapshot,
          changes: { mount_grants: value },
        }),
      ).rejects.toThrow("active project");
      await f.inbox.acknowledge(companyId, f.event.id, {
        snapshot,
        changes: { mount_grants: null },
      });
    });
    it("preserves account-home protection for project-owned credentials", async () => {
      const f = await fixture(),
        native = secretService(db),
        accountHome = "/fixture/account-home";
      await native.projectInstance.set(
        { companyId, projectId: f.project.id, pluginId },
        "home",
        accountHome,
      );
      expect(
        await native.hasInstanceAccountHomeClaim(companyId, accountHome),
      ).toBe(true);
      expect(
        await native.hasInstanceAccountHomeClaim(
          companyId,
          accountHome + "-other",
        ),
      ).toBe(false);
    });
  },
);
describe("project instance secret patches", () => {
  it("accepts bounded bundles and removal and rejects malformed patches without leaking values", () => {
    expect(() =>
      validateProjectInstanceSecretChanges({
        mount_grants: "x".repeat(131_072),
        old: null,
      }),
    ).not.toThrow();
    for (const changes of [
      null,
      [],
      { "bad/key": "private" },
      { mount_grants: "" },
      { mount_grants: " " },
      { mount_grants: 1 },
      { mount_grants: "x".repeat(131_073) },
      Object.fromEntries(
        Array.from({ length: 17 }, (_, i) => [`key_${i}`, "private"]),
      ),
    ]) {
      expect(() => validateProjectInstanceSecretChanges(changes)).toThrow(
        "Invalid project instance secret changes",
      );
    }
  });
});
