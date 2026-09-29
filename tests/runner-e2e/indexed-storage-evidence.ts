import { constants } from "node:fs";
import { open, readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { authorityGeneration as validateAuthorityGeneration } from "../../packages/paperclip-runner/src/control-plane/durable-authority-store.js";

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_FANOUT = 32;
const MAX_AUTHORITY_GENERATION = (1n << 63n) - 1n;
const SHA256 = /^[a-f0-9]{64}$/;

type PageRef = { sha: string; inline?: string; origin?: string };
type Edge = { lower: string; largest: number; page: PageRef };
type Route = {
  lower: string;
  file: string;
  records: number;
  bytes: number;
  fingerprint: number[];
};
type NodePage =
  | { kind: "Leaf"; rows: Route[] }
  | { kind: "Branch"; level: number; children: Edge[] };

function invalid(message: string): never {
  throw new Error(`indexed storage oracle: ${message}`);
}

function safeNonnegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid(`invalid ${field}`);
  }
  return value;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function authorityGeneration(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return String(value);
  const normalized =
    typeof value === "bigint" || typeof value === "string"
      ? String(value)
      : null;
  if (normalized === null)
    return invalid("invalid committed authority generation");
  try {
    validateAuthorityGeneration(normalized);
    if (!normalized.startsWith("r:") && BigInt(normalized) <= 0n)
      return invalid("invalid committed authority generation");
    if (
      !normalized.startsWith("r:") &&
      BigInt(normalized) > MAX_AUTHORITY_GENERATION
    )
      return invalid("invalid committed authority generation");
    return normalized;
  } catch {
    return invalid("invalid committed authority generation");
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid(`invalid ${name}`);
  return value as Record<string, unknown>;
}

function parseEdge(value: unknown): Edge {
  const edge = object(value, "routing edge");
  if (
    typeof edge.lower !== "string" ||
    Buffer.byteLength(edge.lower, "utf8") > 4096
  )
    return invalid("invalid routing edge lower bound");
  const largest = safeNonnegativeInteger(
    edge.largest,
    "routing edge largest value",
  );
  const page = object(edge.page, "routing page reference");
  if (typeof page.sha !== "string" || !SHA256.test(page.sha))
    return invalid("invalid routing page digest");
  if (page.origin !== undefined && page.origin !== null)
    return invalid("routing page has an origin reference");
  if (
    page.inline !== undefined &&
    (typeof page.inline !== "string" ||
      Buffer.byteLength(page.inline) > MAX_PAGE_BYTES)
  ) {
    return invalid("routing inline page exceeds bound");
  }
  return {
    lower: edge.lower,
    largest,
    page: {
      sha: page.sha,
      ...(typeof page.inline === "string" ? { inline: page.inline } : {}),
    },
  };
}

function routeLargest(route: Route): number {
  return route.records > 1 ? route.bytes : 0;
}

function parseRoute(value: unknown): Route {
  const route = object(value, "routing row");
  if (
    typeof route.lower !== "string" ||
    Buffer.byteLength(route.lower, "utf8") > 4096 ||
    typeof route.file !== "string" ||
    Buffer.byteLength(route.file, "utf8") > 4096
  ) {
    return invalid("invalid routing row identity");
  }
  if (
    !Array.isArray(route.fingerprint) ||
    route.fingerprint.length !== 32 ||
    route.fingerprint.some((x) => !Number.isInteger(x) || x < 0 || x > 255)
  ) {
    return invalid("invalid routing fingerprint");
  }
  return {
    lower: route.lower,
    file: route.file,
    records: safeNonnegativeInteger(route.records, "routing record count"),
    bytes: safeNonnegativeInteger(route.bytes, "routing byte count"),
    fingerprint: route.fingerprint as number[],
  };
}

function parseNode(value: unknown): NodePage {
  const node = object(value, "routing page");
  if (node.kind === "Leaf") {
    if (
      !Array.isArray(node.rows) ||
      node.rows.length < 1 ||
      node.rows.length > MAX_FANOUT
    )
      return invalid("invalid routing leaf fanout");
    const rows = node.rows.map(parseRoute);
    for (let i = 1; i < rows.length; i++)
      if (compareUtf8(rows[i - 1]!.lower, rows[i]!.lower) >= 0)
        return invalid("routing leaf keys are not ordered");
    return { kind: "Leaf", rows };
  }
  if (node.kind === "Branch") {
    const level = safeNonnegativeInteger(node.level, "routing branch level");
    if (
      level < 1 ||
      level > 0xffff ||
      !Array.isArray(node.children) ||
      node.children.length < 1 ||
      node.children.length > MAX_FANOUT
    ) {
      return invalid("invalid routing branch fanout or level");
    }
    const children = node.children.map(parseEdge);
    if (children.some((child) => child.page.inline !== undefined))
      return invalid("non-root routing page is inline");
    for (let i = 1; i < children.length; i++)
      if (compareUtf8(children[i - 1]!.lower, children[i]!.lower) >= 0)
        return invalid("routing branch keys are not ordered");
    return { kind: "Branch", level, children };
  }
  return invalid("unsupported routing page kind");
}

function edgeForNode(node: NodePage): { lower: string; largest: number } {
  if (node.kind === "Leaf") {
    return {
      lower: node.rows[0]!.lower,
      largest: Math.max(...node.rows.map(routeLargest)),
    };
  }
  return {
    lower: node.children[0]!.lower,
    largest: Math.max(...node.children.map((child) => child.largest)),
  };
}

async function verifyPrivateDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory).catch(() => null);
  if (
    !stat?.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0
  )
    invalid("routing directory is missing or unsafe");
}

