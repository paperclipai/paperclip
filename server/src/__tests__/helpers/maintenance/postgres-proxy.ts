import { createHash } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";

export type ObservedQuery = { protocol: "simple" | "extended"; sql: string; fingerprint: string };

export function createPostgresProtocolObserver(onQuery: (query: ObservedQuery) => void, onFrame: (type: string) => void = () => {}) {
  let frontend = Buffer.alloc(0), backend = Buffer.alloc(0), startup = true, ready = false, pending = 1;
  const statements = new Map<string, string>(), portals = new Map<string, string>();
  function cstring(body: Buffer, offset = 0): [string, number] {
    const end = body.indexOf(0, offset);
    if (end < 0) throw new Error("PostgreSQL protocol string is incomplete");
    return [body.toString("utf8", offset, end), end + 1];
  }
  function observe(protocol: ObservedQuery["protocol"], sql: string) {
    onQuery({ protocol, sql, fingerprint: createHash("sha256").update(sql).digest("hex").slice(0, 16) });
  }
  return {
    get pending() { return pending; },
    get ready() { return ready; },
    frontend(chunk: Buffer) {
      frontend = Buffer.concat([frontend, chunk]);
      while (frontend.length >= (startup ? 8 : 5)) {
        const length = frontend.readInt32BE(startup ? 0 : 1);
        if (length < (startup ? 8 : 4) || length > 64 * 1024 * 1024) throw new Error(`Invalid PostgreSQL frame length: ${JSON.stringify({ length, startup, bufferedBytes: frontend.length, header: frontend.subarray(0, startup ? 8 : 5).toString("hex") })}`);
        const total = length + (startup ? 0 : 1);
        if (frontend.length < total) return;
        const frame = frontend.subarray(0, total);
        frontend = frontend.subarray(total);
        if (startup) {
          const protocol = frame.readInt32BE(4);
          if (protocol === 196608) startup = false;
          else if (protocol !== 80877103 && protocol !== 80877104 && protocol !== 80877102) throw new Error("Unsupported PostgreSQL startup protocol");
          continue;
        }
        const type = String.fromCharCode(frame[0]!), body = frame.subarray(5);
        onFrame(type);
        if (type === "Q") { pending++; observe("simple", cstring(body)[0]); }
        else if (type === "P") {
          const [name, offset] = cstring(body);
          statements.set(name, cstring(body, offset)[0]);
        } else if (type === "B") {
          const [portal, offset] = cstring(body);
          portals.set(portal, cstring(body, offset)[0]);
        } else if (type === "E") {
          const portal = cstring(body)[0], statement = portals.get(portal);
          if (statement === undefined || !statements.has(statement)) throw new Error("Executed PostgreSQL statement was not observed");
          observe("extended", statements.get(statement)!);
        } else if (type === "S") pending++;
        else if (type === "C") {
          const name = cstring(body, 1)[0];
          if (body[0] === 83) statements.delete(name);
          else portals.delete(name);
        }
      }
    },
    backend(chunk: Buffer) {
      backend = Buffer.concat([backend, chunk]);
      if (startup && backend.length === 1 && backend[0] === 78) { backend = Buffer.alloc(0); return; }
      while (backend.length >= 5) {
        const length = backend.readInt32BE(1);
        if (length < 4 || length > 64 * 1024 * 1024) throw new Error("Unsupported encrypted or invalid PostgreSQL response");
        if (backend.length < length + 1) return;
        if (backend[0] === 90) { ready = true; pending = Math.max(0, pending - 1); }
        backend = backend.subarray(length + 1);
      }
    },
  };
}

export async function startMaintenancePostgresProxy(databaseUrl: string) {
  const upstream = new URL(databaseUrl), queries: ObservedQuery[] = [], errors: Error[] = [];
  const frames = { Query: 0, Parse: 0, Bind: 0, Execute: 0, Sync: 0, Terminate: 0 };
  const transport = { connectionsOpened: 0, connectionsClosed: 0, frontendBytes: 0, backendBytes: 0 };
  const sockets = new Set<Socket>(), observers = new Set<ReturnType<typeof createPostgresProtocolObserver>>();
  const server = createServer(client => {
    transport.connectionsOpened++;
    client.once("close", () => { transport.connectionsClosed++; });
    const target = createConnection({ host: upstream.hostname, port: Number(upstream.port) || 5432 });
    const observer = createPostgresProtocolObserver(query => queries.push(query), type => {
      if (type === "Q") frames.Query++; else if (type === "P") frames.Parse++; else if (type === "B") frames.Bind++;
      else if (type === "E") frames.Execute++; else if (type === "S") frames.Sync++; else if (type === "X") frames.Terminate++;
    });
    observers.add(observer);
    for (const socket of [client, target]) {
      sockets.add(socket);
      socket.on("error", error => { errors.push(error); client.destroy(); target.destroy(); });
      socket.on("close", () => { sockets.delete(socket); if (client.destroyed && target.destroyed) observers.delete(observer); });
    }
    client.on("data", chunk => { transport.frontendBytes += chunk.length; try { observer.frontend(chunk); } catch (error) { errors.push(error as Error); client.destroy(); target.destroy(); } });
    target.on("data", chunk => { transport.backendBytes += chunk.length; try { observer.backend(chunk); } catch (error) { errors.push(error as Error); client.destroy(); target.destroy(); } });
    client.pipe(target); target.pipe(client);
    client.on("end", () => target.end()); target.on("end", () => client.end());
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("PostgreSQL observer failed to bind");
  const url = new URL(databaseUrl); url.hostname = "127.0.0.1"; url.port = String(address.port); url.searchParams.set("sslmode", "disable");
  return {
    url: url.toString(), queries, errors,
    get frames() { return { ...frames }; },
    get transport() { return { ...transport }; },
    get pending() { return [...observers].reduce((sum, observer) => sum + observer.pending, 0); },
    get starting() { return [...observers].filter(observer => !observer.ready).length; },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
