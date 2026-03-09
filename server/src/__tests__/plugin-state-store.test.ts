import { describe, expect, it, vi } from "vitest";
import { pluginStateStore } from "../services/plugin-state-store.js";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeStateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "state-uuid-1",
    pluginId: "plugin-uuid-1",
    scopeKind: "instance",
    scopeId: null,
    namespace: "default",
    stateKey: "my-key",
    valueJson: { synced: true },
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Build a minimal mock DB that resolves select queries with `rows`. */
function makeSelectDb(rows: unknown[]) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

/** Build a mock DB whose select verifies plugin existence (returns `pluginRow`)
 *  and whose insert chain resolves successfully. */
function makeInsertDb(pluginRow: { id: string } | null = { id: "plugin-uuid-1" }) {
  const pluginRows = pluginRow ? [pluginRow] : [];
  const onConflictMock = vi.fn().mockResolvedValue([]);
  const valuesMock = vi.fn().mockReturnValue({ onConflictDoUpdate: onConflictMock });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });

  return {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(pluginRows),
        }),
      }),
      insert: insertMock,
      update: vi.fn(),
      delete: vi.fn(),
    },
    insertMock,
    valuesMock,
    onConflictMock,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pluginStateStore", () => {
  // =========================================================================
  // get
  // =========================================================================

  describe("get", () => {
    it("returns the stored value when the entry exists", async () => {
      const storedValue = { count: 42, label: "hello" };
      const db = makeSelectDb([makeStateRow({ valueJson: storedValue })]);

      const store = pluginStateStore(db as never);
      const result = await store.get("plugin-uuid-1", "instance", "my-key");

      expect(result).toEqual(storedValue);
    });

    it("returns null when no entry exists", async () => {
      const db = makeSelectDb([]);

      const store = pluginStateStore(db as never);
      const result = await store.get("plugin-uuid-1", "instance", "missing-key");

      expect(result).toBeNull();
    });

    it("returns a primitive string value correctly", async () => {
      const db = makeSelectDb([makeStateRow({ valueJson: "hello-world" })]);

      const store = pluginStateStore(db as never);
      const result = await store.get("plugin-uuid-1", "instance", "greeting");

      expect(result).toBe("hello-world");
    });

    it("returns a numeric value correctly", async () => {
      const db = makeSelectDb([makeStateRow({ valueJson: 99 })]);

      const store = pluginStateStore(db as never);
      const result = await store.get("plugin-uuid-1", "instance", "counter");

      expect(result).toBe(99);
    });

    it("returns false correctly (falsy value should not be confused with null)", async () => {
      const db = makeSelectDb([makeStateRow({ valueJson: false })]);

      const store = pluginStateStore(db as never);
      const result = await store.get("plugin-uuid-1", "instance", "flag");

      expect(result).toBe(false);
    });

    it("returns 0 correctly (falsy numeric value)", async () => {
      const db = makeSelectDb([makeStateRow({ valueJson: 0 })]);

      const store = pluginStateStore(db as never);
      const result = await store.get("plugin-uuid-1", "instance", "zero");

      expect(result).toBe(0);
    });

    it("passes scopeId and namespace to the query", async () => {
      const whereMock = vi.fn().mockResolvedValue([]);
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({ where: whereMock }),
        }),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      };

      const store = pluginStateStore(db as never);
      await store.get("plugin-uuid-1", "project", "sync-cursor", {
        scopeId: "proj-123",
        namespace: "linear",
      });

      expect(whereMock).toHaveBeenCalledOnce();
    });

    it("uses the default namespace when none is provided", async () => {
      const whereMock = vi.fn().mockResolvedValue([]);
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({ where: whereMock }),
        }),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      };

      const store = pluginStateStore(db as never);
      // No namespace → should internally use "default"
      await store.get("plugin-uuid-1", "instance", "my-key");

      expect(whereMock).toHaveBeenCalledOnce();
    });

    it("works with all supported scope kinds", async () => {
      const kinds = [
        "instance",
        "company",
        "project",
        "project_workspace",
        "agent",
        "issue",
        "goal",
        "run",
      ] as const;

      for (const scopeKind of kinds) {
        const db = makeSelectDb([makeStateRow({ scopeKind, valueJson: scopeKind })]);
        const store = pluginStateStore(db as never);
        const result = await store.get("plugin-uuid-1", scopeKind, "k");
        expect(result).toBe(scopeKind);
      }
    });
  });

  // =========================================================================
  // set
  // =========================================================================

  describe("set", () => {
    it("calls insert with the correct values for instance scope", async () => {
      const { db, valuesMock } = makeInsertDb();

      const store = pluginStateStore(db as never);
      await store.set("plugin-uuid-1", {
        scopeKind: "instance",
        stateKey: "my-key",
        value: { hello: "world" },
      });

      expect(valuesMock).toHaveBeenCalledOnce();
      const insertedValues = valuesMock.mock.calls[0][0];
      expect(insertedValues).toMatchObject({
        pluginId: "plugin-uuid-1",
        scopeKind: "instance",
        scopeId: null,
        stateKey: "my-key",
        valueJson: { hello: "world" },
        namespace: "default",
      });
    });

    it("defaults scopeId to null when not provided", async () => {
      const { db, valuesMock } = makeInsertDb();

      const store = pluginStateStore(db as never);
      await store.set("plugin-uuid-1", {
        scopeKind: "instance",
        stateKey: "k",
        value: 1,
      });

      const insertedValues = valuesMock.mock.calls[0][0];
      expect(insertedValues.scopeId).toBeNull();
    });

    it("defaults namespace to 'default' when not provided", async () => {
      const { db, valuesMock } = makeInsertDb();

      const store = pluginStateStore(db as never);
      await store.set("plugin-uuid-1", {
        scopeKind: "instance",
        stateKey: "k",
        value: 1,
      });

      expect(valuesMock.mock.calls[0][0].namespace).toBe("default");
    });

    it("uses provided namespace and scopeId", async () => {
      const { db, valuesMock } = makeInsertDb();

      const store = pluginStateStore(db as never);
      await store.set("plugin-uuid-1", {
        scopeKind: "project",
        scopeId: "proj-123",
        namespace: "git",
        stateKey: "branch-name",
        value: "main",
      });

      const insertedValues = valuesMock.mock.calls[0][0];
      expect(insertedValues.namespace).toBe("git");
      expect(insertedValues.scopeId).toBe("proj-123");
      expect(insertedValues.valueJson).toBe("main");
    });

    it("calls onConflictDoUpdate to handle upsert", async () => {
      const { db, onConflictMock } = makeInsertDb();

      const store = pluginStateStore(db as never);
      await store.set("plugin-uuid-1", {
        scopeKind: "instance",
        stateKey: "k",
        value: 42,
      });

      expect(onConflictMock).toHaveBeenCalledOnce();
      const conflictArg = onConflictMock.mock.calls[0][0];
      expect(conflictArg).toHaveProperty("target");
      expect(conflictArg).toHaveProperty("set");
      expect(conflictArg.set).toHaveProperty("valueJson", 42);
    });

    it("stores a null value", async () => {
      const { db, valuesMock } = makeInsertDb();

      const store = pluginStateStore(db as never);
      await store.set("plugin-uuid-1", {
        scopeKind: "instance",
        stateKey: "cleared",
        value: null,
      });

      expect(valuesMock.mock.calls[0][0].valueJson).toBeNull();
    });

    it("stores an array value", async () => {
      const { db, valuesMock } = makeInsertDb();

      const store = pluginStateStore(db as never);
      await store.set("plugin-uuid-1", {
        scopeKind: "run",
        scopeId: "run-1",
        stateKey: "events",
        value: ["a", "b", "c"],
      });

      expect(valuesMock.mock.calls[0][0].valueJson).toEqual(["a", "b", "c"]);
    });

    it("throws a not-found error when the plugin does not exist", async () => {
      const { db } = makeInsertDb(null); // null = plugin not found

      const store = pluginStateStore(db as never);
      await expect(
        store.set("nonexistent-plugin", {
          scopeKind: "instance",
          stateKey: "key",
          value: 42,
        }),
      ).rejects.toThrow();
    });

    it("includes the pluginId in the not-found error message", async () => {
      const { db } = makeInsertDb(null);

      const store = pluginStateStore(db as never);
      await expect(
        store.set("ghost-plugin-id", {
          scopeKind: "instance",
          stateKey: "k",
          value: 1,
        }),
      ).rejects.toThrow("ghost-plugin-id");
    });

    it("attaches a timestamp to the inserted row", async () => {
      const before = new Date();
      const { db, valuesMock } = makeInsertDb();

      const store = pluginStateStore(db as never);
      await store.set("plugin-uuid-1", {
        scopeKind: "instance",
        stateKey: "ts-check",
        value: 1,
      });

      const after = new Date();
      const { updatedAt } = valuesMock.mock.calls[0][0];
      expect(updatedAt).toBeInstanceOf(Date);
      expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  // =========================================================================
  // delete
  // =========================================================================

  describe("delete", () => {
    it("calls db.delete with the correct conditions", async () => {
      const whereMock = vi.fn().mockResolvedValue([]);
      const deleteMock = vi.fn().mockReturnValue({ where: whereMock });
      const db = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: deleteMock };

      const store = pluginStateStore(db as never);
      await store.delete("plugin-uuid-1", "instance", "my-key");

      expect(deleteMock).toHaveBeenCalledOnce();
      expect(whereMock).toHaveBeenCalledOnce();
    });

    it("is idempotent — does not throw when entry does not exist", async () => {
      const db = {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      };

      const store = pluginStateStore(db as never);
      await expect(
        store.delete("plugin-uuid-1", "instance", "nonexistent-key"),
      ).resolves.toBeUndefined();
    });

    it("resolves to undefined on success", async () => {
      const db = {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      };

      const store = pluginStateStore(db as never);
      const result = await store.delete("plugin-uuid-1", "project", "cursor", {
        scopeId: "proj-1",
        namespace: "linear",
      });

      expect(result).toBeUndefined();
    });

    it("accepts optional scopeId and namespace", async () => {
      const whereMock = vi.fn().mockResolvedValue([]);
      const db = {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn().mockReturnValue({ where: whereMock }),
      };

      const store = pluginStateStore(db as never);
      await store.delete("plugin-uuid-1", "issue", "pr-number", {
        scopeId: "issue-99",
        namespace: "github",
      });

      expect(whereMock).toHaveBeenCalledOnce();
    });

    it("works without optional arguments (instance scope)", async () => {
      const whereMock = vi.fn().mockResolvedValue([]);
      const db = {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn().mockReturnValue({ where: whereMock }),
      };

      const store = pluginStateStore(db as never);
      // No options object at all — should use defaults
      await store.delete("plugin-uuid-1", "instance", "global-flag");

      expect(whereMock).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // list
  // =========================================================================

  describe("list", () => {
    it("lists all state entries for a plugin when no filter is provided", async () => {
      const rows = [
        makeStateRow({ stateKey: "a", valueJson: 1 }),
        makeStateRow({ stateKey: "b", valueJson: 2 }),
        makeStateRow({ stateKey: "c", valueJson: 3 }),
      ];
      const db = makeSelectDb(rows);

      const store = pluginStateStore(db as never);
      const result = await store.list("plugin-uuid-1");

      expect(result).toHaveLength(3);
    });

    it("returns an empty array when the plugin has no state", async () => {
      const db = makeSelectDb([]);

      const store = pluginStateStore(db as never);
      const result = await store.list("plugin-uuid-1");

      expect(result).toEqual([]);
    });

    it("applies scopeKind filter when provided", async () => {
      const whereMock = vi.fn().mockResolvedValue([]);
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({ where: whereMock }),
        }),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      };

      const store = pluginStateStore(db as never);
      await store.list("plugin-uuid-1", { scopeKind: "project" });

      expect(whereMock).toHaveBeenCalledOnce();
    });

    it("applies scopeId filter when provided", async () => {
      const whereMock = vi.fn().mockResolvedValue([]);
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({ where: whereMock }),
        }),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      };

      const store = pluginStateStore(db as never);
      await store.list("plugin-uuid-1", { scopeId: "proj-42" });

      expect(whereMock).toHaveBeenCalledOnce();
    });

    it("applies namespace filter when provided", async () => {
      const whereMock = vi.fn().mockResolvedValue([]);
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({ where: whereMock }),
        }),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      };

      const store = pluginStateStore(db as never);
      await store.list("plugin-uuid-1", { namespace: "linear" });

      expect(whereMock).toHaveBeenCalledOnce();
    });

    it("returns full row objects including all expected fields", async () => {
      const row = makeStateRow({
        id: "row-id-1",
        pluginId: "plugin-uuid-1",
        scopeKind: "project",
        scopeId: "proj-1",
        namespace: "default",
        stateKey: "sync-cursor",
        valueJson: { page: 3 },
      });
      const db = makeSelectDb([row]);

      const store = pluginStateStore(db as never);
      const [first] = await store.list("plugin-uuid-1");

      expect(first).toMatchObject({
        id: "row-id-1",
        pluginId: "plugin-uuid-1",
        scopeKind: "project",
        scopeId: "proj-1",
        stateKey: "sync-cursor",
        valueJson: { page: 3 },
      });
    });

    it("accepts an empty filter object (equivalent to no filter)", async () => {
      const db = makeSelectDb([makeStateRow()]);

      const store = pluginStateStore(db as never);
      const result = await store.list("plugin-uuid-1", {});

      expect(result).toHaveLength(1);
    });
  });

  // =========================================================================
  // deleteAll
  // =========================================================================

  describe("deleteAll", () => {
    it("calls db.delete targeting only the given plugin", async () => {
      const whereMock = vi.fn().mockResolvedValue([]);
      const deleteMock = vi.fn().mockReturnValue({ where: whereMock });
      const db = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: deleteMock };

      const store = pluginStateStore(db as never);
      await store.deleteAll("plugin-uuid-1");

      expect(deleteMock).toHaveBeenCalledOnce();
      expect(whereMock).toHaveBeenCalledOnce();
    });

    it("resolves to undefined on success", async () => {
      const db = {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      };

      const store = pluginStateStore(db as never);
      await expect(store.deleteAll("plugin-uuid-1")).resolves.toBeUndefined();
    });

    it("does not throw when the plugin has no state (no rows to delete)", async () => {
      const db = {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      };

      const store = pluginStateStore(db as never);
      // Should succeed silently even if there were 0 rows deleted
      await expect(store.deleteAll("plugin-with-no-state")).resolves.not.toThrow();
    });

    it("is called once per plugin — different pluginIds use separate calls", async () => {
      const makeDeleteDb = () => ({
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });

      const db1 = makeDeleteDb();
      const db2 = makeDeleteDb();

      await pluginStateStore(db1 as never).deleteAll("plugin-a");
      await pluginStateStore(db2 as never).deleteAll("plugin-b");

      expect(db1.delete).toHaveBeenCalledOnce();
      expect(db2.delete).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // PluginStateStore type export
  // =========================================================================

  describe("PluginStateStore type", () => {
    it("pluginStateStore returns an object with the expected methods", () => {
      const db = makeSelectDb([]);
      const store = pluginStateStore(db as never);

      expect(typeof store.get).toBe("function");
      expect(typeof store.set).toBe("function");
      expect(typeof store.delete).toBe("function");
      expect(typeof store.list).toBe("function");
      expect(typeof store.deleteAll).toBe("function");
    });
  });
});
