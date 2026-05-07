import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export type EmbeddedPostgresDirPreparation = {
  clusterVersionFile: string;
  postmasterPidFile: string;
  clusterAlreadyInitialized: boolean;
  removedEmptyDataDir: boolean;
};

export function prepareEmbeddedPostgresDataDir(dataDir: string): EmbeddedPostgresDirPreparation {
  const clusterVersionFile = resolve(dataDir, "PG_VERSION");
  const postmasterPidFile = resolve(dataDir, "postmaster.pid");
  const clusterAlreadyInitialized = existsSync(clusterVersionFile);

  if (!clusterAlreadyInitialized && existsSync(dataDir)) {
    const entries = readdirSync(dataDir);
    if (entries.length === 0) {
      rmSync(dataDir, { recursive: true, force: true });
      return {
        clusterVersionFile,
        postmasterPidFile,
        clusterAlreadyInitialized,
        removedEmptyDataDir: true,
      };
    }

    throw new Error(
      `Embedded PostgreSQL data directory exists but is not an initialized cluster: ${dataDir}. ` +
        `Remove this directory and restart Paperclip. Found entries: ${entries.slice(0, 5).join(", ")}`,
    );
  }

  return {
    clusterVersionFile,
    postmasterPidFile,
    clusterAlreadyInitialized,
    removedEmptyDataDir: false,
  };
}
