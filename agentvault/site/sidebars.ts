import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'doc',
      id: 'index',
      label: 'Introduction',
    },
    {
      type: 'category',
      label: 'Core Hierarchy',
      items: [
        'getting-started/installation',
        'getting-started/quick-start',
        'getting-started/configuration',
      ],
    },
    {
      type: 'category',
      label: 'Sovereign Operations',
      items: [
        'user/tutorial-v1.0',
        'user/deployment',
        'user/wallets',
        'user/backups',
        'user/webapp',
        'user/troubleshooting',
        'user/clawdbot-claude-skill',
      ],
    },
    {
      type: 'category',
      label: 'Command Protocols',
      items: [
        'cli/reference',
        'cli/options',
      ],
    },
    {
      type: 'category',
      label: 'Guardian Layer',
      items: [
        'security/overview',
        'security/best-practices',
      ],
    },
    {
      type: 'category',
      label: 'System Cartography',
      items: [
        'architecture/overview',
        'architecture/modules',
        'architecture/canister',
      ],
    },
    {
      type: 'category',
      label: 'Builder Notes',
      items: [
        'development/contributing',
        'development/testing',
      ],
    },
    {
      type: 'category',
      label: 'Advanced Rituals',
      items: [
        'guides/monitoring',
        'guides/advanced/promotion',
        'guides/advanced/rollback',
      ],
    },
    {
      type: 'category',
      label: 'Archive',
      items: [
        'dev/SECURITY_AUDIT',
        'marketing/release-notes',
        'PRD',
      ],
    },
  ],
};

export default sidebars;
