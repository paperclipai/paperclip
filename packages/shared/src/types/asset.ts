export interface AssetImage {
  assetId: string;
  companyId: string;
  provider: string;
  objectKey: string;
  contentType: string;
  /** Safe integer byte count; persisted as bigint to support files above 2 GiB. */
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  contentPath: string;
}

