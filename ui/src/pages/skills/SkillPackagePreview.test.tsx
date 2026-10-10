// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SkillPackageReference } from '@paperclipai/shared';
import { SkillReferenceChoices, SkillPackagePreview } from './SkillPackagePreview';
import { skillSourcesApi } from '@/api/skillSources';
import { ApiError } from '@/api/client';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('skill reference choices', () => {
  it('can remove a saved choice even when upstream no longer contains the reference', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient();
    const inspection = { files: [{ path: 'SKILL.md', kind: 'skill' as const, encoding: 'utf8' as const, executable: false, sizeBytes: 20 }], warnings: [], requirements: null, references: [], includedReferences: ['removed/SKILL.md'] };
    const preview = vi.spyOn(skillSourcesApi, 'preview').mockResolvedValue({ file: inspection.files[0]!, inspection, content: 'No references remain.', truncated: false, commitSha: 'a'.repeat(40) });
    let selection = ['removed/SKILL.md'];
    function Example() {
      const [included, setIncluded] = useState(selection);
      selection = included;
      return <QueryClientProvider client={client}><SkillPackagePreview companyId="company" repository={{ repositoryUrl: 'https://github.com/acme/skills' }} commitSha={'a'.repeat(40)}
        skill={{ path: 'architect/SKILL.md', name: 'architect', description: null, error: 'Reference is no longer available', inspection }} includedReferences={included} onReferencesChange={setIncluded} onClose={() => {}} /></QueryClientProvider>;
    }
    try {
      await act(async () => root.render(<Example />));
      expect(document.body.textContent).toContain('No longer available · uncheck to remove');
      await act(async () => document.querySelector<HTMLInputElement>('[aria-label="Include removed/SKILL.md"]')!.click());
      expect(selection).toEqual([]);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(preview).toHaveBeenLastCalledWith('company', expect.objectContaining({ includedReferences: [] }), expect.anything());
      expect(document.body.textContent).not.toContain('Reference is no longer available');
    } finally { await act(async () => root.unmount()); client.clear(); host.remove(); preview.mockRestore(); }
  });

  it('updates the package preview and exposes further references before saving', async () => {
    const base = { files: [{ path: 'SKILL.md', kind: 'skill' as const, encoding: 'utf8' as const, executable: false, sizeBytes: 20 }], warnings: [], requirements: null,
      references: [{ fromPath: 'SKILL.md', target: '../runtime/SKILL.md', resolvedPath: 'runtime/SKILL.md', kind: 'outside_package' as const, import: { kind: 'skill' as const, path: 'runtime', fileCount: 2 } }] };
    let busyOnce = true;
    const preview = vi.spyOn(skillSourcesApi, 'preview').mockImplementation(async (_company, request) => {
      if (request.includedReferences?.length && busyOnce) {
        busyOnce = false;
        throw new ApiError('Previous preview is finishing', 429, { details: { code: 'skill_source_scan_limited', retryAfterSeconds: 1 } });
      }
      return {
      file: base.files[0]!, truncated: false, commitSha: 'a'.repeat(40),
      content: request.includedReferences?.length ? 'Run ./repository/runtime/scripts/run.py' : 'Read ../runtime/SKILL.md',
      inspection: request.includedReferences?.length ? { ...base, includedReferences: request.includedReferences,
        files: [...base.files, { ...base.files[0]!, path: 'repository/runtime/SKILL.md' }],
        references: [...base.references, { fromPath: 'runtime/SKILL.md', target: '../shared/data.json', resolvedPath: 'shared/data.json', kind: 'outside_package', import: { kind: 'folder', path: 'shared', fileCount: 1 } }] } : base,
      };
    });
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Example() {
      const [included, setIncluded] = useState<string[]>([]);
      return <QueryClientProvider client={client}><SkillPackagePreview companyId="company" repository={{ repositoryUrl: 'https://github.com/acme/skills' }} commitSha={'a'.repeat(40)}
        skill={{ path: 'architect/SKILL.md', name: 'architect', description: null, error: null, inspection: base }} includedReferences={included} onReferencesChange={setIncluded} onClose={() => {}} /></QueryClientProvider>;
    }
    try {
      await act(async () => root.render(<Example />));
      await act(async () => document.querySelector<HTMLInputElement>('[aria-label="Include ../runtime/SKILL.md"]')!.click());
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
      expect(preview).toHaveBeenLastCalledWith('company', expect.objectContaining({ includedReferences: ['runtime/SKILL.md'] }), expect.anything());
      expect(document.body.textContent).toContain('Run ./repository/runtime/scripts/run.py');
      expect(document.querySelector('[aria-label="Include ../shared/data.json"]')).not.toBeNull();
      expect(document.querySelector('[aria-label="Included package files"]')?.textContent).toContain('runtime');
    } finally { await act(async () => root.unmount()); client.clear(); host.remove(); preview.mockRestore(); }
  });
  it('lets a user remove a saved dependency that has disappeared', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    let selection = ['runtime/SKILL.md'];
    function Example() {
      const [included, setIncluded] = useState(selection);
      selection = included;
      return <SkillReferenceChoices references={[{ fromPath: 'SKILL.md', target: '../runtime/SKILL.md', resolvedPath: 'runtime/SKILL.md', kind: 'outside_package' }]} included={included} onChange={setIncluded} />;
    }
    try {
      await act(async () => root.render(<Example />));
      expect(host.textContent).toContain('No longer available · uncheck to remove');
      await act(async () => host.querySelector<HTMLInputElement>('input')!.click());
      expect(selection).toEqual([]);
      expect(host.querySelector('input')).toBeNull();
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
  it('selects and unselects complete skill/folder imports, with no checkbox for missing paths', async () => {
    const references: SkillPackageReference[] = [
      { fromPath: 'SKILL.md', target: '../runtime/SKILL.md', resolvedPath: 'skills/runtime/SKILL.md', kind: 'outside_package', import: { kind: 'skill', path: 'skills/runtime', fileCount: 5 } },
      { fromPath: 'references/guide.md', target: '../../scripts/run.py', resolvedPath: 'scripts/run.py', kind: 'outside_package', import: { kind: 'folder', path: 'scripts', fileCount: 2 } },
      { fromPath: 'SKILL.md', target: './absent.md', resolvedPath: 'skills/architect/absent.md', kind: 'missing' },
    ];
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    let selection: string[] = [];
    function Example() {
      const [included, setIncluded] = useState<string[]>([]);
      selection = included;
      return <SkillReferenceChoices references={references} included={included} onChange={setIncluded} />;
    }
    try {
      await act(async () => root.render(<Example />));
      expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
      expect(host.textContent).toContain('Whole skill · skills/runtime · 5 files');
      expect(host.textContent).toContain('Whole folder · scripts · 2 files');
      expect(host.textContent).toContain('Not found');
      const skill = host.querySelector<HTMLInputElement>('[aria-label="Include ../runtime/SKILL.md"]')!;
      const script = host.querySelector<HTMLInputElement>('[aria-label="Include ../../scripts/run.py"]')!;
      await act(async () => skill.click());
      await act(async () => script.click());
      expect(selection).toEqual(['skills/runtime/SKILL.md', 'scripts/run.py']);
      expect(skill.checked).toBe(true);
      await act(async () => skill.click());
      expect(selection).toEqual(['scripts/run.py']);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
});
