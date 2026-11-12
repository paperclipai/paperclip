// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SkillSecurityFinding } from '@paperclipai/shared';
import { SkillSecurityReview, emptySkillSecurityTrust, type SkillSecurityTrust } from './SkillSecurityReview';

// A repository scan may report up to its file limit; use a realistic large review.
const OVERRIDABLE = 1_500;
const BLOCKED = 500;
const TOTAL = OVERRIDABLE + BLOCKED;

let root: Root;
let host: HTMLDivElement;
let reads = 0;
let readLimit = Infinity;

/** Counts every read of `overridable`, the field each grouping pass checks, and fails fast on runaway work. */
function counted(finding: SkillSecurityFinding): SkillSecurityFinding {
  const { overridable, ...rest } = finding;
  return Object.defineProperty({ ...rest }, 'overridable', { enumerable: true, get() {
    reads++;
    if (reads > readLimit) throw new Error(`Security review read findings ${reads} times`);
    return overridable;
  } }) as SkillSecurityFinding;
}

const findings = [
  ...Array.from({ length: OVERRIDABLE }, (_, index) => counted({ path: `hooks/flagged-${index}.sh`, code: 'remote_fetch_exec', message: 'Flagged.', sha256: 'd'.repeat(64), overridable: true })),
  ...Array.from({ length: BLOCKED }, (_, index) => counted({ path: `scripts/leak-${index}.sh`, code: 'secret_exfiltration', message: 'Leaks.', sha256: 'e'.repeat(64), overridable: false })),
];

function Harness() {
  const [value, setValue] = useState<SkillSecurityTrust>(emptySkillSecurityTrust);
  return <SkillSecurityReview findings={findings} repository="acme/skills" commitSha={'a'.repeat(40)} canOverride value={value} onChange={setValue} />;
}

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; reads = 0; readLimit = Infinity; });
afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); });

describe('SkillSecurityReview at realistic size', () => {
  it('groups thousands of findings once per scan, not once per keystroke', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(<Harness />));
    expect(host.querySelectorAll('li')).toHaveLength(TOTAL);
    // Grouping reads each finding a fixed number of times; typing must not repeat it.
    const initial = reads;
    expect(initial).toBeLessThanOrEqual(4 * TOTAL);
    readLimit = initial;

    await act(async () => host.querySelector<HTMLButtonElement>('button[role="checkbox"]')!.click());
    const textarea = () => host.querySelector<HTMLTextAreaElement>('textarea')!;
    const reason = 'Reviewed by our team.';
    for (let length = 1; length <= reason.length; length++) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), reason.slice(0, length));
        textarea().dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    expect(textarea().value).toBe(reason);
    expect(host.textContent).toContain(`these ${OVERRIDABLE} flagged files`);
    expect(reads).toBe(initial);
  }, 30_000);
});
