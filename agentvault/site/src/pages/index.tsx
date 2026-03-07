import React, {useMemo, useState} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import HomepageFeatures from '@site/src/components/HomepageFeatures';

import styles from './index.module.css';

type WalletId = 'ethereum' | 'icp' | 'arweave';
type InstallChannel = 'npx' | 'global';
type ProjectTemplate = 'default' | 'minimal';
type DeployNetwork = 'local' | 'ic';
type SnapshotProfileId = 'clawdbot' | 'coding-cli' | 'goose' | 'ide-agent' | 'custom';

type WalletConnection = {
  address: string;
  chainName: string;
  type: WalletId;
};

type WalletOption = {
  id: WalletId;
  name: string;
  chainName: string;
  installUrl: string;
  installLabel: string;
  isAvailable: () => boolean;
  connect: () => Promise<WalletConnection>;
};

type SnapshotProfile = {
  id: SnapshotProfileId;
  name: string;
  description: string;
  defaultPath: string;
  snapshotTarget: string;
  restoreTarget: string;
};

declare global {
  interface Window {
    ethereum?: {
      request: (args: {method: string; params?: unknown[]}) => Promise<unknown>;
    };
    ic?: {
      plug?: {
        requestConnect: (args?: {whitelist?: string[]; host?: string}) => Promise<boolean>;
        agent?: {
          getPrincipal?: () => Promise<{toText: () => string}>;
        };
      };
    };
    arweaveWallet?: {
      connect: (permissions: string[]) => Promise<void>;
      getActiveAddress: () => Promise<string>;
    };
  }
}

const walletOptions: WalletOption[] = [
  {
    id: 'ethereum',
    name: 'MetaMask',
    chainName: 'Ethereum',
    installUrl: 'https://metamask.io/download/',
    installLabel: 'Install MetaMask',
    isAvailable: () => typeof window !== 'undefined' && Boolean(window.ethereum),
    connect: async () => {
      if (typeof window === 'undefined' || !window.ethereum) {
        throw new Error('MetaMask was not detected in this browser.');
      }

      const accounts = (await window.ethereum.request({method: 'eth_requestAccounts'})) as string[];
      if (!accounts || accounts.length === 0) {
        throw new Error('No Ethereum accounts were returned by your wallet.');
      }

      return {
        address: accounts[0],
        chainName: 'Ethereum',
        type: 'ethereum',
      };
    },
  },
  {
    id: 'icp',
    name: 'Plug Wallet',
    chainName: 'ICP',
    installUrl: 'https://plugwallet.ooo/',
    installLabel: 'Install Plug Wallet',
    isAvailable: () => typeof window !== 'undefined' && Boolean(window.ic?.plug),
    connect: async () => {
      if (typeof window === 'undefined' || !window.ic?.plug) {
        throw new Error('Plug wallet was not detected in this browser.');
      }

      const connected = await window.ic.plug.requestConnect({
        whitelist: [],
        host: 'https://icp0.io',
      });

      if (!connected) {
        throw new Error('Wallet connection request was rejected.');
      }

      const principal = await window.ic.plug.agent?.getPrincipal?.();
      const address = principal?.toText?.() ?? 'connected-with-plug';

      return {
        address,
        chainName: 'ICP',
        type: 'icp',
      };
    },
  },
  {
    id: 'arweave',
    name: 'ArConnect',
    chainName: 'Arweave',
    installUrl: 'https://www.arconnect.io/download',
    installLabel: 'Install ArConnect',
    isAvailable: () => typeof window !== 'undefined' && Boolean(window.arweaveWallet),
    connect: async () => {
      if (typeof window === 'undefined' || !window.arweaveWallet) {
        throw new Error('ArConnect was not detected in this browser.');
      }

      await window.arweaveWallet.connect(['ACCESS_ADDRESS', 'SIGN_TRANSACTION']);
      const address = await window.arweaveWallet.getActiveAddress();

      return {
        address,
        chainName: 'Arweave',
        type: 'arweave',
      };
    },
  },
];

