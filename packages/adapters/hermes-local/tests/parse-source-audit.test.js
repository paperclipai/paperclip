import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHermesStdoutParser, parseHermesOutput, parseHermesStdoutLine } from '../src/server/parse.js';

function resolveHermesSourceRoot() {
  const candidates = [
    process.env.HERMES_SOURCE_ROOT,
    path.join(os.homedir(), '.hermes', 'hermes-agent'),
  ].filter((value) => typeof value === 'string' && value.trim().length > 0);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(path.join(resolved, 'agent', 'display.py'))) {
      return resolved;
    }
  }

  return null;
}

const hermesSourceRoot = resolveHermesSourceRoot();
const sourceAuditOptions = hermesSourceRoot ? {} : { skip: 'Hermes source tree not available for source-backed audit.' };

const SOURCE_TOOL_SAMPLES = {
  web_search: [
    ['┊ 🔍 search    llm evals  0.3s', 'search'],
  ],
  web_extract: [
    ['┊ 📄 fetch     example.com  0.4s', 'fetch'],
    ['┊ 📄 fetch     pages  0.4s', 'fetch'],
  ],
  web_crawl: [
    ['┊ 🕸️  crawl     example.com  0.5s', 'crawl'],
  ],
  terminal: [
    ['┊ 💻 $         pwd  0.2s', 'shell'],
  ],
  process: [
    ['┊ ⚙️  proc      ls processes  0.1s', 'process'],
    ['┊ ⚙️  proc      submit 123456789abc  0.1s', 'process'],
  ],
  read_file: [
    ['┊ 📖 read      README.md  0.1s', 'read'],
  ],
  write_file: [
    ['┊ ✍️  write     hello.txt  0.1s', 'write'],
  ],
  patch: [
    ['┊ 🔧 patch     hello.txt  0.1s', 'patch'],
  ],
  search_files: [
    ['┊ 🔎 grep      TODO  0.1s', 'search'],
    ['┊ 🔎 find      package.json  0.1s', 'search'],
  ],
  browser_navigate: [
    ['┊ 🌐 navigate  example.com  0.1s', 'browser'],
  ],
  browser_snapshot: [
    ['┊ 📸 snapshot  compact  0.1s', 'browser'],
    ['┊ 📸 snapshot  full  0.1s', 'browser'],
  ],
  browser_click: [
    ['┊ 👆 click     12  0.1s', 'browser'],
  ],
  browser_type: [
    ['┊ ⌨️  type      "hello"  0.1s', 'browser'],
  ],
  browser_scroll: [
    ['┊ ↓  scroll    down  0.1s', 'browser'],
    ['┊ ↑  scroll    up  0.1s', 'browser'],
    ['┊ →  scroll    right  0.1s', 'browser'],
    ['┊ ←  scroll    left  0.1s', 'browser'],
  ],
  browser_back: [
    ['┊ ◀️  back      0.1s', 'browser'],
  ],
  browser_press: [
    ['┊ ⌨️  press     Enter  0.1s', 'browser'],
  ],
  browser_close: [
    ['┊ 🚪 close     browser  0.1s', 'browser'],
  ],
  browser_get_images: [
    ['┊ 🖼️  images    extracting  0.1s', 'browser'],
  ],
  browser_vision: [
    ['┊ 👁️  vision    analyzing page  0.1s', 'browser'],
  ],
  todo: [
    ['┊ 📋 plan      reading tasks  0.1s', 'plan'],
    ['┊ 📋 plan      3 task(s)  0.1s', 'plan'],
    ['┊ 📋 plan      update 3 task(s)  0.1s', 'plan'],
  ],
  session_search: [
    ['┊ 🔍 recall    "cached query"  0.1s', 'recall'],
  ],
  memory: [
    ['┊ 🧠 memory    +facts: "remember this"  0.1s', 'memory'],
    ['┊ 🧠 memory    ~facts: "old detail"  0.1s', 'memory'],
    ['┊ 🧠 memory    -facts: "old detail"  0.1s', 'memory'],
  ],
  skills_list: [
    ['┊ 📚 skills    list all  0.1s', 'skills'],
  ],
  skill_view: [
    ['┊ 📚 skill     dogfood  0.1s', 'skill'],
  ],
  image_generate: [
    ['┊ 🎨 create    sunset over ocean  0.1s', 'image'],
  ],
  text_to_speech: [
    ['┊ 🔊 speak     hello world  0.1s', 'speech'],
  ],
  vision_analyze: [
    ['┊ 👁️  vision    classify this image  0.1s', 'vision'],
  ],
  mixture_of_agents: [
    ['┊ 🧠 reason    compare options  0.1s', 'reason'],
  ],
  send_message: [
    ['┊ 📨 send      worker: "please continue"  0.1s', 'message'],
  ],
  cronjob: [
    ['[done] ┊ ⏰ cron      create heartbeat  0.1s', 'cron'],
    ['┊ ⏰ cron      listing  0.1s', 'cron'],
    ['┊ ⏰ cron      resume job-1  0.1s', 'cron'],
  ],
  execute_code: [
    ['┊ 🐍 exec      print("hi")  0.1s', 'execute_code'],
  ],
  delegate_task: [
    ['┊ 🔀 delegate  2 parallel tasks  0.1s', 'delegate'],
    ['┊ 🔀 delegate  audit the parser  0.1s', 'delegate'],
  ],
  skill_manage: [
    ['┊ ⚡ skill_man verification-before-completion  0.1s', 'skill_manage'],
  ],
  rl_: [
    ['┊ 🧪 rl        list envs  0.1s', 'rl'],
    ['┊ 🧪 rl        status abc123  0.1s', 'rl'],
  ],
};

