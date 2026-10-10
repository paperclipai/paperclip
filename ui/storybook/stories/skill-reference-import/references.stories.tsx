import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { SkillReferenceChoices } from '@/pages/skills/SkillPackagePreview';
import type { SkillPackageReference } from '@paperclipai/shared';

const references: SkillPackageReference[] = [
  { fromPath: 'SKILL.md', target: '../runtime/SKILL.md', resolvedPath: 'skills/runtime/SKILL.md', kind: 'outside_package', import: { kind: 'skill', path: 'skills/runtime', fileCount: 5 } },
  { fromPath: 'references/rationale-template.md', target: '../../arena/SKILL.md', resolvedPath: 'skills/arena/SKILL.md', kind: 'outside_package', import: { kind: 'skill', path: 'skills/arena', fileCount: 3 } },
  { fromPath: 'SKILL.md', target: '../../scripts/build.py', resolvedPath: 'scripts/build.py', kind: 'outside_package', import: { kind: 'folder', path: 'scripts', fileCount: 4 } },
];
function ReferenceChoices({ missing = false, selected = false }: { missing?: boolean; selected?: boolean }) {
  const [included, setIncluded] = useState(selected ? references.map(reference => reference.resolvedPath) : []);
  return <div className="mx-auto max-w-2xl p-6"><SkillReferenceChoices references={missing ? [...references, { fromPath: 'SKILL.md', target: '../missing.md', resolvedPath: 'missing.md', kind: 'missing' }] : references} included={included} onChange={setIncluded} /></div>;
}
const meta = { title: 'Skills/Reference imports/Choices', component: ReferenceChoices } satisfies Meta<typeof ReferenceChoices>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SkillsAndScripts: Story = {};
export const Included: Story = { args: { selected: true } };
export const MissingFile: Story = { args: { missing: true } };
export const Mobile: Story = { globals: { viewport: { value: 'mobile1', isRotated: false } } };
