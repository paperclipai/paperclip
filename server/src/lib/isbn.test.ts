import { describe, expect, it } from 'vitest';
import { validateAndNormalizeIsbn } from '../lib/isbn';

describe('validateAndNormalizeIsbn', () => {
  describe('ISBN-13', () => {
    it('should validate ISBN-13', () => {
      expect(validateAndNormalizeIsbn('9783161484100')).toBe('9783161484100');
    });

    it('should handle formatted ISBN-13 with hyphens', () => {
      expect(validateAndNormalizeIsbn('978-3-16-148410-0')).toBe('9783161484100');
    });

    it('should handle formatted ISBN-13 with spaces', () => {
      expect(validateAndNormalizeIsbn('978 3 16 148410 0')).toBe('9783161484100');
    });

    it('should reject ISBN-13 with wrong check digit', () => {
      expect(validateAndNormalizeIsbn('9783161484101')).toBe(null);
    });

    it('should reject ISBN-13 with wrong prefix', () => {
      expect(validateAndNormalizeIsbn('9773161484100')).toBe(null);
    });

    it('should reject short ISBN-13', () => {
      expect(validateAndNormalizeIsbn('978316148410')).toBe(null);
    });

    it('should reject long ISBN-13', () => {
      expect(validateAndNormalizeIsbn('97831614841000')).toBe(null);
    });
  });

  describe('ISBN-10', () => {
    it('should validate ISBN-10', () => {
      expect(validateAndNormalizeIsbn('0306406152')).toBe('0306406152');
    });

    it('should handle mixed format valid ISBN-10 with hyphens', () => {
      expect(validateAndNormalizeIsbn('0-306-40615-2')).toBe('0306406152');
    });

    it('should reject ISBN-10 with wrong check digit', () => {
      expect(validateAndNormalizeIsbn('0306406153')).toBe(null);
    });

    it('should reject short ISBN-10', () => {
      expect(validateAndNormalizeIsbn('030640615')).toBe(null);
    });

    it('should reject long ISBN-10', () => {
      expect(validateAndNormalizeIsbn('03064061522')).toBe(null);
    });

    it('should reject ISBN-10 with non-numeric characters (except X)', () => {
      expect(validateAndNormalizeIsbn('030640615A')).toBe(null);
    });
  });

  describe('edge cases', () => {
    it('should return null for empty string', () => {
      expect(validateAndNormalizeIsbn('')).toBe(null);
    });

    it('should return null for non-numeric string', () => {
      expect(validateAndNormalizeIsbn('abcdefghij')).toBe(null);
    });

    it('should handle lowercase x in ISBN-10', () => {
      // Note: ISBN-10 with X check digit uses uppercase X
      // but let's test lowercase gets converted
      expect(validateAndNormalizeIsbn('080442957x')).toBe('080442957X');
    });
  });
});