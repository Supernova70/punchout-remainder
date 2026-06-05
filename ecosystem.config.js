// ecosystem.config.js — PM2 process definition for the WhatsApp reminder bot
// Usage: pm2 start ecosystem.config.js
//        pm2 save && pm2 startup   (to persist across reboots)

module.exports = {
  apps: [{
    name: 'whatsapp-bot',
    script: 'bot.js',
    cwd: '/home/ubuntu/punchout-remainder',
    instances: 1,
    autorestart: true,
    watch: false,
    // Kill and restart if RSS exceeds 700MB (leaves ~300MB headroom on 1GB RAM + swap)
    max_memory_restart: '700M',
    // Wait 10s between restarts to let Chromium fully exit
    restart_delay: 10000,
    // If the process doesn't stay alive for 30s, count it as a failed restart
    min_uptime: '30s',
    // After 5 consecutive crash-restarts, stop auto-restarting (alert required)
    max_restarts: 5,
    env: {
      NODE_ENV: 'production'
    },
    error_file: '/home/ubuntu/.pm2/logs/whatsapp-bot-error.log',
    out_file: '/home/ubuntu/.pm2/logs/whatsapp-bot-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
