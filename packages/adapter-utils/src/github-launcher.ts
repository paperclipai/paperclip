import { isAbsolute } from "node:path";

/** Standalone source for local, SSH, and sandbox runtimes. No secrets in files. */
export function githubLauncherSource(options: { brokerFile?: boolean; interpreterPath?: string; hostGitHub?: boolean; requireGitHubConnection?: boolean } = {}): string {
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
// With a Paperclip GitHub connection, repositories are created and forked
// through its tools so access rules, approvals, owner defaults and audit apply.
const connectorRepositoryTools = new Map([['create', 'create_repository'], ['new', 'create_repository'], ['fork', 'fork_repository']]);
function connectorRepositoryTool(args) {
  if (program !== 'gh' || args[0] !== 'repo' || args.includes('--help') || args.includes('-h')) return null;
  return connectorRepositoryTools.get(args[1]) || null;
}
// Resolve only common network operations. Unrecognized Azure remotes fail closed
// because the isolated environment has no ambient credential helper.
function azureRemote(args, env) {
  if (program !== 'git' || isLocalGit(args)) return null;
  const globalOptions = [];
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    if (gitValueOptions.includes(args[index]) && args[index + 1]) { globalOptions.push(args[index], args[index + 1]); index += 2; continue; }
    if (gitValueOptions.some(option => args[index].startsWith(option + '=')) || /^-[Cc].+/.test(args[index]) || gitFlagOptions.includes(args[index])) globalOptions.push(args[index]);
    index++;
  }
  const command = args[index++];
  const remaining = args.slice(index);
  const isAzure = value => {
    let host = '';
    try { host = new URL(value).hostname.toLowerCase().replace(/\.+$/, ''); }
    catch { host = (/^(?:[^@/:\s]+@)?([^/:\s]+):/.exec(value) || [])[1]?.toLowerCase().replace(/\.+$/, '') || ''; }
    return host === 'dev.azure.com' || host === 'ssh.dev.azure.com' || host === 'visualstudio.com' || host.endsWith('.visualstudio.com');
  };
  const explicit = remaining.map(arg => arg.startsWith('--') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg).find(isAzure);
  if (explicit) return explicit;
  const remoteIndex = remaining.indexOf('--remote');
  const destination = remaining.find(arg => arg.startsWith('--remote='))?.slice('--remote='.length) ||
    (remoteIndex >= 0 ? remaining[remoteIndex + 1] : undefined) || remaining.find(arg => !arg.startsWith('-'));
  const explicitOther = destination && /^(?:[a-z][a-z0-9+.-]*:\/\/|[^@/\s]+@[^/:\s]+:|\/|\.\.?\/|[^\s-][^\s]*\/)/i.test(destination) ? destination : null;
  if (explicitOther) {
    if (command === 'push') {
      const rewrites = spawnSync(executable, [...globalOptions, 'config', '--get-regexp', '^url\\..*\\.pushinsteadof$'], {
        env, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true,
      });
      if (rewrites.status !== 1) return 'paperclip:unresolved-git-remote';
    }
    const expanded = spawnSync(executable, [...globalOptions, 'ls-remote', '--get-url', '--', explicitOther], {
      env, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true,
    });
    if (expanded.status !== 0 || !String(expanded.stdout || '').trim()) return 'paperclip:unresolved-git-remote';
    const target = String(expanded.stdout).trim();
    return isAzure(target) ? target : null;
  }
  if (!['clone', 'fetch', 'pull', 'push', 'ls-remote', 'archive'].includes(command)) return null;
  if (command === 'archive' && !remaining.some(arg => arg === '--remote' || arg.startsWith('--remote='))) return null;
  if (command === 'clone') return null;
  // Remote names cannot contain options or control characters. Git determines
  // the configured URL without running a shell or consulting credential helpers.
  const remoteOption = remaining.indexOf('--remote');
  const namedRemote = remaining.find(arg => arg.startsWith('--remote='))?.slice('--remote='.length) || (remoteOption >= 0 ? remaining[remoteOption + 1] : undefined);
  let remote = namedRemote || remaining.find(arg => !arg.startsWith('-') && /^[A-Za-z0-9_.-]+$/.test(arg));
  if (!remote && ['fetch', 'pull', 'push'].includes(command)) {
    const readGit = extra => {
      const result = spawnSync(executable, [...globalOptions, ...extra], { env, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true });
      return result.status === 0 ? String(result.stdout || '').trim() : '';
    };
    const branch = readGit(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const configured = key => readGit(['config', '--get', key]);
    if (command === 'fetch' && readGit(['config', '--bool', '--get', 'fetch.all']) === 'true') return 'paperclip:unresolved-git-remote';
    remote = (command === 'push' && branch ? configured('branch.' + branch + '.pushRemote') : '') ||
      (command === 'push' ? configured('remote.pushDefault') : '') ||
      (branch ? configured('branch.' + branch + '.remote') : '') || 'origin';
  }
  if (!remote || !/^[A-Za-z0-9_.-]+$/.test(remote) || remote === '.') return 'paperclip:unresolved-git-remote';
  const lookup = spawnSync(executable, [...globalOptions, 'remote', 'get-url', ...(command === 'push' ? ['--push', '--all'] : []), '--', remote], {
    env, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true,
  });
  const value = lookup.status === 0 ? String(lookup.stdout || '').trim() : '';
  if (!value) return 'paperclip:unresolved-git-remote';
  const destinations = value.split(/\r?\n/).filter(Boolean);
  if (destinations.length !== 1) return 'paperclip:unresolved-git-remote';
  return isAzure(destinations[0]) ? destinations[0] : null;
}
// Project-backed GitHub operations fail closed when the broker is unavailable.
function requiresGitHubConnection(args, env) {
  if (!${options.requireGitHubConnection ? 'true' : 'false'}) return false;
  if (program === 'gh') return !args.some(arg => ['--version', '--help', '-h'].includes(arg));
  if (isLocalGit(args)) return false;
  const options = [];
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (gitValueOptions.includes(args[i]) && args[i + 1]) { options.push(args[i], args[i + 1]); i += 2; continue; }
    if (gitValueOptions.some(option => args[i].startsWith(option + '=')) || /^-[Cc].+/.test(args[i]) || gitFlagOptions.includes(args[i])) options.push(args[i]);
    i++;
  }
  const command = args[i++], rest = args.slice(i);
  if (command === 'archive' && !rest.some(arg => arg === '--remote' || arg.startsWith('--remote='))) return false;
  if (['commit', 'tag', 'stash', 'rebase', 'merge', 'cherry-pick', 'revert'].includes(command) ||
      (command === 'remote' && !rest.includes('update'))) return false;
  const host = value => { try { return new URL(value).hostname.toLowerCase().replace(/\.+$/, ''); }
    catch { return (/^(?:[^@/:\s]+@)?([^/:\s]+):/.exec(value) || [])[1]?.toLowerCase().replace(/\.+$/, '') || ''; } };
  const explicit = rest.map(arg => arg.startsWith('--') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg)
    .find(arg => /^(?:[a-z][a-z0-9+.-]*:\/\/|[^@/:\s]+@[^/:\s]+:)/i.test(arg));
  if (explicit) return ['github.com', 'www.github.com'].includes(host(explicit));
  if (['fetch', 'pull', 'push', 'archive', 'ls-remote'].includes(command)) {
    if (rest.includes('--all') || rest.includes('--multiple')) return true;
    const remoteIndex = rest.indexOf('--remote');
    const remote = rest.find(arg => arg.startsWith('--remote='))?.slice('--remote='.length) ||
      (remoteIndex >= 0 ? rest[remoteIndex + 1] : undefined) ||
      rest.find(arg => !arg.startsWith('-') && /^[A-Za-z0-9_.-]+$/.test(arg)) || 'origin';
    const lookup = spawnSync(executable, [...options, 'remote', 'get-url', ...(command === 'push' ? ['--push'] : []), '--', remote],
      { env, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true });
    if (lookup.status !== 0) return true;
    return ['github.com', 'www.github.com'].includes(host(String(lookup.stdout || '').trim()));
  }
  return command !== 'clone' && command !== 'ls-remote';
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
${options.hostGitHub ? String.raw`
  // This mode is selected by the controller when staging the launcher, not by
  // an agent-controlled environment variable. Azure still requires the broker.
  const hostArgs = process.argv.slice(2);
  if (program === 'git' && (hostArgs.includes('submodule') || (hostArgs.includes('remote') && hostArgs.includes('update')) ||
      (hostArgs.includes('fetch') && (hostArgs.includes('--all') || hostArgs.includes('--multiple'))))) {
    process.stderr.write('Paperclip: select one repository for this Git operation.\n');
    process.exit(1);
  }
  if (!azureRemote(process.argv.slice(2), env) && !requiresGitHubConnection(process.argv.slice(2), env)) {
    delete env.PAPERCLIP_GITHUB_BROKER_TOKEN;
    delete env.PAPERCLIP_GITHUB_BRIDGE_TOKEN;
    env.PATH = originalPath.join(path.delimiter);
    const child = spawn(executable, process.argv.slice(2), { env, stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
    child.once('error', () => { process.stderr.write('Paperclip: Git command could not start.\n'); process.exitCode = 1; });
    child.once('exit', (code, signal) => { process.exitCode = code === null ? 128 : code; });
    return;
  }
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
      if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|PAPERCLIP_AZURE_GIT_.*|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_CONFIG_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*)$/.test(key)) delete env[key];
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
    const repositoryUrl = askBroker ? azureRemote(process.argv.slice(2), env) : null;
    const strictGitHub = askBroker && !repositoryUrl && requiresGitHubConnection(process.argv.slice(2), env);
    try {
    let response;
    if (askBroker && base && env.PAPERCLIP_GITHUB_BROKER_TOKEN) {
      const url = base.replace(/\/+$/, '').replace(/\/api$/, '') + (repositoryUrl ? '/runtime-tools/git/credentials' : '/runtime-tools/github/credentials');
      // A slow or restarting control plane must not cost the operation its
      // managed identity, so a failed request is retried before giving up.
      // Busy (409) responses and transport failures keep separate budgets, and
      // the body is read inside the retry so a failed read is retried too.
      let transportFailures = 0, conflicts = 0, result;
      for (;;) {
        try {
          response = await fetch(url, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(strictGitHub ? 45000 : 10000),
            headers: { authorization: 'Bearer ' + (env.PAPERCLIP_GITHUB_BRIDGE_TOKEN || env.PAPERCLIP_API_KEY || env.PAPERCLIP_GITHUB_BROKER_TOKEN),
              'x-paperclip-github-capability': env.PAPERCLIP_GITHUB_BROKER_TOKEN, 'content-type': 'application/json' },
            body: repositoryUrl ? JSON.stringify({ repositoryUrl }) : '{}',
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
        if (strictGitHub) { process.stderr.write('Paperclip: GitHub repository authorization unavailable.\n'); process.exit(1); }
        if (repositoryUrl) { process.stderr.write('Paperclip: Azure DevOps repository authorization unavailable.\n'); process.exit(1); }
        diagnostic(response.status === 401 || response.status === 403 ? 'capability_rejected' : 'broker_response_unavailable');
      } else {
      if (strictGitHub && (result.status !== 'available' || !configReady || !(result.env?.PAPERCLIP_GIT_TOKEN || result.env?.GH_TOKEN || result.env?.GITHUB_TOKEN))) { process.stderr.write('Paperclip: GitHub repository authorization unavailable.\n'); process.exit(1); }
      if (result.status === 'unavailable') {
        if (repositoryUrl) { process.stderr.write('Paperclip: Azure DevOps repository authorization unavailable.\n'); process.exit(1); }
        const reason = typeof result.reason === 'string'
          ? result.reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)
          : 'Check the GitHub connection in Paperclip';
        process.stderr.write('Paperclip: GitHub access unavailable: ' + reason + '. Continuing without GitHub credentials.\n');
      }
      connected = result.status === 'available';
      if (result.status === 'available' && configReady) {
        for (const [key, value] of Object.entries(result.env || {})) {
          if (/^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|PAPERCLIP_AZURE_GIT_(TOKEN|PATH)|GIT_TERMINAL_PROMPT|GIT_CONFIG_NOSYSTEM|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/.test(key) && typeof value === 'string') env[key] = value;
        }
      }
      if (repositoryUrl && (result.status !== 'available' || !configReady)) { process.stderr.write('Paperclip: Azure DevOps repository authorization unavailable.\n'); process.exit(1); }
      }
    } else if (askBroker) { if (repositoryUrl || strictGitHub) process.exit(1); diagnostic('capability_missing'); }
    } catch { if (strictGitHub) { process.stderr.write('Paperclip: GitHub repository authorization unavailable.\n'); process.exit(1); } if (repositoryUrl) { process.stderr.write('Paperclip: Azure DevOps repository authorization unavailable.\n'); process.exit(1); } diagnostic('broker_transport_unavailable'); }
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
  const child = spawn(executable, process.argv.slice(2), { env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.once('error', () => { process.stderr.write('Paperclip: GitHub command could not start.\n'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code === null ? 128 : code; });
}
main().catch(() => { process.stderr.write('Paperclip: GitHub launcher_setup_failed.\n'); process.exitCode = 1; });
`;
}

/** Override inherited credentials even when adapters merge the host environment later. */
export function githubBrokerEnvironment(input: Record<string, unknown>, broker: { url: string; token: string }, options: { preserveHostGitHub?: boolean } = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (typeof value === "string") env[key] = value;
  if (options.preserveHostGitHub) {
    env.PAPERCLIP_GITHUB_OPERATION_ACTIVE = "";
    env.PAPERCLIP_AZURE_GIT_TOKEN = "";
    env.PAPERCLIP_AZURE_GIT_PATH = "";
    env.PAPERCLIP_GITHUB_BROKER_URL = broker.url;
    env.PAPERCLIP_GITHUB_BROKER_TOKEN = broker.token;
    return env;
  }
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PAPERCLIP_GIT_TOKEN", "PAPERCLIP_AZURE_GIT_TOKEN", "PAPERCLIP_AZURE_GIT_PATH", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_COUNT", "PAPERCLIP_GITHUB_OPERATION_ACTIVE"]) env[key] = "";
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
