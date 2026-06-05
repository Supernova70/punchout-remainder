#!/bin/bash
# setup_logrotate.sh — Run once on the server to configure log rotation
# Handles PM2 logs and Python cron logs so disk doesn't fill up

set -e

echo "=========================================="
echo "  Setting up Log Rotation"
echo "=========================================="

# ── 1. PM2 built-in log rotate module ────────────────────────────────────────
echo "→ Installing pm2-logrotate..."
pm2 install pm2-logrotate

# Rotate when log hits 10MB
pm2 set pm2-logrotate:max_size 10M

# Keep only last 7 rotated files per log
pm2 set pm2-logrotate:retain 7

# Rotate daily at midnight
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'

# Compress old logs (saves ~80% space)
pm2 set pm2-logrotate:compress true

# Rotate based on size even if cron hasn't fired yet
pm2 set pm2-logrotate:workerInterval 3600

echo "✓ PM2 log rotation configured"
pm2 set pm2-logrotate 2>/dev/null || true

# ── 2. Linux logrotate for Python cron log ───────────────────────────────────
echo "→ Configuring logrotate for cron.log..."

sudo tee /etc/logrotate.d/punchin-auto > /dev/null << 'EOF'
/home/ubuntu/punchin-auto/logs/cron.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0644 ubuntu ubuntu
    size 5M
}
EOF

echo "✓ logrotate config written to /etc/logrotate.d/punchin-auto"

# ── 3. Clean up any existing .wwebjs_cache ───────────────────────────────────
echo "→ Cleaning existing .wwebjs_cache..."
CACHE_DIR="/home/ubuntu/punchout-remainder/.wwebjs_cache"
if [ -d "$CACHE_DIR" ]; then
    CACHE_SIZE=$(du -sh "$CACHE_DIR" | cut -f1)
    echo "   Current cache size: $CACHE_SIZE — removing..."
    rm -rf "$CACHE_DIR"
    echo "✓ Cache cleared"
else
    echo "✓ No cache directory found"
fi

# ── 4. Add a weekly cache cleanup cron (safety net) ──────────────────────────
echo "→ Adding weekly cache cleanup cron..."
EXISTING_CRON=$(crontab -l 2>/dev/null || true)
CLEANUP_ENTRY="0 2 * * 0 rm -rf /home/ubuntu/punchout-remainder/.wwebjs_cache 2>/dev/null; rm -f /home/ubuntu/punchin-auto/logs/cron.log.tmp 2>/dev/null"

if echo "$EXISTING_CRON" | grep -q "wwebjs_cache"; then
    echo "✓ Cleanup cron already exists"
else
    echo "$EXISTING_CRON
# Weekly cleanup: clear WhatsApp media cache every Sunday 2AM
$CLEANUP_ENTRY" | crontab -
    echo "✓ Weekly cleanup cron added (Sun 2:00 AM)"
fi

# ── 5. Summary ────────────────────────────────────────────────────────────────
echo ""
echo "=========================================="
echo "  Done! Log rotation is active."
echo "=========================================="
echo ""
echo "Current disk usage:"
df -h /
echo ""
echo "Log locations:"
echo "  PM2 logs:   ~/.pm2/logs/  (rotate at 10MB, keep 7)"
echo "  Cron log:   ~/punchin-auto/logs/cron.log (rotate at 5MB, keep 7)"
echo "  WA cache:   disabled via downloadMedia:false in bot.js"
echo ""
echo "Check pm2-logrotate config:"
echo "  pm2 conf pm2-logrotate"
echo ""
