import type { Request } from 'express';
import type { Db } from '@paperclipai/db';
import { forbidden, unprocessable } from '../errors.js';
import { toolAccessService } from './tool-access.js';
import { resolveGitHubOperationCredentials } from './github-operation-credentials.js';
import type { GitHubRead } from './github-skill-source.js';
import { openGitSkillSnapshot } from './skill-source-git-snapshot.js';
import { createSkillSourceScanLimiter } from './skill-source-scan-limit.js';

const limitScans = createSkillSourceScanLimiter();

type Authorization = { connectionId: string | null; grantId?: string | null };
function providerStatus(error: unknown): number | undefined {
  return error instanceof Error && 'details' in error ? (error.details as { status?: number })?.status : undefined;
}

/** Automatic access considers only this caller's grants, never connection management visibility. */
export function skillSourceGitHubReader(db: Db, companyId: string, actor: Request['actor'], connectionId: string | null): GitHubRead {
  let chosen: Authorization | undefined;
  const access = toolAccessService(db);
  const localTrusted = actor.type === 'board' && actor.source === 'local_implicit';
  const headers = async (authorization: Authorization, force = false): Promise<Record<string, string>> => {
    if (actor.type === 'agent') {
      if (!actor.runId || !actor.agentId || actor.companyId !== companyId) {
        if (connectionId) throw forbidden('Private GitHub skills require an authenticated agent run.');
        return {};
      }
      const result = await resolveGitHubOperationCredentials(db, { companyId, agentId: actor.agentId, runId: actor.runId });
      if (result.status === 'available') {
        if (connectionId && result.connectionId !== connectionId) throw forbidden('This run cannot use the source’s saved GitHub connection. Choose the run’s authorized connection.');
        authorization.connectionId = result.connectionId ?? null;
        authorization.grantId = result.grantId;
        return { Authorization: `Bearer ${result.env.GH_TOKEN}` };
      }
      if (connectionId || result.status === 'unavailable') throw forbidden(result.reason ?? 'GitHub authorization is unavailable.');
      return {};
    }
    if (actor.type !== 'board') throw forbidden('Authentication required.');
    if (!authorization.connectionId) return {};
    return access.githubReadHeaders(companyId, authorization.connectionId, actor.userId ?? null, localTrusted, force, authorization.grantId);
  };
  const candidates = async (): Promise<Authorization[]> => {
    if (actor.type !== 'board') return [{ connectionId }];
    const ids = connectionId ? [connectionId] : await access.githubReadConnectionIds(companyId, actor.userId ?? null, localTrusted);
    const result: Authorization[] = [];
    for (const id of ids) {
      for (const grantId of await access.githubReadGrantIds(companyId, id, actor.userId ?? null, localTrusted)) result.push({ connectionId: id, grantId });
    }
    result.sort((a, b) => Number(b.connectionId === chosen?.connectionId && b.grantId === chosen?.grantId) - Number(a.connectionId === chosen?.connectionId && a.grantId === chosen?.grantId));
    if (!connectionId) result.push({ connectionId: null });
    return result;
  };
  const authorized = async <T>(operation: (values: Record<string, string>, authorization: Authorization) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    let lastError: unknown;
    try {
      for (const authorization of await candidates()) {
        let operationStarted = false;
        try {
          const invoke = async (force = false) => {
            signal?.throwIfAborted();
            const values = await headers(authorization, force);
            signal?.throwIfAborted();
            operationStarted = true;
            return operation(values, authorization);
          };
          let result: T;
          try { result = await invoke(); }
          catch (error) {
            if (providerStatus(error) !== 401 || !authorization.connectionId || actor.type !== 'board') throw error;
            result = await invoke(true);
          }
          chosen = authorization;
          return result;
        } catch (error) {
          signal?.throwIfAborted();
          lastError = error instanceof Error && 'status' in error ? error : unprocessable('Could not read GitHub. Check your connection and try again.');
          const status = providerStatus(error);
          if (operationStarted && ![401, 403, 404].includes(status ?? 0)) throw lastError;
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && 'status' in error) throw error;
      throw unprocessable('Could not read GitHub. Check your connection and try again.');
    }
    throw lastError ?? forbidden('Reconnect an active GitHub authorization to read this repository.');
  };
  const read = (async (apiPath: string, signal?: AbortSignal) => {
    if (!apiPath.startsWith('/repos/') || apiPath.includes('://') || apiPath.startsWith('//')) throw unprocessable('Invalid GitHub repository request.');
    return authorized(async authorization => {
      const timeout = AbortSignal.timeout(30_000);
      const response = await fetch(`https://api.github.com${apiPath}`, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...authorization },
        redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        const limited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
        const message = limited ? 'GitHub request limit reached. Try again after the limit resets or use another GitHub connection.'
          : response.status === 404 ? 'Repository, branch, or file is unavailable. Check the URL and GitHub repository access.'
          : [401, 403].includes(response.status) ? 'GitHub denied repository access. Reconnect GitHub or choose an authorized connection.'
          : 'GitHub could not complete the read. Try again.';
        throw unprocessable(message, { code: limited ? 'skill_source_github_rate_limited' : 'skill_source_github_read_failed', status: response.status });
      }
      return response.json();
    }, signal);
  }) as GitHubRead;
  const callerId = actor.type === 'agent' ? `agent:${actor.agentId}` : `board:${actor.userId ?? actor.source}`;
  let scanLease: ReturnType<typeof limitScans> | undefined;
  read.withScan = async operation => {
    const lease = limitScans(companyId, callerId);
    scanLease = lease;
    try { return await operation(); }
    finally { scanLease = undefined; lease.release(); }
  };
  read.openSnapshot = async (input, options = {}) => {
    const ownsLease = !scanLease;
    const lease = scanLease ?? limitScans(companyId, callerId);
    try {
      const snapshot = await authorized(async (values, authorization) => {
        const header = values.Authorization ?? values.authorization;
        if (header && !/^(Bearer|token)\s+\S+$/i.test(header)) throw unprocessable('Reconnect GitHub to download repositories.');
        const token = header?.replace(/^(Bearer|token)\s+/i, '') ?? '';
        return openGitSkillSnapshot({ ...input, token, cacheScope: JSON.stringify([companyId, actor.type, actor.type === 'agent' ? actor.agentId : actor.userId, actor.type === 'agent' ? actor.runId : actor.source, authorization.connectionId, authorization.grantId]) }, { ...options, beforeDownload: lease.beforeDownload });
      }, options.signal);
      return { ...snapshot, release: async () => { try { await snapshot.release(); } finally { if (ownsLease) lease.release(); } } };
    } catch (error) {
      if (ownsLease) lease.release();
      throw error;
    }
  };
  Object.defineProperty(read, 'connectionId', { get: () => chosen?.connectionId ?? null });
  return read;
}
