module.exports = {
  apps: [
    {
      name: 'c2c-mediator',
      script: 'pnpm',
      args: 'start',
      interpreter: 'none',
      cwd: __dirname,
      max_memory_restart: '500M',
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