const snapshotProfiles: SnapshotProfile[] = [
  {
    id: 'clawdbot',
    name: 'Clawdbot / OpenClaw',
    description: 'Capture memory graphs, prompts, and agent runtime configuration.',
    defaultPath: '~/.openclaw',
    snapshotTarget: 'openclaw',
    restoreTarget: 'openclaw',
  },
  {
    id: 'coding-cli',
    name: 'Claude Code / Codex / Gemini CLI',
    description: 'Preserve conversation state, tool context, and coding workspace metadata.',
    defaultPath: '~/.claude',
    snapshotTarget: 'coding-cli',
    restoreTarget: 'coding-cli',
  },
  {
    id: 'goose',
    name: 'Goose',
    description: 'Back up Goose sessions, plugin data, and long-term behaviors.',
    defaultPath: '~/.goose',
    snapshotTarget: 'goose',
    restoreTarget: 'goose',
  },
  {
    id: 'ide-agent',
    name: 'Cursor / Windsurf',
    description: 'Archive IDE assistant context, preferences, and workspace state.',
    defaultPath: '~/.cursor',
    snapshotTarget: 'ide-agent',
    restoreTarget: 'ide-agent',
  },
  {
    id: 'custom',
    name: 'DIY (Custom Path)',
    description: 'Point AgentVault to any local folder and snapshot it deterministically.',
    defaultPath: '~/path/to/agent-folder',
    snapshotTarget: 'custom',
    restoreTarget: 'custom',
  },
];

const backupProtocolPhases = [
  {
    id: '01',
    label: 'Create Snapshot',
    description: 'Package local agent state into an encrypted, content-addressed archive.',
    output: 'snapshot.zip + manifest.json',
  },
  {
    id: '02',
    label: 'Sign Intent',
    description: 'Sign backup intent with wallet keys before any chain operation begins.',
    output: 'wallet signature + hash proof',
  },
  {
    id: '03',
    label: 'Commit Storage',
    description: 'Write backup records to ICP and optional Arweave archival targets.',
    output: 'canister ID + archival transaction',
  },
  {
    id: '04',
    label: 'Verify Recovery',
    description: 'Generate deterministic restore command and audit receipt for operators.',
    output: 'restore command + replay proof',
  },
];

function shortAddress(address: string): string {
  if (address.length <= 14) {
    return address;
  }

  return `${address.slice(0, 7)}...${address.slice(-5)}`;
}

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  const signalMatrix = [
    'SOVEREIGN_RUNTIME',
    'CANISTER_PERSISTENCE',
    'MULTI_CHAIN_MEMORY',
    'RECOVERABLE_STATE',
  ];

  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className={styles.heroGrid} aria-hidden="true" />
      <div className={clsx('container', styles.heroInner)}>
        <p className={styles.protocolTag}>Protocol // 001</p>
        <p className={styles.heroKicker}>Neural Sovereignty</p>
        <Heading as="h1" className={clsx('hero__title', styles.heroTitle)}>
          AgentVault
        </Heading>
        <p className={clsx('hero__subtitle', styles.heroSubtitle)}>{siteConfig.tagline}</p>
        <p className={styles.heroDescription}>
          AgentVault deploys and protects autonomous agents with cryptographic ownership, persistent execution, and deterministic recovery from chain-backed state.
        </p>

        <div className={styles.heroButtons}>
          <Link className="button button--secondary button--lg" to="/docs/getting-started/installation">
            Get Started
          </Link>
          <a className="button button--primary button--lg" href="#instant-control">
            1-Click Control
          </a>
          <Link className="button button--outline button--lg" to="/docs/getting-started/quick-start">
            Quick Start
          </Link>
        </div>

        <div className={styles.signalGrid}>
          {signalMatrix.map((signal) => (
            <div key={signal} className={styles.signalItem}>
              <span className={styles.signalDiamond} aria-hidden="true" />
              <span>{signal}</span>
            </div>
          ))}
        </div>
      </div>
    </header>
  );
}

