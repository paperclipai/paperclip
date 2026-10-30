import type { CompanySkill, CompanySkillDetail, CompanySkillListItem } from "@paperclipai/shared";

export type CompanySkillRouteSubject = Pick<CompanySkill | CompanySkillDetail | CompanySkillListItem, "id" | "key" | "slug">;

export type ParsedCompanySkillRoute = {
  skillToken: string | null;
  filePath: string;
  hasExplicitFilePath: boolean;
};

export type CompanySkillRouteResolution = {
  skill: CompanySkillRouteSubject | null;
  canonicalToken: string | null;
  shouldRedirect: boolean;
  ambiguous: boolean;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function decodeRouteSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function encodeRoutePath(value: string) {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export function encodeSkillFilePath(filePath: string) {
  return encodeRoutePath(filePath);
}

export function decodeSkillFilePath(filePath: string | undefined) {
  if (!filePath) return "SKILL.md";
  return filePath
    .split("/")
    .filter(Boolean)
    .map(decodeRouteSegment)
    .join("/");
}

function decodeSkillRouteToken(tokenPath: string | undefined) {
  if (!tokenPath) return null;
  const token = tokenPath
    .split("/")
    .filter(Boolean)
    .map(decodeRouteSegment)
    .join("/");
  return token.length > 0 ? token : null;
}

export function parseSkillRoute(routePath: string | undefined): ParsedCompanySkillRoute {
  const segments = (routePath ?? "").split("/").filter(Boolean);
  if (segments.length === 0) {
    return { skillToken: null, filePath: "SKILL.md", hasExplicitFilePath: false };
  }

  const filesIndex = segments.indexOf("files");
  const hasExplicitFilePath = filesIndex >= 0;
  const tokenSegments = filesIndex >= 0 ? segments.slice(0, filesIndex) : segments;
  const skillToken = decodeSkillRouteToken(tokenSegments.join("/"));
  if (!skillToken) {
    return { skillToken: null, filePath: "SKILL.md", hasExplicitFilePath };
  }

  return {
    skillToken,
    filePath: filesIndex >= 0 ? decodeSkillFilePath(segments.slice(filesIndex + 1).join("/")) : "SKILL.md",
    hasExplicitFilePath,
  };
}

function shortSkillId(skill: CompanySkillRouteSubject) {
  return skill.id.replace(/-/g, "").slice(0, 8);
}

function slugShortIdToken(skill: CompanySkillRouteSubject) {
  const slug = skill.slug.trim();
  return `${slug || "skill"}-${shortSkillId(skill)}`;
}

function hasExactlyOneMatch(skills: CompanySkillRouteSubject[], predicate: (skill: CompanySkillRouteSubject) => boolean) {
  return skills.filter(predicate).length === 1;
}

function isSafeKeyToken(skill: CompanySkillRouteSubject, skills: CompanySkillRouteSubject[]) {
  const key = skill.key.trim();
  if (!key || key.split("/").includes("files")) return false;
  return !skills.some((candidate) =>
    candidate.id !== skill.id
    && (
      candidate.key === key
      || candidate.slug === key
      || slugShortIdToken(candidate) === key
    )
  );
}

export function canonicalSkillRouteToken(
  skill: CompanySkillRouteSubject,
  skills: CompanySkillRouteSubject[] = [],
) {
  const slug = skill.slug.trim();
  if (slug && hasExactlyOneMatch(skills.length > 0 ? skills : [skill], (candidate) => candidate.slug === slug)) {
    return slug;
  }

  if (isSafeKeyToken(skill, skills)) {
    return skill.key.trim();
  }

  return slugShortIdToken(skill);
}

function uniqueMatch(
  skills: CompanySkillRouteSubject[],
  predicate: (skill: CompanySkillRouteSubject) => boolean,
) {
  const matches = skills.filter(predicate);
  if (matches.length !== 1) return { skill: null, ambiguous: matches.length > 1 };
  return { skill: matches[0], ambiguous: false };
}

export function resolveSkillRouteToken(
  token: string | null,
  skills: CompanySkillRouteSubject[],
): CompanySkillRouteResolution {
  if (!token) {
    return { skill: null, canonicalToken: null, shouldRedirect: false, ambiguous: false };
  }

  const legacyId = UUID_PATTERN.test(token) ? skills.find((skill) => skill.id === token) ?? null : null;
  if (legacyId) {
    return {
      skill: legacyId,
      canonicalToken: canonicalSkillRouteToken(legacyId, skills),
      shouldRedirect: true,
      ambiguous: false,
    };
  }

  const canonical = uniqueMatch(skills, (skill) => canonicalSkillRouteToken(skill, skills) === token);
  if (canonical.skill) {
    return { skill: canonical.skill, canonicalToken: token, shouldRedirect: false, ambiguous: false };
  }

  const bySlug = uniqueMatch(skills, (skill) => skill.slug === token);
  if (bySlug.skill) {
    const canonicalToken = canonicalSkillRouteToken(bySlug.skill, skills);
    return {
      skill: bySlug.skill,
      canonicalToken,
      shouldRedirect: canonicalToken !== token,
      ambiguous: false,
    };
  }
  if (bySlug.ambiguous) {
    return { skill: null, canonicalToken: null, shouldRedirect: false, ambiguous: true };
  }

  const byKey = uniqueMatch(skills, (skill) => skill.key === token);
  if (byKey.skill) {
    const canonicalToken = canonicalSkillRouteToken(byKey.skill, skills);
    return {
      skill: byKey.skill,
      canonicalToken,
      shouldRedirect: canonicalToken !== token,
      ambiguous: false,
    };
  }

  return { skill: null, canonicalToken: null, shouldRedirect: false, ambiguous: byKey.ambiguous };
}

export function skillRoute(
  skill: CompanySkillRouteSubject | string,
  skillsOrFilePath: CompanySkillRouteSubject[] | string | null = [],
  filePath?: string | null,
) {
  const skills = Array.isArray(skillsOrFilePath) ? skillsOrFilePath : [];
  const effectiveFilePath = Array.isArray(skillsOrFilePath) ? filePath : skillsOrFilePath;
  const token = typeof skill === "string" ? skill : canonicalSkillRouteToken(skill, skills);
  const basePath = `/skills/${encodeRoutePath(token)}`;
  return effectiveFilePath ? `${basePath}/files/${encodeSkillFilePath(effectiveFilePath)}` : basePath;
}

export function skillStudioRoute(skillId: string) {
  return `/skills/studio/${encodeURIComponent(skillId)}`;
}

export function skillStudioNewRoute(forkFromSkillId?: string | null, folderId?: string | null) {
  const basePath = "/skills/studio/new";
  const params: string[] = [];
  if (forkFromSkillId) params.push(`forkFrom=${encodeURIComponent(forkFromSkillId)}`);
  if (folderId) params.push(`folderId=${encodeURIComponent(folderId)}`);
  const query = params.join("&");
  return query ? `${basePath}?${query}` : basePath;
}

export function withRouteSkill(
  skills: CompanySkillRouteSubject[],
  skill: CompanySkillRouteSubject,
) {
  return skills.some((candidate) => candidate.id === skill.id) ? skills : [...skills, skill];
}
