module.exports = {
  apps: [
    {
      name: 'paperclip-3100',
      cwd: './server',
      script: './node_modules/tsx/dist/cli.mjs',
      args: 'src/index.ts',
      watch: false,
      env: {
        NODE_ENV: 'development',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '~/.paperclip/instances/default/logs/pm2-error.log',
      out_file: '~/.paperclip/instances/default/logs/pm2-out.log',
    },
  ],
};