function BackupProtocolStudioSection() {
  const [selectedProfileId, setSelectedProfileId] = useState<SnapshotProfileId>('clawdbot');
  const [copiedField, setCopiedField] = useState<'snapshot' | 'restore' | null>(null);

  const selectedProfile = useMemo(
    () => snapshotProfiles.find((profile) => profile.id === selectedProfileId) ?? snapshotProfiles[0],
    [selectedProfileId],
  );

  const snapshotCommand = useMemo(() => {
    if (selectedProfile.id === 'custom') {
      return `agentvault snapshot --path ${selectedProfile.defaultPath}`;
    }

    return `agentvault snapshot --agent ${selectedProfile.snapshotTarget}`;
  }, [selectedProfile]);

  const restoreCommand = useMemo(
    () => `npx agentvault@latest restore --wallet <your-wallet> --agent ${selectedProfile.restoreTarget}`,
    [selectedProfile],
  );

  const handleCopy = async (field: 'snapshot' | 'restore', value: string) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1800);
    } catch {
      // Ignore clipboard failures in environments where clipboard is restricted.
    }
  };

  return (
    <section className={styles.backupStudioSection}>
      <div className="container">
        <div className={styles.backupStudioHeader}>
          <p className={styles.instantControlLabel}>Backup Protocol Studio</p>
          <Heading as="h2" className={styles.instantControlTitle}>
            Snapshot, Sign, and Restore With One Operator Flow
          </Heading>
          <p className={styles.instantControlLead}>
            This mirrors the strongest parts of the backup-focused experience: pick an agent stack, generate the exact snapshot command, and keep restore instructions tied to on-chain records.
          </p>
        </div>

        <div className={styles.backupStudioGrid}>
          <article className={styles.instantPanel}>
            <div className={styles.panelHeader}>
              <p className={styles.panelKicker}>Step A</p>
              <Heading as="h3" className={styles.panelTitle}>
                Select Agent Profile
              </Heading>
            </div>
            <div className={styles.profileList}>
              {snapshotProfiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={clsx(styles.profileButton, selectedProfile.id === profile.id && styles.profileButtonActive)}
                  onClick={() => setSelectedProfileId(profile.id)}>
                  <span className={styles.walletName}>{profile.name}</span>
                  <span className={styles.walletMeta}>{profile.description}</span>
                  <span className={styles.profilePath}>{profile.defaultPath}</span>
                </button>
              ))}
            </div>
          </article>

          <article className={styles.instantPanel}>
            <div className={styles.panelHeader}>
              <p className={styles.panelKicker}>Step B</p>
              <Heading as="h3" className={styles.panelTitle}>
                Snapshot + Restore Commands
              </Heading>
            </div>

            <div className={styles.commandBlock}>
              <p className={styles.commandLabel}>Snapshot Command</p>
              <pre className={styles.commandShell}>
                <code>{snapshotCommand}</code>
              </pre>
              <button
                type="button"
                className={clsx('button button--secondary button--lg', styles.commandButton)}
                onClick={() => void handleCopy('snapshot', snapshotCommand)}>
                {copiedField === 'snapshot' ? 'Copied Snapshot Command' : 'Copy Snapshot Command'}
              </button>
            </div>

            <div className={styles.commandBlock}>
              <p className={styles.commandLabel}>Restore Command</p>
              <pre className={styles.commandShell}>
                <code>{restoreCommand}</code>
              </pre>
              <button
                type="button"
                className={clsx('button button--secondary button--lg', styles.commandButton)}
                onClick={() => void handleCopy('restore', restoreCommand)}>
                {copiedField === 'restore' ? 'Copied Restore Command' : 'Copy Restore Command'}
              </button>
            </div>

            <div className={styles.storagePillRow}>
              <span className={styles.storagePill}>Wallet-Signed</span>
              <span className={styles.storagePill}>ICP Canister</span>
              <span className={styles.storagePill}>Arweave Archive</span>
              <span className={styles.storagePill}>Replay Verified</span>
            </div>
          </article>
        </div>

        <article className={styles.protocolTimelineCard}>
          <div className={styles.panelHeader}>
            <p className={styles.panelKicker}>Step C</p>
            <Heading as="h3" className={styles.panelTitle}>
              Execution Timeline
            </Heading>
          </div>

          <div className={styles.protocolTimeline}>
            {backupProtocolPhases.map((phase) => (
              <div key={phase.id} className={styles.protocolTimelineItem}>
                <span className={styles.protocolTimelineId}>{phase.id}</span>
                <div>
                  <p className={styles.protocolTimelineLabel}>{phase.label}</p>
                  <p className={styles.protocolTimelineText}>{phase.description}</p>
                  <p className={styles.protocolTimelineOutput}>Output: {phase.output}</p>
                </div>
              </div>
            ))}
          </div>

          <div className={styles.deployLinks}>
            <Link className={styles.inlineLink} to="/docs/user/backups">
              Backup Operations
            </Link>
            <Link className={styles.inlineLink} to="/docs/user/troubleshooting">
              Recovery Troubleshooting
            </Link>
            <Link className={styles.inlineLink} to="/docs/security/overview">
              Security Overview
            </Link>
          </div>
        </article>
      </div>
    </section>
  );
}

