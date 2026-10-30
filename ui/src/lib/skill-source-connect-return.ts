const key = (companyId: string) => `paperclip.skill-source-connect-return:${companyId}`;
const lifetime = 30 * 60 * 1000;

/** Tab-local intent survives the full-page OAuth round trip without a redirect URL. */
export function rememberSkillSourceReturn(companyId: string, sourceId: string) {
  if (sourceId !== "new" && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(sourceId)) return;
  sessionStorage.setItem(key(companyId), JSON.stringify({ sourceId, expiresAt: Date.now() + lifetime }));
}

export function skillSourceReturnPath(companyId: string): string | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key(companyId)) ?? "null");
    if (!saved || typeof saved.expiresAt !== "number" || saved.expiresAt < Date.now()
      || typeof saved.sourceId !== "string"
      || (saved.sourceId !== "new" && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(saved.sourceId))) return null;
    return `/skills/sources/${saved.sourceId}`;
  } catch { return null; }
}

export function consumeSkillSourceReturn(companyId: string): string | null {
  const path = skillSourceReturnPath(companyId);
  sessionStorage.removeItem(key(companyId));
  return path;
}
