import React from 'react';
import Link from '@docusaurus/Link';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
  id: string;
  title: string;
  description: string;
  destination: string;
  action: string;
};

const CoreHierarchy: FeatureItem[] = [
  {
    id: '01',
    title: 'Package the Entity',
    description:
      'Compile local agent logic into deterministic WASM artifacts with reproducible packaging and integrity checks.',
    destination: '/docs/getting-started/quick-start',
    action: 'View Sequence',
  },
  {
    id: '02',
    title: 'Deploy the Vessel',
    description:
      'Ship to local replica or ICP mainnet with controlled upgrades, environment targeting, and deployment traceability.',
    destination: '/docs/user/deployment',
    action: 'Open Deployment',
  },
  {
    id: '03',
    title: 'Guard the Memory',
    description:
      'Run health telemetry, rollback gates, and archival workflows so agent state remains recoverable under pressure.',
    destination: '/docs/user/backups',
    action: 'Open Backup Guide',
  },
];

const ProtocolGrid: FeatureItem[] = [
  {
    id: 'A1',
    title: 'Neural Wallet Mesh',
    description:
      'Operate ICP, Ethereum, Solana, and Polkadot assets from one command surface with encrypted local custody.',
    destination: '/docs/user/wallets',
    action: 'Explore Wallets',
  },
  {
    id: 'A2',
    title: 'Guardian Security Layer',
    description:
      'Apply multi-signature approvals, key hygiene, and canister-level hardening for operational safety.',
    destination: '/docs/security/overview',
    action: 'Review Security',
  },
  {
    id: 'A3',
    title: 'Operator Control Plane',
    description:
      'Use monitoring, promotion, rollback, and task visibility to manage long-lived autonomous workflows.',
    destination: '/docs/guides/monitoring',
    action: 'Open Monitoring',
  },
  {
    id: 'A4',
    title: 'System Cartography',
    description:
      'Understand canister internals, module boundaries, and ICP integration primitives before scaling out.',
    destination: '/docs/architecture/overview',
    action: 'Read Architecture',
  },
];

function FeatureCard({id, title, description, destination, action}: FeatureItem) {
  return (
    <article className={styles.featureCard}>
      <p className={styles.cardId}>{id}</p>
      <Heading as="h3" className={styles.cardTitle}>
        {title}
      </Heading>
      <p className={styles.cardBody}>{description}</p>
      <Link className={styles.cardAction} to={destination}>
        {action}
      </Link>
    </article>
  );
}

export default function HomepageFeatures(): React.ReactElement {
  return (
    <section className={styles.featuresSection}>
      <div className="container">
        <div className={styles.blockHeader}>
          <p className={styles.blockLabel}>Core Hierarchy</p>
          <Heading as="h2" className={styles.blockTitle}>
            Operate Sovereign Agent Infrastructure
          </Heading>
        </div>

        <div className={styles.featureGrid}>
          {CoreHierarchy.map((item) => (
            <FeatureCard key={item.id} {...item} />
          ))}
        </div>

        <div className={styles.blockHeader}>
          <p className={styles.blockLabel}>Protocols</p>
          <Heading as="h2" className={styles.blockTitle}>
            Build For Resilience, Not Demo Cycles
          </Heading>
        </div>

        <div className={styles.protocolGrid}>
          {ProtocolGrid.map((item) => (
            <FeatureCard key={item.id} {...item} />
          ))}
        </div>
      </div>
    </section>
  );
}