function ManifestSection() {
  return (
    <section className={styles.manifestSection}>
      <div className="container">
        <article className={styles.manifestCard}>
          <Heading as="h2" className={styles.sectionTitle}>
            <span className={styles.sacredBullet} aria-hidden="true" />
            The Manifested Essence
          </Heading>
          <p className={styles.sectionLead}>
            In the neo-robo-spiritual framework, your agent is not rented infrastructure. It is a sovereign digital extension secured by deterministic deployment, sealed keys, and protocol-level observability.
          </p>

          <div className={clsx(styles.admonition, styles.admonitionNote)}>
            <p className={styles.admonitionLabel}>System Information</p>
            <p>
              Initialization requires configured cycles funding, valid ICP identity context, and encrypted wallet storage. Keep mnemonic phrases outside automated environments.
            </p>
          </div>

          <Heading as="h3" className={styles.sequenceTitle}>
            Initial Sync Sequence
          </Heading>
          <p className={styles.sequenceText}>
            Execute the sync protocol to package, deploy, and verify your first sovereign entity.
          </p>

          <div className={styles.codeVessel}>
            <pre>
              <code>{`# Initialize and enter project
agentvault init neural-entity
cd neural-entity

# Package and deploy locally
agentvault package ./
agentvault deploy --network local

# Verify runtime state
agentvault status
agentvault health`}</code>
            </pre>
          </div>

          <div className={clsx(styles.admonition, styles.admonitionTip)}>
            <p className={styles.admonitionLabel}>Divine Efficiency</p>
            <p>
              Automate health checks and backup snapshots in your deployment loop. Fast recovery is part of sovereignty, not an afterthought.
            </p>
          </div>
        </article>
      </div>
    </section>
  );
}

