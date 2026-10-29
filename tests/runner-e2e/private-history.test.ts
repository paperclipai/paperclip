import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { BoundedHistoryPublisher } from "./history-budget.js";
import { archivePrivateEvidence, PRIVATE_HISTORY_PREFIX, privateArtifactKey, retainPrivateTransfer, transferPrivateArtifact, verifyPrivateHistory } from "./private-history.js";

const execute = promisify(execFile);
const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), "private-history-test-")); roots.push(root); return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function configurations() {
  return {
    "get-bucket-versioning": { Status: "Enabled" },
    "get-bucket-lifecycle-configuration": { Rules: [
      { Status: "Enabled", Filter: { Prefix: `${PRIVATE_HISTORY_PREFIX}/` }, Expiration: { Days: 30 },
        NoncurrentVersionExpiration: { NoncurrentDays: 1 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
      { Status: "Enabled", Filter: { Prefix: `${PRIVATE_HISTORY_PREFIX}/` }, Expiration: { ExpiredObjectDeleteMarker: true } },
    ] },
    "get-public-access-block": { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } },
    "get-bucket-ownership-controls": { OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] } },
    "get-bucket-policy": { Policy: JSON.stringify({ Statement: [{ Effect: "Deny" }] }) },
  };
}
function configurationRunner(config: Record<string, unknown>) {
  return async (args: string[]) => {
    if (args[1] === "get-object-lock-configuration" || args[1] === "get-bucket-replication") {
      throw Object.assign(new Error("Not configured"), { stderr: `(${args[1] === "get-object-lock-configuration" ? "ObjectLockConfigurationNotFoundError" : "ReplicationConfigurationNotFoundError"})` });
    }
    if (!(args[1]! in config)) throw new Error(`Unexpected AWS operation ${args[1]}`);
    return { stdout: JSON.stringify(config[args[1]!]) };
  };
}

it("round trips binary evidence and a ledger without exposing unrelated files", async () => {
  const root = await temporary(), source = path.join(root, "source"), archive = path.join(root, "evidence.zip"), destination = path.join(root, "restored");
  await mkdir(path.join(source, "scheduled"), { recursive: true });
  await writeFile(path.join(source, "scheduled/ledger.jsonl"), '{"cost":"unknown"}\n');
  await writeFile(path.join(source, "binary.png"), Buffer.from([0, 255, 17, 0]));
  await writeFile(path.join(root, "outside"), "private outside material");
  expect(await archivePrivateEvidence("pack", source, archive)).toMatchObject({ files: 2 });
  expect(await archivePrivateEvidence("unpack", archive, destination)).toMatchObject({ files: 2 });
  expect(await readFile(path.join(destination, "binary.png"))).toEqual(Buffer.from([0, 255, 17, 0]));
  expect(await readFile(path.join(destination, "scheduled/ledger.jsonl"), "utf8")).toBe('{"cost":"unknown"}\n');
  expect((await lstat(path.join(destination, "binary.png"))).mode & 0o777).toBe(0o600);
  await expect(lstat(path.join(destination, "outside"))).rejects.toThrow();
  await expect(archivePrivateEvidence("unpack", archive, destination)).rejects.toThrow("already exists");
});

it("rejects symlink sources and oversized source files before producing an archive", async () => {
  const root = await temporary(), source = path.join(root, "source"), archive = path.join(root, "evidence.zip");
  await mkdir(source); await writeFile(path.join(root, "outside"), "outside");
  await symlink(path.join(root, "outside"), path.join(source, "link"));
  await expect(archivePrivateEvidence("pack", source, archive)).rejects.toThrow("regular files");
  await rm(path.join(source, "link")); await writeFile(path.join(source, "huge"), "");
  await truncate(path.join(source, "huge"), 256 * 1024 * 1024 + 1);
  await expect(archivePrivateEvidence("pack", source, archive)).rejects.toThrow("byte allowance");
  await expect(lstat(archive)).rejects.toThrow();
});

it.each(["traversal", "absolute", "symlink", "compressed", "duplicate", "case_collision", "comment", "many_entries", "truncated"])("rejects %s archives without retaining a partial extraction", async kind => {
  const root = await temporary(), archive = path.join(root, "bad.zip"), destination = path.join(root, "restored");
  await execute("python3", ["-c", `
import sys,zipfile,stat
p,kind=sys.argv[1:]
with zipfile.ZipFile(p,'w') as z:
 name={'traversal':'../outside','absolute':'/tmp/outside'}.get(kind,'safe.txt')
 info=zipfile.ZipInfo(name)
 if kind=='symlink': info.external_attr=(stat.S_IFLNK|0o777)<<16
 if kind=='compressed': info.compress_type=zipfile.ZIP_DEFLATED
 z.writestr(info,'data')
 if kind=='duplicate': z.writestr(name,'other')
 if kind=='case_collision': z.writestr('SAFE.txt','other')
 if kind=='comment': z.comment=b'extra'
 if kind=='many_entries':
  for n in range(4097): z.writestr(str(n),'')
if kind=='truncated':
 with open(p,'r+b') as f: f.truncate(12)
`, archive, kind]);
  await expect(archivePrivateEvidence("unpack", archive, destination)).rejects.toThrow();
  await expect(lstat(destination)).rejects.toThrow();
  await expect(lstat(path.join(root, "outside"))).rejects.toThrow();
});

