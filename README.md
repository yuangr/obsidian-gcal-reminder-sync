# GCal Reminder Sync for Obsidian

<p align="center">
  <b>A lightweight, zero-bloat two-way sync & strong reminder plugin between Obsidian tasks and Google Calendar.</b><br>
  <i>Serverless · Powered by native Google Apps Script · Zero note pollution · Guaranteed mobile system-level notifications</i>
</p>

<p align="center">
  <b>English</b> | <a href="./README_zh.md"><b>简体中文</b></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Obsidian-v0.15.0+-purple.svg" alt="Obsidian Version" />
  <img src="https://img.shields.io/badge/Google%20Calendar-API%20Supported-blue.svg" alt="Google Calendar" />
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License" />
</p>

---

## 📖 Why GCal Reminder Sync?

Managing tasks and reminders in Obsidian on mobile devices often suffers from three major pain points:
1. **Unreliable Mobile Alarms**: Once mobile operating systems (Android / iOS) kill or freeze Obsidian in the background, local in-app reminder alarms fail to ring, causing missed meetings and deadlines.
2. **Heavy-handed Note Pollution**: Some existing sync solutions force you to create "a separate markdown file per task", completely ruining your daily notes, outlines, and checklist workflow.
3. **Privacy Concerns with 3rd-Party Clouds**: Transmitting sensitive task data to untrusted third-party servers raises security and privacy risks.

**How This Plugin Solves It**:
- 🎯 **Inline & Minimalist**: Write tasks naturally anywhere in your notes. Add a trigger keyword (e.g., `!gcal`) and it syncs immediately, appending only a clean, hidden comment tag (`<!-- gcal: eventId -->`) at the end of the line. Zero file bloat!
- 🔒 **100% Private & Serverless**: Operates via your own free, personal **Google Apps Script (GAS)** instance. Data travels point-to-point directly between Obsidian and your Google account.
- 🔔 **System-Level Guaranteed Reminders**: Events live directly inside Google Calendar, protected by native Android / iOS system alarm daemons. You get lock screen banners and ringtones even when your phone is locked or Obsidian is closed.
- 🔄 **Full Two-Way Lifecycle**: Supports **instant creation**, **in-place debounced updates**, **auto-cleanup on task completion**, and **pulling updates from Google Calendar**.

---

## ✨ Key Features

- **Inline Trigger Keyword**: Type `!gcal` (customizable) in any task line and press Enter/pause. It pushes to Google Calendar automatically, removes the trigger word, and inserts the event ID comment.
- **Queue-Based Asynchronous Sync Engine**:
  - Freely edit task titles, dates, or times. The plugin updates the existing calendar event in place without recreating it.
  - Built-in debounce and versioned request queue: keystrokes are never lost; newer edits gracefully coalesce if a previous network request is still in-flight.
- **Smart Timestamp Disambiguation & Daytime Fallback**:
  - Supports Obsidian Reminder syntax `(@YYYY-MM-DD HH:mm)`, Tasks plugin syntax (`⏰`, `📅`, `⏳`), and natural date strings.
  - When multiple dates/times exist on a single line, it intelligently isolates the specific timestamp you just edited.
  - **Daytime Alarm for Date-Only Tasks**: Date-only tasks automatically receive a daytime default time (e.g. `09:00`), preventing Google Calendar's default midnight (`00:00`) start from triggering reminders at 23:45 the previous night!
- **Task Completion Auto-Sync**: Checking `- [x]` can automatically delete the event from Google Calendar (or mark it completed/silent).
- **Two-Way Pull**: Pull external edits made on your phone or Google Calendar back into your Obsidian notes with one click.
- **Status Bar Indicator**: Real-time persistent status indicator in the bottom-right corner (Ready / Syncing / Synced / Error).

---

## 🚀 Quick Start Guide (5 Minutes)

The architecture consists of two parts:
1. **Google Apps Script Backend** (Runs free on Google Cloud, no server needed)
2. **Obsidian Plugin** (Runs locally in your vault)

---

### Step 1: Deploy Google Apps Script Backend

