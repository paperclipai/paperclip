/**
 * Multi-Signature Approval Workflows
 *
 * Manages local approval workflows requiring multiple signatures.
 * This is a LOCAL approval tracking system, not cryptographic multisig.
 *
 * IMPORTANT: For production blockchain multisig, use:
 * - ICP canister-based threshold signatures (VetKeys)
 * - The canister multisig module for on-chain verification
 *
 * This module provides:
 * - Approval request tracking
 * - Signature collection and counting
 * - Policy-based approval thresholds
 * - Audit trail for approvals
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parse, stringify } from 'yaml';

const AGENTVAULT_DIR = path.join(os.homedir(), '.agentvault');
const APPROVALS_DIR = path.join(AGENTVAULT_DIR, 'approvals');

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ApprovalPolicy = 'all' | 'majority' | 'quorum';

export interface ApprovalRequest {
  id: string;
  type: 'deploy' | 'upgrade' | 'transfer' | 'config_change' | 'rollback';
  agentName: string;
  canisterId?: string;
  description: string;
  proposedBy: string;
  timestamp: Date;
  expiresAt?: Date;
  policy: ApprovalPolicy;
  requiredApprovals: number;
  approvals: ApprovalSignature[];
  status: ApprovalStatus;
  data?: Record<string, unknown>;
}

/**
 * Approval signature (NOT cryptographic - for audit trail only)
 *
 * This represents an approval action, not a cryptographic signature.
 * For cryptographic multisig, use the VetKeys canister integration.
 */
export interface ApprovalSignature {
  signer: string;
  /** Audit token - NOT a cryptographic signature */
  auditToken: string;
  timestamp: Date;
  comment?: string;
}

export interface ApprovalConfig {
  policy: ApprovalPolicy;
  requiredApprovals?: number;
  approvalTimeoutMs?: number;
  allowedSigners?: string[];
}

function ensureApprovalsDir(): void {
  if (!fs.existsSync(AGENTVAULT_DIR)) {
    fs.mkdirSync(AGENTVAULT_DIR, { recursive: true });
  }
  if (!fs.existsSync(APPROVALS_DIR)) {
    fs.mkdirSync(APPROVALS_DIR, { recursive: true });
  }
}

function getApprovalFilePath(id: string): string {
  ensureApprovalsDir();
  return path.join(APPROVALS_DIR, `${id}.yaml`);
}

