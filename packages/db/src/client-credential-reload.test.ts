import net from "node:net";
import { describe, expect, it } from "vitest";
import { closeRegisteredClients, createDb, mergeDatabaseCredentialPassword, reloadDatabaseCredential, withDedicatedDbConnection, type Db } from "./client.js";

/**
 * A Postgres wire peer that requires cleartext password auth, so it observes
 * exactly the password the client sends on every connection. This is what lets
 * a test prove a credential reload reconnects with the rotated password: the
 * peer records each password in arrival order. The extended-query responses
 * mirror `client-disconnect-replay.test.ts`, the working in-repo reference for
 * a minimal postgres.js peer.
 */
async function startAuthCapturingPeer() {
  const sockets = new Set<net.Socket>();
  const passwords: string[] = [];
  const passwordRequest = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 3]);
  const authOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
  const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
  const parseComplete = Buffer.from([0x31, 0, 0, 0, 4]);
  const bindComplete = Buffer.from([0x32, 0, 0, 0, 4]);
  const emptyRowDescription = Buffer.from([0x54, 0, 0, 0, 6, 0, 0]);
  const commandComplete = Buffer.from([0x43, 0, 0, 0, 0x0d, ...Buffer.from("SELECT 1\0")]);
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let stage: "startup" | "password" | "ready" = "startup";
    let pending = Buffer.alloc(0);
    const statements = new Map<string, number[]>();
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (stage === "startup") {
        if (pending.length < 8) return;
        const total = pending.readUInt32BE(0);
        if (pending.length < total) return;
        pending = pending.subarray(total);
        socket.write(passwordRequest);
        stage = "password";
        return;
      }
      if (stage === "password") {
        if (pending.length < 5 || pending[0] !== 0x70) return;
        const length = pending.readUInt32BE(1);
        if (pending.length < length) return;
        const payload = pending.subarray(5, length);
        const nul = payload.indexOf(0);
        passwords.push(payload.subarray(0, nul === -1 ? payload.length : nul).toString());
        // The int32 length excludes the type byte, so the message spans
        // `1 + length` bytes; dropping only `length` would leave the password's
        // trailing NUL ahead of the first query message.
        pending = pending.subarray(length + 1);
        socket.write(Buffer.concat([authOk, ready]));
        stage = "ready";
      }
      while (pending.length >= 5) {
        const size = pending.readUInt32BE(1) + 1;
        if (pending.length < size) return;
        const message = pending.subarray(0, size);
        pending = pending.subarray(size);
        if (message[0] === 0x50) {
          const nameEnd = message.indexOf(0, 5);
          const textEnd = message.indexOf(0, nameEnd + 1);
          const name = message.toString("utf8", 5, nameEnd);
          const count = message.readUInt16BE(textEnd + 1);
          const parameterTypes = Array.from({ length: count }, (_, index) =>
            message.readUInt32BE(textEnd + 3 + index * 4) || 23);
          statements.set(name, parameterTypes);
          socket.write(parseComplete);
        } else if (message[0] === 0x44) {
          const name = message.toString("utf8", 6, message.length - 1);
          const parameterTypes = statements.get(name) ?? [];
          const description = Buffer.alloc(7 + parameterTypes.length * 4);
          description[0] = 0x74;
          description.writeUInt32BE(description.length - 1, 1);
          description.writeUInt16BE(parameterTypes.length, 5);
          parameterTypes.forEach((type, index) => description.writeUInt32BE(type, 7 + index * 4));
          socket.write(Buffer.concat([description, emptyRowDescription]));
        } else if (message[0] === 0x42) {
          socket.write(bindComplete);
        } else if (message[0] === 0x45) {
          socket.write(commandComplete);
        } else if (message[0] === 0x51) {
          socket.write(Buffer.concat([commandComplete, ready]));
        } else if (message[0] === 0x53) {
          socket.write(ready);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    urlFor: (password: string, database = "test") => `postgres://test:${password}@127.0.0.1:${port}/${database}`,
    passwords: () => [...passwords],
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function run(db: Db): Promise<void> {
  await db.$client.unsafe("select 1");
}

describe("credential reload", () => {
  it("reconnects with the rotated credential on the same database", async () => {
    const peer = await startAuthCapturingPeer();
    let sourceUrl = peer.urlFor("firstpw");
    try {
      const db = createDb(sourceUrl, { credentialSource: () => sourceUrl });
      await run(db);
      expect(peer.passwords()).toEqual(["firstpw"]);

      sourceUrl = peer.urlFor("secondpw");
      await reloadDatabaseCredential(db);
      await run(db);
      expect(peer.passwords()).toEqual(["firstpw", "secondpw"]);
    } finally {
      await peer.close();
      await closeRegisteredClients(peer.urlFor("ignored"));
    }
  }, 15000);

  it("is a no-op when the source returns the same URL", async () => {
    const peer = await startAuthCapturingPeer();
    const fixed = peer.urlFor("firstpw");
    try {
      const db = createDb(fixed, { credentialSource: () => fixed });
      await run(db);
      await reloadDatabaseCredential(db);
      await run(db);
      expect(peer.passwords()).toEqual(["firstpw"]);
    } finally {
      await peer.close();
      await closeRegisteredClients(peer.urlFor("ignored"));
    }
  }, 15000);

  it("does not reset the pool when the source returns a different database", async () => {
    const peer = await startAuthCapturingPeer();
    let sourceUrl = peer.urlFor("firstpw");
    try {
      const db = createDb(sourceUrl, { credentialSource: () => sourceUrl });
      await run(db);
      expect(peer.passwords()).toEqual(["firstpw"]);

      sourceUrl = peer.urlFor("secondpw", "otherdb");
      await reloadDatabaseCredential(db);
      await run(db);
      expect(peer.passwords()).toEqual(["firstpw"]);
    } finally {
      await peer.close();
      await closeRegisteredClients(peer.urlFor("ignored"));
    }
  }, 15000);

  it("is a no-op when no credential source was installed", async () => {
    const peer = await startAuthCapturingPeer();
    try {
      const db = createDb(peer.urlFor("firstpw"));
      await run(db);
      await reloadDatabaseCredential(db);
      await run(db);
      expect(peer.passwords()).toEqual(["firstpw"]);
    } finally {
      await peer.close();
      await closeRegisteredClients(peer.urlFor("ignored"));
    }
  }, 15000);

  it("does not send a repointed file's password to the original server", async () => {
    const peer = await startAuthCapturingPeer();
    let sourceUrl = peer.urlFor("firstpw");
    try {
      const db = createDb(sourceUrl, { credentialSource: () => sourceUrl });
      await run(db);
      expect(peer.passwords()).toEqual(["firstpw"]);

      // Repoint the file to a different database on the same server. The pool
      // is not reset (target changed), but a brand-new connection (dedicated)
      // now reads the repointed file. Its password must not be disclosed to the
      // original server — an empty password is sent instead.
      sourceUrl = peer.urlFor("secondpw", "otherdb");
      await withDedicatedDbConnection(db, (dedicated) => dedicated.$client.unsafe("select 1"));
      expect(peer.passwords()).not.toContain("secondpw");
    } finally {
      await peer.close();
      await closeRegisteredClients(peer.urlFor("ignored"));
    }
  }, 15000);

  it("reports the reload outcome (unchanged / reloaded / rejected)", async () => {
    const peer = await startAuthCapturingPeer();
    let sourceUrl = peer.urlFor("firstpw");
    try {
      const db = createDb(sourceUrl, { credentialSource: () => sourceUrl });
      await run(db);

      expect(await reloadDatabaseCredential(db)).toEqual({ status: "unchanged" });

      sourceUrl = peer.urlFor("secondpw");
      expect(await reloadDatabaseCredential(db)).toEqual({ status: "reloaded" });

      sourceUrl = peer.urlFor("thirdpw", "otherdb");
      expect(await reloadDatabaseCredential(db)).toEqual({ status: "rejected", reason: "target-mismatch" });
    } finally {
      await peer.close();
      await closeRegisteredClients(peer.urlFor("ignored"));
    }
  }, 15000);

  it("mergeDatabaseCredentialPassword copies the file password in but keeps the base URL's options", async () => {
    const base = "postgres://app:oldpw@db.internal:5432/app?sslmode=require&connect_timeout=5";
    // Same target as base, but the file carries no connection options.
    const source = () => "postgres://app:newpw@db.internal:5432/app";
    const merged = await mergeDatabaseCredentialPassword(base, source);
    const url = new URL(merged);
    expect(url.password).toBe("newpw"); // rotated password from the file
    expect(url.username).toBe("app");
    expect(url.hostname).toBe("db.internal");
    expect(url.port).toBe("5432");
    expect(url.pathname).toBe("/app");
    expect(url.searchParams.get("sslmode")).toBe("require"); // preserved
    expect(url.searchParams.get("connect_timeout")).toBe("5"); // preserved
  });

  it("mergeDatabaseCredentialPassword leaves the base unchanged when the file is repointed", async () => {
    const base = "postgres://app:oldpw@db.internal:5432/app?sslmode=require";
    const source = () => "postgres://app:newpw@db.internal:5432/otherdb"; // different database
    const merged = await mergeDatabaseCredentialPassword(base, source);
    expect(merged).toBe(base);
  });

  it("mergeDatabaseCredentialPassword handles a password-less base and encodes special chars", async () => {
    const base = "postgres://app@db.internal:5432/app?sslmode=require"; // no password in base
    const source = () => "postgres://app:p%40ss@db.internal:5432/app"; // p@ss
    const merged = await mergeDatabaseCredentialPassword(base, source);
    const url = new URL(merged);
    expect(decodeURIComponent(url.password)).toBe("p@ss"); // the real password
    expect(url.searchParams.get("sslmode")).toBe("require");
  });
});