1. Open your browser and go to [Google Apps Script](https://script.google.com/home/start) (log in with your Google account).
2. Click **"New project"** in the top left, and rename the project to `GCal-Reminder-Sync`.
3. Clear out the default code in `Code.gs`. Copy and paste the entire content from [`google-apps-script/Code.gs`](./google-apps-script/Code.gs) into the editor.
4. Click the **Save icon (💾)**.
5. In the top-right corner, click **"Deploy" ➔ "New deployment"**.
6. In the configuration modal:
   - Click the gear icon on the left and choose **"Web app"**.
   - **Description**: Enter `v1.0`.
   - **Execute as**: Select **"Me" (your email)**.
   - **Who has access**: Select **"Anyone"** *(Required so Obsidian can communicate via Webhook)*.
7. Click **"Deploy"**.
8. **Authorize Permissions** (First-time setup):
   - In the "Authorization required" popup, click **"Review permissions"** and select your Google account.
   - When the "Google hasn't verified this app" warning appears, click **"Advanced"** (bottom left) ➔ click **"Go to GCal-Reminder-Sync (unsafe)"**.
   - Click **"Allow"**.
9. Once deployed, Google will provide a **Web app URL**, structured as:
   ```text
   https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
   ```
   👉 **Copy and save this URL; you will paste it into the Obsidian plugin settings.**

---

### Step 2: Install Obsidian Plugin

#### Method A: Manual Installation (Recommended)
1. Open your Obsidian vault directory.
2. Navigate to `.obsidian/plugins/` (enable "Show hidden files" in your OS if needed).
3. Create a new folder named `gcal-reminder-sync`.
4. Download the following files from the [latest Release](https://github.com/yuangr/obsidian-gcal-reminder-sync/releases/latest) and place them into `gcal-reminder-sync`:
   - `main.js`
   - `manifest.json`
5. In Obsidian, go to **Settings ➔ Community plugins ➔ Reload plugins**, locate **GCal Reminder Sync**, and toggle it **ON**.

#### Method B: Via BRAT Plugin
1. Install and enable the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat).
2. In BRAT settings, add Beta plugin repository:
   ```text
   yuangr/obsidian-gcal-reminder-sync
   ```

---

### Step 3: Configure Plugin Settings

Go to Obsidian **Settings ➔ Community plugins ➔ GCal Reminder Sync**:

| Setting | Recommended Value | Description |
| :--- | :--- | :--- |
| **Google Apps Script Webhook URL** | Paste your Web app URL | Required. Format: `https://script.google.com/macros/s/.../exec` |
| **Target Calendar Name (Optional)** | `Obsidian Reminders` or empty | Leave empty for your primary default calendar, or specify a custom calendar name |
| **Trigger Keyword** | `!gcal` | Keyword in task lines that triggers calendar event creation |
| **Default Time for Date-Only Tasks** | `09:00` | Fallback time used when a task only has a date without specific hours/minutes |
| **Convert Date-Only to Default Time** | **Enabled** | Eliminates the midnight (00:00) bug where 15-minute reminders ring at 23:45 the previous night |
| **Auto Update on Edit** | **Enabled** | In-place update Google Calendar when you modify task title, date, or time in Obsidian |
| **Edit Debounce Delay (seconds)** | `2.0` | Syncs after pausing typing for 2 seconds to avoid excessive network requests |
| **Sync Immediately on Line Change** | **Enabled** | Triggers sync immediately when moving the cursor to another line |
| **Task Completion Behavior** | **Delete from Calendar** | Cleanly removes the event from Google Calendar when checking `[x]` |
| **Popup Reminder Notice (minutes)** | `15` | Minutes before the event for system popup/alarm reminders (default: 15) |

> 💡 **Connection Test**: Click **"Test Webhook Connection"** at the bottom of the settings tab. A success notice confirms your setup is complete!

---

## 📝 Task Syntax Examples

The plugin supports diverse, flexible task formats:

### 1. Obsidian Reminder Plugin Syntax
```markdown
- [ ] Team weekly sync meeting (@2026-09-20 14:30) !gcal
```

### 2. Obsidian Tasks Plugin Syntax
```markdown
- [ ] Submit quarterly financial review ⏰ 2026-09-21 17:00 📅 2026-09-21 !gcal
```

### 3. Date-Only Tasks (Automatic Daytime Reminder)
```markdown
- [ ] Buy birthday gift for friend 📅 2026-09-22 !gcal
```
*(Automatically scheduled at 09:00 on that day; rings at 08:45 without previous-night false alarms)*

### 4. Plain Natural Language Dates
```markdown
- [ ] Renew driver license 2026-09-23 10:00 !gcal
```

> **After Synchronization**:
> The trigger keyword is automatically replaced by a clean HTML comment containing the event ID:
> `- [ ] Team weekly sync meeting (@2026-09-20 14:30) <!-- gcal: xxxxxxxx@google.com -->`

---

## ❓ Troubleshooting (FAQ)

### Q1: Google shows "Google hasn't verified this app" during authorization?
- **Expected behavior**: This is your own private script running under your personal Google account; it does not need public verification.
- **Solution**: Click **"Advanced"** (bottom left) ➔ **"Go to GCal-Reminder-Sync (unsafe)"** ➔ **"Allow"**. Your data stays 100% inside your personal Google ecosystem.

### Q2: Why did an all-day reminder ring at 23:45 the previous day instead of 15 minutes before?
- **Cause**: In Google Calendar, an all-day event technically starts at 00:00 midnight. A "15-minute before" reminder therefore calculates to 23:45 the night before.
- **Solution**: Enable **"Convert Date-Only to Default Time"** (default `09:00`) in settings. It schedules the event during daytime hours so your reminder sounds at 08:45 AM on the actual day.

### Q3: How to sync across multiple devices (PC / Android / iPhone)?
- Use your preferred vault sync tool (Remotely Save, WebDAV, Git, iCloud, or Obsidian Sync).
- The task line retains `<!-- gcal: eventId -->`. Checking `[x]` or editing on any device will seamlessly update or remove the corresponding Google Calendar event.

---

## 📄 License

This project is licensed under the [MIT License](./LICENSE). Contributions and issues are welcome!