function generateRequestId(): string {
  return `req-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Create a new approval request
 */
export function createApprovalRequest(
  type: ApprovalRequest['type'],
  agentName: string,
  description: string,
  proposedBy: string,
  config: ApprovalConfig,
  data?: Record<string, any>,
): ApprovalRequest {
  const id = generateRequestId();
  const timestamp = new Date();

  const requiredApprovals =
    config.requiredApprovals || calculateRequiredApprovals(config.policy, config.allowedSigners?.length || 1);

  const request: ApprovalRequest = {
    id,
    type,
    agentName,
    description,
    proposedBy,
    timestamp,
    policy: config.policy,
    requiredApprovals,
    approvals: [],
    status: 'pending',
    data,
  };

  if (config.approvalTimeoutMs) {
    request.expiresAt = new Date(timestamp.getTime() + config.approvalTimeoutMs);
  }

  const filePath = getApprovalFilePath(id);
  fs.writeFileSync(filePath, stringify(request), 'utf8');

  return request;
}

/**
 * Calculate required approvals based on policy
 */
export function calculateRequiredApprovals(
  policy: ApprovalPolicy,
  totalSigners: number,
): number {
  switch (policy) {
    case 'all':
      return totalSigners;
    case 'majority':
      return Math.floor(totalSigners / 2) + 1;
    case 'quorum':
    default:
      return Math.max(1, Math.ceil(totalSigners * 0.6));
  }
}

/**
 * Sign an approval request
 */
export function signApprovalRequest(
  id: string,
  signer: string,
  comment?: string,
): boolean {
  const request = getApprovalRequest(id);
  if (!request) {
    return false;
  }

  if (request.status !== 'pending') {
    return false;
  }

  const existingSignature = request.approvals.find((s) => s.signer === signer);
  if (existingSignature) {
    return false;
  }

  const approvalSignature: ApprovalSignature = {
    signer,
    auditToken: crypto.createHash('sha256')
      .update(`${id}:${signer}:${Date.now()}:${request.description}`)
      .digest('hex'),
    timestamp: new Date(),
    comment,
  };

  request.approvals.push(approvalSignature);

  if (request.approvals.length >= request.requiredApprovals) {
    request.status = 'approved';
  }

  const filePath = getApprovalFilePath(id);
  fs.writeFileSync(filePath, stringify(request), 'utf8');

  return true;
}

/**
 * Reject an approval request
 */
export function rejectApprovalRequest(
  id: string,
  rejectedBy: string,
  reason?: string,
): boolean {
  const request = getApprovalRequest(id);
  if (!request) {
    return false;
  }

  if (request.status !== 'pending') {
    return false;
  }

  request.status = 'rejected';
  request.approvals.push({
    signer: rejectedBy,
    auditToken: crypto.createHash('sha256')
      .update(`${id}:rejected:${Date.now()}:${reason || 'no-reason'}`)
      .digest('hex'),
    timestamp: new Date(),
    comment: `Rejected: ${reason || 'No reason provided'}`,
  });

  const filePath = getApprovalFilePath(id);
  fs.writeFileSync(filePath, stringify(request), 'utf8');

  return true;
}

/**
 * Get approval request by ID
 */
export function getApprovalRequest(id: string): ApprovalRequest | null {
  try {
    const filePath = getApprovalFilePath(id);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    interface LegacyApproval {
      signer: string;
      signature?: string;
      auditToken?: string;
      timestamp: string | Date;
      comment?: string;
    }
    interface LegacyApprovalRequest {
      id: string;
      type: ApprovalRequest['type'];
      agentName: string;
      canisterId?: string;
      description: string;
      proposedBy: string;
      timestamp: string | Date;
      expiresAt?: string | Date;
      policy: ApprovalPolicy;
      requiredApprovals: number;
      approvals: LegacyApproval[];
      status: ApprovalStatus;
      data?: Record<string, unknown>;
    }

    const parsed = parse(content) as LegacyApprovalRequest;
    parsed.timestamp = new Date(parsed.timestamp);
    parsed.expiresAt = parsed.expiresAt ? new Date(parsed.expiresAt) : undefined;

    // Migrate old 'signature' field to 'auditToken' for backward compatibility
    parsed.approvals = parsed.approvals.map((a): ApprovalSignature => {
      const migrated: ApprovalSignature = {
        signer: a.signer,
        auditToken: a.auditToken || a.signature || '',
        timestamp: new Date(a.timestamp),
        comment: a.comment,
      };
      return migrated;
    });

    return parsed as ApprovalRequest;
  } catch (error) {
    console.error(`Failed to get approval request ${id}:`, error);
    return null;
  }
}

/**
 * List approval requests
 */
export function listApprovalRequests(
  agentName?: string,
  status?: ApprovalStatus,
): ApprovalRequest[] {
  try {
    ensureApprovalsDir();
    const files = fs.readdirSync(APPROVALS_DIR);
    const requests: ApprovalRequest[] = [];

    for (const file of files) {
      if (file.endsWith('.yaml')) {
        const id = file.replace('.yaml', '');
        const request = getApprovalRequest(id);
        if (request) {
          if (agentName && request.agentName !== agentName) {
            continue;
          }
          if (status && request.status !== status) {
            continue;
          }

          if (request.expiresAt && new Date() > request.expiresAt && request.status === 'pending') {
            request.status = 'expired';
          }

          requests.push(request);
        }
      }
    }

    return requests.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  } catch (error) {
    console.error('Failed to list approval requests:', error);
    return [];
  }
}

/**
 * Delete approval request
 */
export function deleteApprovalRequest(id: string): boolean {
  try {
    const filePath = getApprovalFilePath(id);
    if (!fs.existsSync(filePath)) {
      return false;
    }

    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    console.error(`Failed to delete approval request ${id}:`, error);
    return false;
  }
}

/**
 * Check if request is approved
 */
export function isApproved(id: string): boolean {
  const request = getApprovalRequest(id);
  if (!request) {
    return false;
  }

  return request.status === 'approved';
}

/**
 * Get approval status summary
 */
export function getApprovalSummary(id: string): {
  total: number;
  approved: number;
  required: number;
  status: ApprovalStatus;
} | null {
  const request = getApprovalRequest(id);
  if (!request) {
    return null;
  }

  return {
    total: request.approvals.length,
    approved: request.requiredApprovals,
    required: request.requiredApprovals,
    status: request.status,
  };
}

/**
 * List pending approvals for a signer
 */
export function listPendingApprovals(signer: string): ApprovalRequest[] {
  try {
    const requests = listApprovalRequests(undefined, 'pending');
    return requests.filter((r) => !r.approvals.some((a) => a.signer === signer));
  } catch (error) {
    console.error('Failed to list pending approvals:', error);
    return [];
  }
}

/**
 * Clean up expired requests
 */
export function cleanupExpiredRequests(): number {
  let cleaned = 0;

  try {
    ensureApprovalsDir();
    const files = fs.readdirSync(APPROVALS_DIR);
    const now = new Date();

    for (const file of files) {
      if (file.endsWith('.yaml')) {
        const id = file.replace('.yaml', '');
        const request = getApprovalRequest(id);

        if (
          request &&
          request.expiresAt &&
          now > request.expiresAt &&
          request.status === 'pending'
        ) {
          request.status = 'expired';
          const filePath = getApprovalFilePath(id);
          fs.writeFileSync(filePath, stringify(request), 'utf8');
          cleaned++;
        }
      }
    }
  } catch (error) {
    console.error('Failed to cleanup expired requests:', error);
  }

  return cleaned;
}
