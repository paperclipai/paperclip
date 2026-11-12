import { useId, useMemo } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { SKILL_SECURITY_OVERRIDE_MAX_PATH_BYTES, skillSecurityOverridePathBytes, type SkillSecurityFinding, type SkillSecurityOverrideRequest, type SkillSourceSecurityOverrideSummary } from '@paperclipai/shared';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';

export interface SkillSecurityTrust {
  trusted: boolean;
  reason: string;
  trustFutureUpdates: boolean;
  /** Withdraw the saved approval when no new one replaces it. */
  revoke?: boolean;
}

export const emptySkillSecurityTrust: SkillSecurityTrust = { trusted: false, reason: '', trustFutureUpdates: false, revoke: false };
const MIN_REASON_LENGTH = 10;
const NO_FINDINGS: SkillSecurityFinding[] = [];

/** Flagged files an administrator can still choose to include; one entry per path. */
export function overridableSecurityFiles(findings: SkillSecurityFinding[] = []) {
  const blocked = new Set(findings.filter(finding => !finding.overridable).map(finding => finding.path));
  const files = new Map<string, SkillSecurityFinding>();
  for (const finding of findings) {
    if (finding.overridable && !finding.accepted && !blocked.has(finding.path)) files.set(finding.path, finding);
  }
  return [...files.values()];
}

/** Whether one request can carry every flagged file; the server rejects larger approvals. */
export function fitsSkillSecurityOverride(files: SkillSecurityFinding[]) {
  return skillSecurityOverridePathBytes(files) <= SKILL_SECURITY_OVERRIDE_MAX_PATH_BYTES;
}

/**
 * The request for the server, or null when nothing is trusted. Undefined while the reason is incomplete.
 * Takes the result of `overridableSecurityFiles`, so callers can compute it once per scan instead of per keystroke.
 */
export function skillSecurityOverrideRequest(trust: SkillSecurityTrust, commitSha: string | undefined, files: SkillSecurityFinding[]): SkillSecurityOverrideRequest | null | undefined {
  if (!trust.trusted || !files.length || !commitSha) return null;
  if (trust.reason.trim().length < MIN_REASON_LENGTH) return undefined;
  return { commitSha, reason: trust.reason.trim(), trustFutureUpdates: trust.trustFutureUpdates,
    files: files.map(file => ({ path: file.path, sha256: file.sha256 })) };
}

/**
 * Separates suspicious patterns an administrator may accept from real risks
 * that always stay blocked. Trust allows importing files, never running them.
 */
