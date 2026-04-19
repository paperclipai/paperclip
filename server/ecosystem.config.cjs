module.exports = {
  apps: [
    {
      name: "paperclip-server",
      script: "dist/index.js",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 2000,
      kill_timeout: 10000,
      listen_timeout: 30000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
