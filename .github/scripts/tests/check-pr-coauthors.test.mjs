import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCoauthors, fetchAllPullRequestCommits } from '../check-pr-coauthors.mjs';

function commit(login, name = null, email = null) {
  return {
    author: login ? { login } : null,
    commit: { author: { name: name ?? login, email: email ?? `${login}@users.noreply.github.com` } },
  };
}

test('checkCoauthors: says nothing when every commit is the PR author\'s own', () => {
  const result = checkCoauthors(
    [commit('tonio-alucema'), commit('tonio-alucema')],
    'tonio-alucema'
  );

  assert.equal(result.passed, true);
  assert.deepEqual(result.informational, []);
});

test('checkCoauthors: hands over the trailer when the branch carries someone else\'s commit', () => {
  // The case this exists for: a stale contributor PR rebased and landed by a
  // maintainer. Squash-merging drops the contributor unless the squash body
  // carries their trailer.
  const result = checkCoauthors(
    [commit('stubbi', 'Jannes Stubbemann'), commit('tonio-alucema')],
    'tonio-alucema'
  );

  assert.equal(result.informational.length, 1);
  assert.match(result.informational[0], /Jannes Stubbemann/);
  assert.match(
    result.informational[0],
    /Co-Authored-By: Jannes Stubbemann <stubbi@users\.noreply\.github\.com>/
  );
});

test('checkCoauthors: never fails the PR, because the squash message does not exist yet', () => {
  // Informational only. The author of the PR cannot satisfy this from the PR,
  // so failing here would block work on something unfixable at that point.
  const result = checkCoauthors([commit('stubbi')], 'tonio-alucema');

  assert.equal(result.passed, true);
});

test('checkCoauthors: matches the PR author case-insensitively', () => {
  // GitHub logins are case-insensitive, and PR_AUTHOR does not always arrive
  // in the same case as the commit author login.
  const result = checkCoauthors([commit('Tonio-Alucema')], 'tonio-alucema');

  assert.deepEqual(result.informational, []);
});

test('checkCoauthors: ignores bots', () => {
  const result = checkCoauthors(
    [commit('github-actions[bot]'), commit('dependabot[bot]')],
    'tonio-alucema'
  );

  assert.deepEqual(result.informational, []);
});

test('checkCoauthors: lists each contributor once, however many commits they wrote', () => {
  const result = checkCoauthors(
    [commit('stubbi', 'Jannes Stubbemann'), commit('stubbi', 'Jannes Stubbemann')],
    'tonio-alucema'
  );

  const trailers = result.informational[0].match(/Co-Authored-By:/g) ?? [];
  assert.equal(trailers.length, 1);
});

test('checkCoauthors: falls back to the raw git author when GitHub matched no account', () => {
  // A commit authored with an email GitHub cannot resolve still deserves a
  // trailer — that is precisely the identity most likely to be lost.
  const result = checkCoauthors(
    [{ author: null, commit: { author: { name: 'Ada Lovelace', email: 'ada@example.com' } } }],
    'tonio-alucema'
  );

  assert.match(result.informational[0], /Co-Authored-By: Ada Lovelace <ada@example\.com>/);
});

test('checkCoauthors: skips an unattributable commit rather than emitting a broken trailer', () => {
  const result = checkCoauthors(
    [{ author: null, commit: { author: { name: 'Nameless', email: null } } }],
    'tonio-alucema'
  );

  assert.deepEqual(result.informational, []);
});

test('checkCoauthors: names the count rather than everyone when several contributed', () => {
  const result = checkCoauthors(
    [commit('stubbi', 'Jannes Stubbemann'), commit('elJayAdvisor', 'LJ')],
    'tonio-alucema'
  );

  assert.match(result.informational[0], /2 other contributors/);
  assert.match(result.informational[0], /Jannes Stubbemann/);
  assert.match(result.informational[0], /LJ/);
});

test('checkCoauthors: tolerates a PR with no commits', () => {
  assert.deepEqual(checkCoauthors([], 'tonio-alucema').informational, []);
  assert.deepEqual(checkCoauthors(undefined, 'tonio-alucema').informational, []);
});

test('fetchAllPullRequestCommits: pages until a short batch', async () => {
  const seen = [];
  const commits = await fetchAllPullRequestCommits(async (path) => {
    seen.push(path);
    if (path.endsWith('page=1')) return Array.from({ length: 100 }, () => commit('stubbi'));
    return [commit('tonio-alucema')];
  }, 'paperclipai/paperclip', 9900, 'token');

  assert.equal(commits.length, 101);
  assert.equal(seen.length, 2);
});

test('fetchAllPullRequestCommits: stops at the API ceiling instead of looping', async () => {
  // `/pulls/{n}/commits` caps at 250 and keeps returning full pages of nothing
  // new past that. A branch that large is not what this gate is about, but it
  // must not spin.
  let calls = 0;
  const commits = await fetchAllPullRequestCommits(async () => {
    calls += 1;
    return Array.from({ length: 100 }, () => commit('stubbi'));
  }, 'paperclipai/paperclip', 9900, 'token');

  assert.equal(calls, 3);
  assert.equal(commits.length, 300);
});

test('checkCoauthors: counts one person once when their git name varies across commits', () => {
  // People change their git config. Keying the dedup on the rendered trailer
  // would put two lines for the same contributor into the squash body.
  const result = checkCoauthors(
    [commit('stubbi', 'Jannes Stubbemann'), commit('stubbi', 'J. Stubbemann')],
    'tonio-alucema'
  );

  const trailers = result.informational[0].match(/Co-Authored-By:/g) ?? [];
  assert.equal(trailers.length, 1);
  assert.doesNotMatch(result.informational[0], /other contributors/);
});

test('checkCoauthors: does not credit the PR author as a co-author of themselves', () => {
  // Their own commit, authored with an email GitHub could not match to the
  // account. Without the guard they appear in their own trailer list.
  const byName = checkCoauthors(
    [{ author: null, commit: { author: { name: 'tonio-alucema', email: 'tonio@example.com' } } }],
    'tonio-alucema'
  );
  const byEmail = checkCoauthors(
    [{ author: null, commit: { author: { name: 'Tonio', email: 'tonio-alucema@users.noreply.github.com' } } }],
    'tonio-alucema'
  );

  assert.deepEqual(byName.informational, []);
  assert.deepEqual(byEmail.informational, []);
});

test('checkCoauthors: counts one person once when some commits matched their account and some did not', () => {
  // The mixed case: GitHub resolved one commit to the login and left another
  // unmatched, both carrying the same email. Keying on login alone emits two
  // trailers for one contributor.
  const result = checkCoauthors(
    [
      commit('stubbi', 'Jannes Stubbemann', 'jannes@example.com'),
      { author: null, commit: { author: { name: 'Jannes Stubbemann', email: 'jannes@example.com' } } },
    ],
    'tonio-alucema'
  );

  const trailers = result.informational[0].match(/Co-Authored-By:/g) ?? [];
  assert.equal(trailers.length, 1);
});
