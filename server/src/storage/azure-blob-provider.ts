import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  type BlockBlobClient,
} from "@azure/storage-blob";
import { Readable } from "node:stream";
import type { StorageProvider, GetObjectResult, HeadObjectResult } from "./types.js";
import { notFound, unprocessable } from "../errors.js";

interface AzureBlobProviderConfig {
  connectionString?: string;
  accountName?: string;
  accountKey?: string;
  containerName: string;
  prefix?: string;
}

function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function buildKey(prefix: string, objectKey: string): string {
  if (!prefix) return objectKey;
  return `${prefix}/${objectKey}`;
}

function createBlobServiceClient(config: AzureBlobProviderConfig): BlobServiceClient {
  if (config.connectionString) {
    return BlobServiceClient.fromConnectionString(config.connectionString);
  }
  if (config.accountName && config.accountKey) {
    const credential = new StorageSharedKeyCredential(config.accountName, config.accountKey);
    return new BlobServiceClient(`https://${config.accountName}.blob.core.windows.net`, credential);
  }
  throw unprocessable(
    "Azure Blob Storage requires either a connectionString or both accountName and accountKey",
  );
}

export function createAzureBlobStorageProvider(config: AzureBlobProviderConfig): StorageProvider {
  const containerName = config.containerName.trim();
  if (!containerName) throw unprocessable("Azure Blob container name is required");

  const prefix = normalizePrefix(config.prefix);
  const serviceClient = createBlobServiceClient(config);
  const containerClient = serviceClient.getContainerClient(containerName);

  function getBlockBlobClient(objectKey: string): BlockBlobClient {
    return containerClient.getBlockBlobClient(buildKey(prefix, objectKey));
  }

  return {
    id: "azure_blob",

    async putObject(input) {
      const blobClient = getBlockBlobClient(input.objectKey);
      await blobClient.upload(input.body, input.contentLength, {
        blobHTTPHeaders: { blobContentType: input.contentType },
      });
    },

    async getObject(input): Promise<GetObjectResult> {
      const blobClient = getBlockBlobClient(input.objectKey);
      let response;
      try {
        response = await blobClient.download();
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404) throw notFound("Object not found");
        throw err;
      }
      if (!response.readableStreamBody) throw notFound("Object not found");

      return {
        stream: response.readableStreamBody as Readable,
        contentType: response.contentType,
        contentLength: response.contentLength,
        etag: response.etag,
        lastModified: response.lastModified,
      };
    },

    async headObject(input): Promise<HeadObjectResult> {
      const blobClient = getBlockBlobClient(input.objectKey);
      try {
        const props = await blobClient.getProperties();
        return {
          exists: true,
          contentType: props.contentType,
          contentLength: props.contentLength,
          etag: props.etag,
          lastModified: props.lastModified,
        };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404) return { exists: false };
        throw err;
      }
    },

    async deleteObject(input): Promise<void> {
      const blobClient = getBlockBlobClient(input.objectKey);
      await blobClient.deleteIfExists();
    },
  };
}
