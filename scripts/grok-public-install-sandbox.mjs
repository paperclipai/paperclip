// Keep public-package lifecycle code off the verification host. Resolve and
// cache the public npm graph without scripts, then execute it offline.
export const GROK_PUBLIC_INSTALL_IMAGE =
  'node:24-trixie@sha256:be40f6a87b9b22215ddb20da0a2320a5c6d583fe3ee3b0024d9fa4f05b40c8fd';
// Complete the scripts-disabled install without resolving the graph again.
export const GROK_PUBLIC_INSTALL_LIFECYCLE = [
  'npm', 'rebuild', '--offline', '--ignore-scripts=false', '--dangerously-allow-all-scripts',
];

export function grokConsumerDockerArgs({ assets, consumer, cache, command, uid, gid, download = false, prerequisite, temporarySizeMb = 256 }) {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) {
    throw new Error('Public-install verification requires an unprivileged host user');
  }
  if (!Number.isSafeInteger(temporarySizeMb) || temporarySizeMb < 256 || temporarySizeMb > 2048) throw new Error('Invalid bounded public-install temporary size');
  return [
    'run', '--rm', '--platform', 'linux/amd64',
    '--user', `${uid}:${gid}`, '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--memory', '3g',
    '--network', download ? 'bridge' : 'none',
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=${temporarySizeMb}m,mode=1777`,
    '--env', 'HOME=/tmp', '--env', 'npm_config_cache=/cache',
    '--env', 'npm_config_nodedir=/usr/local',
    '--env', 'npm_config_audit=false', '--env', 'npm_config_fund=false',
    '--env', `npm_config_ignore_scripts=${download ? 'true' : 'false'}`,
    '--mount', `type=bind,src=${assets},dst=/packages,readonly`,
    '--mount', `type=bind,src=${consumer},dst=/consumer`,
    '--mount', `type=bind,src=${cache},dst=/cache`,
    ...(prerequisite ? ['--mount', `type=bind,src=${prerequisite},dst=/opt/paperclip/providers/grok/1.0.13/grok,readonly`] : []),
    '--workdir', '/consumer', GROK_PUBLIC_INSTALL_IMAGE, ...command,
  ];
}