it("fails closed on public access, ACLs, a reader grant, or unavailable inspection", async () => {
  const root = await temporary();
  await verifyPrivateHistory(new BoundedHistoryPublisher(path.join(root, "allowed.json"), configurationRunner(configurations())), "private-bucket");
  for (const operation of ["get-public-access-block", "get-bucket-ownership-controls", "get-bucket-policy"]) {
    const config: Record<string, unknown> = configurations();
    config[operation] = operation === "get-bucket-policy" ? { Policy: '{"Statement":[{"Effect":"Allow"}]}' } : {};
    const runner = vi.fn(configurationRunner(config));
    await expect(verifyPrivateHistory(new BoundedHistoryPublisher(path.join(root, `${operation}.json`), runner), "private-bucket")).rejects.toThrow();
    expect(runner.mock.calls.some(([args]) => args[1] === "put-object")).toBe(false);
  }
  await expect(verifyPrivateHistory(new BoundedHistoryPublisher(path.join(root, "denied.json"), async () => { throw new Error("AccessDenied"); }), "private-bucket")).rejects.toThrow("AccessDenied");
});

it("uses immutable private keys and restores the uploaded archive through the actual transfer path", async () => {
  const root = await temporary(), source = path.join(root, "source"), stored = path.join(root, "stored.zip"), destination = path.join(root, "restored");
  await mkdir(source); await writeFile(path.join(source, "ledger.jsonl"), "retained attempt\n");
  const config = configurationRunner(configurations());
  const runner = vi.fn(async (args: string[]) => {
    if (args[1] === "put-object") {
      expect(args).toEqual(expect.arrayContaining(["--if-none-match", "*", "--cache-control", "private, no-store"]));
      expect(args[args.indexOf("--key") + 1]).toBe(privateArtifactKey("evidence", "12345"));
      await copyFile(args[args.indexOf("--body") + 1]!, stored);
      return { stdout: '{"VersionId":"retained-version","ETag":"tag"}' };
    }
    if (args[1] === "get-object") {
      expect(args).toContain(`bytes=0-${264 * 1024 * 1024}`);
      await copyFile(stored, args[args.indexOf("--cli-connect-timeout") - 1]!);
      return { stdout: '{"VersionId":"retained-version"}' };
    }
    return config(args);
  });
  const upload = new BoundedHistoryPublisher(path.join(root, "upload.json"), runner);
  expect(await transferPrivateArtifact({ operation: "upload", kind: "evidence", runId: "12345", directory: source, bucket: "private-bucket", publisher: upload }))
    .toMatchObject({ private: true, versionId: "retained-version", files: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  await transferPrivateArtifact({ operation: "download", kind: "evidence", runId: "12345", directory: destination, bucket: "private-bucket", publisher: new BoundedHistoryPublisher(path.join(root, "download.json"), runner) });
  expect(await readFile(path.join(destination, "ledger.jsonl"), "utf8")).toBe("retained attempt\n");
  expect(runner).toHaveBeenCalledTimes(16);
});

it("rejects unsafe run identities and other artifact kinds", () => {
  for (const id of ["../123", "0", "1/2", "123-2"]) expect(() => privateArtifactKey("report", id)).toThrow();
  expect(() => privateArtifactKey("public", "123")).toThrow();
});

it.each([false, true])("retains an unknown transfer without retrying it when receipt upload fails=%s", async receiptFails => {
  const root = await temporary(), source = path.join(root, "source"), receipt = path.join(root, "transfer.json");
  await mkdir(source); await writeFile(path.join(source, "ledger.jsonl"), "original evidence\n");
  const config = configurationRunner(configurations());
  const runner = vi.fn(async (args: string[]) => {
    if (args[1] !== "put-object") return config(args);
    await copyFile(args[args.indexOf("--body") + 1]!, path.join(root, "accepted.zip"));
    throw new Error("Response lost after server accepted archive");
  });
  const retain = vi.fn(async (args: string[]) => {
    expect(args[args.indexOf("--key") + 1]).toBe(`${privateArtifactKey("evidence", "12345")}.upload-receipt.json`);
    const snapshot = JSON.parse(await readFile(args[args.indexOf("--body") + 1]!, "utf8"));
    expect(snapshot.transfer.status).toBe("failed_or_unknown");
    expect(snapshot.requests.at(-1)).toMatchObject({ operation: "put-object", status: "failed_or_unknown" });
    expect(snapshot.billedUsd).toBeNull();
    expect(snapshot.receiptUpload.status).toBe("pending_at_snapshot");
    if (receiptFails) throw new Error("Receipt response also lost");
    return { stdout: '{"VersionId":"receipt-version"}' };
  });
  await expect(retainPrivateTransfer({ operation: "upload", kind: "evidence", runId: "12345", directory: source,
    bucket: "private-bucket", publisher: new BoundedHistoryPublisher(receipt, runner) }, receipt,
    () => new BoundedHistoryPublisher(`${receipt}.retention.json`, retain)))
    .rejects.toThrow(receiptFails ? "receipt retention failed" : "Response lost");
  expect(runner.mock.calls.filter(([args]) => args[1] === "put-object")).toHaveLength(1);
  expect(retain).toHaveBeenCalledTimes(1);
  expect((await lstat(`${receipt}.transfer.json`)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(`${receipt}.retention.json`, "utf8")).requests[0].status)
    .toBe(receiptFails ? "failed_or_unknown" : "accepted");
});

it("keeps protocol controller, report and cell archives disjoint inside the existing private prefix", () => {
  const kinds = ["evidence", "report", "protocol-control", "protocol-report", "protocol-cell-native-codex--get-task-context"];
  const keys = kinds.map(kind => privateArtifactKey(kind, "12345"));
  expect(new Set(keys).size).toBe(kinds.length);
  expect(keys.every(key => key.startsWith(`${PRIVATE_HISTORY_PREFIX}/campaigns/gha-12345-1/`))).toBe(true);
  for (const kind of ["protocol-cell-", "protocol-cell-../report", "protocol-cell-a/b", `protocol-cell-${"a".repeat(201)}`]) {
    expect(() => privateArtifactKey(kind, "12345")).toThrow();
  }
});

it("gives independent shared-manifest downloaders separate immutable receipts", async () => {
  const root = await temporary(), source = path.join(root, "source"), archive = path.join(root, "control.zip");
  await mkdir(source); await writeFile(path.join(source, "controller-manifest.json"), '{"campaign":"synthetic"}');
  await archivePrivateEvidence("pack", source, archive);
  const config = configurationRunner(configurations()), receipts = new Map<string, unknown>(), downloads: string[] = [];
  const runner = async (args: string[]) => {
    if (args[1] === "get-object") {
      downloads.push(args[args.indexOf("--key") + 1]!);
      await copyFile(archive, args[args.indexOf("--cli-connect-timeout") - 1]!);
      return { stdout: '{"VersionId":"manifest-version"}' };
    }
    if (args[1] === "put-object") {
      expect(args).toEqual(expect.arrayContaining(["--if-none-match", "*", "--cache-control", "private, no-store"]));
      const key = args[args.indexOf("--key") + 1]!;
      if (receipts.has(key)) throw new Error("Immutable receipt already exists");
      receipts.set(key, JSON.parse(await readFile(args[args.indexOf("--body") + 1]!, "utf8")));
      return { stdout: '{"VersionId":"receipt-version"}' };
    }
    return config(args);
  };
  for (const receiptIdentity of ["protocol-live-mini--get-task-context", "protocol-live-acpx-claude--get-task-context", "report"]) {
    const receipt = path.join(root, `${receiptIdentity}.json`);
    await retainPrivateTransfer({ operation: "download", kind: "protocol-control", runId: "12345", receiptIdentity,
      directory: path.join(root, receiptIdentity), bucket: "private-bucket", publisher: new BoundedHistoryPublisher(receipt, runner) },
      receipt, () => new BoundedHistoryPublisher(`${receipt}.retention.json`, runner));
    expect(await readFile(path.join(root, receiptIdentity, "controller-manifest.json"), "utf8")).toBe('{"campaign":"synthetic"}');
  }
  expect(new Set(downloads)).toEqual(new Set([privateArtifactKey("protocol-control", "12345")]));
  expect(receipts.size).toBe(3);
  expect([...receipts.values()]).toEqual(expect.arrayContaining([
    expect.objectContaining({ receiptIdentity: "report", transfer: expect.objectContaining({ uri: expect.stringContaining("protocol-control.zip") }) }),
  ]));
  const receipt = path.join(root, "duplicate.json");
  await expect(retainPrivateTransfer({ operation: "download", kind: "protocol-control", runId: "12345", receiptIdentity: "report",
    directory: path.join(root, "duplicate"), bucket: "private-bucket", publisher: new BoundedHistoryPublisher(receipt, runner) },
    receipt, () => new BoundedHistoryPublisher(`${receipt}.retention.json`, runner))).rejects.toThrow("receipt retention failed");
  expect(receipts.size).toBe(3);
});