async function readPage(dbPath: string, edge: Edge): Promise<NodePage> {
  let bytes: Buffer;
  if (edge.page.inline !== undefined) {
    bytes = Buffer.from(edge.page.inline, "utf8");
  } else {
    const routing = `${dbPath}.routing`;
    const first = path.join(routing, edge.page.sha.slice(0, 2));
    const second = path.join(first, edge.page.sha.slice(2, 4));
    await verifyPrivateDirectory(routing);
    await verifyPrivateDirectory(first);
    await verifyPrivateDirectory(second);
    const filePath = path.join(second, `${edge.page.sha.slice(4)}.json`);
    const pathStat = await lstat(filePath).catch(() => null);
    if (
      !pathStat?.isFile() ||
      pathStat.isSymbolicLink() ||
      (pathStat.mode & 0o077) !== 0 ||
      pathStat.size > MAX_PAGE_BYTES
    )
      invalid("routing page file is missing or unsafe");
    let file;
    try {
      file = await open(
        filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > MAX_PAGE_BYTES
      )
        invalid("routing page file is missing or unsafe");
      const bounded = Buffer.alloc(MAX_PAGE_BYTES + 1);
      let length = 0;
      while (length < bounded.length) {
        const result = await file.read(
          bounded,
          length,
          bounded.length - length,
          null,
        );
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      bytes = bounded.subarray(0, length);
    } catch {
      return invalid("routing page file is missing or unsafe");
    } finally {
      await file?.close();
    }
  }
  if (
    bytes.length > MAX_PAGE_BYTES ||
    createHash("sha256").update(bytes).digest("hex") !== edge.page.sha
  ) {
    return invalid("routing page digest or size mismatch");
  }
  let node: NodePage;
  try {
    node = parseNode(JSON.parse(bytes.toString("utf8")));
  } catch {
    return invalid("routing page is malformed");
  }
  const actual = edgeForNode(node);
  if (actual.lower !== edge.lower || actual.largest !== edge.largest)
    invalid("routing child differs from parent edge");
  return node;
}

/**
 * Walks the immutable route tree in depth-first order without materializing a
 * history-sized collection. Parent pages are reread as the cursor advances,
 * keeping memory bounded to the current page and one edge per tree level.
 */
async function countRoutedReceipts(
  dbPath: string,
  root: Edge,
): Promise<bigint> {
  type Frame = { edge: Edge; level: number; nextChild: number };
  const stack: Frame[] = [];
  let edge = root;
  let expectedLevel: number | undefined;
  let total = 0n;
  let lastRouteLower: string | undefined;
  while (true) {
    const node = await readPage(dbPath, edge);
    if (
      expectedLevel !== undefined &&
      node.kind !== "Branch" &&
      expectedLevel !== 0
    )
      invalid("routing tree level skipped");
    if (
      expectedLevel !== undefined &&
      node.kind === "Branch" &&
      node.level !== expectedLevel
    )
      invalid("routing tree level mismatch");
    if (node.kind === "Leaf") {
      for (const route of node.rows) {
        if (
          lastRouteLower !== undefined &&
          compareUtf8(route.lower, lastRouteLower) <= 0
        )
          invalid("routing ranges overlap or are out of order");
        lastRouteLower = route.lower;
        total += BigInt(route.records);
      }
    } else {
      if (expectedLevel !== undefined && node.level !== expectedLevel)
        invalid("routing tree level mismatch");
      stack.push({ edge, level: node.level, nextChild: 1 });
      edge =
        node.children[0]!.page.inline === undefined
          ? node.children[0]!
          : invalid("routing child is inline");
      expectedLevel = node.level - 1;
      continue;
    }
    let descended = false;
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const parent = await readPage(dbPath, frame.edge);
      if (parent.kind !== "Branch" || parent.level !== frame.level)
        invalid("routing parent changed during read");
      if (frame.nextChild < parent.children.length) {
        const child = parent.children[frame.nextChild++]!;
        if (child.page.inline !== undefined) invalid("routing child is inline");
        edge = child;
        expectedLevel = frame.level - 1;
        descended = true;
        break;
      }
      stack.pop();
    }
    if (!descended) return total;
  }
}

