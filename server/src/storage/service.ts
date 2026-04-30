import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { StorageProvider as StorageProviderId } from "@paperclipai/shared";
import type { StorageService, StorageProvider, PutFileInput, PutFileResult } from "./types.js";
import { badRequest, forbidden, unprocessable } from "../errors.js";

const MAX_SEGMENT_LENGTH = 120;

function sanitizeSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "file";
  return cleaned.slice(0, MAX_SEGMENT_LENGTH);
}

function normalizeNamespace(namespace: string): string {
  const normalized = namespace
    .split("/")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => sanitizeSegment(entry));
  if (normalized.length === 0) return "misc";
  return normalized.join("/");
}

function splitFilename(filename: string | null): { stem: string; ext: string } {
  if (!filename) return { stem: "file", ext: "" };
  const base = path.basename(filename).trim();
  if (!base) return { stem: "file", ext: "" };

  const extRaw = path.extname(base);
  const stemRaw = extRaw ? base.slice(0, base.length - extRaw.length) : base;
  const stem = sanitizeSegment(stemRaw);
  const ext = extRaw
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "")
    .slice(0, 16);
  return {
    stem,
    ext,
  };
}

function ensureCompanyPrefix(companyId: string, objectKey: string): void {
  const expectedPrefix = `${companyId}/`;
  if (!objectKey.startsWith(expectedPrefix)) {
    throw forbidden("Object does not belong to company");
  }
  if (objectKey.includes("..")) {
    throw badRequest("Invalid object key");
  }
}

function hashBuffer(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function buildObjectKey(companyId: string, namespace: string, originalFilename: string | null): string {
  const ns = normalizeNamespace(namespace);
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const { stem, ext } = splitFilename(originalFilename);
  const suffix = randomUUID();
  const filename = `${suffix}-${stem}${ext}`;
  return `${companyId}/${ns}/${year}/${month}/${day}/${filename}`;
}

function assertPutFileInput(input: PutFileInput): void {
  if (!input.companyId || input.companyId.trim().length === 0) {
    throw unprocessable("companyId is required");
  }
  if (!input.namespace || input.namespace.trim().length === 0) {
    throw unprocessable("namespace is required");
  }
  if (!input.contentType || input.contentType.trim().length === 0) {
    throw unprocessable("contentType is required");
  }
  if (!(input.body instanceof Buffer)) {
    throw unprocessable("body must be a Buffer");
  }
  if (input.body.length <= 0) {
    throw unprocessable("File is empty");
  }
}

type StorageServiceFactoryInput =
  | StorageProvider
  | {
      activeProvider: StorageProvider;
      providers: Partial<Record<StorageProviderId, StorageProvider>>;
    };

function isStorageProvider(input: StorageServiceFactoryInput): input is StorageProvider {
  return typeof (input as StorageProvider).putObject === "function";
}

function resolveProvider(
  providers: Partial<Record<StorageProviderId, StorageProvider>>,
  providerId: StorageProviderId,
): StorageProvider {
  const provider = providers[providerId];
  if (!provider) {
    throw unprocessable(`Storage provider '${providerId}' is not configured.`);
  }
  return provider;
}

export function createStorageService(input: StorageServiceFactoryInput): StorageService {
  const activeProvider = isStorageProvider(input) ? input : input.activeProvider;
  const providers = isStorageProvider(input)
    ? { [input.id]: input }
    : input.providers;

  return {
    provider: activeProvider.id,

    async putFile(input: PutFileInput): Promise<PutFileResult> {
      assertPutFileInput(input);
      const objectKey = buildObjectKey(input.companyId, input.namespace, input.originalFilename);
      const byteSize = input.body.length;
      const contentType = input.contentType.trim().toLowerCase();
      await activeProvider.putObject({
        objectKey,
        body: input.body,
        contentType,
        contentLength: byteSize,
      });

      return {
        provider: activeProvider.id,
        objectKey,
        contentType,
        byteSize,
        sha256: hashBuffer(input.body),
        originalFilename: input.originalFilename,
      };
    },

    async getObject(companyId: string, objectKey: string, providerOverride?: StorageProviderId) {
      ensureCompanyPrefix(companyId, objectKey);
      return resolveProvider(providers, providerOverride ?? activeProvider.id).getObject({ objectKey });
    },

    async headObject(companyId: string, objectKey: string, providerOverride?: StorageProviderId) {
      ensureCompanyPrefix(companyId, objectKey);
      return resolveProvider(providers, providerOverride ?? activeProvider.id).headObject({ objectKey });
    },

    async deleteObject(companyId: string, objectKey: string, providerOverride?: StorageProviderId) {
      ensureCompanyPrefix(companyId, objectKey);
      await resolveProvider(providers, providerOverride ?? activeProvider.id).deleteObject({ objectKey });
    },
  };
}
