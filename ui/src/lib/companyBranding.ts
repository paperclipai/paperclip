export function getCompanyLogoPath(logoAssetId: string | null | undefined): string | null {
  if (!logoAssetId) return null;
  return `/api/assets/${logoAssetId}/content`;
}
