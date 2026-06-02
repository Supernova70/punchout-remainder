const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

// ============================================
// CONFIGURATION - Customize these values
// ============================================
const CONFIG = {
  GROUP_NAME: 'CL Chat',
  TIMEZONE: 'Asia/Kolkata',
  PUNCH_IN_HOUR: 9,
  PUNCH_IN_MINUTE: 0,
  PUNCH_OUT_HOUR: 17,
  PUNCH_OUT_MINUTE: 0,
  FOLLOWUP_DELAY_MINUTES: 30,
  SUNDAY_OFF: true,
  DATA_FILE: './punch_data.json',
};

// ============================================
// State Management
// ============================================

let client = null;
let groupId = null;
let groupParticipants = [];
let currentSessionState = null;
let cronjobs = [];

function loadState() {
  if (fs.existsSync(CONFIG.DATA_FILE)) {
    try {
      const data = fs.readFileSync(CONFIG.DATA_FILE, 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      console.log('Error reading state file, starting fresh:', err.message);
    }
  }
  return null;
}

function saveState(state) {
  try {
    fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Error saving state:', err.message);
  }
}

function initializeSessionState(sessionType) {
  const participants = {};
  groupParticipants.forEach((id) => {
    participants[id] = {
      done: false,
      name: extractNumberFromId(id),
    };
  });

  const state = {
    currentSession: sessionType,
    participants: participants,
    followUpSent: false,
    createdAt: new Date().toISOString(),
  };

  currentSessionState = state;
  saveState(state);
  return state;
}

function markAsDone(id) {
  if (currentSessionState && currentSessionState.participants[id]) {
    currentSessionState.participants[id].done = true;
    saveState(currentSessionState);
    return true;
  }
  return false;
}

function getPendingParticipants() {
  if (!currentSessionState) return [];
  return Object.entries(currentSessionState.participants)
    .filter(([id, info]) => !info.done)
    .map(([id, info]) => ({ id, ...info }));
}

function isSunday() {
  return new Date().getDay() === 0;
}

function extractNumberFromId(id) {
  return id.split('@')[0];
}

// ============================================
// WhatsApp Message Helpers
// ============================================

async function sendMessage(chatId, text, mentions) {
  if (!client) {
    console.log('Client not connected, cannot send message');
    return;
  }
  try {
    await client.sendMessage(chatId, text, { mentions });
    console.log('✓ Message sent to group');
  } catch (err) {
    console.error('Error sending message:', err.message);
  }
}

// ============================================
// Scheduled Cron Jobs
// ============================================

function setupCronJobs() {
  console.log('Setting up cron jobs...');

  cronjobs.forEach((job) => job.stop());
  cronjobs = [];

  // Punch-in reminder
  const punchInJob = cron.schedule(
    `${CONFIG.PUNCH_IN_MINUTE} ${CONFIG.PUNCH_IN_HOUR} * * *`,
    async () => {
      if (isSunday() && CONFIG.SUNDAY_OFF) {
        console.log(`[${CONFIG.PUNCH_IN_HOUR}:${String(CONFIG.PUNCH_IN_MINUTE).padStart(2, '0')}] Sunday - Skipping punch-in reminder`);
        return;
      }
      console.log(`[${CONFIG.PUNCH_IN_HOUR}:${String(CONFIG.PUNCH_IN_MINUTE).padStart(2, '0')}] Sending punch-in reminder`);
      if (!groupId || !client) {
        console.log('Group not found or client disconnected');
        return;
      }

      initializeSessionState('morning');

      const mentionText = groupParticipants
        .map((id) => `@${extractNumberFromId(id)}`)
        .join(' ');

      const text = `⏰ Punch In Time! Guys, please punch in for the day. Reply with !done once you have punched in.\n\n${mentionText}`;

      const mentions = groupParticipants.map((id) => id);
      await sendMessage(groupId, text, mentions);
    },
    { timezone: CONFIG.TIMEZONE }
  );
  cronjobs.push(punchInJob);

  // Punch-in follow-up
  const followUpMinute = (CONFIG.PUNCH_IN_MINUTE + CONFIG.FOLLOWUP_DELAY_MINUTES) % 60;
  const followUpHour = CONFIG.PUNCH_IN_HOUR + Math.floor((CONFIG.PUNCH_IN_MINUTE + CONFIG.FOLLOWUP_DELAY_MINUTES) / 60);

  const punchInFollowupJob = cron.schedule(
    `${followUpMinute} ${followUpHour} * * *`,
    async () => {
      if (isSunday() && CONFIG.SUNDAY_OFF) return;
      console.log(`[Follow-up] Checking for punch-in follow-up`);
      if (!groupId || !client || !currentSessionState || currentSessionState.currentSession !== 'morning') return;

      const pending = getPendingParticipants();
      if (pending.length === 0) {
        console.log(`[Follow-up] Everyone has punched in, no follow-up needed`);
        currentSessionState.followUpSent = true;
        saveState(currentSessionState);
        return;
      }

      const pendingMentions = pending.map((p) => `@${p.name}`).join(' ');
      const pendingNames = pending.map((p) => p.name).join(', ');

      const text = `⏰ Gentle Reminder: The following people still need to punch in: ${pendingNames}. Please punch in and reply !done.\n\n${pendingMentions}`;

      const mentions = pending.map((p) => p.id);
      await sendMessage(groupId, text, mentions);
      currentSessionState.followUpSent = true;
      saveState(currentSessionState);
    },
    { timezone: CONFIG.TIMEZONE }
  );
  cronjobs.push(punchInFollowupJob);

  // Punch-out reminder
  const punchOutJob = cron.schedule(
    `${CONFIG.PUNCH_OUT_MINUTE} ${CONFIG.PUNCH_OUT_HOUR} * * *`,
    async () => {
      if (isSunday() && CONFIG.SUNDAY_OFF) {
        console.log(`[${CONFIG.PUNCH_OUT_HOUR}:${String(CONFIG.PUNCH_OUT_MINUTE).padStart(2, '0')}] Sunday - Skipping punch-out reminder`);
        return;
      }
      console.log(`[${CONFIG.PUNCH_OUT_HOUR}:${String(CONFIG.PUNCH_OUT_MINUTE).padStart(2, '0')}] Sending punch-out reminder`);
      if (!groupId || !client) {
        console.log('Group not found or client disconnected');
        return;
      }

      initializeSessionState('evening');

      const mentionText = groupParticipants
        .map((id) => `@${extractNumberFromId(id)}`)
        .join(' ');

      const text = `🏁 Punch Out Time! Guys, please punch out for the day. Reply with !done once you have punched out.\n\n${mentionText}`;

      const mentions = groupParticipants.map((id) => id);
      await sendMessage(groupId, text, mentions);
    },
    { timezone: CONFIG.TIMEZONE }
  );
  cronjobs.push(punchOutJob);

  // Punch-out follow-up
  const followOutMinute = (CONFIG.PUNCH_OUT_MINUTE + CONFIG.FOLLOWUP_DELAY_MINUTES) % 60;
  const followOutHour = CONFIG.PUNCH_OUT_HOUR + Math.floor((CONFIG.PUNCH_OUT_MINUTE + CONFIG.FOLLOWUP_DELAY_MINUTES) / 60);

  const punchOutFollowupJob = cron.schedule(
    `${followOutMinute} ${followOutHour} * * *`,
    async () => {
      if (isSunday() && CONFIG.SUNDAY_OFF) return;
      console.log(`[Follow-up] Checking for punch-out follow-up`);
      if (!groupId || !client || !currentSessionState || currentSessionState.currentSession !== 'evening') return;

      const pending = getPendingParticipants();
      if (pending.length === 0) {
        console.log(`[Follow-up] Everyone has punched out, no follow-up needed`);
        currentSessionState.followUpSent = true;
        saveState(currentSessionState);
        return;
      }

      const pendingMentions = pending.map((p) => `@${p.name}`).join(' ');
      const pendingNames = pending.map((p) => p.name).join(', ');

      const text = `⏰ Gentle Reminder: The following people still need to punch out: ${pendingNames}. Please punch out and reply !done.\n\n${pendingMentions}`;

      const mentions = pending.map((p) => p.id);
      await sendMessage(groupId, text, mentions);
      currentSessionState.followUpSent = true;
      saveState(currentSessionState);
    },
    { timezone: CONFIG.TIMEZONE }
  );
  cronjobs.push(punchOutFollowupJob);

  // 3 PM Motivational message
  const motivationalJob = cron.schedule(
    `0 15 * * *`,
    async () => {
      if (isSunday() && CONFIG.SUNDAY_OFF) return;
      console.log(`[3:00 PM] Sending motivational message`);
      if (!groupId || !client) {
        console.log('Group not found or client disconnected');
        return;
      }

      const mentionText = groupParticipants
        .map((id) => `@${extractNumberFromId(id)}`)
        .join(' ');

      const text = `💪 Hope your internship is going well! Keep up the great work guys! 🚀\n\n${mentionText}`;

      const mentions = groupParticipants.map((id) => id);
      await sendMessage(groupId, text, mentions);
    },
    { timezone: CONFIG.TIMEZONE }
  );
  cronjobs.push(motivationalJob);

  console.log('✓ Cron jobs scheduled successfully\n');
}

// ============================================
// Find and Cache Group
// ============================================

async function findAndCacheGroup() {
  try {
    const chats = await client.getChats();
    const targetGroup = chats.find(
      (chat) => chat.isGroup && chat.name === CONFIG.GROUP_NAME
    );

    if (!targetGroup) {
      console.log(`❌ Group "${CONFIG.GROUP_NAME}" not found!\n`);
      console.log('Available groups:');
      const groups = chats.filter((chat) => chat.isGroup);
      if (groups.length === 0) {
        console.log('  (No groups found)');
      } else {
        groups.forEach((group) => {
          console.log(`  • ${group.name || 'Unnamed'}`);
        });
      }
      console.log('\nPlease update CONFIG.GROUP_NAME with the exact group name and restart.\n');
      return;
    }

    groupId = targetGroup.id._serialized;
    console.log(`✓ Found group: "${CONFIG.GROUP_NAME}"`);
    console.log(`  Group ID: ${groupId}\n`);

    groupParticipants = targetGroup.participants.map((p) => p.id._serialized);

    console.log(`✓ Cached ${groupParticipants.length} participants:`);
    groupParticipants.forEach((id) => {
      console.log(`  • ${extractNumberFromId(id)}`);
    });

    const savedState = loadState();
    if (savedState) {
      currentSessionState = savedState;
      console.log(`\n✓ Loaded previous session state (${savedState.currentSession})`);
    }

    console.log('\n✓ Bot ready! Cron jobs are active and listening for messages.\n');

    setupMessageListener();
    setupCronJobs();
  } catch (err) {
    console.error('Error finding group:', err.message);
  }
}

// ============================================
// Message Handler
// ============================================

function setupMessageListener() {
  client.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();

      if (!chat.isGroup || chat.id._serialized !== groupId) return;
      if (msg.fromMe) return;

      const text = msg.body;
      const senderId = msg.author || msg.from;

      if (text) {
        console.log(`[${extractNumberFromId(senderId)}] ${text}`);
      }

      const command = text.trim().toLowerCase();

      if (command === '!done') {
        try {
          const messageId = msg.id._serialized;
          await client.sendReaction(messageId, '✅');
          console.log('✓ Reacted to !done with ✅');
        } catch (err) {
          console.error('Error reacting to !done:', err.message);
        }
        if (currentSessionState) {
          const wasMarked = markAsDone(senderId);
          if (wasMarked) {
            console.log(`✓ ${extractNumberFromId(senderId)} marked as done for ${currentSessionState.currentSession} session`);
          }
        }
      }

      if (command === '!ping') {
        try {
          const messageId = msg.id._serialized;
          await client.sendReaction(messageId, '🏓');
          console.log('✓ Reacted to !ping with 🏓');
        } catch (err) {
          console.error('Error reacting to !ping:', err.message);
        }
        await sendMessage(groupId, '🏓 Pong!');
      }

      if (command === '!pending') {
        try {
          const messageId = msg.id._serialized;
          await client.sendReaction(messageId, '📋');
          console.log('✓ Reacted to !pending with 📋');
        } catch (err) {
          console.error('Error reacting to !pending:', err.message);
        }
        if (!currentSessionState) {
          await client.sendMessage(senderId, '⚠️ No active session. Wait for the next punch reminder.');
          return;
        }

        const pending = getPendingParticipants();
        if (pending.length === 0) {
          await client.sendMessage(senderId, '✅ Everyone has completed their punch for this session!');
          return;
        }

        const sessionType = currentSessionState.currentSession === 'morning' ? 'Punch In' : 'Punch Out';
        const lines = pending.map((p, i) => `${i + 1}. ${p.name}`);
        const text = `📋 *Pending ${sessionType}*\nSession: ${currentSessionState.currentSession}\n\n${lines.join('\n')}\n\nTotal pending: ${pending.length}`;

        await client.sendMessage(senderId, text);
      }
    } catch (err) {
      console.error('Error processing message:', err.message);
    }
  });

  console.log('✓ Message listener setup');
}

