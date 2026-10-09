// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi } from 'vitest';
import { SkillSourceTree, updateSkillTreeSelection } from './SkillSourceTree';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const candidates = [
  { path: 'SKILL.md', name: 'Root', description: 'Repository skill', error: null },
  { path: '.agents/one/SKILL.md', name: 'One', description: 'First hidden skill', error: null },
  { path: '.agents/one/nested/SKILL.md', name: 'Nested', description: null, error: null },
  { path: '.agents/two/SKILL.md', name: 'Two', description: null, error: 'Invalid content' },
];
function changeSearch(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Search discovered skills"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
describe('skill source selection tree', () => {
  it('toggles descendants independently of the root skill and other folders', () => {
    const all = new Set(candidates.map(skill => skill.path));
    const next = updateSkillTreeSelection(candidates, all, '.agents/one', false);
    expect([...next]).toEqual(['SKILL.md', '.agents/two/SKILL.md']);
    expect(updateSkillTreeSelection(candidates, next, '.agents/one', true)).toEqual(all);
    expect(updateSkillTreeSelection(candidates, all, '', false).size).toBe(0);
  });
  it('renders labeled native checkbox controls, tracks excluded folders, and collapses branches', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    let exclusions: string[] = [];
    function Example() {
      const [selected, setSelected] = useState(new Set(candidates.map(skill => skill.path)));
      const [folders, setFolders] = useState<string[]>([]);
      return <SkillSourceTree candidates={candidates} selected={selected} excludedFolders={folders} onChange={(next, excluded) => { exclusions = excluded; setSelected(next); setFolders(excluded); }} />;
    }
    try {
      await act(async () => root.render(<Example />));
      const checkbox = host.querySelector<HTMLInputElement>('[aria-label="Import folder .agents/one"]')!;
      expect(checkbox.type).toBe('checkbox');
      await act(async () => checkbox.click());
      expect(exclusions).toEqual(['.agents/one']);
      expect(host.querySelector<HTMLInputElement>('[aria-label="Import .agents/one/SKILL.md"]')?.checked).toBe(false);
      expect(host.querySelector<HTMLInputElement>('[aria-label="Import SKILL.md"]')?.checked).toBe(true);
      const collapse = host.querySelector<HTMLButtonElement>('[aria-label="Collapse one"]')!;
      await act(async () => collapse.click());
      expect(host.querySelector('[data-file-tree-path=".agents/one"]')?.getAttribute('aria-expanded')).toBe('false');
      expect(host.querySelector('[aria-label="Import .agents/one/SKILL.md"]')).toBeNull();
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
  it('searches descriptions, selects full folders with Space, and keeps hidden siblings selected', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    let selection = new Set<string>();
    let exclusions: string[] = [];
    function Example() {
      const [selected, setSelected] = useState(selection);
      const [folders, setFolders] = useState<string[]>([]);
      return <SkillSourceTree candidates={candidates} selected={selected} excludedFolders={folders} onChange={(next, excluded) => { selection = next; exclusions = excluded; setSelected(next); setFolders(excluded); }} />;
    }
    try {
      await act(async () => root.render(<Example />));
      await act(async () => changeSearch(host, 'First hidden'));
      expect(host.querySelector('[data-file-tree-path=".agents/one/nested/SKILL.md"]')).toBeNull();
      const folder = host.querySelector('[data-file-tree-path=".agents/one"]')!;
      await act(async () => folder.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
      expect([...selection]).toEqual(['.agents/one/SKILL.md', '.agents/one/nested/SKILL.md']);
      await act(async () => folder.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
      expect(selection.size).toBe(0);
      expect(exclusions).toEqual(['.agents/one']);
      await act(async () => changeSearch(host, ''));
      expect(host.querySelector('[data-file-tree-path=".agents/one/nested/SKILL.md"]')).not.toBeNull();
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
  it('compacts folder chains without changing package paths, exclusions, or bulk selection', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const compactCandidates = [
      { path: 'SKILL.md', name: 'Root', description: 'Root skill', error: null },
      { path: '.agents/skills/review/SKILL.md', name: 'Review', description: 'Review changes', error: null },
      { path: '.agents/skills/review/security/SKILL.md', name: 'Security', description: 'Review security', error: null },
    ];
    let selection = new Set(compactCandidates.map(skill => skill.path));
    let exclusions: string[] = [];
    function Example() {
      const [selected, setSelected] = useState(selection);
      const [folders, setFolders] = useState<string[]>([]);
      return <SkillSourceTree candidates={compactCandidates} selected={selected} excludedFolders={folders} onChange={(next, excluded) => { selection = next; exclusions = excluded; setSelected(next); setFolders(excluded); }} />;
    }
    try {
      await act(async () => root.render(<Example />));
      expect(host.querySelector('[data-file-tree-path=".agents"]')).toBeNull();
      const folder = host.querySelector('[data-file-tree-path=".agents/skills/review"]')!;
      expect(folder.textContent).toBe('.agents/skills/review');
      await act(async () => folder.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
      expect([...selection]).toEqual(['SKILL.md']);
      expect(exclusions).toEqual(['.agents/skills/review']);
      const all = host.querySelector<HTMLInputElement>('[aria-label="Import folder Repository"]')!;
      expect(all.indeterminate).toBe(true);
      await act(async () => all.click());
      expect([...selection]).toEqual(compactCandidates.map(skill => skill.path));
      expect(exclusions).toEqual([]);
      await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Collapse all')!.click());
      expect(host.querySelector('[aria-label="Import .agents/skills/review/SKILL.md"]')).toBeNull();
      await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Expand all')!.click());
      expect(host.querySelector<HTMLInputElement>('[aria-label="Import .agents/skills/review/SKILL.md"]')?.checked).toBe(true);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it('selects a complete package independently of nested skills and previews included files without checkboxes', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const preview = vi.fn();
    const packages = candidates.map(candidate => ({ ...candidate, inspection: { requirements: null, references: [], warnings: [], files: [
      { path: 'SKILL.md', kind: 'skill', encoding: 'utf8' as const, sizeBytes: 100, executable: false },
      { path: 'scripts/run.sh', kind: 'script', encoding: 'utf8' as const, sizeBytes: 20, executable: true },
    ] } }));
    let selection = new Set(packages.map(skill => skill.path));
    function Example() {
      const [selected, setSelected] = useState(selection);
      return <SkillSourceTree candidates={packages} selected={selected} excludedFolders={[]} onPreview={preview} onChange={next => { selection = next; setSelected(next); }} />;
    }
    try {
      await act(async () => root.render(<Example />));
      // New nested packages stay visible while their parent package is collapsed.
      expect(host.querySelector('[aria-label="Import .agents/one/nested/SKILL.md"]')).not.toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Expand One"]')!.click());
      const row = host.querySelector<HTMLElement>('[data-file-tree-path=".agents/one/SKILL.md/scripts/run.sh"]')!;
      expect(row.textContent).toContain('Included');
      expect(row.querySelector('input')).toBeNull();
      expect(row.hasAttribute('aria-checked')).toBe(false);
      await act(async () => row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
      expect(selection.size).toBe(packages.length);
      await act(async () => row.click());
      expect(preview).toHaveBeenCalledWith(packages[1], 'scripts/run.sh');
      await act(async () => host.querySelector<HTMLInputElement>('[aria-label="Import .agents/one/SKILL.md"]')!.click());
      expect(selection.has('.agents/one/SKILL.md')).toBe(false);
      expect(selection.has('.agents/one/nested/SKILL.md')).toBe(true);
      // The inspector button owns its keys; Space must not toggle the package checkbox.
      const inspect = host.querySelector<HTMLButtonElement>('[aria-label="Inspect One"]')!;
      await act(async () => inspect.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
      expect(selection.has('.agents/one/SKILL.md')).toBe(false);
      await act(async () => changeSearch(host, 'scripts/run.sh'));
      expect(host.querySelector('[data-file-tree-path=".agents/one/SKILL.md/scripts/run.sh"]')).not.toBeNull();
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

});
