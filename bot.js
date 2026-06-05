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
  SUNDAY_OFF: true,
  DATA_FILE: './punch_data.json',
  PUNCH_STATUS_FILE: '/home/ubuntu/punchin-auto/status/punch_status.json',
  PUNCH_CONFIG_FILE: '/home/ubuntu/punchin-auto/config.json',
  // Auto punch check times (after punch_action.py runs)
  PUNCH_IN_CHECK_MINUTE: 5,
  PUNCH_IN_CHECK_HOUR: 9,
  PUNCH_OUT_CHECK_MINUTE: 35,
  PUNCH_OUT_CHECK_HOUR: 17,
  // Follow-up times (for manual users who didn't !done)
  PUNCH_IN_FOLLOWUP_MINUTE: 40,
  PUNCH_IN_FOLLOWUP_HOUR: 9,
  PUNCH_OUT_FOLLOWUP_MINUTE: 10,
  PUNCH_OUT_FOLLOWUP_HOUR: 18,
};

// ============================================
// State Management
// ============================================

let client = null;
let groupId = null;
let groupParticipants = [];
let autoPunchUsers = []; // Users with auto-punch configured
let manualUsers = []; // Users who need to punch manually
let currentSessionState = null;
let cronjobs = [];

// ============================================
// Retry Configuration
// ============================================
const RETRY_CONFIG = {
  maxRetries: 5,
  retryDelay: 3000, // 3 seconds between retries
};

let connectionAttempts = 0;

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
// Load Auto-Punch Users from Config
// ============================================

function loadAutoPunchUsers() {
  try {
    if (fs.existsSync(CONFIG.PUNCH_CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG.PUNCH_CONFIG_FILE, 'utf-8'));
      autoPunchUsers = (config.users || []).map(u => ({
        name: u.name,
        whatsapp: u.whatsapp
      }));
      console.log(`✓ Loaded ${autoPunchUsers.length} auto-punch users from config:`);
      autoPunchUsers.forEach(u => console.log(`  • ${u.name} (${u.whatsapp})`));
    }
  } catch (err) {
    console.error('Error loading punch config:', err.message);
  }
}

function categorizeParticipants() {
  const autoPunchNumbers = autoPunchUsers.map(u => u.whatsapp);
  
  manualUsers = groupParticipants
    .filter(id => !autoPunchNumbers.includes(extractNumberFromId(id)))
    .map(id => ({
      id,
      number: extractNumberFromId(id)
    }));

  console.log(`\n✓ Categorized participants:`);
  console.log(`  Auto-punch: ${autoPunchUsers.length} users`);
  console.log(`  Manual (need reminder): ${manualUsers.length} users`);
  manualUsers.forEach(u => console.log(`  • ${u.number}`));
}

// ============================================
// WhatsApp Message Helpers
// ============================================

