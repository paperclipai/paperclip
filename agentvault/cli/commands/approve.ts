import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  createApprovalRequest,
  signApprovalRequest,
  rejectApprovalRequest,
  listApprovalRequests,
  listPendingApprovals,
  deleteApprovalRequest,
  isApproved,
  getApprovalSummary,
  cleanupExpiredRequests,
  type ApprovalConfig,
  // MFA — TOTP path
  setupMfa,
  issueChallenge,
  verifyMfaApproval,
  verifyBiometricApproval,
  validateOtpToken,
  unlockBranch,
  getMfaAuditLog,
  getMfaStatus,
  getDeviceFingerprint,
  registerDevice,
} from '../../src/security/index.js';
import {
  setupBiometricCredential,
  signChallenge,
  hasBiometricCredential,
} from '../../src/security/webauthn.js';

const approveCmd = new Command('approve');

approveCmd
  .description('[Experimental] Manage multi-signature approval workflows')
  .action(async () => {
    console.log(chalk.yellow('[Experimental] This feature is under active development and may change.'));
    console.log(chalk.yellow('Please specify a subcommand: create, list, sign, reject, delete, or cleanup'));
    console.log(chalk.gray(`\nExamples:
  ${chalk.cyan('agentvault approve create deploy <agent-name> "Description"')}${chalk.gray('  Create approval request')}
  ${chalk.cyan('agentvault approve list')}${chalk.gray('                     List all requests')}
  ${chalk.cyan('agentvault approve sign <request-id>')}${chalk.gray('             Sign a request')}
  ${chalk.cyan('agentvault approve reject <request-id>')}${chalk.gray('          Reject a request')}
  ${chalk.cyan('agentvault approve pending <signer>')}${chalk.gray('          Show pending requests')}`));
  });

