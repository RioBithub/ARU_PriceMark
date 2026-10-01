module.exports = {
  apps: [{
    name: 'aru-pricemark',
    script: './server.js',
    cwd: '/opt/apps/ARU_PriceMark',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: { NODE_ENV: 'production' }
  }]
};
