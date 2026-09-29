import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  lstat,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { inspectIndexedStorage } from "./indexed-storage-evidence.js";

const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const uuid = "7e57d004-2b97-4e7a-8f3b-44b7a90c73e1";

async function makeBase(
  root: string,
  schemaVersion: 1 | 2,
  generation: number | string,
) {
  const session = path.join(
    root,
    "runtime/paperclip-runner/durable-sessions",
    "a".repeat(64),
  );
  await mkdir(path.join(session, "control-plane"), { recursive: true });
  await mkdir(path.join(session, "runner"));
  await writeFile(
    path.join(session, "control-plane/control-plane-state.json"),
    JSON.stringify({
      schema: "paperclip.runner.authority-locator.v1",
      location: { kind: "postgres" },
    }),
  );
  const dbPaths: string[] = [];
  for (const [file, key, schema] of [
    ["runner-state", "runner", "paperclip.runner.durable.state.indexed.v1"],
    [
      "codex-provider-state",
      "codex-provider",
      "paperclip.runner.codex-provider-state.indexed.v1",
    ],
  ]) {
    const dbPath = path.join(session, "runner", `${file}.sqlite`);
    dbPaths.push(dbPath);
    await writeFile(
      path.join(session, "runner", `${file}.json`),
      JSON.stringify({ schema, binding: "private-binding" }),
    );
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE store_binding(singleton INTEGER, schema_version INTEGER, binding TEXT); CREATE TABLE current_state(key TEXT,generation,bytes BLOB,digest BLOB); CREATE TABLE receipts(bytes BLOB); CREATE TABLE receipt_routing_heads(name TEXT PRIMARY KEY,root TEXT);",
    );
    db.prepare("INSERT INTO store_binding VALUES(1,?, 'private-binding')").run(
      schemaVersion,
    );
    const bytes = Buffer.from('{"private":"provider-data"}');
    db.prepare("INSERT INTO current_state VALUES(?,?,?,?)").run(
      key,
      generation,
      bytes,
      createHash("sha256").update(bytes).digest(),
    );
    if (schemaVersion === 1) db.exec("INSERT INTO receipts VALUES(X'00')");
    db.close();
  }
  return { session, dbPaths };
}

async function writePage(dbPath: string, node: unknown) {
  const bytes = Buffer.from(JSON.stringify(node));
  const digest = sha(bytes);
  const directory = path.join(
    `${dbPath}.routing`,
    digest.slice(0, 2),
    digest.slice(2, 4),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, `${digest.slice(4)}.json`), bytes, {
    mode: 0o600,
  });
  return { sha: digest };
}

function route(lower: string, records: number) {
  return {
    lower,
    file: `private-shard-${lower}.sqlite`,
    records,
    bytes: 256,
    fingerprint: Array(32).fill(7),
  };
}

async function putTree(dbPath: string, totalRecords = 3) {
  const leafOne = { kind: "Leaf", rows: [route("", totalRecords)] };
  const leafTwo = { kind: "Leaf", rows: [route("z", totalRecords)] };
  const pageOne = await writePage(dbPath, leafOne);
  const pageTwo = await writePage(dbPath, leafTwo);
  const leafEdge = (lower: string, page: { sha: string }) => ({
    lower,
    largest: 256,
    page,
  });
  const middle = {
    kind: "Branch",
    level: 1,
    children: [leafEdge("", pageOne), leafEdge("z", pageTwo)],
  };
  const middlePage = await writePage(dbPath, middle);
  const rootNode = {
    kind: "Branch",
    level: 2,
    children: [{ lower: "", largest: 256, page: middlePage }],
  };
  const inline = JSON.stringify(rootNode);
  const root = { lower: "", largest: 256, page: { sha: sha(inline), inline } };
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO receipt_routing_heads VALUES('routes',?)").run(
    JSON.stringify(root),
  );
  db.close();
  return { rootNode, middle, pageOne, pageTwo };
}