function readHermesSourceFile(...parts) {
  assert.ok(hermesSourceRoot, 'Hermes source root should be available for this test.');
  return fs.readFileSync(path.join(hermesSourceRoot, ...parts), 'utf8');
}

function extractDisplayBranchToolNames(displaySource) {
  const names = new Set();
  for (const match of displaySource.matchAll(/if tool_name == "([^"]+)":/g)) {
    names.add(match[1]);
  }
  if (/if tool_name\.startswith\("rl_"\):/.test(displaySource)) {
    names.add('rl_');
  }
  return names;
}

test('cleanResponse suppresses leaked banner summary rows audited from Hermes banner.py', sourceAuditOptions, () => {
  const bannerSource = readHermesSourceFile('hermes_cli', 'banner.py');
  assert.match(bannerSource, /Available Tools/);
  assert.match(bannerSource, /MCP Servers/);
  assert.match(bannerSource, /Available Skills/);
  assert.match(bannerSource, /No skills installed/);
  assert.match(bannerSource, /\/help for commands/);
  assert.match(bannerSource, /commits behind/);

  const parsed = parseHermesOutput(
    [
      'Available Tools',
      'MCP Servers',
      'Available Skills',
      'No skills installed',
      'Profile: scratch',
      '31 tools · 0 skills · /help for commands',
      '⚠ 8 commits behind — run hermes update to update',
      'Parser stayed focused.',
    ].join('\n'),
    '',
  );

  assert.equal(parsed.response, 'Parser stayed focused.');
});

test('parser suppresses CLI boilerplate emitters audited from Hermes cli.py', sourceAuditOptions, () => {
  const cliSource = readHermesSourceFile('cli.py');
  assert.match(cliSource, /Initializing agent\.\.\./);
  assert.match(cliSource, /Resume this session with:/);
  assert.match(cliSource, /session_id:/);
  assert.match(cliSource, /Query:/);
  assert.match(cliSource, /preparing \{tool_name\}/);

  const ts = '2026-01-01T00:00:00Z';
  const parser = createHermesStdoutParser();
  const entries = [
    'Query: verify CLI audit',
    'Initializing agent...',
    '  ┊ 💻 preparing terminal…',
    '╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮',
    'CLI audit stayed focused.',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
    'Resume this session with:',
    '  hermes --resume 20260405_155219_11945e',
    '  hermes -c "CLI audit"',
    'session_id: SESSION_ID',
  ].flatMap((line) => parser.parseLine(line, ts));

  assert.deepEqual(entries, [
    { kind: 'assistant', ts, text: 'CLI audit stayed focused.' },
  ]);
});

