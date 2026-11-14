import { expect, it } from "vitest";
import { connectPostgres } from "./postgres-connection.js";

it("uses a Unix socket rather than TCP for libpq host URIs", async () => {
  const client = connectPostgres("postgresql://runtime@localhost:5433/example?host=/run/postgresql");
  try {
    expect(client.options.host).toEqual(["/run/postgresql"]);
    expect(client.options.path).toBe("/run/postgresql/.s.PGSQL.5433");
    expect(client.options.connection).not.toHaveProperty("host");
  } finally {
    await client.end();
  }
});

it("preserves explicit driver host overrides", async () => {
  const client = connectPostgres("postgresql://runtime@localhost/example?host=/run/postgresql", {
    host: "/other/socket",
    port: 5434,
  });
  try {
    expect(client.options.path).toBe("/other/socket/.s.PGSQL.5434");
    expect(client.options.connection).not.toHaveProperty("host");
  } finally {
    await client.end();
  }
});

it("supports TCP hosts in the libpq host query parameter", async () => {
  const client = connectPostgres("postgresql://runtime@localhost:5433/example?host=db.example");
  try {
    expect(client.options.host).toEqual(["db.example"]);
    expect(client.options.path).toBeFalsy();
    expect(client.options.connection).not.toHaveProperty("host");
  } finally {
    await client.end();
  }
});