async function putTwoLeafTree(
  dbPath: string,
  firstLower: string,
  secondLower: string,
) {
  const firstPage = await writePage(dbPath, {
    kind: "Leaf",
    rows: [route(firstLower, 2)],
  });
  const secondPage = await writePage(dbPath, {
    kind: "Leaf",
    rows: [route(secondLower, 2)],
  });
  const middle = {
    kind: "Branch",
    level: 1,
    children: [
      { lower: firstLower, largest: 256, page: firstPage },
      { lower: secondLower, largest: 256, page: secondPage },
    ],
  };
  const middlePage = await writePage(dbPath, middle);
  const rootNode = {
    kind: "Branch",
    level: 2,
    children: [{ lower: firstLower, largest: 256, page: middlePage }],
  };
  const inline = JSON.stringify(rootNode);
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO receipt_routing_heads VALUES('routes',?)").run(
    JSON.stringify({
      lower: firstLower,
      largest: 256,
      page: { sha: sha(inline), inline },
    }),
  );
  db.close();
}

async function treeDigest(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string) {
    const metadata = await lstat(directory);
    if (metadata.isFile()) {
      output.push(
        `${path.basename(directory)}:${sha(await readFile(directory))}`,
      );
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else
        output.push(
          `${path.relative(root, file)}:${sha(await readFile(file))}`,
        );
    }
  }
  await visit(root);
  return output.sort();
}

