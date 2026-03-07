import React from 'react';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import Link from '@docusaurus/Link';

import styles from './changelog.module.css';

const releaseFeatures = [
  'Production-grade agent packaging, deployment, and lifecycle operations.',
  '37-command CLI surface for automation, diagnostics, and maintenance.',
  'Multi-chain wallet operations for ICP, Ethereum, Solana, and Polkadot.',
  'Security controls with multi-signature approvals and encrypted backups.',
  'Monitoring, promotion, rollback, and archival workflows for reliability.',
];

const knownLimitations = [
  'Wallet cryptography currently emphasizes transport security over full hardware-backed key custody.',
  'VetKeys threshold signatures are represented in simulation mode for v1.0 workflows.',
  'Bittensor inference integrations require external API credentials.',
  'Arweave archival requires operator wallet setup and funding.',
];

function Changelog(): React.ReactElement {
  return (
    <Layout title="Changelog" description="AgentVault release history and protocol updates.">
      <main className={styles.main}>
        <div className="container">
          <section className={styles.headerCard}>
            <p className={styles.protocolTag}>Archive // Protocol Release</p>
            <Heading as="h1" className={styles.pageTitle}>
              Changelog
            </Heading>
            <p className={styles.pageLead}>
              Release stream for the AgentVault runtime. Current stable milestone: <strong>v1.0.0</strong> (February 2026).
            </p>
          </section>

          <section className={styles.releaseCard}>
            <Heading as="h2" className={styles.releaseTitle}>
              v1.0.0 // Neural Sovereignty Baseline
            </Heading>
            <p className={styles.releaseSubtitle}>First stable release for continuous on-chain agent operations.</p>

            <Heading as="h3" className={styles.subTitle}>
              Manifested Capabilities
            </Heading>
            <ul className={styles.itemList}>
              {releaseFeatures.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>

            <Heading as="h3" className={styles.subTitle}>
              Install
            </Heading>
            <div className={styles.codeVessel}>
              <pre>
                <code>npm install -g agentvault@1.0.0</code>
              </pre>
            </div>

            <Heading as="h3" className={styles.subTitle}>
              Operational Reading
            </Heading>
            <div className={styles.linkGrid}>
              <Link to="/docs/getting-started/quick-start">Quick Start</Link>
              <Link to="/docs/user/tutorial-v1.0">Tutorial</Link>
              <Link to="/docs/cli/reference">CLI Reference</Link>
              <Link to="/docs/dev/SECURITY_AUDIT">Security Audit</Link>
            </div>

            <Heading as="h3" className={styles.subTitle}>
              Known Limitations
            </Heading>
            <ul className={styles.itemList}>
              {knownLimitations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>

          <section className={styles.actions}>
            <Link className="button button--secondary" to="https://github.com/johnnyclem/agentvault">
              View Source
            </Link>
            <Link className="button button--outline" to="https://www.npmjs.com/package/agentvault">
              View Package
            </Link>
          </section>
        </div>
      </main>
    </Layout>
  );
}

export default Changelog;
