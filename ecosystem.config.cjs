module.exports = {
  apps: [
    {
      name: "paperclip",
      script: "pnpm",
      args: "dev:once",
      cwd: "/Users/quanghung/Documents/paperclip",
      autorestart: false,
      watch: false,
      max_memory_restart: "0",
      cron_restart: "",
      max_restarts: 0,
      env: {
        NODE_ENV: "development",
      },
    },
    {
      name: "cloudflared-paperclip",
      script: "cloudflared",
      args: "tunnel run paperclip",
      autorestart: true,
      watch: false,
    },
  ],
};
