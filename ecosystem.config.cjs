module.exports = {
  apps: [{
    name: 'paperclip',
    script: 'pnpm',
    args: 'dev:once',
    cwd: '/Users/quanghung/Documents/paperclip',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'development',
      PAPERCLIP_MIGRATION_AUTO_APPLY: 'true',
    },
  }, {
    name: 'cloudflared-paperclip',
    script: '/opt/homebrew/bin/cloudflared',
    args: 'tunnel --config /Users/quanghung/.cloudflared/config.yml run c214bad6-c982-43dd-9b34-68f5925cfa41',
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
  }],
};