export function SkillSecurityReview({ findings = NO_FINDINGS, repository, commitSha, canOverride, value, onChange, disabled, recorded }: {
  findings?: SkillSecurityFinding[];
  repository: string;
  commitSha?: string;
  canOverride: boolean;
  value: SkillSecurityTrust;
  onChange: (value: SkillSecurityTrust) => void;
  disabled?: boolean;
  recorded?: SkillSourceSecurityOverrideSummary | null;
}) {
  const id = useId();
  // A scan can report thousands of findings. Derive the groups and their rows once per scan,
  // not on every keystroke in the reason field.
  const { overridable, overridableFits, blocked, accepted, blockedRows, overridableRows } = useMemo(() => {
    const overridable = overridableSecurityFiles(findings);
    const blocked = findings.filter(finding => !finding.overridable);
    const accepted = [...new Set(findings.filter(finding => finding.accepted).map(finding => finding.path))];
    return { overridable, overridableFits: fitsSkillSecurityOverride(overridable), blocked, accepted,
      blockedRows: blocked.map(finding => <li key={`${finding.path}:${finding.code}`} className="break-words">
        <span className="font-mono">{finding.path}</span> — {finding.message}
      </li>),
      overridableRows: overridable.map(finding => <li key={finding.path} className="break-words">
        <span className="font-mono">{finding.path}</span> — {finding.message}
      </li>) };
  }, [findings]);
  if (!overridable.length && !blocked.length && !accepted.length && !recorded) return null;
  const short = commitSha?.slice(0, 7);
  const reasonMissing = value.trusted && value.reason.trim().length < MIN_REASON_LENGTH;
  return <section className="space-y-3 rounded-md border border-border px-3 py-3 text-sm" aria-label="Security review">
    <h3 className="flex items-center gap-2 font-medium"><ShieldAlert className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />Security review</h3>
    {blocked.length > 0 && <div className="space-y-1">
      <p className="text-xs font-medium">Always blocked</p>
      <ul className="space-y-1 text-xs text-muted-foreground">{blockedRows}</ul>
      <p className="text-xs text-muted-foreground">These findings point to real risks, such as leaking credentials, and can’t be overridden.</p>
    </div>}
    {overridable.length > 0 && <div className="space-y-2">
      <p className="text-xs font-medium">Flagged patterns</p>
      <ul className="space-y-1 text-xs text-muted-foreground">{overridableRows}</ul>
      {canOverride && !overridableFits ? <p className="text-xs text-muted-foreground">These flagged files have too many or too long paths to approve in one request. Remove or move some of them in the repository, then scan again.</p>
      : canOverride ? <div className="space-y-2">
        <label className="flex items-start gap-2" htmlFor={`${id}-trust`}>
          <Checkbox id={`${id}-trust`} className="mt-0.5" checked={value.trusted} disabled={disabled}
            onCheckedChange={checked => onChange({ ...value, trusted: checked === true })} />
          <span>I trust {repository}{short ? <> at commit <span className="font-mono">{short}</span></> : null} and want to include {overridable.length === 1 ? 'this flagged file' : `these ${overridable.length} flagged files`}.</span>
        </label>
        {value.trusted && <div className="space-y-2 pl-6">
          <label className="flex flex-col gap-1 text-xs" htmlFor={`${id}-reason`}>Why do you trust this repository?
            <Textarea id={`${id}-reason`} value={value.reason} disabled={disabled} rows={2} aria-invalid={reasonMissing || undefined}
              placeholder="For example: maintained by our team, reviewed the flagged files." onChange={event => onChange({ ...value, reason: event.target.value })} />
          </label>
          {reasonMissing && <p className="text-xs text-destructive">Add a reason of at least {MIN_REASON_LENGTH} characters. It’s saved in the activity log.</p>}
          <label className="flex items-start gap-2 text-xs" htmlFor={`${id}-future`}>
            <Checkbox id={`${id}-future`} className="mt-0.5" checked={value.trustFutureUpdates} disabled={disabled}
              onCheckedChange={checked => onChange({ ...value, trustFutureUpdates: checked === true })} />
            <span>Keep including these files in future updates. Without this, every new commit needs a new review.</span>
          </label>
          <p className="text-xs text-muted-foreground">Trust lets these files be imported. It doesn’t let scripts run without their normal approval.</p>
        </div>}
      </div> : <p className="text-xs text-muted-foreground">Only a company administrator can include these files.</p>}
    </div>}
    {(accepted.length > 0 || recorded) && <p className="flex items-start gap-2 text-xs text-muted-foreground">
      <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>{recorded
        ? <>{recorded.fileCount} flagged {recorded.fileCount === 1 ? 'file is' : 'files are'} trusted by an administrator at commit <span className="font-mono">{recorded.commitSha.slice(0, 7)}</span>{recorded.trustFutureUpdates ? ', including future updates' : ''}.</>
        : <>{accepted.length} flagged {accepted.length === 1 ? 'file is' : 'files are'} included under an administrator override.</>}</span>
    </p>}
    {recorded && !value.trusted && <label className="flex items-start gap-2 text-xs" htmlFor={`${id}-revoke`}>
      <Checkbox id={`${id}-revoke`} className="mt-0.5" checked={value.revoke === true} disabled={disabled}
        onCheckedChange={checked => onChange({ ...value, revoke: checked === true })} />
      <span>Stop trusting these files. Flagged files are left out when you save, and only a company administrator can withdraw trust.</span>
    </label>}
  </section>;
}
