module.exports = {
  apps: [
    {
      name: 'paperclip',
      script: './start.sh',
      interpreter: 'bash',
      env: {
        DATABASE_URL: 'postgres://paperclip:paperclip@127.0.0.1:5432/paperclip',
        PORT: '3100',
        HOST: '127.0.0.1',
        SERVE_UI: 'true',
        // PAPERCLIP_CORS_ALLOWED_ORIGINS: 'https://your-domain.example.com',
        NODE_ENV: 'production',
      },
      watch: false,
      autorestart: true,
      max_restarts: 5,
      min_uptime: '10s',
    },
  ],
};