function InstantControlSection() {
  const [selectedWallet, setSelectedWallet] = useState<WalletId | null>(null);
  const [walletConnection, setWalletConnection] = useState<WalletConnection | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [walletInstall, setWalletInstall] = useState<{label: string; url: string} | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);

  const [projectName, setProjectName] = useState('my-agent');
  const [template, setTemplate] = useState<ProjectTemplate>('default');
  const [installChannel, setInstallChannel] = useState<InstallChannel>('npx');
  const [packagePath, setPackagePath] = useState('./');
  const [network, setNetwork] = useState<DeployNetwork>('local');
  const [canisterId, setCanisterId] = useState('');
  const [copiedAction, setCopiedAction] = useState<'install' | 'deploy' | null>(null);

  const safeProjectName = projectName.trim() || 'my-agent';
  const safePackagePath = packagePath.trim() || './';
  const cliPrefix = installChannel === 'global' ? 'agentvault' : 'npx agentvault@latest';

  const installCommand = useMemo(() => {
    if (installChannel === 'global') {
      return `npm install -g agentvault && agentvault init ${safeProjectName} --template ${template}`;
    }

    return `npx agentvault@latest init ${safeProjectName} --template ${template}`;
  }, [installChannel, safeProjectName, template]);

  const deployCommand = useMemo(() => {
    const deployFlags = canisterId.trim()
      ? `--network ${network} --canister-id ${canisterId.trim()} --upgrade`
      : `--network ${network}`;

    return `cd ${safeProjectName} && ${cliPrefix} package ${safePackagePath} && ${cliPrefix} deploy ${deployFlags}`;
  }, [canisterId, cliPrefix, network, safePackagePath, safeProjectName]);

  const handleConnectWallet = async (wallet: WalletOption) => {
    setSelectedWallet(wallet.id);
    setWalletError(null);
    setWalletInstall(null);

    if (!wallet.isAvailable()) {
      setWalletInstall({label: wallet.installLabel, url: wallet.installUrl});
      return;
    }

    setWalletConnecting(true);
    try {
      const connection = await wallet.connect();
      setWalletConnection(connection);
      setNetwork(connection.type === 'icp' ? 'ic' : 'local');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Wallet connection failed.';
      setWalletError(message);
    } finally {
      setWalletConnecting(false);
    }
  };

  const handleCopy = async (mode: 'install' | 'deploy', value: string) => {
    setWalletError(null);

    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setWalletError('Clipboard access is unavailable in this browser.');
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setCopiedAction(mode);
      setTimeout(() => setCopiedAction(null), 2000);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to copy command.';
      setWalletError(message);
    }
  };

  return (
    <section id="instant-control" className={styles.instantControlSection}>
      <div className="container">
        <div className={styles.instantControlHeader}>
          <p className={styles.instantControlLabel}>Instant Control</p>
          <Heading as="h2" className={styles.instantControlTitle}>
            Wallet Connect + 1-Click Install/Deploy
          </Heading>
          <p className={styles.instantControlLead}>
            Connect your wallet, tune deployment settings, and copy ready-to-run commands for the exact environment you are shipping to.
          </p>
        </div>

        <div className={styles.instantControlGrid}>
          <article className={styles.instantPanel}>
            <div className={styles.panelHeader}>
              <p className={styles.panelKicker}>Step 1</p>
              <Heading as="h3" className={styles.panelTitle}>
                Connect Wallet
              </Heading>
            </div>

            <div className={styles.walletList}>
              {walletOptions.map((wallet) => {
                const isSelected = selectedWallet === wallet.id;
                const isConnected = walletConnection?.type === wallet.id;
                const isAvailable = wallet.isAvailable();

                return (
                  <button
                    key={wallet.id}
                    type="button"
                    className={clsx(styles.walletButton, isSelected && styles.walletButtonActive)}
                    onClick={() => void handleConnectWallet(wallet)}
                    disabled={walletConnecting}>
                    <span className={styles.walletName}>{wallet.name}</span>
                    <span className={styles.walletMeta}>
                      {wallet.chainName} · {isAvailable ? 'detected' : 'not detected'}
                    </span>
                    <span className={styles.walletState}>
                      {walletConnecting && isSelected ? 'connecting...' : isConnected ? 'connected' : 'connect'}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className={styles.walletStatus}>
              {walletConnection ? (
                <p className={styles.walletSuccess}>
                  Connected {walletConnection.chainName}: <code>{shortAddress(walletConnection.address)}</code>
                </p>
              ) : (
                <p className={styles.walletHint}>No wallet connected yet.</p>
              )}

              {walletInstall ? (
                <p className={styles.walletHint}>
                  Wallet extension missing.{' '}
                  <a href={walletInstall.url} target="_blank" rel="noreferrer">
                    {walletInstall.label}
                  </a>
                </p>
              ) : null}

              {walletError ? <p className={styles.walletError}>{walletError}</p> : null}
            </div>
          </article>

          <article className={styles.instantPanel}>
            <div className={styles.panelHeader}>
              <p className={styles.panelKicker}>Step 2</p>
              <Heading as="h3" className={styles.panelTitle}>
                Customize 1-Click Flow
              </Heading>
            </div>

            <div className={styles.configGrid}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Project Name</span>
                <input
                  className={styles.fieldInput}
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                />
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Template</span>
                <select
                  className={styles.fieldInput}
                  value={template}
                  onChange={(event) => setTemplate(event.target.value as ProjectTemplate)}>
                  <option value="default">default</option>
                  <option value="minimal">minimal</option>
                </select>
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Install Channel</span>
                <select
                  className={styles.fieldInput}
                  value={installChannel}
                  onChange={(event) => setInstallChannel(event.target.value as InstallChannel)}>
                  <option value="npx">npx</option>
                  <option value="global">global npm</option>
                </select>
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Package Path</span>
                <input
                  className={styles.fieldInput}
                  value={packagePath}
                  onChange={(event) => setPackagePath(event.target.value)}
                />
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Deploy Network</span>
                <select
                  className={styles.fieldInput}
                  value={network}
                  onChange={(event) => setNetwork(event.target.value as DeployNetwork)}>
                  <option value="local">local</option>
                  <option value="ic">ic</option>
                </select>
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Existing Canister ID (optional)</span>
                <input
                  className={styles.fieldInput}
                  placeholder="abcde-aaaab"
                  value={canisterId}
                  onChange={(event) => setCanisterId(event.target.value)}
                />
              </label>
            </div>

            <div className={styles.commandBlock}>
              <p className={styles.commandLabel}>1-Click Install</p>
              <pre className={styles.commandShell}>
                <code>{installCommand}</code>
              </pre>
              <button
                type="button"
                className={clsx('button button--secondary button--lg', styles.commandButton)}
                onClick={() => void handleCopy('install', installCommand)}>
                {copiedAction === 'install' ? 'Copied Install Command' : 'Copy Install Command'}
              </button>
            </div>

            <div className={styles.commandBlock}>
              <p className={styles.commandLabel}>1-Click Deploy</p>
              <pre className={styles.commandShell}>
                <code>{deployCommand}</code>
              </pre>
              <button
                type="button"
                className={clsx('button button--secondary button--lg', styles.commandButton)}
                onClick={() => void handleCopy('deploy', deployCommand)}>
                {copiedAction === 'deploy' ? 'Copied Deploy Command' : 'Copy Deploy Command'}
              </button>
            </div>

            <div className={styles.deployLinks}>
              <Link className={styles.inlineLink} to="/docs/getting-started/installation">
                Installation Guide
              </Link>
              <Link className={styles.inlineLink} to="/docs/user/deployment">
                Deployment Guide
              </Link>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

function Pathways() {
  return (
    <section className={styles.pathwaysSection}>
      <div className="container">
        <div className={styles.pathGrid}>
          <article className={clsx(styles.pathCard, styles.pathCardCyan)}>
            <p className={styles.pathLabel}>Next Step</p>
            <Heading as="h3" className={styles.pathTitle}>
              Backup + Recovery Ops
            </Heading>
            <p className={styles.pathBody}>
              Configure retention, validate restore drills, and automate operational backup checks.
            </p>
            <Link className={styles.pathAction} to="/docs/user/backups">
              Open Runbook
            </Link>
          </article>

          <article className={clsx(styles.pathCard, styles.pathCardPink)}>
            <p className={styles.pathLabel}>Deep Dive</p>
            <Heading as="h3" className={styles.pathTitle}>
              Threat Model + Hardening
            </Heading>
            <p className={styles.pathBody}>
              Review production hardening, key custody controls, and failure-response strategy.
            </p>
            <Link className={styles.pathAction} to="/docs/security/overview">
              Read Security Guide
            </Link>
          </article>
        </div>
      </div>
    </section>
  );
}

export default function Home(): React.ReactElement {
  const {siteConfig} = useDocusaurusContext();

  return (
    <Layout
      title={`${siteConfig.title} // Neural Sovereignty`}
      description="Neo-robo-spiritual platform for sovereign AI agents on ICP canisters.">
      <HomepageHeader />
      <main className={styles.main}>
        <ManifestSection />
        <InstantControlSection />
        <BackupProtocolStudioSection />
        <HomepageFeatures />
        <Pathways />
      </main>
    </Layout>
  );
}
