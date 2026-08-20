// pm2 process definition for the panel itself.
//   pm2 start deploy/ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'devbox-panel',
      cwd: '/home/deploy/devbox-panel',
      script: 'src/server.js',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
        PANEL_BEHIND_PROXY: '1',
        PANEL_CONFIG: '/etc/devbox-panel/panel.config.json',
      },
      // The panel spawns detached children (make, docker logs, tail -F) on purpose:
      // they must survive a panel restart, so pm2 must not try to reap the tree.
      kill_timeout: 5000,
    },
  ],
}
