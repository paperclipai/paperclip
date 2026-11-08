import { isAbsolute } from "node:path";

/** Standalone source for local, SSH, and sandbox runtimes. No secrets in files. */
export function githubLauncherSource(options: { accountHome?: string; brokerFile?: boolean; interpreterPath?: string } = {}): string {
  if (options.interpreterPath !== undefined && (typeof options.interpreterPath !== "string"
    || !isAbsolute(options.interpreterPath) || /[\s\0]/u.test(options.interpreterPath))) {
    throw new Error("GitHub launcher interpreter must be an absolute path without whitespace");
  }
  return String.raw`#!${options.interpreterPath ?? "/usr/bin/env node"}
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
// A PATH shim can capture this launcher's absolute path and call it again.
// Reject that cycle before resolving another executable or capturing authority.
if (process.env.PAPERCLIP_GITHUB_OPERATION_ACTIVE) {
  process.stderr.write('Paperclip: GitHub launcher_recursion_rejected.\n');
  process.exit(126);
}
const directory = path.dirname(fs.realpathSync(process.argv[1]));
const program = path.basename(process.argv[1]);
const SIGNING_KEYS = '^(commit|tag)\\.gpgsign$|^gpg\\.format$|^gpg\\.ssh\\.allowedsignersfile$|^user\\.signingkey$';
// Without the account's signing policy only commands that never create commits or tags may run.
// Aliases and unknown subcommands can create them, so they are refused too.
const SAFE_WITHOUT_SIGNING = new Set(['add', 'archive', 'blame', 'branch', 'bundle', 'cat-file', 'check-ignore', 'checkout', 'clean',
  'clone', 'config', 'describe', 'diff', 'diff-files', 'fetch', 'for-each-ref', 'grep', 'help', 'init', 'log', 'ls-files', 'ls-remote',
  'ls-tree', 'merge-base', 'mv', 'push', 'remote', 'reset', 'restore', 'rev-list', 'rev-parse', 'rm', 'show', 'show-ref',
  'sparse-checkout', 'status', 'submodule', 'switch', 'symbolic-ref', 'var', 'version', 'worktree', 'write-tree']);
// Finds the subcommand and the options that choose the repository a command runs in, so the
// signing lookup is evaluated in the same context (includeIf rules depend on it).
function parseGitInvocation(args) {
  const lookup = [];
  const valued = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source']);
  const targeting = new Set(['-C', '--git-dir', '--work-tree']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) return { lookup, subcommand: arg };
    if (valued.has(arg)) {
      if (targeting.has(arg) && i + 1 < args.length) lookup.push(arg, args[i + 1]);
      i += 1;
    } else if (/^--(git-dir|work-tree)=/.test(arg)) lookup.push(arg);
  }
  return { lookup, subcommand: '' };
}
const invocation = program === 'git' ? parseGitInvocation(process.argv.slice(2)) : { lookup: [], subcommand: '' };
const originalPath = (process.env.PATH || '').split(path.delimiter).filter(p => {
  try { return fs.realpathSync(p) !== directory; } catch { return true; }
});
const executable = originalPath.map(p => path.join(p, program)).find(p => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
});
if (!['git', 'gh'].includes(program) || !executable) {
  process.stderr.write('Paperclip: requested GitHub command is not installed.\n');
  process.exit(127);
}
const localGitCommands = new Set(['init', 'status', 'add', 'config', 'rev-parse', 'log', 'diff', 'diff-files', 'write-tree', 'show', 'branch', 'checkout', 'switch', 'restore', 'reset', 'rm', 'mv', 'worktree', 'grep', 'blame', 'describe', 'ls-files', 'ls-tree', 'cat-file', 'rev-list', 'merge-base', 'show-ref', 'for-each-ref', 'symbolic-ref', 'check-ignore', 'version', 'help']);
const gitValueOptions = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source'];
const gitFlagOptions = ['-p', '-P', '--paginate', '--no-pager', '--bare', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--no-advice', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs'];
function isLocalGit(args) {
  if (program !== 'git') return false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (gitValueOptions.includes(arg)) { index += 1; continue; }
    if (gitValueOptions.some(option => arg.startsWith(option + '='))) continue;
    if (gitFlagOptions.includes(arg)) continue;
    return arg === '--version' || arg === '--help' || localGitCommands.has(arg);
  }
  return false;
}
async function main() {
  let env = { ...process.env };
${options.brokerFile ? String.raw`
  delete env.PAPERCLIP_API_URL;
  delete env.PAPERCLIP_API_KEY;
  delete env.PAPERCLIP_GITHUB_BRIDGE_TOKEN;
  env.PAPERCLIP_GITHUB_BROKER_URL = '';
  env.PAPERCLIP_GITHUB_BROKER_TOKEN = '';
  try {
    const broker = JSON.parse(fs.readFileSync(path.join(directory, 'broker.json'), 'utf8'));
    if (typeof broker.url === 'string' && typeof broker.token === 'string') {
      env.PAPERCLIP_GITHUB_BROKER_URL = broker.url;
      env.PAPERCLIP_GITHUB_BROKER_TOKEN = broker.token;
    }
  } catch {}
` : ''}
  const diagnostic = (code) => process.stderr.write('Paperclip: GitHub ' + code + '; continuing without managed credentials.\n');
  const configRoot = env.GH_CONFIG_DIR || os.tmpdir();
  // A missing/unwritable scratch directory must not break local Git. The
  // fallback deliberately cannot load the host's gh authentication files.
  let configDirectory = path.join(directory, 'unavailable-gh-config');
  let configReady = false;
  let authorReady = false;
  try {
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    configDirectory = fs.mkdtempSync(path.join(configRoot, 'paperclip-github-operation-'));
    fs.chmodSync(configDirectory, 0o700);
    configReady = true;
    process.once('exit', () => { try { fs.rmSync(configDirectory, { recursive: true, force: true }); } catch {} });
    fs.writeFileSync(path.join(configDirectory, 'gitconfig'), '[user]\n\tname = Paperclip\n\temail = noreply@paperclip.ing\n', { mode: 0o600 });
    authorReady = true;
  } catch { diagnostic('configuration_directory_unavailable'); }
  {
    for (const key of Object.keys(env)) {
      if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_CONFIG_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*)$/.test(key)) delete env[key];
    }
    Object.assign(env, {
      GH_CONFIG_DIR: configDirectory, SSH_AUTH_SOCK: '',
      GIT_CONFIG_GLOBAL: authorReady ? path.join(configDirectory, 'gitconfig') : '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '5', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'git@github.com:',
      GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
      GIT_CONFIG_KEY_3: 'core.askPass', GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'user.useConfigOnly', GIT_CONFIG_VALUE_4: 'true',
    });
    const base = env.PAPERCLIP_GITHUB_BROKER_URL || env.PAPERCLIP_API_URL;
    const askBroker = !isLocalGit(process.argv.slice(2));
    try {
    let response;
    if (askBroker && base && env.PAPERCLIP_GITHUB_BROKER_TOKEN) {
      const url = base.replace(/\/+$/, '').replace(/\/api$/, '') + '/runtime-tools/github/credentials';
      // A slow or restarting control plane must not cost the operation its
      // managed identity, so a failed request is retried before giving up.
      // Busy (409) responses and transport failures keep separate budgets, and
      // the body is read inside the retry so a failed read is retried too.
      let transportFailures = 0, conflicts = 0, result;
      for (;;) {
        try {
          response = await fetch(url, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
            headers: { authorization: 'Bearer ' + (env.PAPERCLIP_GITHUB_BRIDGE_TOKEN || env.PAPERCLIP_API_KEY || env.PAPERCLIP_GITHUB_BROKER_TOKEN),
              'x-paperclip-github-capability': env.PAPERCLIP_GITHUB_BROKER_TOKEN, 'content-type': 'application/json' },
            body: '{}',
          });
          if (response.status === 409 && conflicts < 29) {
            conflicts += 1;
            await response.arrayBuffer();
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
          result = response.ok ? await response.json() : null;
          break;
        } catch (error) {
          transportFailures += 1;
          if (transportFailures >= 3) throw error;
          await new Promise(resolve => setTimeout(resolve, 500 * transportFailures));
        }
      }
      if (!response.ok) {
        diagnostic(response.status === 401 || response.status === 403 ? 'capability_rejected' : 'broker_response_unavailable');
      } else {
      if (result.status === 'unavailable') {
        const reason = typeof result.reason === 'string'
          ? result.reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)
          : 'Check the GitHub connection in Paperclip';
        process.stderr.write('Paperclip: GitHub access unavailable: ' + reason + '. Continuing without GitHub credentials.\n');
      }
      if (result.status === 'available' && configReady) {
        for (const [key, value] of Object.entries(result.env || {})) {
          if (/^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/.test(key) && typeof value === 'string') env[key] = value;
        }
      }
      }
    } else if (askBroker) { diagnostic('capability_missing'); }
    } catch { diagnostic('broker_transport_unavailable'); }
  }
  // Honour the commit-signing configuration of the account that owns this machine, so that
  // enabling managed GitHub credentials never turns signed commits into unsigned ones.
  // Only these non-executable keys are read, from the real account home (adapters may
  // redirect $HOME) and in the repository context of the requested command. They go into a
  // scratch global config, so repository configuration keeps its normal precedence over them.
  let signingUnreadable = false;
  try {
    const gitBinary = program === 'git' ? executable : originalPath.map(p => path.join(p, 'git')).find(p => {
      try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
    });
    const accountHome = ${JSON.stringify(options.accountHome ?? null)} || os.userInfo().homedir;
    if (gitBinary && accountHome) {
      // The marker makes a PATH shim that re-enters this launcher fail fast instead of recursing.
      const lookupEnv = { PATH: originalPath.join(path.delimiter), HOME: accountHome, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', PAPERCLIP_GITHUB_OPERATION_ACTIVE: '1' };
      // Git reads $XDG_CONFIG_HOME/git/config next to ~/.gitconfig; an isolated directory has none.
      if (process.env.XDG_CONFIG_HOME) lookupEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
      const read = spawnSync(gitBinary, [...invocation.lookup, 'config', '--global', '--includes', '--null', '--get-regexp', SIGNING_KEYS],
        { env: lookupEnv, encoding: 'utf8', timeout: 5000 });
      // A lookup that re-enters this launcher through a PATH shim is the recursion cycle itself.
      if (read.status === 126 && /launcher_recursion_rejected/.test(read.stderr || '')) {
        process.stderr.write(read.stderr);
        process.exitCode = 126;
        return;
      }
      if (read.error || (read.status !== 0 && read.status !== 1)) {
        signingUnreadable = true; // status 1 only means that no signing key is configured
      } else if (read.status === 0 && read.stdout) {
        const settings = new Map();
        for (const record of read.stdout.split('\0')) {
          if (!record) continue;
          const at = record.indexOf('\n');
          // A key written without a value is a Git boolean and means true.
          settings.set(at < 0 ? record : record.slice(0, at), at < 0 ? 'true' : record.slice(at + 1));
        }
        for (const key of ['gpg.ssh.allowedsignersfile', 'user.signingkey']) {
          const value = settings.get(key);
          if (value && value.startsWith('~/')) settings.set(key, path.join(accountHome, value.slice(2)));
        }
        // A public-key path relies on ssh-agent, which this launcher deliberately does not
        // inherit; use the matching private key file when it is readable.
        const signingKey = settings.get('user.signingkey');
        if (signingKey && signingKey.endsWith('.pub')) {
          try { fs.accessSync(signingKey.slice(0, -4), fs.constants.R_OK); settings.set('user.signingkey', signingKey.slice(0, -4)); } catch {}
        }
        // OpenPGP keys live under the account's GnuPG home, which a redirected $HOME hides.
        const signs = ['commit.gpgsign', 'tag.gpgsign'].some(key => /^(true|yes|on|1)$/i.test(settings.get(key) || ''));
        const format = settings.get('gpg.format');
        const gnupgHome = path.join(accountHome, '.gnupg');
        if (signs && (!format || format === 'openpgp') && !env.GNUPGHOME && fs.existsSync(gnupgHome)) env.GNUPGHOME = gnupgHome;
        if (!configReady) {
          signingUnreadable = true;
        } else {
          const quote = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
          // Keep the managed default author: this file replaces GIT_CONFIG_GLOBAL, and the settings
          // above carry no user.name or user.email, so the include cannot shadow the account's choice.
          const lines = authorReady ? ['[include]', '\tpath = ' + quote(path.join(configDirectory, 'gitconfig'))] : [];
          for (const [key, value] of settings) {
            const parts = key.split('.');
            const name = parts.pop();
            const section = parts.shift();
            lines.push(parts.length ? '[' + section + ' "' + parts.join('.') + '"]' : '[' + section + ']', '\t' + name + ' = ' + quote(value));
          }
          const file = path.join(configDirectory, 'signing.gitconfig');
          fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
          env.GIT_CONFIG_GLOBAL = file;
        }
      }
    }
  } catch { signingUnreadable = true; }
  if (signingUnreadable) {
    process.stderr.write('Paperclip: the account commit-signing configuration could not be read.\n');
    // A lookup failure is not the same as "no signing configured": never create an unsigned object.
    if (invocation.subcommand && !SAFE_WITHOUT_SIGNING.has(invocation.subcommand)) {
      process.stderr.write('Paperclip: refusing to run git ' + invocation.subcommand + ' without it.\n');
      process.exitCode = 1;
      return;
    }
  }
  // Only this invocation and its children inherit the captured credential.
  env.PAPERCLIP_GITHUB_OPERATION_ACTIVE = '1';
  // Its Git children use the real binary, so steering cannot split a gh operation.
  env.PATH = originalPath.join(path.delimiter);
  // Nested shell aliases must not reload the parent launcher profile and
  // recapture a newer identity. All ordinary descendants stay in this operation.
  env.ZDOTDIR = configDirectory;
  env.BASH_ENV = '/dev/null';
  env.GIT_SSH_COMMAND = 'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes';
  const child = spawn(executable, process.argv.slice(2), { env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.once('error', () => { process.stderr.write('Paperclip: GitHub command could not start.\n'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code === null ? 128 : code; });
}
main().catch(() => { process.stderr.write('Paperclip: GitHub launcher_setup_failed.\n'); process.exitCode = 1; });
`;
}

/** Override inherited credentials even when adapters merge the host environment later. */
export function githubBrokerEnvironment(input: Record<string, unknown>, broker: { url: string; token: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (typeof value === "string") env[key] = value;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PAPERCLIP_GIT_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_COUNT", "PAPERCLIP_GITHUB_OPERATION_ACTIVE"]) env[key] = "";
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) env[key] = "";
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  env.GIT_SSH_COMMAND = "ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes";
  env.SSH_AUTH_SOCK = "";
  env.PAPERCLIP_GITHUB_BROKER_URL = broker.url;
  env.PAPERCLIP_GITHUB_BROKER_TOKEN = broker.token;
  return env;
}
