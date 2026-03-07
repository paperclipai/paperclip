/**
 * Skills command - Manage domain-specific agent skill files
 *
 * Usage:
 *   agentvault skills list
 *   agentvault skills update --ios
 *   agentvault skills update --domain <name>
 *   agentvault skills show <skill-id>
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillEntry {
  id: string;
  file: string;
  title: string;
  tags: string[];
  qualityGates: string[];
}

interface SkillsManifest {
  domain: string;
  version: string;
  updatedAt: string;
  description: string;
  skills: SkillEntry[];
  qualityGates: Record<string, string>;
  updateCommand: string;
  loadOrder: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSkillsRoot(cwd: string): string {
  // Walk up from cwd until we find a skills/ directory or hit the root
  let dir = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'skills');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: create next to the cwd
  return path.join(path.resolve(cwd), 'skills');
}

function loadManifest(domainDir: string): SkillsManifest | null {
  const manifestPath = path.join(domainDir, 'skills.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as SkillsManifest;
  } catch {
    return null;
  }
}

function listDomains(skillsRoot: string): string[] {
  if (!fs.existsSync(skillsRoot)) return [];
  return fs.readdirSync(skillsRoot).filter(entry => {
    return fs.statSync(path.join(skillsRoot, entry)).isDirectory();
  });
}

// ---------------------------------------------------------------------------
// iOS skill content (bundled so `update --ios` works offline too)
// These mirror the canonical files under skills/ios/ in the repo.
// ---------------------------------------------------------------------------

const IOS_SKILLS_VERSION = '1.0.0';

const IOS_MANIFEST: SkillsManifest = {
  domain: 'ios',
  version: IOS_SKILLS_VERSION,
  updatedAt: new Date().toISOString().slice(0, 10),
  description: 'iOS engineering domain skills for AgentVault Guild agents',
  skills: [
    {
      id: 'swiftui-cell-reuse',
      file: 'SwiftUI-CellReuse.md',
      title: 'SwiftUI Cell Reuse Patterns',
      tags: ['swiftui', 'list', 'lazyvstack', 'performance', 'cell-reuse'],
      qualityGates: ['cell-reuse', 'memory-profile'],
    },
    {
      id: 'avplayer-best-practices',
      file: 'AVPlayer-BestPractices.md',
      title: 'AVPlayer Lifecycle & Reuse Best Practices',
      tags: ['avplayer', 'avfoundation', 'video', 'memory', 'lifecycle'],
      qualityGates: ['avplayer-reuse', 'memory-profile'],
    },
    {
      id: 'privacy-policy-template',
      file: 'PrivacyPolicy-Template.md',
      title: 'App Store Privacy Policy Template',
      tags: ['privacy', 'app-store', 'compliance', 'legal'],
      qualityGates: ['privacy-flags'],
    },
    {
      id: 'xcode-project-structure',
      file: 'Xcode-Project-Structure.md',
      title: 'Xcode Project Structure Conventions',
      tags: ['xcode', 'project-structure', 'spm', 'targets', 'schemes'],
      qualityGates: [],
    },
  ],
  qualityGates: {
    'cell-reuse':
      'Generated list/scroll code must use LazyVStack or List with stable IDs, never re-create views unnecessarily.',
    'avplayer-reuse':
      'AVPlayer instances must be pooled or reused; never create a new AVPlayer per cell without cleanup.',
    'memory-profile':
      'No retain cycles; weak/unowned references used for closures that outlive their enclosing scope.',
    'privacy-flags':
      'App must declare all data-collection practices; NSPrivacyCollectedDataTypes must be set in PrivacyInfo.xcprivacy.',
  },
  updateCommand: 'agentvault skills update --ios',
  loadOrder: [
    'xcode-project-structure',
    'swiftui-cell-reuse',
    'avplayer-best-practices',
    'privacy-policy-template',
  ],
};

// ---------------------------------------------------------------------------
// Sub-command handlers
// ---------------------------------------------------------------------------

function handleList(skillsRoot: string): void {
  const domains = listDomains(skillsRoot);
  if (domains.length === 0) {
    console.log(chalk.yellow('No skill domains found.'));
    console.log('Run', chalk.bold('agentvault skills update --ios'), 'to install iOS skills.');
    return;
  }

  console.log(chalk.bold('\nInstalled skill domains:\n'));
  for (const domain of domains) {
    const manifest = loadManifest(path.join(skillsRoot, domain));
    if (manifest) {
      console.log(
        chalk.cyan(`  ${domain}`),
        chalk.gray(`v${manifest.version}`),
        chalk.gray(`(${manifest.skills.length} skills)`),
      );
      for (const skill of manifest.skills) {
        console.log(chalk.gray(`    • ${skill.id} — ${skill.title}`));
      }
    } else {
      console.log(chalk.cyan(`  ${domain}`), chalk.gray('(no manifest)'));
    }
  }
  console.log();
}

function handleShow(skillsRoot: string, skillId: string): void {
  const domains = listDomains(skillsRoot);
  for (const domain of domains) {
    const domainDir = path.join(skillsRoot, domain);
    const manifest = loadManifest(domainDir);
    if (!manifest) continue;

    const entry = manifest.skills.find(s => s.id === skillId);
    if (!entry) continue;

    const filePath = path.join(domainDir, entry.file);
    if (!fs.existsSync(filePath)) {
      console.log(chalk.red(`Skill file not found: ${filePath}`));
      return;
    }

    console.log(chalk.bold(`\n${entry.title}`));
    console.log(chalk.gray(`Domain: ${domain}  ·  Version: ${manifest.version}`));
    console.log(chalk.gray(`Quality gates: ${entry.qualityGates.join(', ') || 'none'}\n`));
    console.log(fs.readFileSync(filePath, 'utf-8'));
    return;
  }

  console.log(chalk.red(`Skill '${skillId}' not found. Run 'agentvault skills list' to see available skills.`));
}

async function handleUpdate(skillsRoot: string, domain: string): Promise<void> {
  const spinner = ora(`Updating ${domain} skills…`).start();

  if (domain !== 'ios') {
    spinner.fail(`Domain '${domain}' is not yet supported. Only 'ios' is available.`);
    return;
  }

  const domainDir = path.join(skillsRoot, domain);
  if (!fs.existsSync(domainDir)) {
    fs.mkdirSync(domainDir, { recursive: true });
  }

  // Check existing version
  const existing = loadManifest(domainDir);
  if (existing && existing.version === IOS_SKILLS_VERSION) {
    spinner.succeed(`iOS skills are already up to date (v${IOS_SKILLS_VERSION}).`);
    return;
  }

  // Write manifest
  const manifestPath = path.join(domainDir, 'skills.json');
  fs.writeFileSync(manifestPath, JSON.stringify(IOS_MANIFEST, null, 2), 'utf-8');

  // For each skill file, copy from the repo's skills/ios/ directory if present
  // (supports both installed-package and monorepo dev scenarios)
  const repoSkillsDir = path.resolve(__dirname, '../../skills/ios');
  let copiedFromRepo = 0;

  for (const skill of IOS_MANIFEST.skills) {
    const destPath = path.join(domainDir, skill.file);
    const srcPath = path.join(repoSkillsDir, skill.file);

    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      copiedFromRepo++;
    } else if (!fs.existsSync(destPath)) {
      // Skill file missing and no source — write a placeholder
      const placeholder = `# ${skill.title}\n\n_Skill file not yet installed. Run \`agentvault skills update --ios\` again after pulling the latest AgentVault source._\n`;
      fs.writeFileSync(destPath, placeholder, 'utf-8');
    }
  }

  spinner.succeed(
    `iOS skills updated to v${IOS_SKILLS_VERSION}` +
    (copiedFromRepo > 0 ? ` (${copiedFromRepo} files copied from repo)` : ' (manifest updated)') +
    '.',
  );

  console.log();
  console.log(chalk.cyan('Installed skills:'));
  for (const skill of IOS_MANIFEST.skills) {
    console.log(`  • ${chalk.bold(skill.id)} — ${skill.title}`);
  }
  console.log();
  console.log('Skills directory:', chalk.bold(domainDir));
  console.log('Run', chalk.bold('agentvault skills list'), 'to verify.\n');
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const skillsCmd: Command = new Command('skills')
  .description('Manage domain-specific agent skill files')
  .addHelpText(
    'after',
    `
Examples:
  agentvault skills list                    List all installed skill domains
  agentvault skills update --ios            Install/update iOS skills
  agentvault skills update --domain ios     Same as --ios
  agentvault skills show swiftui-cell-reuse Display a skill's full content
`,
  );

// skills list
skillsCmd
  .command('list')
  .description('List all installed skill domains and their skills')
  .option('--cwd <path>', 'working directory', process.cwd())
  .action((opts: { cwd: string }) => {
    const skillsRoot = resolveSkillsRoot(opts.cwd);
    handleList(skillsRoot);
  });

// skills show <id>
skillsCmd
  .command('show <skillId>')
  .description('Display the full content of a skill file')
  .option('--cwd <path>', 'working directory', process.cwd())
  .action((skillId: string, opts: { cwd: string }) => {
    const skillsRoot = resolveSkillsRoot(opts.cwd);
    handleShow(skillsRoot, skillId);
  });

// skills update
skillsCmd
  .command('update')
  .description('Install or update skill files for a domain')
  .option('--ios', 'Update iOS domain skills')
  .option('--domain <name>', 'Update skills for the specified domain')
  .option('--cwd <path>', 'working directory', process.cwd())
  .action(async (opts: { ios?: boolean; domain?: string; cwd: string }) => {
    const skillsRoot = resolveSkillsRoot(opts.cwd);
    const domain = opts.ios ? 'ios' : opts.domain;

    if (!domain) {
      console.log(chalk.red('Specify a domain: --ios or --domain <name>'));
      process.exit(1);
    }

    await handleUpdate(skillsRoot, domain);
  });
