import { useId } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import type { SkillSecurityFinding, SkillSecurityOverrideRequest, SkillSourceSecurityOverride } from '@paperclipai/shared';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';

export interface SkillSecurityTrust {
  trusted: boolean;
  reason: string;
  trustFutureUpdates: boolean;
}

export const emptySkillSecurityTrust: SkillSecurityTrust = { trusted: false, reason: '', trustFutureUpdates: false };
const MIN_REASON_LENGTH = 10;

/** Flagged files an administrator can still choose to include; one entry per path. */
export function overridableSecurityFiles(findings: SkillSecurityFinding[] = []) {
  const blocked = new Set(findings.filter(finding => !finding.overridable).map(finding => finding.path));
  const files = new Map<string, SkillSecurityFinding>();
  for (const finding of findings) {
    if (finding.overridable && !finding.accepted && !blocked.has(finding.path)) files.set(finding.path, finding);
  }
  return [...files.values()];
}

/** The request for the server, or null when nothing is trusted. Undefined while the reason is incomplete. */
export function skillSecurityOverrideRequest(trust: SkillSecurityTrust, commitSha: string | undefined, findings: SkillSecurityFinding[] = []): SkillSecurityOverrideRequest | null | undefined {
  const files = overridableSecurityFiles(findings);
  if (!trust.trusted || !files.length || !commitSha) return null;
  if (trust.reason.trim().length < MIN_REASON_LENGTH) return undefined;
  return { commitSha, reason: trust.reason.trim(), trustFutureUpdates: trust.trustFutureUpdates,
    files: files.map(file => ({ path: file.path, sha256: file.sha256 })) };
}

/**
 * Separates suspicious patterns an administrator may accept from real risks
 * that always stay blocked. Trust allows importing files, never running them.
 */
export function SkillSecurityReview({ findings = [], repository, commitSha, canOverride, value, onChange, disabled, recorded }: {
  findings?: SkillSecurityFinding[];
  repository: string;
  commitSha?: string;
  canOverride: boolean;
  value: SkillSecurityTrust;
  onChange: (value: SkillSecurityTrust) => void;
  disabled?: boolean;
  recorded?: SkillSourceSecurityOverride | null;
}) {
  const id = useId();
  const overridable = overridableSecurityFiles(findings);
  const blocked = findings.filter(finding => !finding.overridable);
  const accepted = [...new Set(findings.filter(finding => finding.accepted).map(finding => finding.path))];
  if (!overridable.length && !blocked.length && !accepted.length && !recorded) return null;
  const short = commitSha?.slice(0, 7);
  const reasonMissing = value.trusted && value.reason.trim().length < MIN_REASON_LENGTH;
  return <section className="space-y-3 rounded-md border border-border px-3 py-3 text-sm" aria-label="Security review">
    <h3 className="flex items-center gap-2 font-medium"><ShieldAlert className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />Security review</h3>
    {blocked.length > 0 && <div className="space-y-1">
      <p className="text-xs font-medium">Always blocked</p>
      <ul className="space-y-1 text-xs text-muted-foreground">{blocked.map(finding => <li key={`${finding.path}:${finding.code}`} className="break-words">
        <span className="font-mono">{finding.path}</span> — {finding.message}
      </li>)}</ul>
      <p className="text-xs text-muted-foreground">These findings point to real risks, such as leaking credentials, and can’t be overridden.</p>
    </div>}
    {overridable.length > 0 && <div className="space-y-2">
      <p className="text-xs font-medium">Flagged patterns</p>
      <ul className="space-y-1 text-xs text-muted-foreground">{overridable.map(finding => <li key={finding.path} className="break-words">
        <span className="font-mono">{finding.path}</span> — {finding.message}
      </li>)}</ul>
      {canOverride ? <div className="space-y-2">
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
        ? <>{recorded.files.length} flagged {recorded.files.length === 1 ? 'file is' : 'files are'} trusted by an administrator at commit <span className="font-mono">{recorded.commitSha.slice(0, 7)}</span>{recorded.trustFutureUpdates ? ', including future updates' : ''}.</>
        : <>{accepted.length} flagged {accepted.length === 1 ? 'file is' : 'files are'} included under an administrator override.</>}</span>
    </p>}
  </section>;
}
