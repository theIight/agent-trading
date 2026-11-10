// pm2: `npm run pm2:start` (build web rồi chạy). MCP `wyckoff` không chạy ở đây — agent tự spawn qua stdio.
// PATH kế thừa từ shell lúc `pm2 start`; nếu không thấy `claude`/`agy`, đặt CLAUDE_BIN/AGY_BIN tuyệt đối trong .env.
module.exports = {
  apps: [
    {
      name: 'wca-server',
      cwd: __dirname,
      script: 'npm',
      args: 'run start -w @wca/server',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 5000,
      time: true,
    },
    {
      name: 'wca-web',
      cwd: __dirname,
      script: 'npm',
      args: 'run preview -w @wca/web',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      time: true,
    },
  ],
};
