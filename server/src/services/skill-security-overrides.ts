import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  isSkillSecurityOverridableCode,
  type CompanySkillAuditFinding,
  type CompanySkillVersionFileInventoryEntry,
  type SkillSecurityFinding,
  type SkillSecurityOverrideRequest,
  type SkillSourceSecurityOverride,
} from '@paperclipai/shared';
import { conflict, unprocessable } from '../errors.js';
import { skillFileBytes } from './skill-snapshot.js';

/** Mirrors `SkillSecurityFindingAcceptor` in company-skills.ts without importing that module. */
export type SecurityFindingAcceptor = (filePath: string, sha256: string, code: string) => boolean;

type OverrideGrant = Pick<SkillSourceSecurityOverride, 'commitSha' | 'trustFutureUpdates'> & {
  files: Array<{ path: string; sha256: string }>;
};

/** Blocking codes reported back so a reviewer can see what was left out and why. */
const REPORTED_BLOCKING_CODES = new Set(['remote_fetch_exec', 'secret_exfiltration']);

export function fileSha256(file: CompanySkillVersionFileInventoryEntry) {
  return createHash('sha256').update(skillFileBytes(file)).digest('hex');
}

/**
 * Builds the acceptor for one scanned commit. A grant applies to the commit an
 * administrator reviewed, and only to the exact bytes they saw. With the
 * explicit future-updates opt-in it keeps applying to the same paths in later
 * commits. Non-overridable codes are never accepted, whatever the grant says.
 */
export function securityOverrideAcceptor(
  grants: Array<OverrideGrant | null | undefined>,
  commitSha: string,
  toRepositoryPath: (filePath: string) => string = filePath => filePath,
): SecurityFindingAcceptor | undefined {
  const active = grants.filter((grant): grant is OverrideGrant => Boolean(grant));
  if (!active.length) return undefined;
  const commit = commitSha.toLowerCase();
  // Index once per scan: a repository can hold thousands of audited and approved files.
  const byPath = new Map<string, Array<{ sha256: string; sameCommit: boolean; trustFutureUpdates: boolean }>>();
  for (const grant of active) {
    const sameCommit = grant.commitSha.toLowerCase() === commit;
    for (const file of grant.files) {
      const approvals = byPath.get(file.path) ?? [];
      approvals.push({ sha256: file.sha256.toLowerCase(), sameCommit, trustFutureUpdates: grant.trustFutureUpdates });
      byPath.set(file.path, approvals);
    }
  }
  return (filePath, sha256, code) => {
    if (!isSkillSecurityOverridableCode(code)) return false;
    const hash = sha256.toLowerCase();
    return (byPath.get(toRepositoryPath(filePath)) ?? []).some(approval => (approval.sameCommit && approval.sha256 === hash) || approval.trustFutureUpdates);
  };
}

/** Maps a skill-relative audit path to its repository path. */
export function skillRelativeToRepositoryPath(skillDirectory: string) {
  const directory = skillDirectory === '.' ? '' : skillDirectory;
  return (filePath: string) => directory ? path.posix.join(directory, filePath) : filePath;
}

/** Reports blocking findings (and accepted ones) per file with the exact content hash. */
export function securityFindingsFor(
  findings: CompanySkillAuditFinding[],
  files: CompanySkillVersionFileInventoryEntry[],
  toRepositoryPath: (filePath: string) => string = filePath => filePath,
): SkillSecurityFinding[] {
  const byPath = new Map(files.map(file => [file.path, file]));
  const reported: SkillSecurityFinding[] = [];
  for (const finding of findings) {
    if (!finding.path || !REPORTED_BLOCKING_CODES.has(finding.code)) continue;
    const file = byPath.get(finding.path);
    if (!file) continue;
    const accepted = finding.severity !== 'error';
    reported.push({ path: toRepositoryPath(finding.path), code: finding.code, message: finding.message,
      sha256: fileSha256(file), overridable: isSkillSecurityOverridableCode(finding.code), ...(accepted ? { accepted: true } : {}) });
  }
  return reported;
}

/** Merges per-skill and repository findings, one entry per path and code. */
export function mergeSecurityFindings(findings: SkillSecurityFinding[]) {
  const merged = new Map<string, SkillSecurityFinding>();
  for (const finding of findings) {
    const key = `${finding.path}\0${finding.code}`;
    const previous = merged.get(key);
    merged.set(key, previous ? { ...previous, accepted: Boolean(previous.accepted && finding.accepted) || undefined } : finding);
  }
  return [...merged.values()].map(finding => finding.accepted ? finding : (({ accepted: _accepted, ...rest }) => rest)(finding))
    .sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
}

/**
 * Confirms that every approved file was actually flagged with an overridable
 * finding at the reviewed commit and that the approval now covers it. A
 * mismatch means the repository or the audit changed after review.
 */
export function verifySecurityOverride(request: SkillSecurityOverrideRequest, scan: { commitSha: string; securityFindings?: SkillSecurityFinding[] }) {
  if (scan.commitSha.toLowerCase() !== request.commitSha.toLowerCase()) {
    throw conflict('The repository changed after the security review. Scan it again and review the flagged files.', { code: 'skill_security_override_stale' });
  }
  const findingsByPath = new Map<string, SkillSecurityFinding[]>();
  for (const finding of scan.securityFindings ?? []) findingsByPath.set(finding.path, [...(findingsByPath.get(finding.path) ?? []), finding]);
  for (const file of request.files) {
    const matches = findingsByPath.get(file.path) ?? [];
    if (!matches.length) throw unprocessable(`${file.path} is not flagged at this commit. Scan again before approving.`, { code: 'skill_security_override_stale' });
    if (matches.some(finding => !finding.overridable)) {
      throw unprocessable(`${file.path} contains a finding that can never be overridden.`, { code: 'skill_security_override_forbidden' });
    }
    if (matches.some(finding => finding.sha256.toLowerCase() !== file.sha256.toLowerCase() || !finding.accepted)) {
      throw conflict(`${file.path} changed after the security review. Scan it again.`, { code: 'skill_security_override_stale' });
    }
  }
}

export function recordedSecurityOverride(request: SkillSecurityOverrideRequest, findings: SkillSecurityFinding[], userId: string | null, now = new Date()): SkillSourceSecurityOverride {
  const overridableCode = new Map<string, string>();
  for (const finding of findings) if (finding.overridable && !overridableCode.has(finding.path)) overridableCode.set(finding.path, finding.code);
  return {
    commitSha: request.commitSha.toLowerCase(),
    files: request.files.map(file => ({ path: file.path, sha256: file.sha256.toLowerCase(),
      code: overridableCode.get(file.path) ?? 'remote_fetch_exec' }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    reason: request.reason.trim(),
    trustFutureUpdates: request.trustFutureUpdates,
    approvedByUserId: userId,
    approvedAt: now.toISOString(),
  };
}