it("accepts v1 stores and exports exact decimal-string receipt counts without private data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "indexed-evidence-v1-"));
  try {
    const { dbPaths } = await makeBase(root, 1, 17);
    const evidence = await inspectIndexedStorage(root);
    expect(evidence.schema).toBe("paperclip.indexed-storage-evidence.v2");
    expect(evidence.sessions[0]).toMatchObject({
      runnerGeneration: "17",
      runnerReceipts: "1",
      providerReceipts: "1",
    });
    expect(JSON.stringify(evidence)).not.toContain("private");
    expect(JSON.stringify(evidence)).not.toContain("provider-data");
    for (const dbPath of dbPaths)
      expect((await lstat(dbPath)).isFile()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("counts a subdivided route tree and accepts opaque authority generations read-only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "indexed-evidence-tree-"));
  try {
    const { session, dbPaths } = await makeBase(root, 2, `r:${uuid}`);
    for (const dbPath of dbPaths)
      await putTree(dbPath, Number.MAX_SAFE_INTEGER);
    const before = await Promise.all(
      [...dbPaths, ...dbPaths.map((dbPath) => `${dbPath}.routing`)].map((p) =>
        treeDigest(p),
      ),
    );
    const evidence = await inspectIndexedStorage(root);
    expect(evidence.schema).toBe("paperclip.indexed-storage-evidence.v2");
    expect(evidence.sessions[0]).toMatchObject({
      runnerGeneration: `r:${uuid}`,
      runnerReceipts: "18014398509481982",
      providerReceipts: "18014398509481982",
    });
    const after = await Promise.all(
      [...dbPaths, ...dbPaths.map((dbPath) => `${dbPath}.routing`)].map((p) =>
        treeDigest(p),
      ),
    );
    expect(after).toEqual(before);
    expect(await lstat(session)).toBeTruthy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("uses Rust UTF-8 byte ordering for supplementary Unicode route keys", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "indexed-evidence-unicode-"));
  try {
    const { dbPaths } = await makeBase(root, 2, 6);
    const bmp = "\uE000";
    const supplementary = "\u{10000}";
    for (const dbPath of dbPaths)
      await putTwoLeafTree(dbPath, bmp, supplementary);
    const evidence = await inspectIndexedStorage(root);
    expect(evidence.sessions[0]).toMatchObject({
      runnerReceipts: "4",
      providerReceipts: "4",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects reverse Unicode ordering where UTF-8 bytes descend", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "indexed-evidence-unicode-reverse-"),
  );
  try {
    const { dbPaths } = await makeBase(root, 2, 7);
    await putTwoLeafTree(dbPaths[0]!, "\u{10000}", "\uE000");
    await expect(inspectIndexedStorage(root)).rejects.toThrow(
      "routing page is malformed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects keys that overlap across otherwise valid leaf ranges", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "indexed-evidence-overlap-"));
  try {
    const { dbPaths } = await makeBase(root, 2, 4);
    const firstLeaf = {
      kind: "Leaf",
      rows: [route("", 2), route("zz", 2)],
    };
    const secondLeaf = { kind: "Leaf", rows: [route("z", 2)] };
    const firstPage = await writePage(dbPaths[0]!, firstLeaf);
    const secondPage = await writePage(dbPaths[0]!, secondLeaf);
    const middle = {
      kind: "Branch",
      level: 1,
      children: [
        { lower: "", largest: 256, page: firstPage },
        { lower: "z", largest: 256, page: secondPage },
      ],
    };
    const middlePage = await writePage(dbPaths[0]!, middle);
    const rootNode = {
      kind: "Branch",
      level: 2,
      children: [{ lower: "", largest: 256, page: middlePage }],
    };
    const inline = JSON.stringify(rootNode);
    const db = new DatabaseSync(dbPaths[0]!);
    db.prepare("INSERT INTO receipt_routing_heads VALUES('routes',?)").run(
      JSON.stringify({
        lower: "",
        largest: 256,
        page: { sha: sha(inline), inline },
      }),
    );
    db.close();
    await expect(inspectIndexedStorage(root)).rejects.toThrow(
      "routing ranges overlap or are out of order",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not disclose malformed root or page contents in diagnostics", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "indexed-evidence-redaction-"),
  );
  try {
    const { dbPaths } = await makeBase(root, 2, 5);
    const secretRoot = "ROOT_PRIVATE_SENTINEL";
    const db = new DatabaseSync(dbPaths[0]!);
    db.prepare("INSERT INTO receipt_routing_heads VALUES('routes',?)").run(
      secretRoot,
    );
    db.close();
    await expect(inspectIndexedStorage(root)).rejects.toThrow(
      "receipt routing root is malformed",
    );
    let errorText = "";
    try {
      await inspectIndexedStorage(root);
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
    }
    expect(errorText).not.toContain(secretRoot);

    const secretPage = Buffer.from('{"private":"PAGE_PRIVATE_SENTINEL"}');
    const pageSha = sha(secretPage);
    const pageDirectory = path.join(
      `${dbPaths[0]}.routing`,
      pageSha.slice(0, 2),
      pageSha.slice(2, 4),
    );
    await mkdir(pageDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(pageDirectory, `${pageSha.slice(4)}.json`),
      secretPage,
      {
        mode: 0o600,
      },
    );
    const edge = JSON.stringify({
      lower: "",
      largest: 0,
      page: { sha: pageSha },
    });
    const update = new DatabaseSync(dbPaths[0]!);
    update
      .prepare("UPDATE receipt_routing_heads SET root=? WHERE name='routes'")
      .run(edge);
    update.close();
    errorText = "";
    try {
      await inspectIndexedStorage(root);
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
    }
    expect(errorText).toContain("routing page is malformed");
    expect(errorText).not.toContain("PAGE_PRIVATE_SENTINEL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  "missing page",
  "corrupt page",
  "origin reference",
  "flat legacy format",
  "symlink directory",
] as const)("rejects %s in schema v2", async (mode) => {
  const root = await mkdtemp(path.join(tmpdir(), "indexed-evidence-invalid-"));
  try {
    const { dbPaths } = await makeBase(root, 2, 3);
    const { pageOne } = await putTree(dbPaths[0]!);
    const filePath = path.join(
      `${dbPaths[0]}.routing`,
      pageOne.sha.slice(0, 2),
      pageOne.sha.slice(2, 4),
      `${pageOne.sha.slice(4)}.json`,
    );
    if (mode === "missing page") await rm(filePath);
    if (mode === "corrupt page")
      await writeFile(filePath, "{}", { mode: 0o600 });
    if (mode === "symlink directory") {
      const routingRoot = `${dbPaths[0]}.routing`;
      const firstDir = path.join(routingRoot, pageOne.sha.slice(0, 2));
      const outside = path.join(root, "outside-routing");
      const outsideParent = path.join(outside, pageOne.sha.slice(0, 2));
      await mkdir(path.join(outsideParent, pageOne.sha.slice(2, 4)), {
        recursive: true,
      });
      await writeFile(
        path.join(
          outsideParent,
          pageOne.sha.slice(2, 4),
          `${pageOne.sha.slice(4)}.json`,
        ),
        await readFile(filePath),
      );
      await rm(firstDir, { recursive: true });
      await symlink(outsideParent, firstDir);
    }
    if (mode === "origin reference") {
      const db = new DatabaseSync(dbPaths[0]!);
      const current = JSON.parse(
        String(
          db
            .prepare(
              "SELECT root FROM receipt_routing_heads WHERE name='routes'",
            )
            .get()!.root,
        ),
      );
      current.page.origin = "/outside/store";
      db.prepare(
        "UPDATE receipt_routing_heads SET root=? WHERE name='routes'",
      ).run(JSON.stringify(current));
      db.close();
    }
    if (mode === "flat legacy format") {
      const db = new DatabaseSync(dbPaths[0]!);
      db.exec("CREATE TABLE receipt_routes(lower_key TEXT)");
      db.close();
    }
    await expect(inspectIndexedStorage(root)).rejects.toThrow(
      mode === "symlink directory"
        ? "routing directory is missing or unsafe"
        : "indexed storage oracle",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects symlinked routing pages and unsupported generations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "indexed-evidence-symlink-"));
  try {
    const { dbPaths } = await makeBase(root, 2, "fenced");
    const generationDb = new DatabaseSync(dbPaths[0]!);
    generationDb
      .prepare("UPDATE current_state SET generation=? WHERE key='runner'")
      .run(7);
    generationDb.close();
    // Repair the provider generation too so the routing corruption is reached.
    const providerDb = new DatabaseSync(dbPaths[1]!);
    providerDb
      .prepare(
        "UPDATE current_state SET generation=? WHERE key='codex-provider'",
      )
      .run(7);
    providerDb.close();
    const { pageOne } = await putTree(dbPaths[0]!);
    const filePath = path.join(
      `${dbPaths[0]}.routing`,
      pageOne.sha.slice(0, 2),
      pageOne.sha.slice(2, 4),
      `${pageOne.sha.slice(4)}.json`,
    );
    const regularPath = `${filePath}.regular`;
    await rm(filePath);
    await writeFile(
      regularPath,
      JSON.stringify({ kind: "Leaf", rows: [route("", 1)] }),
      { mode: 0o600 },
    );
    await symlink(regularPath, filePath);
    await expect(inspectIndexedStorage(root)).rejects.toThrow(
      "routing page file is missing or unsafe",
    );
    await rm(filePath);
    await writeFile(
      filePath,
      JSON.stringify({ kind: "Leaf", rows: [route("", 1)] }),
      { mode: 0o600 },
    );
    const db = new DatabaseSync(dbPaths[0]!);
    db.prepare("UPDATE current_state SET generation=? WHERE key='runner'").run(
      "fenced",
    );
    db.close();
    await expect(inspectIndexedStorage(root)).rejects.toThrow(
      "invalid committed authority generation",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects invalid locator formats before reporting evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "indexed-evidence-locator-"));
  try {
    const { session } = await makeBase(root, 1, 1);
    await writeFile(
      path.join(session, "control-plane/control-plane-state.json"),
      JSON.stringify({
        schema: "paperclip.runner.durable.control-plane-state.v1",
      }),
    );
    await expect(inspectIndexedStorage(root)).rejects.toThrow(
      "did not activate Postgres authority",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
