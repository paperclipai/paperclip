import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectTranslationReferences, findMissingReferences } from './ui-localization-audit.mjs';

test('resolves imported aliases, hook namespaces and explicit namespace options', () => {
  const refs = inspectTranslationReferences(`
    import { t as globalTranslate, useTranslation } from '@/i18n';
    globalTranslate('ready', { ns: 'state' });
    function Card() {
      const { t: local } = useTranslation('tasks');
      return <p>{local('title')}{local('nav:home')}</p>;
    }
  `, 'fixture.tsx');
  assert.deepEqual(refs.static.map(x => [x.namespace, x.key]), [['state', 'ready'], ['tasks', 'title'], ['nav', 'home']]);
});

test('uses the nearest hook binding instead of a different component namespace', () => {
  const refs = inspectTranslationReferences(`
    import { useTranslation } from '@/i18n';
    function One() { const { t } = useTranslation('one'); return <p>{t('title')}</p>; }
    function Two() { const { t } = useTranslation('two'); return <p>{t('title')}</p>; }
  `, 'fixture.tsx');
  assert.deepEqual(refs.static.map(x => x.namespace), ['one', 'two']);
});

test('reports dynamic references separately and does not pretend to validate their keys', () => {
  const refs = inspectTranslationReferences(`
    import { t } from '@/i18n';
    export function label(status) { return t('state:' + status); }
  `, 'fixture.ts');
  assert.equal(refs.static.length, 0);
  assert.equal(refs.dynamic.length, 1);
});

test('requires both English and Chinese references, including plural variants', () => {
  const refs = { static: [{ namespace: 'tasks', key: 'count', file: 'fixture.tsx', line: 1 }], dynamic: [] };
  assert.deepEqual(findMissingReferences(refs.static, {
    en: { tasks: { count_one: '{{count}} task', count_other: '{{count}} tasks' } },
    'zh-CN': { tasks: { count_one: '{{count}} 个任务', count_other: '{{count}} 个任务' } },
  }), []);
  const missing = findMissingReferences(refs.static, { en: { tasks: { count: 'Tasks' } }, 'zh-CN': {} });
  assert.deepEqual(missing[0].missingLanguages, ['zh-CN']);
});

test('does not classify unrelated helper functions as translation calls', () => {
  const refs = inspectTranslationReferences(`function t(value) { return value; } t('not-a-key');`, 'fixture.ts');
  assert.equal(refs.static.length, 0);
});
