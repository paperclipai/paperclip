import { appendFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export function imageMetadata({ repository, sha, ref, event, lastMigration, migrationCount, created = new Date().toISOString(), license = "" }) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository ?? "") || !/^[a-f0-9]{40}$/.test(sha ?? "") ||
      !/^[\w.-]+\.sql$/.test(lastMigration ?? "") || !/^\d+$/.test(migrationCount ?? "") || !Number.isFinite(Date.parse(created))) {
    throw new Error("Invalid image metadata inputs.");
  }
  const image = `ghcr.io/${repository.toLowerCase()}`;
  const versions = [];
  if (ref?.startsWith("refs/tags/v")) {
    const version = ref.slice("refs/tags/v".length);
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
    if (match && match.slice(1, 4).every(value => Number.isSafeInteger(Number(value))) &&
        (!match[4] || match[4].slice(1).split(".").every(part => !/^0\d+$/.test(part)))) {
      const normalized = `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ""}`;
      versions.push(normalized, match[4] ? normalized : `${match[1]}.${match[2]}`);
    }
    versions.push("latest");
  }
  if (ref?.startsWith("refs/tags/nightly/v")) versions.push("nightly");
  if (ref?.startsWith("refs/tags/beta/v")) versions.push("beta");
  if (repository === "paperclipai/paperclip" && event === "push" && ref === "refs/heads/master") versions.push(`sha-${sha}`);
  versions.push(`sha-${sha.slice(0, 7)}`);
  const unique = [...new Set(versions)];
  const source = `https://github.com/${repository}`;
  const labels = {
    "org.opencontainers.image.created": created,
    "org.opencontainers.image.source": source,
    "org.opencontainers.image.url": source,
    "org.opencontainers.image.revision": sha,
    "org.opencontainers.image.title": repository.split("/")[1],
    "org.opencontainers.image.version": unique[0],
    "org.opencontainers.image.licenses": license,
    "io.github.paperclipai.schema.last-migration": lastMigration,
    "io.github.paperclipai.schema.migration-count": migrationCount,
  };
  return { tags: unique.map(tag => `${image}:${tag}`), labels };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const metadata = imageMetadata({ repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA, ref: process.env.GITHUB_REF,
    event: process.env.GITHUB_EVENT_NAME, lastMigration: process.env.LAST_MIGRATION, migrationCount: process.env.MIGRATION_COUNT,
    license: (await readFile(new URL("../LICENSE", import.meta.url), "utf8")).startsWith("MIT License") ? "MIT" : "" });
  const delimiter = randomUUID();
  await appendFile(process.env.GITHUB_OUTPUT, `json=${JSON.stringify(metadata)}\nlabels<<${delimiter}\n${Object.entries(metadata.labels).map(([key, value]) => `${key}=${value}`).join("\n")}\n${delimiter}\n`);
}
