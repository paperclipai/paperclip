module.exports = {
  apps: [
    {
      name: "paperclip-v2",
      cwd: "./server",
      script: "/opt/homebrew/opt/node@22/bin/node",
      args: "dist/index.js",
      interpreter: "none",
      max_memory_restart: "600M",
      env: {
        PORT: 3050,
        NODE_ENV: "production",
        // UI 빌드 결과물 경로 (서버가 static serve)
        PAPERCLIP_UI_DIR: "../ui/dist",
      },
      // 로그 설정
      error_file: "./logs/paperclip-v2-error.log",
      out_file: "./logs/paperclip-v2-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      // 재시작 정책
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: "10s",
    },
  ],
};