approveCmd
  .command('create')
  .description('Create a new approval request')
  .argument('<type>', 'Request type: deploy, upgrade, transfer, config_change, rollback')
  .argument('<agent-name>', 'Agent name')
  .argument('<description>', 'Description of the change')
  .option('--proposed-by <name>', 'Proposer name', 'admin')
  .option('--policy <policy>', 'Approval policy: all, majority, quorum', 'majority')
  .option('--required <number>', 'Number of required approvals')
  .option('--timeout <ms>', 'Approval timeout in milliseconds', '86400000')
  .option('--signers <count>', 'Number of allowed signers', '3')
  .action(async (type, agentName, description, options) => {
    const spinner = ora(`Creating approval request...`).start();

    try {
      const config: ApprovalConfig = {
        policy: options.policy as any,
        requiredApprovals: options.required ? parseInt(options.required, 10) : undefined,
        approvalTimeoutMs: parseInt(options.timeout, 10),
        allowedSigners: Array.from({ length: parseInt(options.signers, 10) }, (_, i) => `signer${i + 1}`),
      };

      const request = createApprovalRequest(
        type as any,
        agentName,
        description,
        options.proposedBy,
        config,
      );

      spinner.succeed(chalk.green(`Approval request created: ${request.id}`));
      console.log(chalk.gray(`Type: ${request.type}`));
      console.log(chalk.gray(`Policy: ${request.policy}`));
      console.log(chalk.gray(`Required approvals: ${request.requiredApprovals}`));
      console.log(chalk.gray(`Expires: ${request.expiresAt?.toLocaleString()}`));
    } catch (error) {
      spinner.fail(chalk.red('Failed to create approval request'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

approveCmd
  .command('list')
  .description('List approval requests')
  .option('--agent <name>', 'Filter by agent name')
  .option('--status <status>', 'Filter by status: pending, approved, rejected, expired')
  .action(async (options) => {
    const spinner = ora('Loading approval requests...').start();

    try {
      const requests = listApprovalRequests(options.agent, options.status as any);

      spinner.succeed(chalk.green(`Found ${requests.length} request(s)`));

      if (requests.length === 0) {
        console.log(chalk.gray('No approval requests found'));
        return;
      }

      for (const req of requests) {
        const statusColor = {
          pending: chalk.yellow,
          approved: chalk.green,
          rejected: chalk.red,
          expired: chalk.gray,
        }[req.status] || chalk.gray;

        const progress = `${req.approvals.length}/${req.requiredApprovals}`;

        console.log(`\n${chalk.bold(req.id)}`);
        console.log(`  Type: ${req.type}`);
        console.log(`  Agent: ${req.agentName}`);
        console.log(`  Status: ${statusColor(req.status)} ${progress}`);
        console.log(`  Proposed by: ${req.proposedBy}`);
        console.log(`  Description: ${req.description}`);

        if (req.approvals.length > 0) {
          console.log('  Signatures:');
          for (const sig of req.approvals) {
            console.log(`    - ${sig.signer} (${sig.timestamp.toLocaleString()})`);
            if (sig.comment) {
              console.log(`      ${chalk.gray(sig.comment)}`);
            }
          }
        }
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to list approval requests'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

approveCmd
  .command('sign')
  .description('Sign an approval request')
  .argument('<request-id>', 'Request ID to sign')
  .argument('<signer>', 'Signer name')
  .option('--comment <text>', 'Comment on signature')
  .action(async (requestId, signer, options) => {
    const spinner = ora(`Signing request ${requestId}...`).start();

    try {
      const success = signApprovalRequest(requestId, signer, options.comment);

      if (success) {
        const approved = isApproved(requestId);
        spinner.succeed(chalk.green(`Request signed by ${signer}`));
        if (approved) {
          console.log(chalk.green('\n✓ Request is now approved!'));
        } else {
          const summary = getApprovalSummary(requestId);
          if (summary) {
            console.log(chalk.gray(`Approvals: ${summary.approved}/${summary.required}`));
          }
        }
      } else {
        spinner.fail(chalk.red('Failed to sign request'));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to sign request'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

approveCmd
  .command('reject')
  .description('Reject an approval request')
  .argument('<request-id>', 'Request ID to reject')
  .argument('<signer>', 'Signer name')
  .option('--reason <text>', 'Rejection reason')
  .action(async (requestId, signer, options) => {
    const spinner = ora(`Rejecting request ${requestId}...`).start();

    try {
      const success = rejectApprovalRequest(requestId, signer, options.reason);

      if (success) {
        spinner.succeed(chalk.green(`Request rejected by ${signer}`));
      } else {
        spinner.fail(chalk.red('Failed to reject request'));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to reject request'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

approveCmd
  .command('pending')
  .description('List pending approvals for a signer')
  .argument('<signer>', 'Signer name')
  .action(async (signer) => {
    const spinner = ora(`Loading pending approvals for ${signer}...`).start();

    try {
      const requests = listPendingApprovals(signer);

      spinner.succeed(chalk.green(`Found ${requests.length} pending request(s)`));

      if (requests.length === 0) {
        console.log(chalk.gray('No pending requests'));
        return;
      }

      for (const req of requests) {
        console.log(`\n${chalk.bold(req.id)}`);
        console.log(`  Type: ${req.type}`);
        console.log(`  Agent: ${req.agentName}`);
        console.log(`  Description: ${req.description}`);
        console.log(`  Required: ${req.requiredApprovals}`);
        console.log(`  Current: ${req.approvals.length}`);
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to list pending approvals'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

approveCmd
  .command('delete')
  .description('Delete an approval request')
  .argument('<request-id>', 'Request ID to delete')
  .action(async (requestId) => {
    const spinner = ora(`Deleting request ${requestId}...`).start();

    try {
      const success = deleteApprovalRequest(requestId);

      if (success) {
        spinner.succeed(chalk.green(`Request deleted: ${requestId}`));
      } else {
        spinner.fail(chalk.red('Failed to delete request'));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to delete request'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

approveCmd
  .command('cleanup')
  .description('Clean up expired requests')
  .action(async () => {
    const spinner = ora('Cleaning up expired requests...').start();

    try {
      const cleaned = cleanupExpiredRequests();

      if (cleaned > 0) {
        spinner.succeed(chalk.green(`Marked ${cleaned} expired request(s)`));
      } else {
        spinner.info(chalk.gray('No expired requests to clean'));
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to cleanup'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

// ─── MFA subcommand ──────────────────────────────────────────────────────────

const mfaCmd = new Command('mfa');
mfaCmd.description('Multi-factor human approval (TOTP + nonce + one-time link)');

// agentvault approve mfa setup --branch <branch-id>
mfaCmd
  .command('setup')
  .description('Generate a TOTP seed for a branch — scan the QR URI once in your authenticator app')
  .requiredOption('--branch <branch-id>', 'Branch / workflow identifier (e.g. pending-001)')
  .action(async (options) => {
    const spinner = ora('Generating TOTP seed…').start();
    try {
      const setup = setupMfa(options.branch);
      spinner.succeed(chalk.green(`MFA seed created for branch: ${setup.branchId}`));

      console.log(chalk.bold('\n  TOTP Secret (keep offline):'));
      console.log(`  ${chalk.cyan(setup.totpSecretB32)}`);

      console.log(chalk.bold('\n  Scan this URI in Authy / Google Authenticator:'));
      console.log(`  ${chalk.yellow(setup.otpAuthUri)}`);

      console.log(
        chalk.gray(
          '\n  The secret is stored locally in ~/.agentvault/mfa/\n' +
            '  The agent never transmits the seed — only nonces and hashes go on-chain.',
        ),
      );
    } catch (error) {
      spinner.fail(chalk.red('Setup failed'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// agentvault approve mfa challenge <request-id> --branch <branch-id>
mfaCmd
  .command('challenge')
  .description('Issue a challenge (nonce + hash + one-time link) for a pending approval request')
  .argument('<request-id>', 'Approval request ID')
  .requiredOption('--branch <branch-id>', 'Branch that owns the TOTP seed')
  .action(async (requestId, options) => {
    const spinner = ora('Issuing MFA challenge…').start();
    try {
      const challenge = issueChallenge(requestId, options.branch);
      spinner.succeed(chalk.green('Challenge issued'));

      console.log(chalk.bold('\n  Reply with:'));
      console.log(`  ${chalk.cyan(`APPROVE <TOTP-code> ${challenge.nonce}`)}`);

      console.log(chalk.bold('\n  Or click the one-time link (valid 60 s):'));
      console.log(`  ${chalk.yellow(challenge.approvalLink)}`);

      console.log(chalk.bold('\n  Challenge hash (SHA-256):'));
      console.log(`  ${chalk.gray(challenge.challengeHash)}`);

      console.log(chalk.gray(`\n  Nonce: ${challenge.nonce}  |  Expires: ${challenge.expiresAt}`));
    } catch (error) {
      spinner.fail(chalk.red('Failed to issue challenge'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// agentvault approve mfa verify <request-id> <totp-code> <nonce> --branch <branch-id>
mfaCmd
  .command('verify')
  .description('Verify a TOTP code + nonce reply from the approver')
  .argument('<request-id>', 'Approval request ID')
  .argument('<totp-code>', '6-digit TOTP code from authenticator app')
  .argument('<nonce>', 'Nonce that was issued in the challenge (integer)')
  .requiredOption('--branch <branch-id>', 'Branch that owns the TOTP seed')
  .option('--fingerprint <hex>', 'Override device fingerprint (default: auto-detected)')
  .action(async (requestId, totpCode, nonceStr, options) => {
    const spinner = ora('Verifying MFA approval…').start();
    try {
      const nonce = parseInt(nonceStr, 10);
      if (isNaN(nonce)) {
        spinner.fail(chalk.red('Invalid nonce — must be an integer'));
        process.exit(1);
      }

      const result = verifyMfaApproval({
        requestId,
        branchId: options.branch,
        totpCode,
        nonce,
        deviceFingerprint: options.fingerprint,
      });

      if (result.ok) {
        spinner.succeed(chalk.green('Approval verified'));
        console.log(chalk.bold('\n  Audit token (forward to ICP canister):'));
        console.log(`  ${chalk.cyan(result.auditToken)}`);
        console.log(
          chalk.gray('\n  Run: agentvault approve sign <request-id> <signer> to complete the multi-sig flow.'),
        );
      } else {
        spinner.fail(chalk.red(`Verification failed: ${result.reason}`));

        const hints: Record<string, string> = {
          'invalid-totp': 'Check your authenticator app clock and try again.',
          'nonce-mismatch': 'Use the nonce from the latest challenge (agentvault approve mfa challenge).',
          'nonce-replayed': 'This nonce has already been used. Issue a new challenge.',
          'rate-limited': 'You have exceeded 3 approvals / hour. Wait before retrying.',
          'anomaly': 'Unknown device detected — branch auto-locked. Run: agentvault approve mfa unlock',
          'branch-locked': 'Branch is locked. Run: agentvault approve mfa unlock --branch <id>',
          'not-setup': 'MFA not configured. Run: agentvault approve mfa setup --branch <id>',
        };

        const hint = hints[result.reason];
        if (hint) console.log(chalk.yellow(`  Hint: ${hint}`));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Verification error'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// agentvault approve mfa link-verify <token>
mfaCmd
  .command('link-verify')
  .description('Validate a one-time approval link token (simulates the webapp handler)')
  .argument('<token>', 'Hex token from the approval link URL')
  .action(async (token) => {
    const spinner = ora('Validating one-time token…').start();
    try {
      const result = validateOtpToken(token);
      if (result.ok) {
        spinner.succeed(chalk.green(`Token valid — request ID: ${result.requestId}`));
        console.log(chalk.gray('  Token is now consumed and cannot be reused.'));
      } else {
        spinner.fail(chalk.red(`Token invalid: ${result.reason}`));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Token validation error'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// agentvault approve mfa unlock --branch <branch-id>
mfaCmd
  .command('unlock')
  .description('Unlock a branch after investigating a new-device anomaly')
  .requiredOption('--branch <branch-id>', 'Branch to unlock')
  .requiredOption('--totp <code>', '6-digit TOTP code confirming the unlock is authorised')
  .option('--register-device <fingerprint>', 'Register the new device fingerprint as trusted')
  .action(async (options) => {
    const spinner = ora('Unlocking branch…').start();
    try {
      const ok = unlockBranch(options.branch, options.totp, options.registerDevice);
      if (ok) {
        spinner.succeed(chalk.green(`Branch '${options.branch}' unlocked`));
        if (options.registerDevice) {
          console.log(chalk.gray(`  Device ${options.registerDevice} added to trusted list.`));
        }
      } else {
        spinner.fail(chalk.red('Unlock failed — TOTP code invalid or branch not found'));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Unlock error'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// agentvault approve mfa audit --branch <branch-id>
mfaCmd
  .command('audit')
  .description('Display the local MFA audit log for a branch')
  .requiredOption('--branch <branch-id>', 'Branch to query')
  .option('--json', 'Output raw JSON')
  .action(async (options) => {
    const spinner = ora('Loading audit log…').start();
    try {
      const entries = getMfaAuditLog(options.branch);
      spinner.succeed(chalk.green(`${entries.length} audit entry(ies) for branch '${options.branch}'`));

      if (entries.length === 0) {
        console.log(chalk.gray('  No events recorded yet.'));
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }

      for (const e of entries) {
        const eventColor: Record<string, (s: string) => string> = {
          'approved':          (s) => chalk.green(s),
          'rejected':          (s) => chalk.red(s),
          'anomaly-detected':  (s) => chalk.magenta(s),
          'branch-locked':     (s) => chalk.red(s),
          'branch-unlocked':   (s) => chalk.green(s),
          'rate-limit-exceeded': (s) => chalk.yellow(s),
          'challenge-issued':  (s) => chalk.blue(s),
          'setup':             (s) => chalk.cyan(s),
        };

        const colorFn = eventColor[e.event] ?? ((s: string) => chalk.gray(s));

        console.log(`\n  ${chalk.bold(e.id)}`);
        console.log(`    Event:     ${colorFn(e.event)}`);
        console.log(`    Request:   ${e.requestId}`);
        console.log(`    Timestamp: ${e.timestamp}`);
        if (e.nonce !== undefined) console.log(`    Nonce:     ${e.nonce}`);
        if (e.challengeHash) console.log(`    Hash:      ${chalk.gray(e.challengeHash)}`);
        if (e.auditToken) console.log(`    AuditTok:  ${chalk.cyan(e.auditToken)}`);
        if (e.deviceFingerprint) console.log(`    Device:    ${chalk.gray(e.deviceFingerprint)}`);
        if (e.detail) console.log(`    Detail:    ${chalk.gray(e.detail)}`);
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to load audit log'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// agentvault approve mfa status --branch <branch-id>
mfaCmd
  .command('status')
  .description('Show MFA posture (nonce, lock state) for a branch')
  .requiredOption('--branch <branch-id>', 'Branch to inspect')
  .action(async (options) => {
    const status = getMfaStatus(options.branch);

    if (!status.configured) {
      console.log(chalk.yellow(`MFA not configured for branch '${options.branch}'.`));
      console.log(chalk.gray(`  Run: agentvault approve mfa setup --branch ${options.branch}`));
      return;
    }

    const lockLabel = status.locked
      ? chalk.red('LOCKED (anomaly detected)')
      : chalk.green('unlocked');

    console.log(chalk.bold(`\nMFA status — ${options.branch}`));
    console.log(`  State:         ${lockLabel}`);
    console.log(`  Current nonce: ${status.currentNonce}`);
    console.log(`  Used nonces:   ${status.usedNonceCount}`);
    console.log(`  Created:       ${status.createdAt ?? 'unknown'}`);
    console.log(`  Device:        ${chalk.gray(getDeviceFingerprint())}`);
  });

// agentvault approve mfa device-register --signer <id> --fingerprint <hex>
mfaCmd
  .command('device-register')
  .description('Manually trust a device fingerprint for a signer (after secondary confirmation)')
  .requiredOption('--signer <id>', 'Signer identifier (device fingerprint or username)')
  .requiredOption('--fingerprint <hex>', 'Device fingerprint to register as trusted')
  .action(async (options) => {
    registerDevice(options.signer, options.fingerprint);
    console.log(chalk.green(`Device ${options.fingerprint} registered for signer ${options.signer}.`));
  });

// ─── Biometric subcommands ────────────────────────────────────────────────────
// Layer 2: WebAuthn / Secure Enclave fallback when TOTP is unavailable.

// agentvault approve mfa biometric-setup [--fingerprint <hex>]
mfaCmd
  .command('biometric-setup')
  .description(
    'Enrol this device\'s biometric key (P-256 / WebAuthn).\n' +
    'Generates a device-bound ECDSA keypair stored in ~/.agentvault/mfa/.\n' +
    'The private key is AES-256-GCM encrypted and never leaves this machine.\n' +
    'In a browser this maps to navigator.credentials.create() with Face ID / fingerprint.',
  )
  .option(
    '--fingerprint <hex>',
    'Override device fingerprint (default: auto-detected from hostname+platform+arch)',
  )
  .action(async (options) => {
    const spinner = ora('Generating biometric credential…').start();
    try {
      const fingerprint = options.fingerprint ?? getDeviceFingerprint();
      const setup = setupBiometricCredential(fingerprint);

      spinner.succeed(chalk.green('Biometric credential enrolled'));
      console.log(chalk.bold('\n  Credential ID:'));
      console.log(`  ${chalk.cyan(setup.credentialId)}`);
      console.log(chalk.bold('\n  Public key (SPKI, base64url) — register with ICP canister:'));
      console.log(`  ${chalk.yellow(setup.publicKeyB64)}`);
      console.log(chalk.bold('\n  Device fingerprint:'));
      console.log(`  ${chalk.gray(setup.deviceFingerprint)}`);
      console.log(
        chalk.gray(
          '\n  The private key is stored encrypted in ~/.agentvault/mfa/\n' +
          '  Send the public key to your ICP canister to enable remote verification.\n' +
          '  Use --fingerprint to enrol on behalf of another device.',
        ),
      );
    } catch (error) {
      spinner.fail(chalk.red('Biometric enrolment failed'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// agentvault approve mfa biometric-verify <request-id> <nonce> --branch <branch-id>
mfaCmd
  .command('biometric-verify')
  .description(
    'Approve a pending request using the device biometric key instead of TOTP.\n' +
    'Signs the challenge hash from issueChallenge() with the enrolled P-256 key.\n' +
    'Use this when your TOTP app is unavailable (lost phone, etc.).',
  )
  .argument('<request-id>', 'Approval request ID')
  .argument('<nonce>', 'Nonce from the challenge (integer)')
  .requiredOption('--branch <branch-id>', 'Branch that owns the TOTP seed')
  .option('--challenge-hash <hex>', 'SHA-256 challenge hash (from: agentvault approve mfa challenge)')
  .option('--fingerprint <hex>', 'Override device fingerprint')
  .action(async (requestId, nonceStr, options) => {
    const spinner = ora('Signing with biometric key…').start();
    try {
      const nonce = parseInt(nonceStr, 10);
      if (isNaN(nonce)) {
        spinner.fail(chalk.red('Invalid nonce — must be an integer'));
        process.exit(1);
      }

      const fingerprint = options.fingerprint ?? getDeviceFingerprint();

      if (!hasBiometricCredential(fingerprint)) {
        spinner.fail(chalk.red(`No biometric credential found for device ${fingerprint}`));
        console.log(
          chalk.yellow('  Run: agentvault approve mfa biometric-setup'),
        );
        process.exit(1);
      }

      // The challenge hash is required for biometric verification — it was shown
      // by `agentvault approve mfa challenge` and must be copy-pasted here.
      if (!options.challengeHash) {
        spinner.fail(chalk.red('--challenge-hash is required for biometric verification'));
        console.log(chalk.gray('  Get it from: agentvault approve mfa challenge <request-id> --branch <branch-id>'));
        process.exit(1);
      }

      const challengeHash = options.challengeHash as string;

      // Sign the challenge with device key
      const assertion = signChallenge(challengeHash, fingerprint);

      // Verify through all MFA layers
      const result = verifyBiometricApproval({
        requestId,
        branchId: options.branch,
        challengeHash,
        assertion,
        nonce,
        deviceFingerprint: fingerprint,
      });

      if (result.ok) {
        spinner.succeed(chalk.green('Biometric approval verified'));
        console.log(chalk.bold('\n  Audit token (forward to ICP canister):'));
        console.log(`  ${chalk.cyan(result.auditToken)}`);
        console.log(chalk.bold('\n  Assertion (credential + signature):'));
        console.log(chalk.gray(`  credentialId:  ${assertion.credentialId}`));
        console.log(chalk.gray(`  signCounter:   ${assertion.signCounter}`));
        console.log(chalk.gray(`  signatureB64:  ${assertion.signatureB64.slice(0, 32)}…`));
        console.log(
          chalk.gray('\n  Run: agentvault approve sign <request-id> <signer> to complete the multi-sig flow.'),
        );
      } else {
        spinner.fail(chalk.red(`Biometric verification failed: ${result.reason}`));

        const hints: Record<string, string> = {
          'biometric-not-enrolled': 'Run: agentvault approve mfa biometric-setup to enrol this device.',
          'biometric-signature-invalid': 'Signature did not match the enrolled public key.',
          'biometric-counter-replay': 'Sign counter did not increment — possible replay attack.',
          'nonce-mismatch': 'Use the nonce from the latest challenge.',
          'nonce-replayed': 'This nonce is already used. Issue a new challenge.',
          'rate-limited': 'You have exceeded 3 approvals / hour.',
          'anomaly': 'Unknown device — branch auto-locked. Run: agentvault approve mfa unlock',
          'branch-locked': 'Branch is locked. Run: agentvault approve mfa unlock --branch <id>',
          'not-setup': 'MFA not configured. Run: agentvault approve mfa setup --branch <id>',
        };

        const hint = hints[result.reason];
        if (hint) console.log(chalk.yellow(`  Hint: ${hint}`));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Biometric verification error'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

approveCmd.addCommand(mfaCmd);

export { approveCmd };
