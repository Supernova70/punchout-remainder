# Punchout Reminder Bot

A WhatsApp group reminder bot that sends automated punch-in/out reminders using whatsapp-web.js.

## Features

- ⏰ Automatic punch-in reminders at 9:00 AM
- 🏁 Automatic punch-out reminders at 5:00 PM
- 📋 Follow-up reminders for pending participants (9:30 AM & 5:30 PM)
- 💪 Motivational message at 3:00 PM
- 📝 Bot commands:
  - `!ping` - Test if bot is alive (reacts with 🏓)
  - `!done` - Mark yourself as done (reacts with ✅)
  - `!pending` - Get list of pending participants in DM (reacts with 📋)
- ✅ Emoji reactions to all commands in the group
- ⏯️ Skip Sundays option

## Installation

1. Clone the repository:
```bash
git clone https://github.com/Supernova70/punchout-remainder.git
cd punchout-remainder
```

2. Install dependencies:
```bash
npm install
```

3. Configure the bot in `bot.js`:
```javascript
const CONFIG = {
  GROUP_NAME: 'Your Group Name Here',    // Exact WhatsApp group name
  TIMEZONE: 'Asia/Kolkata',               // Your timezone
  PUNCH_IN_HOUR: 9,                       // 0-23 format
  PUNCH_IN_MINUTE: 0,
  PUNCH_OUT_HOUR: 17,
  PUNCH_OUT_MINUTE: 0,
  FOLLOWUP_DELAY_MINUTES: 30,
  SUNDAY_OFF: true,
  DATA_FILE: './punch_data.json',
};
```

## Running the Bot

1. Start the bot:
```bash
npm start
```

2. Scan the QR code with WhatsApp on your phone when prompted

3. The bot will:
   - Find your group by name
   - Cache all group participants
   - Start listening for commands
   - Send reminders at scheduled times

## Messages Sent

### Punch-In (9:00 AM)
```
⏰ Punch In Time! Guys, please punch in for the day. Reply with !done once you have punched in.

@user1 @user2 @user3
```

### Punch-In Follow-Up (9:30 AM)
```
⏰ Gentle Reminder: The following people still need to punch in: user1, user2. Please punch in and reply !done.

@user1 @user2
```

### Punch-Out (5:00 PM)
```
🏁 Punch Out Time! Guys, please punch out for the day. Reply with !done once you have punched out.

@user1 @user2 @user3
```

### Punch-Out Follow-Up (5:30 PM)
```
⏰ Gentle Reminder: The following people still need to punch out: user1, user2. Please punch out and reply !done.

@user1 @user2
```

### 3 PM Motivational (3:00 PM)
```
💪 Hope your internship is going well! Keep up the great work guys! 🚀

@user1 @user2 @user3
```

## Bot Commands

| Command | Reaction | Response |
|---------|----------|----------|
| `!ping` | 🏓 | "🏓 Pong!" in group |
| `!done` | ✅ | Marks you as done |
| `!pending` | 📋 | DM with pending list |

## Deployment on Server

To run the bot 24/7 on your server:

### Using PM2 (Recommended)
```bash
npm install -g pm2
pm2 start bot.js --name "punchout-bot"
pm2 startup
pm2 save
```

### Using systemd (Linux)
Create `/etc/systemd/system/punchout-bot.service`:
```ini
[Unit]
Description=Punchout Reminder Bot
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/punchout-remainder
ExecStart=/usr/bin/node bot.js
Restart=always

[Install]
WantedBy=multi-user.target
```

Then enable it:
```bash
sudo systemctl enable punchout-bot
sudo systemctl start punchout-bot
```

## File Structure

```
punchout-remainder/
├── bot.js              # Main bot file
├── package.json        # Dependencies
├── package-lock.json
├── .gitignore
├── README.md
├── punch_data.json     # Session state (auto-generated)
└── .wwebjs_auth/       # WhatsApp auth (auto-generated)
```

## Important Notes

⚠️ **WARNING**: Use a spare phone number for this bot! 
- This bot runs on your WhatsApp account
- WhatsApp may restrict or block the account if they detect bot activity
- Always use a dedicated bot account, not your personal account

## Troubleshooting

**Bot not connecting?**
- Check your internet connection
- Make sure the group name in CONFIG matches exactly
- Delete `.wwebjs_auth/` folder and rescan QR code

**Reactions not working?**
- Ensure the message is recent
- Check that you have permission to react in the group

**Messages not sending?**
- Verify the group name is correct
- Check if the bot is muted
- Ensure group participants are loaded (check console output)

## License

ISC

## Support

For issues, create a GitHub issue or contact the maintainer.
