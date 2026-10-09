import { beforeEach, describe, expect, it, vi } from "vitest";
import * as p from "@clack/prompts";
import { promptDatabase } from "../prompts/database.js";
import { promptSecrets } from "../prompts/secrets.js";
import { promptServer } from "../prompts/server.js";
import { promptStorage } from "../prompts/storage.js";
import type { DatabaseConfig } from "../config/schema.js";

vi.mock("@clack/prompts", () => ({
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  password: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  note: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

type CapturedTextOptions = {
  message: string;
  defaultValue?: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

const capturedText: CapturedTextOptions[] = [];

/**
 * Emulates @clack/core submit semantics for pressing Enter without typing:
 * the validator runs on the RAW input (the empty string) and defaultValue is
 * substituted only after validation passes. A validator that rejects "" makes
 * the shown default unacceptable.
 */
function pressEnterOnEveryTextPrompt() {
  vi.mocked(p.text).mockImplementation(async (opts) => {
    const options = opts as unknown as CapturedTextOptions;
    capturedText.push(options);
    const error = options.validate?.("");
    if (error) {
      throw new Error(`"${options.message}" rejected pressing Enter on its default: ${String(error)}`);
    }
    return options.defaultValue ?? "";
  });
}

function queueSelects(values: unknown[]) {
  const remaining = [...values];
  vi.mocked(p.select).mockImplementation(async () => {
    if (remaining.length === 0) throw new Error("unexpected select prompt");
    return remaining.shift() as never;
  });
}

function validatorFor(message: string): NonNullable<CapturedTextOptions["validate"]> {
  const call = capturedText.find((options) => options.message === message);
  if (!call?.validate) throw new Error(`no validator captured for "${message}"`);
  return call.validate;
}

const dbFixture: DatabaseConfig = {
  mode: "postgres",
  connectionString: "postgres://user:pass@localhost:5432/paperclip",
  embeddedPostgresDataDir: "/var/lib/paperclip/db",
  embeddedPostgresPort: 54329,
  backup: {
    enabled: false,
    intervalMinutes: 30,
    retentionDays: 7,
    dir: "/var/lib/paperclip/backups",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  capturedText.length = 0;
  vi.mocked(p.isCancel).mockReturnValue(false);
  vi.mocked(p.confirm).mockImplementation(async (opts) => (opts.initialValue ?? false) as never);
  pressEnterOnEveryTextPrompt();
});

describe("promptDatabase accepts defaults", () => {
  it("accepts every shown default in the embedded-postgres flow", async () => {
    queueSelects(["embedded-postgres"]);

    const db = await promptDatabase();

    expect(db.mode).toBe("embedded-postgres");
    expect(db.embeddedPostgresPort).toBe(54329);
    expect(db.embeddedPostgresDataDir).toBeTruthy();
    expect(db.backup.intervalMinutes).toBe(60);
    expect(db.backup.retentionDays).toBe(30);
    expect(db.backup.dir).toBeTruthy();
  });

  it("keeps real validation for typed port, interval, and retention input", async () => {
    queueSelects(["embedded-postgres"]);
    await promptDatabase();

    const port = validatorFor("Embedded PostgreSQL port");
    expect(port("")).toBeUndefined();
    expect(port(undefined)).toBeUndefined();
    expect(port("54329")).toBeUndefined();
    expect(port("0")).toBeTruthy();
    expect(port("70000")).toBeTruthy();
    expect(port("abc")).toBeTruthy();

    const interval = validatorFor("Backup interval (minutes)");
    expect(interval("")).toBeUndefined();
    expect(interval("60")).toBeUndefined();
    expect(interval("0")).toBeTruthy();
    expect(interval("999999")).toBeTruthy();

    const retention = validatorFor("Backup retention (days)");
    expect(retention("")).toBeUndefined();
    expect(retention("30")).toBeUndefined();
    expect(retention("0")).toBeTruthy();
    expect(retention("99999")).toBeTruthy();

    const backupDir = validatorFor("Backup directory");
    expect(backupDir("")).toBeUndefined();
    expect(backupDir("   ")).toBeTruthy();
  });

  it("accepts the saved connection string default when reconfiguring postgres mode", async () => {
    queueSelects(["postgres"]);

    const db = await promptDatabase(dbFixture);

    expect(db.connectionString).toBe(dbFixture.connectionString);
  });

  it("still requires a connection string when no saved default exists", async () => {
    queueSelects(["postgres"]);

    await expect(promptDatabase()).rejects.toThrow(/Connection string is required/);

    const connection = validatorFor("PostgreSQL connection string");
    expect(connection("postgres://user:pass@localhost:5432/paperclip")).toBeUndefined();
    expect(connection("mysql://nope")).toBeTruthy();
  });
});

describe("promptServer accepts defaults", () => {
  it("accepts the default port in the loopback flow", async () => {
    queueSelects(["loopback"]);

    const { server } = await promptServer();

    expect(server.port).toBe(3100);

    const port = validatorFor("Server port");
    expect(port("")).toBeUndefined();
    expect(port("8443")).toBeUndefined();
    expect(port("0")).toBeTruthy();
    expect(port("abc")).toBeTruthy();
  });

  it("accepts empty optional hostnames in the lan flow", async () => {
    queueSelects(["lan"]);

    const { server } = await promptServer();

    expect(server.allowedHostnames).toEqual([]);
  });

  it("accepts the loopback default host in the custom local_trusted flow", async () => {
    queueSelects(["custom", "local_trusted"]);

    const { server } = await promptServer();

    expect(server.host).toBe("127.0.0.1");
  });

  it("still rejects accepting a non-loopback saved host in local_trusted mode", async () => {
    queueSelects(["custom", "local_trusted"]);

    await expect(promptServer({ currentServer: { host: "0.0.0.0" } })).rejects.toThrow(/loopback/);
  });

  it("accepts the saved public base URL default when reconfiguring a public deployment", async () => {
    queueSelects(["custom", "authenticated", "public"]);

    const { auth } = await promptServer({
      currentServer: { host: "0.0.0.0", port: 8443 },
      currentAuth: { publicBaseUrl: "https://paperclip.example.com" },
    });

    expect(auth.publicBaseUrl).toBe("https://paperclip.example.com");
  });

  it("still requires a public base URL when no saved default exists", async () => {
    queueSelects(["custom", "authenticated", "public"]);

    await expect(promptServer()).rejects.toThrow(/Public base URL is required/);

    const url = validatorFor("Public base URL");
    expect(url("https://paperclip.example.com")).toBeUndefined();
    expect(url("ftp://paperclip.example.com")).toBeTruthy();
    expect(url("not a url")).toBeTruthy();
  });
});

describe("promptStorage accepts defaults", () => {
  it("accepts the default base directory in the local_disk flow", async () => {
    queueSelects(["local_disk"]);

    const storage = await promptStorage();

    expect(storage.provider).toBe("local_disk");
    expect(storage.localDisk.baseDir).toBeTruthy();

    const baseDir = validatorFor("Local storage base directory");
    expect(baseDir("")).toBeUndefined();
    expect(baseDir("   ")).toBeTruthy();
  });

  it("accepts the default bucket and region in the s3 flow", async () => {
    queueSelects(["s3"]);

    const storage = await promptStorage();

    expect(storage.s3.bucket).toBe("paperclip");
    expect(storage.s3.region).toBe("us-east-1");

    expect(validatorFor("S3 bucket")("   ")).toBeTruthy();
    expect(validatorFor("S3 region")("   ")).toBeTruthy();
  });
});

describe("promptSecrets accepts defaults", () => {
  it("accepts the default key file path in the local_encrypted flow", async () => {
    queueSelects(["local_encrypted"]);

    const secrets = await promptSecrets();

    expect(secrets.provider).toBe("local_encrypted");
    expect(secrets.localEncrypted.keyFilePath).toBeTruthy();

    const keyPath = validatorFor("Local encrypted key file path");
    expect(keyPath("")).toBeUndefined();
    expect(keyPath("   ")).toBeTruthy();
  });
});

describe("invalid saved or derived defaults are still validated", () => {
  // Accepting a default must not bypass validation: the validators check the
  // effective value (typed input, or the default), so a bad value from the
  // environment or a hand-edited config errors at the prompt instead of
  // blowing up later at config-schema parsing.
  it("rejects accepting an out-of-range saved server port", async () => {
    queueSelects(["loopback"]);

    await expect(
      promptServer({ currentServer: { port: 70000 as never } }),
    ).rejects.toThrow(/integer between 1 and 65535/);
  });

  it("rejects accepting a non-integer saved embedded PostgreSQL port", async () => {
    queueSelects(["embedded-postgres"]);

    await expect(
      promptDatabase({ ...dbFixture, mode: "embedded-postgres", embeddedPostgresPort: 12.5 as never }),
    ).rejects.toThrow(/Port must be an integer/);
  });

  it("rejects accepting an invalid saved public base URL", async () => {
    queueSelects(["custom", "authenticated", "public"]);

    await expect(
      promptServer({
        currentServer: { host: "0.0.0.0", port: 8443 },
        currentAuth: { publicBaseUrl: "not a url" },
      }),
    ).rejects.toThrow(/valid URL/);
  });

  it("rejects accepting a whitespace-only saved S3 bucket", async () => {
    queueSelects(["s3"]);

    await expect(
      promptStorage({
        provider: "s3",
        localDisk: { baseDir: "" },
        s3: { bucket: "   ", region: "us-east-1", endpoint: "", forcePathStyle: false },
      } as never),
    ).rejects.toThrow(/Bucket is required/);
  });
});
