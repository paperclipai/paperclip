import { describe, expect, it } from 'vitest';
import { resolveExternalTestDatabaseUrl } from './external-test-database.js';

describe('external test database guard', () => {
  it('leaves embedded PostgreSQL as the default', () => {
    expect(resolveExternalTestDatabaseUrl('UNSET_TEST_DB', '')).toBeUndefined();
  });
  it.each(['postgres', 'postgresql'])('accepts a dedicated %s test database', protocol => {
    const url = `${protocol}://user:synthetic@localhost/skills_test?sslmode=disable`;
    expect(resolveExternalTestDatabaseUrl('TEST_DB', url)).toBe(url);
  });
  it.each([
    'postgres://user:synthetic@localhost/paperclip',
    'postgres://user:synthetic@localhost/',
    'postgres://user:synthetic@localhost/skills_test?database=paperclip',
    'postgres://user:synthetic@localhost/skills_test?dbname=paperclip',
    'postgres://user:synthetic@localhost/skills_test?options=-csearch_path=public',
    'postgres://user:synthetic@localhost/skills_test%2Fpaperclip',
    'https://localhost/skills_test',
    'not a URL',
  ])('rejects an unsafe target without exposing its URL', url => {
    expect(() => resolveExternalTestDatabaseUrl('TEST_DB', url)).toThrow(/^TEST_DB must name a dedicated PostgreSQL database/);
    try { resolveExternalTestDatabaseUrl('TEST_DB', url); }
    catch (error) { expect(String(error)).not.toContain('synthetic'); }
  });
});
