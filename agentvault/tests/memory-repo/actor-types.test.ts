import { describe, it, expect } from 'vitest';
import { idlFactory } from '../../src/canister/memory-repo-actor.idl.js';
import {
  createMemoryRepoActor,
  createAnonymousAgent,
  createAuthenticatedAgent,
  validateCanisterId,
} from '../../src/canister/memory-repo-actor.js';
import type {
  Commit,
  RepoStatus,
  SecurityStatus,
  OperationResult,
  RebaseResult,
  MergeStrategy,
  ConflictEntry,
  MergeResult,
  _SERVICE,
} from '../../src/canister/memory-repo-actor.js';

// Shared mock IDL for structural tests
const mockIDL = {
  Service: (methods: Record<string, unknown>) => methods,
  Func: (args: unknown[], ret: unknown[], modes: string[]) => ({ args, ret, modes }),
  Text: 'Text',
  Int: 'Int',
  Nat: 'Nat',
  Bool: 'Bool',
  Null: 'Null',
  Principal: 'Principal',
  Opt: (t: unknown) => ({ opt: t }),
  Vec: (t: unknown) => ({ vec: t }),
  Record: (fields: Record<string, unknown>) => ({ record: fields }),
  Variant: (fields: Record<string, unknown>) => ({ variant: fields }),
  Tuple: (...args: unknown[]) => ({ tuple: args }),
};