async function sendMessage(chatId, text, mentions) {
  if (!client) {
    console.log('sendMessage: Client not connected');
    return;
  }
  if (!chatId) {
    console.log('sendMessage: chatId is null');
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

  // ===== PUNCH IN FLOW =====

  // 9:05 AM - Check auto-punch IN results + tag manual users
  const punchInCheckJob = cron.schedule(
    `${CONFIG.PUNCH_IN_CHECK_MINUTE} ${CONFIG.PUNCH_IN_CHECK_HOUR} * * *`,
    async () => {
      if (isSunday() && CONFIG.SUNDAY_OFF) return;
      console.log(`[9:05 AM] Checking punch-in status...`);
      if (!groupId || !client) {
        console.log(`[9:05 AM] Skipped: groupId=${!!groupId}, client=${!!client}`);
        return;
      }

      initializeSessionState('morning');

      // Read the punch status file
      const statusData = readPunchStatus();
      if (statusData && statusData.action === 'in') {
        // Send auto-punch report
        await sendPunchReport(statusData);
      }

      // Send reminder to manual users
      await sendManualReminder('in');
    },
    { timezone: CONFIG.TIMEZONE }
  );
  cronjobs.push(punchInCheckJob);

  // 9:40 AM - Follow-up for manual users who didn't !done
  const punchInFollowupJob = cron.schedule(
    `${CONFIG.PUNCH_IN_FOLLOWUP_MINUTE} ${CONFIG.PUNCH_IN_FOLLOWUP_HOUR} * * *`,
    async () => {
      if (isSunday() && CONFIG.SUNDAY_OFF) return;
      console.log(`[9:40 AM] Sending punch-in follow-up...`);
      if (!groupId || !client || !currentSessionState) {
        console.log(`[Follow-up] Skipped: groupId=${!!groupId}, client=${!!client}, state=${!!currentSessionState}`);
        return;
      }

      const pending = getPendingParticipants();
      if (pending.length === 0) {
        console.log(`[Follow-up] Everyone done, no follow-up needed`);
        return;
      }

      const pendingMentions = pending.map((p) => `@${p.name}`).join(' ');
      const mentions = pending.map((p) => p.id);

      const text = `⏰ *Reminder:* These people still need to punch in:\n\n${pendingMentions}\n\nPlease punch in and reply !done`;

      await sendMessage(groupId, text, mentions);
      currentSessionState.followUpSent = true;
      saveState(currentSessionState);
    },
    { timezone: CONFIG.TIMEZONE }
  );
  cronjobs.push(punchInFollowupJob);

  // ===== PUNCH OUT FLOW =====

  // 5:35 PM - Check auto-punch OUT results + tag manual users
  const punchOutCheckJob = cron.schedule(
    `${CONFIG.PUNCH_OUT_CHECK_MINUTE} ${CONFIG.PUNCH_OUT_CHECK_HOUR} * * *`,
    async () => {
      if (isSunday() && CONFIG.SUNDAY_OFF) return;
      console.log(`[5:35 PM] Checking punch-out status...`);
      if (!groupId || !client) {
        console.log(`[5:35 PM] Skipped: groupId=${!!groupId}, client=${!!client}`);
        return;
      }

      initializeSessionState('evening');

      // Read the punch status file
      const statusData = readPunchStatus();
      if (statusData && statusData.action === 'out') {
        // Send auto-punch report
        await sendPunchReport(statusData);
      }

      // Send reminder to manual users
      await sendManualReminder('out');
    },
    { timezone: CONFIG.TIMEZONE }
  );
  cronjobs.push(punchOutCheckJob);

  // 6:10 PM - Follow-up for manual users who didn't !done
  const punchOutFollowupJob = cron.schedule(
    `${CONFIG.PUNCH_OUT_FOLLOWUP_MINUTE} ${CONFIG.PUNCH_OUT_FOLLOWUP_HOUR} * * *`,
    async () => {
      if (isSunday() && CONFIG.SUNDAY_OFF) return;
      console.log(`[6:10 PM] Sending punch-out follow-up...`);
      if (!groupId || !client || !currentSessionState) {
        console.log(`[Follow-up] Skipped: groupId=${!!groupId}, client=${!!client}, state=${!!currentSessionState}`);
        return;
      }

      const pending = getPendingParticipants();
      if (pending.length === 0) {
        console.log(`[Follow-up] Everyone done, no follow-up needed`);
        return;
      }

      const pendingMentions = pending.map((p) => `@${p.name}`).join(' ');
      const mentions = pending.map((p) => p.id);

      const text = `⏰ *Reminder:* These people still need to punch out:\n\n${pendingMentions}\n\nPlease punch out and reply !done`;

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
        console.log(`[3:00 PM] Skipped: groupId=${!!groupId}, client=${!!client}`);
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

  console.log('✓ Cron jobs scheduled:');
  console.log('  9:05 AM  - Check punch-in + tag manual users');
  console.log('  9:40 AM  - Follow-up for punch-in');
  console.log('  5:35 PM  - Check punch-out + tag manual users');
  console.log('  6:10 PM  - Follow-up for punch-out');
  console.log('  3:00 PM  - Motivational message\n');
}

// ============================================
// Punch Status Helpers
// ============================================

function readPunchStatus() {
  try {
    if (fs.existsSync(CONFIG.PUNCH_STATUS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.PUNCH_STATUS_FILE, 'utf-8'));
      return data;
    }
  } catch (err) {
    console.error('Error reading punch status:', err.message);
  }
  return null;
}

async function sendPunchReport(data) {
  const action = data.action.toUpperCase();
  const results = data.results || [];

  const successUsers = results.filter(r => r.status === 'SUCCESS');
  const alreadyDoneUsers = results.filter(r => r.status === 'ALREADY_DONE');
  const failedUsers = results.filter(r => !['SUCCESS', 'ALREADY_DONE'].includes(r.status));

  let message = `*Auto Punch ${action} Report*\n`;
  message += `Time: ${new Date().toLocaleString('en-IN', { timeZone: CONFIG.TIMEZONE })}\n\n`;

  if (successUsers.length > 0) {
    message += `✅ *Successful (${successUsers.length}):*\n`;
    successUsers.forEach(u => {
      message += `  • ${u.name}`;
      if (u.coordinates) message += ` (${u.coordinates})`;
      message += '\n';
    });
    message += '\n';
  }

  if (alreadyDoneUsers.length > 0) {
    message += `⏭️ *Already Done (${alreadyDoneUsers.length}):*\n`;
    alreadyDoneUsers.forEach(u => {
      message += `  • ${u.name}\n`;
    });
    message += '\n';
  }

  if (failedUsers.length > 0) {
    message += `❌ *Failed (${failedUsers.length}):*\n`;
    failedUsers.forEach(u => {
      message += `  • ${u.name} - ${u.status}`;
      if (u.reason) message += ` (${u.reason})`;
      message += '\n';
    });
    message += '\n';
  }

  const totalProcessed = successUsers.length + alreadyDoneUsers.length;
  message += `_Total: ${totalProcessed}/${results.length} completed_`;

  try {
    await client.sendMessage(groupId, message);
    console.log(`✓ Punch ${action} report sent to group`);
  } catch (err) {
    console.error('Error sending punch report:', err.message);
  }

  // Send DM to each successfully auto-punched user
  for (const result of results) {
    if (result.whatsapp && result.status === 'SUCCESS') {
      const userJid = `${result.whatsapp}@s.whatsapp.net`;
      const userMsg = `Hi ${result.name}! ✅ Your punch ${action} was successful.\nTime: ${new Date().toLocaleString('en-IN', { timeZone: CONFIG.TIMEZONE })}`;
      try {
        await client.sendMessage(userJid, userMsg);
        console.log(`✓ DM sent to ${result.name}`);
      } catch (err) {
        console.error(`Error sending DM to ${result.name}:`, err.message);
      }
    }
  }
}

async function sendManualReminder(action) {
  if (manualUsers.length === 0) {
    console.log('No manual users to remind');
    return;
  }

  const manualMentions = manualUsers.map(u => `@${u.number}`).join(' ');
  const mentions = manualUsers.map(u => u.id);

  const actionText = action === 'in' ? 'punch in' : 'punch out';
  let text = `⏰ *Punch ${action.toUpperCase()} Time!*\n\n`;
  text += `Auto-punch users: Done ✅\n\n`;
  text += `Manual users, please ${actionText} now:\n${manualMentions}\n\n`;
  text += `Reply !done after you ${actionText}`;

  try {
    await client.sendMessage(groupId, text, { mentions });
    console.log(`✓ Manual ${action} reminder sent (tagged ${manualUsers.length} users)`);
  } catch (err) {
    console.error('Error sending manual reminder:', err.message);
  }
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

    // Load auto-punch users and categorize
    loadAutoPunchUsers();
    categorizeParticipants();

    const savedState = loadState();
    if (savedState) {
      const stateDate = new Date(savedState.createdAt);
      const today = new Date();
      const isToday = stateDate.toDateString() === today.toDateString();
      
      if (isToday) {
        currentSessionState = savedState;
        console.log(`\n✓ Loaded previous session state (${savedState.currentSession})`);
      } else {
        console.log(`\n⚠️ Found old session state from ${stateDate.toDateString()}, discarding`);
        saveState(null);
      }
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
  console.log(`  Skip Sundays: ${CONFIG.SUNDAY_OFF}`);
  console.log(`  Punch Status File: ${CONFIG.PUNCH_STATUS_FILE}`);
  console.log(`  Punch Config File: ${CONFIG.PUNCH_CONFIG_FILE}\n`);

  const puppeteerConfig = {
    headless: true,
    protocolTimeout: 120000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-blink-features=AutomationControlled'
    ],
  };

  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: puppeteerConfig,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
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

  client.on('change_state', (state) => {
    console.log('🔄 State Changed:', state);
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Loading Screen: ${percent}% - ${message}`);
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
    connectionAttempts++;
    console.error(`\n❌ Error during initialization (attempt ${connectionAttempts}/${RETRY_CONFIG.maxRetries}):`, err.message);
    
    if (connectionAttempts < RETRY_CONFIG.maxRetries) {
      console.log(`⏳ Retrying in ${RETRY_CONFIG.retryDelay/1000} seconds...\n`);
      setTimeout(() => {
        connectionAttempts = 0;
        connectToWhatsApp();
      }, RETRY_CONFIG.retryDelay);
    } else {
      console.error('❌ Max connection attempts reached. Exiting.');
      process.exit(1);
    }
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
