module.exports = {
  apps: [
    {
      name: 'paperclip-3100',
      cwd: '/Users/dev3/Desktop/paperclipai/server',
      script: './node_modules/tsx/dist/cli.mjs',
      args: 'src/index.ts',
      watch: false,
      env: {
        NODE_ENV: 'development',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/Users/dev3/.paperclip/instances/default/logs/pm2-error.log',
      out_file: '/Users/dev3/.paperclip/instances/default/logs/pm2-out.log',
    },
  ],
};