async function receiptCount(
  db: DatabaseSync,
  dbPath: string,
  schemaVersion: number,
): Promise<bigint> {
  if (schemaVersion === 1) {
    const query = db.prepare("SELECT count(*) AS count FROM receipts");
    query.setReadBigInts(true);
    const count = query.get()?.count;
    if (typeof count !== "bigint" || count < 1n)
      return invalid("no durable historical receipts");
    return count;
  }
  if (schemaVersion !== 2) return invalid("unsupported indexed store schema");
  const flatRoutes = db
    .prepare(
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='receipt_routes') AS found",
    )
    .get()?.found;
  if (flatRoutes === 1)
    return invalid("unsupported flat receipt routing format");
  const routingHeads = db
    .prepare(
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='receipt_routing_heads') AS found",
    )
    .get()?.found;
  if (routingHeads !== 1) return invalid("missing receipt routing heads");
  const heads = db.prepare(
    "SELECT CASE WHEN length(CAST(root AS BLOB))<=8388608 THEN root END AS root FROM receipt_routing_heads WHERE name='routes'",
  );
  const rootValue = heads.get()?.root;
  if (
    typeof rootValue !== "string" ||
    Buffer.byteLength(rootValue) > 8 * 1024 * 1024
  )
    return invalid("missing or oversized receipt routing root");
  let root: Edge;
  try {
    root = parseEdge(JSON.parse(rootValue));
  } catch {
    return invalid("receipt routing root is malformed");
  }
  const count = await countRoutedReceipts(dbPath, root);
  if (count < 1n) return invalid("no durable historical receipts");
  return count;
}

/** Read-only oracle. Publishes counts and sizes, never credentials, bindings,
 * provider identities, receipt bodies, or private database files. */