test('parser classifies Hermes chat status and failure lines audited from cli.py', sourceAuditOptions, () => {
  const cliSource = readHermesSourceFile('cli.py');
  assert.match(cliSource, /\[@ context:/);
  assert.match(cliSource, /Failed to initialize agent:/);
  assert.match(cliSource, /Session not found:/);
  assert.match(cliSource, /Use a session ID from a previous CLI run/);

  const ts = '2026-01-01T00:00:00Z';
  const parser = createHermesStdoutParser();
  const entries = [
    '[@ context: 2 ref(s), 137 tokens]',
    '⚠ context injection refused for /tmp/secret.txt',
    'Failed to initialize agent: missing config.yaml',
    'Session not found: deadbeef',
    'Use a session ID from a previous CLI run (hermes sessions list).',
  ].flatMap((line) => parser.parseLine(line, ts));

  assert.deepEqual(entries, [
    { kind: 'system', ts, text: '[@ context: 2 ref(s), 137 tokens]' },
    { kind: 'stderr', ts, text: '⚠ context injection refused for /tmp/secret.txt' },
    { kind: 'stderr', ts, text: 'Failed to initialize agent: missing config.yaml' },
    { kind: 'stderr', ts, text: 'Session not found: deadbeef' },
    { kind: 'stderr', ts, text: 'Use a session ID from a previous CLI run (hermes sessions list).' },
  ]);
});

test('parser suppresses non-tty spinner bootstrap lines audited from Hermes display.py', sourceAuditOptions, () => {
  const displaySource = readHermesSourceFile('agent', 'display.py');
  assert.match(displaySource, /\[tool\]\s+\{self\.message\}/);

  const ts = '2026-01-01T00:00:00Z';
  const parser = createHermesStdoutParser();
  const entries = [
    '  [tool] running terminal command',
    '[done] ┊ 💻 $         pwd  0.2s',
    '╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮',
    'Spinner audit stayed focused.',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
  ].flatMap((line) => parser.parseLine(line, ts));

  assert.deepEqual(entries, [
    {
      kind: 'tool_call',
      ts,
      name: 'shell',
      input: { command: 'pwd' },
      toolUseId: entries[0]?.toolUseId,
    },
    {
      kind: 'tool_result',
      ts,
      toolUseId: entries[0]?.toolUseId,
      toolName: 'shell',
      content: 'status: completed\nduration: 0.2s\n\npwd',
      isError: false,
    },
    { kind: 'assistant', ts, text: 'Spinner audit stayed focused.' },
  ]);
});

test('parser covers thinking preview and reasoning box emitters audited from Hermes cli.py', sourceAuditOptions, () => {
  const cliSource = readHermesSourceFile('cli.py');
  assert.match(cliSource, /\[thinking\]/);
  assert.match(cliSource, /Reasoning /);

  const ts = '2026-01-01T00:00:00Z';
  const parser = createHermesStdoutParser();
  const entries = [
    '  [thinking] previewed one line',
    '┌─ Reasoning ─────────────────────────────────────────────────────────────────┐',
    '│ boxed reasoning one                                                        │',
    '│ boxed reasoning two                                                        │',
    '└─────────────────────────────────────────────────────────────────────────────┘',
    '╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮',
    'Reasoning audit stayed focused.',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
  ].flatMap((line) => parser.parseLine(line, ts));

  assert.deepEqual(entries, [
    { kind: 'thinking', ts, text: 'previewed one line' },
    { kind: 'thinking', ts, text: 'boxed reasoning one' },
    { kind: 'thinking', ts, text: 'boxed reasoning two' },
    { kind: 'assistant', ts, text: 'Reasoning audit stayed focused.' },
  ]);
});

test('parser covers Hermes tool failure suffixes audited from display.py', sourceAuditOptions, () => {
  const displaySource = readHermesSourceFile('agent', 'display.py');
  assert.match(displaySource, /\[exit 1\]/);
  assert.match(displaySource, /\[full\]/);
  assert.match(displaySource, /\[error\]/);

  const ts = '2026-01-01T00:00:00Z';
  const exitEntries = parseHermesStdoutLine('┊ 💻 $         exit 7  0.2s [exit 7]', ts);
  assert.equal(exitEntries[1]?.kind, 'tool_result');
  assert.equal(exitEntries[1]?.isError, true);
  assert.match(exitEntries[1]?.content ?? '', /exit_code: 7/);

  const fullEntries = parseHermesStdoutLine('┊ 🧠 memory    +facts: "remember this"  0.1s [full]', ts);
  assert.equal(fullEntries[1]?.kind, 'tool_result');
  assert.equal(fullEntries[1]?.isError, true);
  assert.match(fullEntries[1]?.content ?? '', /status: failed/);

  const errorEntries = parseHermesStdoutLine('┊ 🐍 exec      print("hi")  0.1s [error]', ts);
  assert.equal(errorEntries[1]?.kind, 'tool_result');
  assert.equal(errorEntries[1]?.isError, true);
  assert.match(errorEntries[1]?.content ?? '', /status: failed/);
});

test('parseHermesStdoutLine covers tool preview branches audited from Hermes display.py', sourceAuditOptions, () => {
  const displaySource = readHermesSourceFile('agent', 'display.py');
  const branchNames = extractDisplayBranchToolNames(displaySource);

  for (const branchName of branchNames) {
    assert.ok(SOURCE_TOOL_SAMPLES[branchName], `Missing parser audit samples for Hermes tool branch "${branchName}".`);
  }

  for (const [branchName, samples] of Object.entries(SOURCE_TOOL_SAMPLES)) {
    assert.ok(samples.length > 0, `Expected at least one parser audit sample for "${branchName}".`);
    for (const [line, expectedName] of samples) {
      const entries = parseHermesStdoutLine(line, '2026-01-01T00:00:00Z');
      assert.equal(entries[0]?.kind, 'tool_call', `${branchName}: ${line}`);
      assert.equal(entries[0]?.name, expectedName, `${branchName}: ${line}`);
      assert.equal(entries[1]?.kind, 'tool_result', `${branchName}: ${line}`);
    }
  }
});
