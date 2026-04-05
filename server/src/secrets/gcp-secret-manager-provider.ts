import { createHash } from "node:crypto";
import type { SecretProviderModule, StoredSecretVersionMaterial } from "./types.js";
import { badRequest, unprocessable } from "../errors.js";

/**
 * GCP Secret Manager provider for the company secrets system.
 *
 * Uses the @google-cloud/secret-manager SDK with Application Default
 * Credentials (ADC). On Cloud Run the service-account identity is automatic;
 * locally, set GOOGLE_APPLICATION_CREDENTIALS or use `gcloud auth
 * application-default login`.
 *
 * Config env vars:
 *   PAPERCLIP_GCP_PROJECT_ID  — required when provider is active
 */

interface GcpSecretMaterial extends StoredSecretVersionMaterial {
  scheme: "gcp_secret_manager_v1";
  /** Full resource name: projects/X/secrets/Y/versions/Z */
  versionResourceName: string;
}

function getProjectId(): string {
  const projectId = process.env.PAPERCLIP_GCP_PROJECT_ID;
  if (!projectId) {
    throw unprocessable(
      "gcp_secret_manager provider requires PAPERCLIP_GCP_PROJECT_ID to be set",
    );
  }
  return projectId;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asGcpMaterial(value: StoredSecretVersionMaterial): GcpSecretMaterial {
  if (
    value &&
    typeof value === "object" &&
    value.scheme === "gcp_secret_manager_v1" &&
    typeof value.versionResourceName === "string"
  ) {
    return value as GcpSecretMaterial;
  }
  throw badRequest("Invalid gcp_secret_manager secret material");
}

/**
 * Lazy-load the SDK so the import only happens when the provider is actually
 * used. This avoids hard failures when the package is not installed (e.g.
 * local dev with local_encrypted provider).
 */
async function getClient() {
  try {
    const mod = await import("@google-cloud/secret-manager");
    return new mod.SecretManagerServiceClient();
  } catch (err) {
    throw unprocessable(
      "gcp_secret_manager provider requires @google-cloud/secret-manager to be installed. " +
        "Run: pnpm add @google-cloud/secret-manager",
    );
  }
}

export const gcpSecretManagerProvider: SecretProviderModule = {
  id: "gcp_secret_manager",
  descriptor: {
    id: "gcp_secret_manager",
    label: "GCP Secret Manager",
    requiresExternalRef: true,
  },

  async createVersion(input) {
    const projectId = getProjectId();
    const client = await getClient();
    const externalRef = input.externalRef;
    if (!externalRef) {
      throw badRequest(
        "gcp_secret_manager requires an externalRef (the secret name in GCP)",
      );
    }

    const secretParent = `projects/${projectId}/secrets/${externalRef}`;

    // Ensure the secret resource exists; create if missing.
    try {
      await client.getSecret({ name: secretParent });
    } catch (err: unknown) {
      const code = (err as { code?: number }).code;
      if (code === 5 /* NOT_FOUND */) {
        await client.createSecret({
          parent: `projects/${projectId}`,
          secretId: externalRef,
          secret: {
            replication: { automatic: {} },
          },
        });
      } else {
        throw err;
      }
    }

    // Add a new version with the secret value.
    const [version] = await client.addSecretVersion({
      parent: secretParent,
      payload: { data: Buffer.from(input.value, "utf8") },
    });

    const versionResourceName = version.name!;

    return {
      material: {
        scheme: "gcp_secret_manager_v1" as const,
        versionResourceName,
      },
      valueSha256: sha256Hex(input.value),
      externalRef,
    };
  },

  async resolveVersion(input) {
    const material = asGcpMaterial(input.material);
    const client = await getClient();

    const [accessResponse] = await client.accessSecretVersion({
      name: material.versionResourceName,
    });

    const payload = accessResponse.payload?.data;
    if (!payload) {
      throw unprocessable(
        `GCP Secret Manager returned empty payload for ${material.versionResourceName}`,
      );
    }

    return typeof payload === "string"
      ? payload
      : Buffer.from(payload).toString("utf8");
  },
};