export async function inspectIndexedStorage(instanceRoot: string) {
  const root = path.join(
    instanceRoot,
    "runtime",
    "paperclip-runner",
    "durable-sessions",
  );
  const evidence: Array<{
    controller: "postgres";
    runnerGeneration: string;
    providerGeneration: string;
    runnerCurrentBytes: number;
    providerCurrentBytes: number;
    runnerReceipts: string;
    providerReceipts: string;
  }> = [];
  for (const directory of await readdir(root, { withFileTypes: true })) {
    if (!directory.isDirectory() || !/^[a-f0-9]{64}$/.test(directory.name))
      continue;
    const session = path.join(root, directory.name);
    const controlPath = path.join(
      session,
      "control-plane",
      "control-plane-state.json",
    );
    const stat = await lstat(controlPath).catch(() => null);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
      invalid("controller is not a bounded locator");
    const control = JSON.parse(await readFile(controlPath, "utf8"));
    if (
      control.schema !== "paperclip.runner.authority-locator.v1" ||
      control.location?.kind !== "postgres"
    )
      invalid("controller did not activate Postgres authority");
    const snapshots = [];
    for (const [name, key, schema] of [
      ["runner-state", "runner", "paperclip.runner.durable.state.indexed.v1"],
      [
        "codex-provider-state",
        "codex-provider",
        "paperclip.runner.codex-provider-state.indexed.v1",
      ],
    ] as const) {
      const locatorPath = path.join(session, "runner", `${name}.json`);
      const metadata = await lstat(locatorPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > 4096
      )
        invalid("invalid local locator");
      const locator = JSON.parse(await readFile(locatorPath, "utf8"));
      if (locator.schema !== schema) invalid("local format did not activate");
      const dbPath = path.join(session, "runner", `${name}.sqlite`);
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        db.exec("PRAGMA query_only=ON; BEGIN");
        const bindingQuery = db.prepare(
          "SELECT schema_version,binding FROM store_binding WHERE singleton=1",
        );
        bindingQuery.setReadBigInts(true);
        const binding = bindingQuery.get();
        if (
          !binding ||
          binding.binding !== locator.binding ||
          typeof binding.schema_version !== "bigint"
        )
          invalid("binding mismatch");
        const version = Number(binding.schema_version);
        if (!Number.isSafeInteger(version))
          invalid("invalid indexed schema version");
        const size = db
          .prepare(
            "SELECT length(bytes) AS bytes FROM current_state WHERE key=?",
          )
          .get(key)?.bytes;
        if (
          typeof size !== "number" ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > 32 * 1024 * 1024
        )
          invalid("unbounded current state");
        const query = db.prepare(
          "SELECT generation,bytes,digest FROM current_state WHERE key=?",
        );
        query.setReadBigInts(true);
        const row = query.get(key);
        if (
          !row ||
          !(row.bytes instanceof Uint8Array) ||
          !(row.digest instanceof Uint8Array) ||
          row.digest.byteLength !== 32 ||
          !createHash("sha256")
            .update(row.bytes)
            .digest()
            .equals(Buffer.from(row.digest))
        )
          invalid("invalid current commit");
        const generation = authorityGeneration(row.generation);
        const receipts = await receiptCount(db, dbPath, version);
        snapshots.push({
          generation,
          bytes: size,
          receipts: receipts.toString(),
        });
      } finally {
        db.close();
      }
    }
    evidence.push({
      controller: "postgres",
      runnerGeneration: snapshots[0]!.generation,
      providerGeneration: snapshots[1]!.generation,
      runnerCurrentBytes: snapshots[0]!.bytes,
      providerCurrentBytes: snapshots[1]!.bytes,
      runnerReceipts: snapshots[0]!.receipts,
      providerReceipts: snapshots[1]!.receipts,
    });
  }
  if (!evidence.length) invalid("no indexed session was exercised");
  return {
    schema: "paperclip.indexed-storage-evidence.v2",
    sessions: evidence,
  };
}