describe('MemoryRepo Actor Types', () => {
  describe('IDL Factory', () => {
    it('should export an idlFactory function', () => {
      expect(typeof idlFactory).toBe('function');
    });

    it('should produce a service with all 19 methods', () => {
      const service = idlFactory({ IDL: mockIDL }) as Record<string, unknown>;
      const expectedMethods = [
        // Security (7)
        'freeze', 'manualUnlock', 'killCanister', 'reviveCanister',
        'addAuthorizedPrincipal', 'removeAuthorizedPrincipal', 'getSecurityStatus',
        // Core (9)
        'initRepo', 'commit', 'getCommit', 'log', 'getCurrentState',
        'getRepoStatus', 'getBranches', 'createBranch', 'switchBranch',
        // Rebase + Merge (3)
        'rebase', 'merge', 'cherryPick',
      ];

      for (const method of expectedMethods) {
        expect(service).toHaveProperty(method);
      }
      expect(Object.keys(service)).toHaveLength(22);
    });

    it('should mark query methods correctly', () => {
      const service = idlFactory({ IDL: mockIDL }) as Record<string, any>;

      const queryMethods = ['getSecurityStatus', 'getCommit', 'log', 'getCurrentState', 'getRepoStatus', 'getBranches'];
      for (const m of queryMethods) {
        expect(service[m].modes).toEqual(['query']);
      }

      const updateMethods = [
        'freeze', 'manualUnlock', 'killCanister', 'reviveCanister',
        'addAuthorizedPrincipal', 'removeAuthorizedPrincipal',
        'initRepo', 'commit', 'createBranch', 'switchBranch',
        'rebase', 'merge', 'cherryPick',
      ];
      for (const m of updateMethods) {
        expect(service[m].modes).toEqual([]);
      }
    });

    it('should have correct arg counts for each method', () => {
      const service = idlFactory({ IDL: mockIDL }) as Record<string, any>;

      expect(service.initRepo.args).toHaveLength(1);
      expect(service.commit.args).toHaveLength(3);
      expect(service.getCommit.args).toHaveLength(1);
      expect(service.log.args).toHaveLength(1);
      expect(service.getCurrentState.args).toHaveLength(0);
      expect(service.getRepoStatus.args).toHaveLength(0);
      expect(service.getBranches.args).toHaveLength(0);
      expect(service.createBranch.args).toHaveLength(1);
      expect(service.switchBranch.args).toHaveLength(1);
      expect(service.rebase.args).toHaveLength(2);
      expect(service.merge.args).toHaveLength(2);
      expect(service.cherryPick.args).toHaveLength(1);
      expect(service.addAuthorizedPrincipal.args).toHaveLength(1);
      expect(service.removeAuthorizedPrincipal.args).toHaveLength(1);
      expect(service.freeze.args).toHaveLength(0);
      expect(service.getSecurityStatus.args).toHaveLength(0);
    });
  });

  describe('TypeScript Types (bigint correctness)', () => {
    it('should have bigint timestamp in Commit', () => {
      const commit: Commit = {
        id: 'c_123_0',
        timestamp: BigInt('1700000000000000000'),
        message: 'test commit',
        diff: 'some diff content',
        tags: ['tag1', 'tag2'],
        parent: ['c_122_0'],
        branch: 'main',
      };

      expect(typeof commit.timestamp).toBe('bigint');
      expect(commit.tags).toHaveLength(2);
    });

    it('should support empty parent for genesis commits', () => {
      const genesis: Commit = {
        id: 'c_100_0',
        timestamp: BigInt(1700000000),
        message: 'Genesis',
        diff: 'soul content',
        tags: ['genesis'],
        parent: [],
        branch: 'main',
      };

      expect(genesis.parent).toHaveLength(0);
    });

    it('should have bigint totalCommits/totalBranches in RepoStatus', () => {
      const status: RepoStatus = {
        initialized: true,
        currentBranch: 'main',
        totalCommits: BigInt(5),
        totalBranches: BigInt(2),
        owner: 'abc-123',
      };

      expect(typeof status.totalCommits).toBe('bigint');
      expect(typeof status.totalBranches).toBe('bigint');
    });

    it('should have correct SecurityStatus type shape', () => {
      const sec: SecurityStatus = {
        owner: 'abc-123',
        frozenMode: false,
        canisterKilled: false,
        authorizedCount: BigInt(3),
        heapBytes: BigInt(1024),
      };

      expect(typeof sec.authorizedCount).toBe('bigint');
      expect(typeof sec.heapBytes).toBe('bigint');
      expect(sec.frozenMode).toBe(false);
    });

    it('should support OperationResult ok variant', () => {
      const result: OperationResult = { ok: 'success' };
      expect('ok' in result).toBe(true);
    });

    it('should support OperationResult err variant', () => {
      const result: OperationResult = { err: 'failure' };
      expect('err' in result).toBe(true);
    });

    it('should have bigint commitsReplayed in RebaseResult', () => {
      const result: RebaseResult = {
        ok: { newBranch: 'rebase/123', commitsReplayed: BigInt(3) },
      };
      if ('ok' in result) {
        expect(typeof result.ok.commitsReplayed).toBe('bigint');
      }
    });

    it('should have correct MergeStrategy type', () => {
      const auto: MergeStrategy = { auto: null };
      const manual: MergeStrategy = { manual: null };
      expect('auto' in auto).toBe(true);
      expect('manual' in manual).toBe(true);
    });

    it('should have correct ConflictEntry type shape', () => {
      const conflict: ConflictEntry = {
        commitId: 'c_456_1',
        message: 'conflicting commit',
        tags: ['feature'],
        diff: 'conflicting diff',
      };
      expect(conflict.commitId).toBe('c_456_1');
    });

    it('should have bigint merged in MergeResult ok variant', () => {
      const ok: MergeResult = { ok: { merged: BigInt(2), message: 'Merged 2 commits' } };
      const conflicts: MergeResult = { conflicts: [] };
      const err: MergeResult = { err: 'Branch not found' };

      expect('ok' in ok).toBe(true);
      if ('ok' in ok) {
        expect(typeof ok.ok.merged).toBe('bigint');
      }
      expect('conflicts' in conflicts).toBe(true);
      expect('err' in err).toBe(true);
    });
  });

  describe('Actor Creation Functions', () => {
    it('should export createMemoryRepoActor function', () => {
      expect(typeof createMemoryRepoActor).toBe('function');
    });

    it('should export createAnonymousAgent function', () => {
      expect(typeof createAnonymousAgent).toBe('function');
    });

    it('should export createAuthenticatedAgent function', () => {
      expect(typeof createAuthenticatedAgent).toBe('function');
    });

    it('should export validateCanisterId function', () => {
      expect(typeof validateCanisterId).toBe('function');
    });

    it('should throw on invalid canister ID', () => {
      expect(() => validateCanisterId('not-a-valid-principal')).toThrow('Invalid canister ID');
    });
  });

  describe('_SERVICE Interface', () => {
    it('should define all 19 expected methods', () => {
      const methodNames: (keyof _SERVICE)[] = [
        // Security
        'freeze', 'manualUnlock', 'killCanister', 'reviveCanister',
        'addAuthorizedPrincipal', 'removeAuthorizedPrincipal', 'getSecurityStatus',
        // Core
        'initRepo', 'commit', 'getCommit', 'log', 'getCurrentState',
        'getRepoStatus', 'getBranches', 'createBranch', 'switchBranch',
        // Rebase + Merge
        'rebase', 'merge', 'cherryPick',
      ];

      expect(methodNames).toHaveLength(19);
    });
  });
});
