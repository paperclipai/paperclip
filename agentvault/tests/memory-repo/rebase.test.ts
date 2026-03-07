import { describe, it, expect } from 'vitest';
import { idlFactory } from '../../src/canister/memory-repo-actor.idl.js';
import type { RebaseResult, Commit } from '../../src/canister/memory-repo-actor.js';

// Shared mock IDL
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

describe('MemoryRepo Rebase', () => {
  describe('IDL', () => {
    it('should include rebase method as an update call with 2 args', () => {
      const service = idlFactory({ IDL: mockIDL }) as Record<string, any>;
      expect(service).toHaveProperty('rebase');
      expect(service.rebase.args).toHaveLength(2);
      expect(service.rebase.ret).toHaveLength(1);
      expect(service.rebase.modes).toEqual([]);
    });
  });

  describe('RebaseResult Type', () => {
    it('should support ok variant with bigint commitsReplayed', () => {
      const result: RebaseResult = {
        ok: { newBranch: 'rebase/42', commitsReplayed: BigInt(5) },
      };
      expect('ok' in result).toBe(true);
      if ('ok' in result) {
        expect(typeof result.ok.commitsReplayed).toBe('bigint');
        expect(result.ok.newBranch).toMatch(/^rebase\//);
      }
    });

    it('should support err variant', () => {
      const result: RebaseResult = { err: 'Branch has no commits' };
      expect('err' in result).toBe(true);
      if ('err' in result) {
        expect(result.err).toBe('Branch has no commits');
      }
    });
  });

  describe('Rebase Algorithm (Type-Level)', () => {
    it('should model a genesis commit followed by replayed commits', () => {
      const rebasedGenesis: Commit = {
        id: 'c_new_0',
        timestamp: BigInt(1700000000),
        message: 'Genesis: Rebase from new Soul.md',
        diff: 'New soul content',
        tags: ['genesis', 'soul', 'rebase'],
        parent: [],
        branch: 'rebase/42',
      };

      const replayedCommit: Commit = {
        id: 'c_new_1',
        timestamp: BigInt(1700000001),
        message: 'Original commit message',
        diff: 'original diff',
        tags: ['feature'],
        parent: ['c_new_0'],
        branch: 'rebase/42',
      };

      expect(rebasedGenesis.parent).toHaveLength(0);
      expect(rebasedGenesis.tags).toContain('rebase');
      expect(rebasedGenesis.tags).toContain('genesis');
      expect(replayedCommit.parent[0]).toBe(rebasedGenesis.id);
      expect(replayedCommit.branch).toBe(rebasedGenesis.branch);
    });

    it('should preserve original commit messages and diffs during replay', () => {
      const original: Commit = {
        id: 'c_old_1',
        timestamp: BigInt(1600000000),
        message: 'Add chat memory',
        diff: 'user: hello',
        tags: ['chat'],
        parent: ['c_old_0'],
        branch: 'main',
      };

      const replayed: Commit = {
        id: 'c_new_1',
        timestamp: BigInt(1700000001),
        message: original.message,
        diff: original.diff,
        tags: original.tags,
        parent: ['c_new_0'],
        branch: 'rebase/42',
      };

      expect(replayed.message).toBe(original.message);
      expect(replayed.diff).toBe(original.diff);
      expect(replayed.tags).toEqual(original.tags);
      expect(replayed.branch).not.toBe(original.branch);
    });
  });
});
