const DEFAULT_SOURCE = "unknown";
const DEFAULT_DETAIL_TYPE = "unknown";

export async function handler(event) {
  const source = event?.source ?? DEFAULT_SOURCE;
  const detailType = event?.["detail-type"] ?? DEFAULT_DETAIL_TYPE;
  const detail = event?.detail ?? {};
  const entitlementsTableName = process.env.ENTITLEMENTS_TABLE_NAME ?? "kinetica-entitlements";

  const response = {
    ok: true,
    message: "Paperclip ingest middleware scaffold executed successfully.",
    received: {
      source,
      detailType,
      detail,
    },
    config: {
      entitlementsTableName,
      deploymentStage: process.env.DEPLOYMENT_STAGE ?? "dev",
    },
  };

  return {
    statusCode: 200,
    body: JSON.stringify(response),
  };
}
