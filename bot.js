const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

// ============================================
// CONFIGURATION - Customize these values
// ============================================
const CONFIG = {
  GROUP_NAME: 'CL Testing',
  TIMEZONE: 'Asia/Kolkata',
  SUNDAY_OFF: true,
  DATA_FILE: './punch_data.json',
  PUNCH_STATUS_FILE: '/home/ubuntu/punchin-auto/status/punch_status.json',
  PUNCH_CONFIG_FILE: '/home/ubuntu/punchin-auto/config.json',
  // Ignore list: members who should never be tagged or shown in pending
  IGNORE_FILE: './ignore.json',
  // Stale lock file path (Chromium leaves this behind on crash)
  WWEBJS_SESSION_DIR: '/home/ubuntu/punchout-remainder/.wwebjs_auth/session',
  // Auto punch check times (after punch_action.py runs)
  // NOTE: punch_action.py runs sequentially per user (new browser per user).
  // With 4 users × ~2-5 min each = up to 20 min total.
  // Cron fires at 9:00 AM and 9:30 AM; bot checks at 9:15 AM and 9:45 AM
  // to ensure the Python script has finished before the report is sent.
  PUNCH_IN_CHECK_MINUTE: 15,   // was 5  → now 15 to allow 15 min for 4 users
  PUNCH_IN_CHECK_HOUR: 9,
  PUNCH_OUT_CHECK_MINUTE: 45,  // was 35 → now 45 (same reason for punch-out)
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
let botJid = null; // Bug 1 Fix: bot's own JID to exclude from participants
let botIsReady = false; // true once 'ready' fires; prevents loading_screen from killing a live session
let groupParticipants = [];
let participantNames = {}; // JID → display name (fetched from WA contact info)
let participantNumbers = {}; // JID → normalized phone number (Contact.number, reliable even for @lid)
let numberToJid = {};       // normalized phone number → JID (reverse lookup for !done)
let lidToNumber = {};       // @lid JID → real phone number (built at startup from group.participants)
let autoPunchUsers = []; // Users with auto-punch configured
let ignoredNumbers = new Set(); // Numbers that should never be reminded or shown in !pending
let manualUsers = []; // Users who need to punch manually
let currentSessionState = null;
let cronjobs = [];
const startTime = Date.now(); // Track bot uptime for !status

// ============================================
// Retry Configuration
// ============================================
const RETRY_CONFIG = {
  maxRetries: 5,
  retryDelay: 3000, // 3 seconds between retries
};

let connectionAttempts = 0;
let loadingTimeout = null;
let lastLoadingPercent = 0;
let loadingStuckSince = null;

// ============================================
// Problem 1 Fix: Stale Chromium lock file cleanup
// ============================================

function cleanStaleLockFiles() {
  const lockFiles = [
    path.join(CONFIG.WWEBJS_SESSION_DIR, 'SingletonLock'),
    path.join(CONFIG.WWEBJS_SESSION_DIR, 'SingletonCookie'),
    path.join(CONFIG.WWEBJS_SESSION_DIR, 'SingletonSocket'),
  ];

  let cleaned = 0;
  for (const lockPath of lockFiles) {
    try {
      if (fs.existsSync(lockPath)) {
        fs.rmSync(lockPath, { force: true });
        console.log(`🧹 Removed stale lock file: ${path.basename(lockPath)}`);
        cleaned++;
      }
    } catch (err) {
      console.error(`⚠️ Could not remove ${path.basename(lockPath)}: ${err.message}`);
    }
  }
  if (cleaned === 0) {
    console.log('✓ No stale lock files found');
  }
}

// ============================================
// State File Helpers
// ============================================

function loadState() {
  if (fs.existsSync(CONFIG.DATA_FILE)) {
    try {
      const data = fs.readFileSync(CONFIG.DATA_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      // Problem 5 Fix: handle null/empty state gracefully
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
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

// Problem 5 Fix: delete file instead of writing "null"
function clearState() {
  try {
    if (fs.existsSync(CONFIG.DATA_FILE)) {
      fs.unlinkSync(CONFIG.DATA_FILE);
      console.log('✓ Cleared stale state file');
    }
  } catch (err) {
    console.error('Error clearing state file:', err.message);
  }
}

function initializeSessionState(sessionType) {
  // Build lookup sets for fast O(1) membership tests
  const autoPunchNumberSet = new Set(autoPunchUsers.map(u => u.whatsapp));

  const participants = {};
  groupParticipants.forEach((id) => {
    // Bug 1 Fix: skip the bot's own JID so it never appears in the pending list
    if (botJid && id === botJid) return;

    const number = participantNumbers[id] || normalizeNumber(extractNumberFromId(id));
    const isAutoPunch = autoPunchNumberSet.has(number);
    const isIgnored = ignoredNumbers.has(number);

    participants[id] = {
      // Auto-punch and ignored users are pre-marked as done so they never
      // appear in pending lists or follow-up tags.
      done: isAutoPunch || isIgnored,
      isAutoPunch,
      isIgnored,
      // Use the human-readable display name fetched at startup; fall back to number
      name: participantNames[id] || number,
      // Real phone number from Contact.number — used to match !done senders
      number,
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
  console.log(`  [session] initialized '${sessionType}': ${
    Object.values(participants).filter(p => !p.isAutoPunch && !p.isIgnored).length
  } manual users pending, ${
    Object.values(participants).filter(p => p.isAutoPunch).length
  } auto-punch done, ${
    Object.values(participants).filter(p => p.isIgnored).length
  } ignored`);
  return state;
}

// Resolve a sender JID (which can be @c.us, @lid, or carry a device suffix)
// to the participant's real phone number.
//
// IMPORTANT: @lid JIDs (e.g. "258750338314249@lid") contain an opaque LID
// token — NOT a real phone number. Both getContactById(@lid) and
// msg.getContact() incorrectly return the LID token as contact.number.
//
// The ONLY reliable source is the lidToNumber map built at startup from
// group.participants, where each participant has both .id (@c.us) and .lid.
async function resolveSenderNumber(senderId) {
  const isLid = senderId.endsWith('@lid');

  // Primary path for @lid senders: use the pre-built startup map.
  // This is the only API-independent way to get the real phone number.
  if (isLid) {
    if (lidToNumber[senderId]) {
      return lidToNumber[senderId];
    }
    // LID not in map (user joined after startup) — fall through to contact lookup
    // but warn so we know this path was taken.
    console.warn(`⚠️ @lid sender ${senderId} not in lidToNumber map, trying contact API...`);
  }

  // Fast path: @c.us JID already cached during findAndCacheGroup()
  if (!isLid && participantNumbers[senderId]) return participantNumbers[senderId];

  // Slow path: try getContactById (works reliably for @c.us, may fail for @lid)
  try {
    const contact = await client.getContactById(senderId);
    if (contact && contact.number) {
      const num = normalizeNumber(contact.number);
      // Only trust the result if it looks like a real phone number (7+ digits)
      // to avoid caching the LID token itself as the number.
      if (num.length >= 7) {
        participantNumbers[senderId] = num;
        if (!numberToJid[num]) numberToJid[num] = senderId;
        return num;
      }
    }
  } catch (err) {
    console.warn(`⚠️ resolveSenderNumber failed for ${senderId}: ${err.message}`);
  }

  // Last-resort: digits from the JID (safe for @c.us, meaningless for @lid).
  return normalizeNumber(extractNumberFromId(senderId));
}

// Returns:
//   'marked'         → newly marked done
//   'already'        → was already done (ack with 👌 instead of ✅)
//   'not_in_session' → no current session
//
// preResolvedNumber: pass the real phone number already resolved via
// msg.getContact() so we don't have to call getContactById() here
// (getContactById on an @lid JID incorrectly returns the LID token as number).
async function markAsDone(senderId, preResolvedNumber = null) {
  if (!currentSessionState) return 'not_in_session';

  // Prefer the pre-resolved number from msg.getContact() (accurate for @lid).
  // Fall back to our own resolver only if nothing was passed in.
  const number = preResolvedNumber || await resolveSenderNumber(senderId);
  console.log(`  [markAsDone] sender=${senderId} resolved number=${number}`);

  // Search ALL participant entries by their stored phone number.
  // This works regardless of whether the session was keyed by @c.us or @lid JID,
  // because every entry stores the real phone number in .number at init time.
  let matchKey = null;
  for (const key in currentSessionState.participants) {
    if (currentSessionState.participants[key].number === number) {
      matchKey = key;
      break;
    }
  }

  if (matchKey) {
    if (currentSessionState.participants[matchKey].done) {
      console.log(`  [markAsDone] ${number} already done (key=${matchKey})`);
      return 'already';
    }
    currentSessionState.participants[matchKey].done = true;
    saveState(currentSessionState);
    console.log(`  [markAsDone] ✓ marked ${number} done (key=${matchKey})`);
    return 'marked';
  }

  // Number not in session — could be: (a) user joined after session started,
  // or (b) sender resolution failed and 'number' is a LID token / garbage value.
  //
  // SAFETY GUARD: only add a new participant entry if the number looks like a
  // real phone number (7–15 digits) AND is not already tracked under a different
  // key. This prevents a failed @lid resolution from creating a phantom entry
  // that marks itself done while leaving the real participant still pending.
  const looksLikePhone = /^\d{7,15}$/.test(number);
  const alreadyExists = Object.values(currentSessionState.participants)
    .some(p => p.number === number);

  if (!looksLikePhone) {
    // number is probably an unresolved LID token (15+ digits) or null-ish —
    // do NOT create a phantom entry; log and silently ignore.
    console.warn(`  [markAsDone] ⚠️ could not resolve real number for ${senderId} (got '${number}') — not marking done to avoid phantom entry`);
    return 'not_in_session';
  }

  if (alreadyExists) {
    console.log(`  [markAsDone] ${number} found as already-done via duplicate-guard`);
    return 'already';
  }

  // Genuinely new participant (joined after session started) — add & mark done.
  console.log(`  [markAsDone] ${number} not in session, adding as new entry`);
  currentSessionState.participants[senderId] = {
    done: true,
    number,
    name: participantNames[senderId] || number,
  };
  saveState(currentSessionState);
  return 'marked';
}

function getPendingParticipants() {
  if (!currentSessionState) return [];
  return Object.entries(currentSessionState.participants)
    // Triple guard: check done flag, isAutoPunch flag, AND live ignoredNumbers set.
    // The live set check catches cases where state was loaded before ignore.json
    // was read, or where the flag wasn't set on a pre-existing saved entry.
    .filter(([id, info]) => !info.done && !info.isAutoPunch && !info.isIgnored && !ignoredNumbers.has(info.number))
    .map(([id, info]) => ({ id, ...info }));
}

function isSunday() {
  // Bug 6 Fix: use IST-aware day check instead of server local time (EC2 is UTC by default).
  // At UTC midnight, IST is already 5:30 AM — so getDay() on UTC time would wrongly
  // treat the last 30 min of IST Saturday as Sunday.
  const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return nowIST.getDay() === 0;
}

function extractNumberFromId(id) {
  return id.split('@')[0];
}

// Problem 6 Fix: Normalize phone numbers (strip non-digits)
function normalizeNumber(num) {
  return String(num).replace(/\D/g, '');
}

// ============================================
// Load Auto-Punch Users from Config
// ============================================

function loadAutoPunchUsers() {
  autoPunchUsers = [];
  try {
    if (!fs.existsSync(CONFIG.PUNCH_CONFIG_FILE)) {
      console.warn(`⚠️ Auto-punch config not found at ${CONFIG.PUNCH_CONFIG_FILE}`);
      console.warn('   Every group member will be treated as a manual user.');
      return;
    }
    const config = JSON.parse(fs.readFileSync(CONFIG.PUNCH_CONFIG_FILE, 'utf-8'));
    autoPunchUsers = (config.users || []).map(u => ({
      name: u.name,
      whatsapp: normalizeNumber(u.whatsapp),
    }));
    if (autoPunchUsers.length === 0) {
      console.warn('⚠️ Auto-punch config loaded but contains no users.');
      console.warn('   Every group member will be treated as a manual user.');
      return;
    }
    console.log(`✓ Loaded ${autoPunchUsers.length} auto-punch users from config:`);
    autoPunchUsers.forEach(u => console.log(`  • ${u.name} (${u.whatsapp})`));
  } catch (err) {
    console.error('Error loading punch config:', err.message);
  }
}

// ============================================
// Load Ignored Users from ignore.json
// ============================================
// Format: { "numbers": ["918160615190", "917348082840"] }
// Edit the file on the server and restart the bot to apply changes.
// No code deployment needed.

function loadIgnoredUsers() {
  ignoredNumbers = new Set();
  try {
    if (!fs.existsSync(CONFIG.IGNORE_FILE)) {
      console.log(`ℹ️  No ignore.json found at ${CONFIG.IGNORE_FILE} — no users ignored.`);
      console.log('   Create it to silently exclude group members from reminders.');
      return;
    }
    const data = JSON.parse(fs.readFileSync(CONFIG.IGNORE_FILE, 'utf-8'));
    const numbers = data.numbers || data; // support both {"numbers":[...]} and plain array
    if (!Array.isArray(numbers) || numbers.length === 0) {
      console.log('ℹ️  ignore.json is empty — no users ignored.');
      return;
    }
    for (const num of numbers) {
      ignoredNumbers.add(normalizeNumber(String(num)));
    }
    console.log(`✅ Loaded ${ignoredNumbers.size} ignored number(s) from ignore.json:`);
    ignoredNumbers.forEach(n => console.log(`  • ${n}`));
  } catch (err) {
    console.error('Error loading ignore.json:', err.message);
  }
}

function categorizeParticipants() {
  const autoPunchNumbers = autoPunchUsers.map(u => u.whatsapp);

  manualUsers = groupParticipants
    .filter(id => {
      // Problem 6 Fix: normalize WA JID number before comparing
      const normalized = normalizeNumber(extractNumberFromId(id));
      const isAuto = autoPunchNumbers.includes(normalized);
      const isIgnored = ignoredNumbers.has(normalized);
      const tag = isAuto ? 'auto-punch ✅' : isIgnored ? 'ignored 🔇' : 'manual 🖐️';
      console.log(`  [match] ${normalized} → ${tag}`);
      return !isAuto && !isIgnored;
    })
    .map(id => ({
      id,
      number: extractNumberFromId(id),
    }));

  console.log(`\n✓ Categorized participants:`);
  console.log(`  Auto-punch: ${autoPunchUsers.length} users`);
  console.log(`  Ignored:    ${ignoredNumbers.size} users`);
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

  // 9:15 AM - Check auto-punch IN results + tag manual users
  // (was 9:05 AM — extended to 9:15 AM to allow ~15 min for punch_action.py
  //  to process all users sequentially with separate browser instances)
  const punchInCheckJob = cron.schedule(
    `${CONFIG.PUNCH_IN_CHECK_MINUTE} ${CONFIG.PUNCH_IN_CHECK_HOUR} * * *`,
    async () => {
      if (isSunday() && CONFIG.SUNDAY_OFF) return;
      console.log(`[9:15 AM] Checking punch-in status...`);
      if (!groupId || !client) {
        console.log(`[9:15 AM] Skipped: groupId=${!!groupId}, client=${!!client}`);
        return;
      }

      initializeSessionState('morning');

      // Read the punch status file
      const statusData = readPunchStatus();
      if (statusData && statusData.action === 'in') {
        // Pre-mark auto-punched users as done so they don't appear in
        // pending lists or follow-up tags (they're already handled)
        markAutoPunchUsersAsDone(statusData);
        // Send auto-punch report to group
        await sendPunchReport(statusData);
      }

      // Send reminder to manual users only (auto-punch users already marked done)
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

      const pendingMentions = pending.map((p) => `@${extractNumberFromId(p.id)}`).join(' ');
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

  // 5:45 PM - Check auto-punch OUT results + tag manual users
  // (was 5:35 PM — extended to 5:45 PM to allow ~15 min for punch_action.py)
  const punchOutCheckJob = cron.schedule(
    `${CONFIG.PUNCH_OUT_CHECK_MINUTE} ${CONFIG.PUNCH_OUT_CHECK_HOUR} * * *`,
    async () => {
      if (isSunday() && CONFIG.SUNDAY_OFF) return;
      console.log(`[5:45 PM] Checking punch-out status...`);
      if (!groupId || !client) {
        console.log(`[5:45 PM] Skipped: groupId=${!!groupId}, client=${!!client}`);
        return;
      }

      initializeSessionState('evening');

      // Read the punch status file
      const statusData = readPunchStatus();
      if (statusData && statusData.action === 'out') {
        // Pre-mark auto-punched users as done so they don't appear in
        // pending lists or follow-up tags (they're already handled)
        markAutoPunchUsersAsDone(statusData);
        // Send auto-punch report to group
        await sendPunchReport(statusData);
      }

      // Send reminder to manual users only (auto-punch users already marked done)
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

      const pendingMentions = pending.map((p) => `@${extractNumberFromId(p.id)}`).join(' ');
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
  console.log('  9:15 AM  - Check punch-in + tag manual users (was 9:05 AM)');
  console.log('  9:40 AM  - Follow-up for punch-in');
  console.log('  5:45 PM  - Check punch-out + tag manual users (was 5:35 PM)');
  console.log('  6:10 PM  - Follow-up for punch-out');
  console.log('  3:00 PM  - Motivational message\n');
}

// ============================================
// Punch Status Helpers
// ============================================

// Pre-mark auto-punched users as done in the current session state so they:
//   1. Never appear in getPendingParticipants() / !pending list
//   2. Never get tagged in follow-up reminders
//   3. Still appear in the 3PM motivational message (that uses groupParticipants, not pending list)
function markAutoPunchUsersAsDone(statusData) {
  if (!statusData || !currentSessionState) return 0;
  const results = statusData.results || [];
  let markedCount = 0;

  for (const result of results) {
    if (!['SUCCESS', 'ALREADY_DONE'].includes(result.status)) continue;
    if (!result.whatsapp) continue;

    const normalizedWa = normalizeNumber(result.whatsapp);
    // Match by the participant's real phone number (stored on each entry),
    // not by digits inside the JID — JIDs may be @lid format.
    const matchingId = Object.keys(currentSessionState.participants).find(
      id => currentSessionState.participants[id].number === normalizedWa
    );

    if (matchingId) {
      currentSessionState.participants[matchingId].done = true;
      markedCount++;
      console.log(`✓ Pre-marked ${result.name} as done (auto-punch: ${result.status})`);
    } else {
      console.warn(`⚠️ Auto-punch result for ${result.name} (${normalizedWa}) not found in group participants`);
    }
  }

  if (markedCount > 0) saveState(currentSessionState);
  console.log(`✓ ${markedCount} auto-punch user(s) pre-marked as done`);
  return markedCount;
}

function readPunchStatus() {
  try {
    if (fs.existsSync(CONFIG.PUNCH_STATUS_FILE)) {
      const stats = fs.statSync(CONFIG.PUNCH_STATUS_FILE);
      const mtime = new Date(stats.mtime);
      const now = new Date();
      if (now - mtime > 12 * 60 * 60 * 1000) {
        console.log('⚠️ Punch status file is stale, ignoring');
        return null;
      }
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

    const normalizedBotNumber = botJid ? normalizeNumber(extractNumberFromId(botJid)) : null;
    groupParticipants = targetGroup.participants
      .map((p) => p.id._serialized)
      .filter((id) => !normalizedBotNumber || normalizeNumber(extractNumberFromId(id)) !== normalizedBotNumber);

    // Fetch each participant's display name AND real phone number.
    // Also attempt to extract LID from contact._data.lid (Strategy 1).
    console.log(`⏳ Fetching contact info for ${groupParticipants.length} participants...`);
    participantNames = {};
    participantNumbers = {};
    numberToJid = {};
    lidToNumber = {};
    for (const id of groupParticipants) {
      try {
        const contact = await client.getContactById(id);
        const displayName = contact.name || contact.pushname || contact.number || extractNumberFromId(id);
        const number = normalizeNumber(contact.number || extractNumberFromId(id));
        participantNames[id] = displayName;
        participantNumbers[id] = number;
        numberToJid[number] = id;

        // Strategy 1: extract LID from raw contact data if available
        const lidJid = contact._data?.lid?._serialized;
        if (lidJid) {
          lidToNumber[lidJid] = number;
        }
      } catch (_) {
        participantNames[id] = extractNumberFromId(id); // safe fallback
        participantNumbers[id] = normalizeNumber(extractNumberFromId(id));
        numberToJid[participantNumbers[id]] = id;
      }
    }

    // Strategy 2: check raw GroupParticipant._data.lid (different from contact.lid)
    for (const p of targetGroup.participants) {
      const rawLid = p._data?.lid?._serialized || p.lid?._serialized;
      if (rawLid && !lidToNumber[rawLid]) {
        const realNum = normalizeNumber(extractNumberFromId(p.id._serialized));
        if (realNum) lidToNumber[rawLid] = realNum;
      }
    }

    // Strategy 3: Puppeteer — query WhatsApp Web's internal Store.Contact
    // which always has the LID↔phone mapping regardless of whatsapp-web.js version.
    if (Object.keys(lidToNumber).length === 0) {
      console.log('  (Strategies 1 & 2 found no LIDs — trying Puppeteer Store.Contact...)');
      try {
        const groupNumbers = new Set(Object.values(participantNumbers));
        const puppeteerLids = await client.pupPage.evaluate(() => {
          const result = {};
          try {
            // WA Web exposes its contact store at window.Store.Contact
            const contacts = window.Store.Contact.getModelsArray();
            for (const c of contacts) {
              // Each contact has .id (c.us JID) and .lid (lid JID) when migrated
              if (c.lid && c.lid._serialized && c.id && c.id.user) {
                result[c.lid._serialized] = c.id.user;
              }
            }
          } catch (e) { /* Store not available */ }
          return result;
        });
        for (const [lid, phoneUser] of Object.entries(puppeteerLids)) {
          const normalized = normalizeNumber(phoneUser);
          if (groupNumbers.has(normalized)) {
            lidToNumber[lid] = normalized;
          }
        }
      } catch (e) {
        console.warn(`  ⚠️ Puppeteer LID lookup failed: ${e.message}`);
      }
    }

    const lidCount = Object.keys(lidToNumber).length;
    console.log(`✓ Built LID map: ${lidCount} LID → phone number mappings`);
    if (lidCount > 0) {
      Object.entries(lidToNumber).forEach(([lid, num]) => console.log(`  ${lid} → ${num}`));
    } else {
      console.log('  ⚠️ No LID mappings found — @lid senders will fall back to contact API');
    }

    console.log(`✓ Cached ${groupParticipants.length} participants:`);
    groupParticipants.forEach((id) => {
      const name = participantNames[id] || extractNumberFromId(id);
      console.log(`  • ${name} (${extractNumberFromId(id)})`);
    });

    // Load auto-punch users, ignored users, then categorize
    loadAutoPunchUsers();
    loadIgnoredUsers();
    categorizeParticipants();


    const savedState = loadState();
    if (savedState) {
      const stateDateStr = new Date(savedState.createdAt).toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE }).split(',')[0];
      const todayStr = new Date().toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE }).split(',')[0];
      const isToday = stateDateStr === todayStr;

      if (isToday) {
        currentSessionState = savedState;

        // Re-apply ignore/auto-punch flags to the loaded state.
        // The state may have been saved BEFORE ignore.json or config.json was
        // edited, so the flags could be stale. Re-applying here ensures that:
        //   - Newly ignored members are immediately excluded without needing
        //     to delete punch_data.json.
        //   - Newly un-ignored members immediately become pending again.
        const autoPunchNumberSet = new Set(autoPunchUsers.map(u => u.whatsapp));
        let flagsUpdated = 0;
        for (const [id, p] of Object.entries(currentSessionState.participants)) {
          const wasIgnored = !!p.isIgnored;
          const wasAuto = !!p.isAutoPunch;
          p.isIgnored = ignoredNumbers.has(p.number);
          p.isAutoPunch = autoPunchNumberSet.has(p.number);
          // Mark done if ignored or auto-punch; restore pending if no longer either
          if ((p.isIgnored || p.isAutoPunch) && !p.done) {
            p.done = true;
            flagsUpdated++;
          }
          if (wasIgnored !== p.isIgnored || wasAuto !== p.isAutoPunch) flagsUpdated++;
        }
        if (flagsUpdated > 0) saveState(currentSessionState);

        console.log(`\n✓ Loaded previous session state (${savedState.currentSession})`);
      } else {
        console.log(`\n⚠️ Found old session state from ${stateDateStr}, discarding`);
        // Problem 5 Fix: delete the file instead of writing null
        clearState();
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
  // Remove any existing 'message' listener before re-registering.
  // This is safe because we always add exactly one listener here.
  // Using removeAllListeners() instead of a boolean flag means that if
  // 'ready' fires again (e.g. after a page reload triggered by TIMEOUT/CONFLICT
  // reconnect), the listener is cleanly refreshed rather than silently skipped.
  client.removeAllListeners('message');

  client.on('message', async (msg) => {
    try {
      // DEBUG: log every incoming message before any filtering to verify the
      // event listener is actually firing (helps diagnose silent message loss)
      console.log(`[RAW MSG] from=${msg.from} author=${msg.author} body=${msg.body}`);

      const chat = await msg.getChat();

      if (!chat.isGroup || chat.id._serialized !== groupId) return;
      if (msg.fromMe) return;

      // Bug 4 Fix: msg.body is null for stickers, images, voice notes, reactions.
      // .trim() on null throws TypeError — guard early and skip non-text messages.
      const text = msg.body;
      if (!text || !text.trim()) return;

      // Bug 3 Fix: in a group, msg.author is the sender's JID and msg.from is
      // the GROUP's JID. Never fall back to msg.from for DMs.
      const senderIdRaw = msg.author;
      if (!senderIdRaw) {
        console.warn('⚠️ Could not determine senderId (msg.author missing), skipping command');
        return;
      }

      // Fix: Remove device ID from sender JID (e.g., 1234:1@c.us -> 1234@c.us)
      // so it matches the participant ID format.
      const senderId = senderIdRaw.replace(/:\d+@/, '@');
      const isLidSender = senderId.endsWith('@lid');

      // ── Sender resolution ──────────────────────────────────────────────────
      // WhatsApp now uses opaque @lid JIDs in message authors. All contact
      // API methods (getContactById, msg.getContact) return the LID token as
      // contact.number rather than the real phone number.
      //
      // Resolution order (fastest to slowest / most reliable first):
      //   1. lidToNumber cache (populated at startup or lazily on first match)
      //   2. participantNumbers cache (works for legacy @c.us senders)
      //   3. msg._data.notifyName — push name embedded directly in raw message
      //      data, matched against participantNames built at startup. Zero API
      //      calls, works regardless of JID format.
      //   4. msg.getContact() — last resort, may return wrong number for @lid
      // ───────────────────────────────────────────────────────────────────────
      let senderRealNumber = null;
      let resolvedVia = '?';

      // Layer 1: LID cache (fast, populated lazily)
      if (isLidSender && lidToNumber[senderId]) {
        senderRealNumber = lidToNumber[senderId];
        resolvedVia = 'lid-cache';

      // Layer 2: direct @c.us cache
      } else if (!isLidSender && participantNumbers[senderId]) {
        senderRealNumber = participantNumbers[senderId];
        resolvedVia = 'phone-cache';

      } else {
        // Layer 3: notifyName matching — no API call needed.
        // msg._data.notifyName is the sender's WhatsApp push name, embedded in
        // every message at delivery time regardless of JID type.
        //
        // Matching strategy (in order, stops at first match):
        //   a. Exact case-insensitive match          "Sanjay Rohan" == "Sanjay Rohan"
        //   b. notifyName is a first-name prefix     "Sanjay Rohan".startsWith("Sanjay")
        //   c. contact name is prefix of notifyName  "Sanjay".startsWith("Sanjay Rohan") (rare)
        //   d. substring match (last resort)          "Sanjay Rohan".includes("Sanjay")
        const nameMatches = (stored, push) => {
          const s = stored.toLowerCase().trim();
          const p = push.toLowerCase().trim();
          return s === p ||
            s.startsWith(p + ' ') ||
            p.startsWith(s + ' ') ||
            s.includes(p) ||
            p.includes(s);
        };

        const notifyName = msg._data?.notifyName || msg.notifyName;
        console.log(`  [resolve] notifyName=${JSON.stringify(notifyName)} participantNames=${JSON.stringify(Object.values(participantNames))}`);
        if (notifyName) {
          for (const [jid, name] of Object.entries(participantNames)) {
            if (nameMatches(name, notifyName)) {
              senderRealNumber = participantNumbers[jid];
              resolvedVia = `name-match("${notifyName}"→"${name}")`;
              // Cache so future messages from this sender are instant
              if (isLidSender && senderRealNumber) {
                lidToNumber[senderId] = senderRealNumber;
              }
              break;
            }
          }
        }

        // Layer 4: msg.getContact() — may return LID token as number for @lid senders
        if (!senderRealNumber) {
          try {
            const senderContact = await msg.getContact();
            if (senderContact && senderContact.number) {
              const num = normalizeNumber(senderContact.number);
              // Only trust if it matches a known participant (guards against LID token)
              if (numberToJid[num]) {
                senderRealNumber = num;
                resolvedVia = 'getContact';
                if (isLidSender) lidToNumber[senderId] = num;
              } else {
                console.warn(`  [resolve] getContact returned unrecognised number ${num} for ${senderId} — skipping`);
              }
            }
          } catch (e) {
            console.warn(`  [resolve] msg.getContact() failed: ${e.message}`);
          }
        }
      }

      console.log(`[${senderRealNumber || extractNumberFromId(senderId)}] ${text} (via ${resolvedVia})`);

      const command = text.trim().toLowerCase();

      // Bug 5 Fix: use else-if chain so commands are mutually exclusive
      // and intent is clear — no accidental fall-through.
      // Match !done strictly (was .includes() which fired on "!doner", "i'm !done now", etc.)
      if (command === '!done' || command.startsWith('!done ')) {
        const result = await markAsDone(senderId, senderRealNumber);
        if (result === 'marked') {
          try {
            await msg.react('✅');
            console.log('✓ Reacted to !done with ✅');
          } catch (err) {
            console.error('Error reacting to !done:', err.message);
          }
          console.log(`✓ ${extractNumberFromId(senderId)} marked as done for ${currentSessionState.currentSession} session`);
        } else if (result === 'already') {
          // Acknowledge so the user knows their first !done DID register —
          // otherwise they re-type !done thinking it didn't take.
          try {
            await msg.react('👌');
          } catch (err) { /* ignore */ }
          console.log(`  [Ack] ${extractNumberFromId(senderId)} already marked done.`);
        } else {
          // no active session — silently ignore (don't react)
          console.log(`  [Ignore] !done from ${extractNumberFromId(senderId)} — no active session.`);
        }

      } else if (command === '!ping') {
        // !ping → reply in GROUP (intentional — just a liveness check)
        try {
          await msg.react('🏓');
          console.log('✓ Reacted to !ping with 🏓');
        } catch (err) {
          console.error('Error reacting to !ping:', err.message);
        }
        await sendMessage(groupId, '🏓 Pong!');

      } else if (command === '!pending') {
        // React in group so sender sees acknowledgement, then DM the list
        try {
          await msg.react('📋');
          console.log('✓ Reacted to !pending with 📋');
        } catch (err) {
          console.error('Error reacting to !pending:', err.message);
        }

        // Send reply to sender's DM — not the group — to keep chat clean.
        // Fix: use senderId (msg.author) directly as the DM target.
        // Reconstructing '${number}@c.us' breaks for users identified by LID
        // in newer WhatsApp versions, causing 'No LID for user' crash.
        if (!currentSessionState) {
          await client.sendMessage(senderId, '⚠️ No active session right now. Wait for the next punch reminder.');
        } else {
          const pending = getPendingParticipants();
          if (pending.length === 0) {
            await client.sendMessage(senderId, '✅ Everyone has completed their punch for this session!');
          } else {
            const sessionType = currentSessionState.currentSession === 'morning' ? 'Punch In' : 'Punch Out';
            const lines = pending.map((p, i) => `${i + 1}. ${p.name}`);
            const replyText = `📋 *Pending ${sessionType}*\nSession: ${currentSessionState.currentSession}\n\n${lines.join('\n')}\n\nTotal pending: ${pending.length}`;
            await client.sendMessage(senderId, replyText);
          }
        }
        console.log(`✓ !pending result sent as DM to ${extractNumberFromId(senderId)}`);

      } else if (command === '!status') {
        // React in group so sender sees acknowledgement, then DM the status
        try {
          await msg.react('📊');
        } catch (err) {
          console.error('Error reacting to !status:', err.message);
        }

        const uptimeMs = Date.now() - startTime;
        const uptimeHrs = Math.floor(uptimeMs / 3_600_000);
        const uptimeMins = Math.floor((uptimeMs % 3_600_000) / 60_000);
        const uptimeSecs = Math.floor((uptimeMs % 60_000) / 1_000);
        const uptimeStr = `${uptimeHrs}h ${uptimeMins}m ${uptimeSecs}s`;

        const sessionInfo = currentSessionState
          ? `${currentSessionState.currentSession} (started ${new Date(currentSessionState.createdAt).toLocaleTimeString('en-IN', { timeZone: CONFIG.TIMEZONE })})`
          : 'None (between sessions)';

        const pendingList = getPendingParticipants();

        let statusFileInfo = '❌ Not found';
        try {
          if (fs.existsSync(CONFIG.PUNCH_STATUS_FILE)) {
            const stat = fs.statSync(CONFIG.PUNCH_STATUS_FILE);
            const mtime = stat.mtime.toLocaleString('en-IN', { timeZone: CONFIG.TIMEZONE });
            statusFileInfo = `✅ Last updated: ${mtime}`;
          }
        } catch (_) { /* ignore */ }

        const cronStatus = cronjobs.length > 0 ? `✅ ${cronjobs.length} jobs active` : '❌ Not running';

        let statusMsg = `📊 *Bot Status*\n`;
        statusMsg += `━━━━━━━━━━━━━━━━━━━━\n`;
        statusMsg += `🕒 *Uptime:* ${uptimeStr}\n`;
        statusMsg += `📅 *Session:* ${sessionInfo}\n`;
        statusMsg += `👥 *Pending:* ${pendingList.length} participant(s)\n`;
        statusMsg += `📁 *Status file:* ${statusFileInfo}\n`;
        statusMsg += `⚙️ *Cron jobs:* ${cronStatus}\n`;
        statusMsg += `━━━━━━━━━━━━━━━━━━━━\n`;
        statusMsg += `_Next check-in: 9:15 AM | Check-out: 5:45 PM_`;

        // Send reply to sender's DM — not the group — to keep chat clean.
        // Fix: use senderId (msg.author) directly — avoids 'No LID for user' crash.
        await client.sendMessage(senderId, statusMsg);
        console.log(`✓ !status report sent as DM to ${extractNumberFromId(senderId)}`);

      } else if (command === '!reinit' || command.startsWith('!reinit ')) {
        // Emergency admin command: manually initialize a session when the bot
        // loses currentSessionState (e.g. after a spurious restart mid-session).
        // Usage: !reinit evening  OR  !reinit morning
        const parts = text.trim().split(/\s+/);
        const sessionType = parts[1]?.toLowerCase();
        if (sessionType !== 'morning' && sessionType !== 'evening') {
          await client.sendMessage(senderId, '⚠️ Usage: !reinit morning  OR  !reinit evening');
        } else if (!groupParticipants.length) {
          await client.sendMessage(senderId, '❌ Cannot reinit: group not yet cached. Wait for bot to finish loading.');
        } else {
          initializeSessionState(sessionType);
          await msg.react('🔄');
          await client.sendMessage(senderId,
            `✅ Session re-initialized as *${sessionType}*.\n` +
            `Participants reset to pending: ${groupParticipants.length}\n` +
            `Use !pending to verify.`
          );
          console.log(`✓ !reinit: session manually initialized as ${sessionType} by ${extractNumberFromId(senderId)}`);
        }
      }

    } catch (err) {
      console.error('Error processing message:', err.message);
    }
  });

  console.log('✓ Message listener registered');
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

  // Problem 1 Fix: Remove stale Chromium lock files BEFORE creating Client
  console.log('🧹 Cleaning stale lock files...');
  cleanStaleLockFiles();

  // Problem 12 Fix: Gracefully destroy previous client before creating new one
  if (client) {
    console.log('🔄 Destroying previous client instance...');
    try {
      await client.destroy();
    } catch (e) {
      console.log('  (destroy error ignored):', e.message);
    }
    client = null;
    // Give Chromium time to fully exit before spawning a new instance
    await new Promise(r => setTimeout(r, 3000));
    console.log('✓ Previous client destroyed, waiting 3s...');
  }

  // Problem 2 Fix: Increased protocolTimeout to 300000 (5 min)
  // Problem 1 Fix: Added --disable-background-media-suspend
  // Problem 2 Fix: Added --disable-renderer-backgrounding, --disable-ipc-flooding-protection
  const puppeteerConfig = {
    headless: true,
    protocolTimeout: 300000, // was 120000 → now 300000 (5 min)
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
      '--disable-blink-features=AutomationControlled',
      '--disable-features=NetworkService',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-background-media-suspend',    // Problem 1 Fix
      '--disable-renderer-backgrounding',      // Problem 2 Fix
      '--disable-ipc-flooding-protection',     // Problem 2 Fix
    ],
  };

  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: puppeteerConfig,
    // Prevent media (images/videos/memes) from being downloaded to .wwebjs_cache/
    // In a busy group this would fill disk very quickly. We only need text messages.
    downloadMedia: false,
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

  // Bad states where WhatsApp Web's incoming message bridge silently dies:
  //   TIMEOUT  — WA server lost the WebSocket but Chromium page is still alive.
  //              Outbound sends still work (buffered CDP), receives are dead.
  //   CONFLICT — The same WA account was opened elsewhere, invalidating this session.
  // In both cases the 'disconnected' event never fires, so we must act here.
  const BAD_STATES = ['TIMEOUT', 'CONFLICT', 'UNPAIRED', 'UNPAIRED_IDLE'];
  client.on('change_state', (state) => {
    console.log('🔄 WhatsApp state changed:', state);
    if (BAD_STATES.includes(state)) {
      console.warn(`⚠️  Bad state detected: ${state}. Triggering reconnect in 10s...`);
      botIsReady = false;
      // Give WA 10 s to self-recover before forcing a full reconnect
      setTimeout(() => {
        console.log(`🔄 Reconnecting after bad state (${state})...`);
        client.destroy().catch(() => {});
        setTimeout(() => connectToWhatsApp(), 5000);
      }, 10000);
    }
  });

  client.on('loading_screen', (percent, message) => {
    // CRITICAL: Once the bot is fully ready (botIsReady=true), ignore all
    // loading_screen events. WhatsApp Web fires loading_screen AFTER the ready
    // event in many sessions — this is benign and does NOT mean the bot is
    // stuck. Restarting in response would kill a live, healthy session.
    if (botIsReady) {
      console.log(`[loading_screen ignored — bot already ready] ${percent}% - ${message}`);
      return;
    }

    console.log(`⏳ Loading Screen: ${percent}% - ${message}`);

    if (percent === lastLoadingPercent) {
      if (!loadingStuckSince) {
        loadingStuckSince = Date.now();
      } else if (Date.now() - loadingStuckSince > 60000) {
        console.log('⚠️ Loading stuck at same percentage for 60s, restarting...');
        if (loadingTimeout) clearTimeout(loadingTimeout);
        client.destroy().catch(() => {});
        setTimeout(() => connectToWhatsApp(), 5000);
        return;
      }
    } else {
      loadingStuckSince = null;
      lastLoadingPercent = percent;
    }

    if (loadingTimeout) clearTimeout(loadingTimeout);
    loadingTimeout = setTimeout(() => {
      console.log('⚠️ Loading screen timeout (120s), restarting...');
      client.destroy().catch(() => {});
      setTimeout(() => connectToWhatsApp(), 5000);
    }, 120000);
  });

  client.on('ready', async () => {
    botIsReady = true;  // ← Must be set FIRST to block spurious loading_screen events
    if (loadingTimeout) clearTimeout(loadingTimeout);
    loadingStuckSince = null;
    lastLoadingPercent = 0;
    connectionAttempts = 0;
    // Bug 1 Fix: capture the bot's own JID so it can be excluded from participants
    botJid = client.info.wid._serialized;
    console.log(`\n✓ Connected to WhatsApp! (bot JID: ${botJid})`);
    console.log('⏳ Loading chats...\n');
    await findAndCacheGroup();
  });

  client.on('disconnected', (reason) => {
    botIsReady = false;  // ← Allow loading_screen handler to arm restart timer again
    console.log('\n❌ Disconnected:', reason);
    connectionAttempts = 0; // reset so reconnect gets a fresh slate
    participantNames = {}; // clear stale names; will be re-fetched on next ready
    console.log('⏳ Reconnecting in 5 seconds...\n');
    setTimeout(() => connectToWhatsApp(), 5000);
  });

  try {
    await client.initialize();
  } catch (err) {
    connectionAttempts++;
    console.error(`\n❌ Error during initialization (attempt ${connectionAttempts}/${RETRY_CONFIG.maxRetries}):`, err.message);

    if (connectionAttempts < RETRY_CONFIG.maxRetries) {
      console.log(`⏳ Retrying in ${RETRY_CONFIG.retryDelay / 1000} seconds...\n`);
      setTimeout(() => {
        // NOTE: Do NOT reset connectionAttempts here — let it increment until
        // a successful 'ready' event resets it (Problem 3 Fix)
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

process.on('SIGTERM', async () => {
  console.log('\n\n⏹️  SIGTERM received, shutting down...');
  if (currentSessionState) {
    saveState(currentSessionState);
  }
  cronjobs.forEach((job) => job.stop());
  if (client) {
    try { await client.destroy(); } catch (_) {}
  }
  process.exit(0);
});

// ============================================
// Main Entry Point
// ============================================

connectToWhatsApp().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