// ============================================
// Connection Handler
// ============================================

async function connectToWhatsApp() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║     WhatsApp Group Reminder Bot (whatsapp-web.js)    ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  console.log('⚠️  WARNING: Use a SPARE phone number for this bot!');
  console.log(`    This bot will run on your WhatsApp account.\n`);

  console.log(`Configuration:`);
  console.log(`  Group Name: ${CONFIG.GROUP_NAME}`);
  console.log(`  Timezone: ${CONFIG.TIMEZONE}`);
  console.log(`  Punch In: ${CONFIG.PUNCH_IN_HOUR}:${String(CONFIG.PUNCH_IN_MINUTE).padStart(2, '0')}`);
  console.log(`  Punch Out: ${CONFIG.PUNCH_OUT_HOUR}:${String(CONFIG.PUNCH_OUT_MINUTE).padStart(2, '0')}`);
  console.log(`  Follow-up Delay: ${CONFIG.FOLLOWUP_DELAY_MINUTES} minutes`);
  console.log(`  Skip Sundays: ${CONFIG.SUNDAY_OFF}\n`);

  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', (qr) => {
    console.log('📱 Scan this QR code with your WhatsApp phone:\n');
    qrcode.generate(qr, { small: true });
    console.log();
  });

  client.on('authenticated', () => {
    console.log('✓ Authenticated successfully!');
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
  });

  client.on('ready', async () => {
    console.log('\n✓ Connected to WhatsApp!');
    console.log('⏳ Loading chats...\n');
    await findAndCacheGroup();
  });

  client.on('disconnected', (reason) => {
    console.log('\n❌ Disconnected:', reason);
    console.log('⏳ Reconnecting in 5 seconds...\n');
    setTimeout(() => connectToWhatsApp(), 5000);
  });

  try {
    await client.initialize();
  } catch (err) {
    console.error('Fatal error during initialization:', err.message);
    process.exit(1);
  }
}

// ============================================
// Graceful Shutdown
// ============================================

process.on('SIGINT', async () => {
  console.log('\n\n⏹️  Shutting down gracefully...');
  if (currentSessionState) {
    saveState(currentSessionState);
    console.log('✓ State saved to', CONFIG.DATA_FILE);
  }
  cronjobs.forEach((job) => job.stop());
  console.log('✓ Cron jobs stopped');
  if (client) {
    await client.destroy();
    console.log('✓ WhatsApp connection closed');
  }
  console.log('✓ Goodbye!\n');
  process.exit(0);
});

// ============================================
// Main Entry Point
// ============================================

connectToWhatsApp().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
