import { expect, it } from "vitest";
import { closeRegisteredClients, createDb } from "./client.js";

it.each(["/run/postgresql", "%2Frun%2Fpostgresql"])(
  "connects through the URI socket host %s while preserving pool options",
  async (host) => {
    const url = `postgresql://runtime@localhost:5433/example?host=${host}`;
    const db = createDb(url, { prepare: false, maxConnections: 2, applicationName: "socket-test" });
    try {
      expect(db.$client.options.host).toEqual(["/run/postgresql"]);
      expect(db.$client.options.path).toBe("/run/postgresql/.s.PGSQL.5433");
      expect(db.$client.options.connection).not.toHaveProperty("host");
      expect(db.$client.options.connection.application_name).toBe("socket-test");
      expect(db.$client.options.prepare).toBe(false);
      expect(db.$client.options.max).toBe(2);
    } finally {
      await closeRegisteredClients(url);
    }
  },
);

it("keeps ordinary TCP URI options", async () => {
  const url = "postgresql://runtime:fixture%3Apassword@db.example:5433/example?sslmode=require";
  const db = createDb(url);
  try {
    expect(db.$client.options.host).toEqual(["db.example"]);
    expect(db.$client.options.port).toEqual([5433]);
    expect(db.$client.options.path).toBeFalsy();
    expect(db.$client.options.database).toBe("example");
    expect(db.$client.options.user).toBe("runtime");
    expect(db.$client.options.ssl).toBe("require");
  } finally {
    await closeRegisteredClients(url);
  }
});
