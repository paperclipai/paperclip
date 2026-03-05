module.exports = {
  apps: [
    {
      name: 'paperclip',
      script: '/home/avi/projects/paperclip/start.sh',
      interpreter: 'bash',
      cwd: '/home/avi/projects/paperclip',
      env: {
        DATABASE_URL: 'postgres://paperclip:paperclip@127.0.0.1:5432/paperclip',
        PORT: '3004',
        HOST: '127.0.0.1',
        SERVE_UI: 'true',
        NODE_ENV: 'production',
      },
      watch: false,
      autorestart: true,
      max_restarts: 5,
      min_uptime: '10s',
    },
  ],
};
