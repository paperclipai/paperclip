/**
 * Consistency checks across wrangler.jsonc, the container Dockerfile and
 * package.json. These encode the deployment's cross-file invariants — most
 * importantly the Sandbox SDK requirement that the base image tag match the
 * @cloudflare/sandbox package version exactly.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAPERCLIP_PORT, PAPERCLIP_UID, STORAGE_MOUNT_PATH } from "../src/lib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/** Minimal JSONC parser: strips // and /* *\/ comments outside strings. */
function parseJsonc(text: string): any {
  const stripped = text.replace(
    /"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match) => (match.startsWith('"') ? match : "")
  );
  return JSON.parse(stripped);
}

const wrangler = parseJsonc(read("wrangler.jsonc"));
const pkg = JSON.parse(read("package.json"));
const dockerfile = read("container/Dockerfile");

describe("wrangler.jsonc", () => {
  it("wires the Sandbox container, DO binding and migration to one class", () => {
    const containerClass = wrangler.containers[0].class_name;
    expect(containerClass).toBe("Sandbox");
    expect(wrangler.durable_objects.bindings[0].class_name).toBe(containerClass);
    expect(wrangler.migrations[0].new_sqlite_classes).toContain(containerClass);
  });

  it("uses the container Dockerfile as the image", () => {
    expect(wrangler.containers[0].image).toBe("./container/Dockerfile");
  });

  it("enables nodejs_compat (required by the Sandbox SDK)", () => {
    expect(wrangler.compatibility_flags).toContain("nodejs_compat");
  });

  it("carries no account- or zone-specific configuration", () => {
    const raw = read("wrangler.jsonc");
    expect(wrangler.account_id).toBeUndefined();
    expect(wrangler.routes).toBeUndefined();
    expect(raw).not.toMatch(/account_id/);
  });

  it("defaults to private exposure (embedded Postgres requirement)", () => {
    expect(wrangler.vars.PAPERCLIP_DEPLOYMENT_EXPOSURE).toBe("private");
  });
});

describe("container image", () => {
  it("pins the base image to the exact @cloudflare/sandbox version", () => {
    const sdkVersion = pkg.dependencies["@cloudflare/sandbox"];
    // Must be an exact pin — the SDK and in-container runtime version together.
    expect(sdkVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerfile).toContain(`FROM docker.io/cloudflare/sandbox:${sdkVersion}`);
  });

  it("exposes the Paperclip port for local dev", () => {
    expect(dockerfile).toContain(`EXPOSE ${PAPERCLIP_PORT}`);
  });

  it("installs Paperclip and the agent CLIs with exact version pins", () => {
    expect(dockerfile).toMatch(/paperclipai@\d+\.\d+\.\d+/);
    expect(dockerfile).toMatch(/@anthropic-ai\/claude-code@\d+\.\d+\.\d+/);
    // Mutable tags make image rebuilds non-reproducible and un-reviewable.
    expect(dockerfile).not.toContain("@latest");
  });

  it("pins the paperclip uid the R2 mount options rely on", () => {
    expect(dockerfile).toContain(`useradd -m -u ${PAPERCLIP_UID} `);
  });
});

describe("boot script", () => {
  const script = read("container/start-paperclip.sh");

  it("excludes the R2 storage mount from the ownership pass", () => {
    // s3fs rejects chown; a bare `chown -R /paperclip` would abort the boot.
    expect(script).toContain(`-path ${STORAGE_MOUNT_PATH} -prune`);
    expect(script).not.toMatch(/chown -R paperclip:paperclip \/paperclip\s*$/m);
  });

  it("serializes duplicate boots with a non-blocking lock", () => {
    expect(script).toContain("flock --nonblock");
  });
});
