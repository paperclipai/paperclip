import { isAbsolute } from "node:path";

/** Standalone source for local, SSH, and sandbox runtimes. No secrets in files. */
export function githubLauncherSource(options: { brokerFile?: boolean; interpreterPath?: string } = {}): string {
  if (options.interpreterPath !== undefined && (typeof options.interpreterPath !== "string"
    || !isAbsolute(options.interpreterPath) || /[\s\0]/u.test(options.interpreterPath))) {
    throw new Error("GitHub launcher interpreter must be an absolute path without whitespace");
  }
  return String.raw`#!${options.interpreterPath ?? "/usr/bin/env node"}
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
// A PATH shim can capture this launcher's absolute path and call it again.
// Reject that cycle before resolving another executable or capturing authority.
if (process.env.PAPERCLIP_GITHUB_OPERATION_ACTIVE) {
  process.stderr.write('Paperclip: GitHub launcher_recursion_rejected.\n');
  process.exit(126);
}
const directory = path.dirname(fs.realpathSync(process.argv[1]));
const program = path.basename(process.argv[1]);
const originalPath = (process.env.PATH || '').split(path.delimiter).filter(p => {
  // Empty, relative and "." entries would resolve the tool against the working
  // directory, which lets a planted binary run with the managed environment.
  if (process.platform === 'win32' ? !path.win32.isAbsolute(p) : !path.isAbsolute(p)) return false;
  try { return fs.realpathSync(p) !== directory; } catch { return true; }
});
// Search PATH directories first and PATHEXT entries second, as on Windows.
const extensions = process.platform === 'win32'
  ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(ext => /^\.[a-z0-9]+$/i.test(ext))
  : [''];
const executable = originalPath.flatMap(p => extensions.map(ext => path.join(p, program + ext))).find(p => {
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
// With a Paperclip GitHub connection, repositories are created and forked
// through its tools so access rules, approvals, owner defaults and audit apply.
const connectorRepositoryTools = new Map([['create', 'create_repository'], ['new', 'create_repository'], ['fork', 'fork_repository']]);
function connectorRepositoryTool(args) {
  if (program !== 'gh' || args[0] !== 'repo' || args.includes('--help') || args.includes('-h')) return null;
  return connectorRepositoryTools.get(args[1]) || null;
}
// Node refuses to spawn .bat/.cmd files directly on Windows (EINVAL since the
// CVE-2024-27980 fix), so batch tools run through cmd.exe with every argument
// quoted and caret-escaped twice: once for cmd's /c parse, once for the batch
// file's own %* re-parse. Line breaks and NUL cannot cross cmd.exe intact, so
// such arguments are refused instead of being reinterpreted. Note that a batch
// file which enables cmd's delayed expansion can still expand !VAR! itself; that
// is inherent to batch and outside the launcher's control.
const cmdMeta = /([()\][%!^"\x60<>&|;, *?])/g;
function cmdQuote(arg) {
  let quoted = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  quoted = ('"' + quoted + '"').replace(cmdMeta, '^$1');
  return quoted.replace(cmdMeta, '^$1');
}
function spawnResolved(file, args, env) {
  if (process.platform !== 'win32' || !/\.(bat|cmd)$/i.test(file)) {
    return spawn(file, args, { env, stdio: 'inherit' });
  }
  if (args.some(arg => /[\r\n\0]/.test(arg))) {
    process.stderr.write('Paperclip: GitHub batch_argument_rejected; line breaks cannot be passed to a batch file.\n');
    process.exitCode = 1;
    return null;
  }
  // A relative or empty SystemRoot would resolve cmd.exe against the working directory.
  const root = [env.SystemRoot, env.SYSTEMROOT].find(value => value && path.win32.isAbsolute(value)) || 'C:\\Windows';
  const shell = path.win32.join(root, 'System32', 'cmd.exe');
  const line = [file.replace(cmdMeta, '^$1'), ...args.map(cmdQuote)].join(' ');
  // cmd.exe truncates command lines past 8191 characters; fail explicitly instead.
  if (line.length + 2 > 8191) {
    process.stderr.write('Paperclip: GitHub batch_command_too_long; the arguments exceed the cmd.exe line limit.\n');
    process.exitCode = 1;
    return null;
  }
  return spawn(shell, ['/d', '/s', '/v:off', '/c', '"' + line + '"'], { env, stdio: 'inherit', windowsVerbatimArguments: true });
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
  let connected = false;
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
      if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_CONFIG_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*)$/i.test(key)) delete env[key];
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
      connected = result.status === 'available';
      if (result.status === 'available' && configReady) {
        for (const [key, value] of Object.entries(result.env || {})) {
          if (/^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/.test(key) && typeof value === 'string') env[key] = value;
        }
      }
      }
    } else if (askBroker) { diagnostic('capability_missing'); }
    } catch { diagnostic('broker_transport_unavailable'); }
  }
  const connectorTool = connected ? connectorRepositoryTool(process.argv.slice(2)) : null;
  if (connectorTool) {
    process.stderr.write("Paperclip: use the GitHub connection's " + connectorTool + " tool instead of gh repo " + process.argv[3] +
      ", so the connection's access rules apply. " + (connectorTool === 'fork_repository'
        ? 'Then clone the fork or add it as a git remote.' : 'Then add the repository as a git remote and push.') + '\n');
    process.exitCode = 1;
    return;
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
  const child = spawnResolved(executable, process.argv.slice(2), env);
  if (!child) return;
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
  // Windows environment names are case-insensitive, so gh_token reaches a child as GH_TOKEN.
  const credential = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_CONFIG_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*|PAPERCLIP_GITHUB_OPERATION_ACTIVE)$/i;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && !(credential.test(key) && key !== key.toUpperCase())) env[key] = value;
  }
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
