# GCal Reminder Sync for Obsidian

<p align="center">
  <b>A lightweight, zero-bloat two-way sync & strong reminder plugin between Obsidian tasks and Google Calendar.</b><br>
  <i>Serverless · Powered by native Google Apps Script · Zero note pollution · Guaranteed mobile system-level notifications</i>
</p>

<p align="center">
  <a href="#english"><b>English Documentation</b></a> | <a href="#中文说明"><b>中文说明</b></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Obsidian-v0.15.0+-purple.svg" alt="Obsidian Version" />
  <img src="https://img.shields.io/badge/Google%20Calendar-API%20Supported-blue.svg" alt="Google Calendar" />
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License" />
</p>

---

<a name="english"></a>
## 🇬🇧 English Documentation

### 📖 Why GCal Reminder Sync?

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

### ✨ Key Features

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

### 🚀 Quick Start Guide (5 Minutes)

The architecture consists of two parts:
1. **Google Apps Script Backend** (Runs free on Google Cloud, no server needed)
2. **Obsidian Plugin** (Runs locally in your vault)

---

#### Step 1: Deploy Google Apps Script Backend

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

#### Step 2: Install Obsidian Plugin

##### Method A: Manual Installation (Recommended)
1. Open your Obsidian vault directory.
2. Navigate to `.obsidian/plugins/` (enable "Show hidden files" in your OS if needed).
3. Create a new folder named `gcal-reminder-sync`.
4. Download the following files from the [latest Release](https://github.com/yuangr/obsidian-gcal-reminder-sync/releases/latest) and place them into `gcal-reminder-sync`:
   - `main.js`
   - `manifest.json`
5. In Obsidian, go to **Settings ➔ Community plugins ➔ Reload plugins**, locate **GCal Reminder Sync**, and toggle it **ON**.

##### Method B: Via BRAT Plugin
1. Install and enable the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat).
2. In BRAT settings, add Beta plugin repository:
   ```text
   yuangr/obsidian-gcal-reminder-sync
   ```

---

#### Step 3: Configure Plugin Settings

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

### 📝 Task Syntax Examples

The plugin supports diverse, flexible task formats:

#### 1. Obsidian Reminder Plugin Syntax
```markdown
- [ ] Team weekly sync meeting (@2026-09-20 14:30) !gcal
```

#### 2. Obsidian Tasks Plugin Syntax
```markdown
- [ ] Submit quarterly financial review ⏰ 2026-09-21 17:00 📅 2026-09-21 !gcal
```

#### 3. Date-Only Tasks (Automatic Daytime Reminder)
```markdown
- [ ] Buy birthday gift for friend 📅 2026-09-22 !gcal
```
*(Automatically scheduled at 09:00 on that day; rings at 08:45 without previous-night false alarms)*

#### 4. Plain Natural Language Dates
```markdown
- [ ] Renew driver license 2026-09-23 10:00 !gcal
```

> **After Synchronization**:
> The trigger keyword is automatically replaced by a clean HTML comment containing the event ID:
> `- [ ] Team weekly sync meeting (@2026-09-20 14:30) <!-- gcal: xxxxxxxx@google.com -->`

---

### ❓ Troubleshooting (FAQ)

#### Q1: Google shows "Google hasn't verified this app" during authorization?
- **Expected behavior**: This is your own private script running under your personal Google account; it does not need public verification.
- **Solution**: Click **"Advanced"** (bottom left) ➔ **"Go to GCal-Reminder-Sync (unsafe)"** ➔ **"Allow"**. Your data stays 100% inside your personal Google ecosystem.

#### Q2: Why did an all-day reminder ring at 23:45 the previous day instead of 15 minutes before?
- **Cause**: In Google Calendar, an all-day event technically starts at 00:00 midnight. A "15-minute before" reminder therefore calculates to 23:45 the night before.
- **Solution**: Enable **"Convert Date-Only to Default Time"** (default `09:00`) in settings. It schedules the event during daytime hours so your reminder sounds at 08:45 AM on the actual day.

#### Q3: How to sync across multiple devices (PC / Android / iPhone)?
- Use your preferred vault sync tool (Remotely Save, WebDAV, Git, iCloud, or Obsidian Sync).
- The task line retains `<!-- gcal: eventId -->`. Checking `[x]` or editing on any device will seamlessly update or remove the corresponding Google Calendar event.

---

<a name="中文说明"></a>
## 🇨🇳 中文说明

### 📖 为什么选择此方案？

在移动端使用 Obsidian 进行任务与日程管理时，很多用户会遭遇以下核心痛点：
1. **本地提醒不可靠**：手机后台进程一旦被系统杀死，Obsidian 本地插件的闹铃无法响铃，导致重要会议或待办漏提；
2. **重型插件侵入性太高**：市面上部分同步方案要求“一条待办新建一篇单独的 Markdown 笔记”，严重破坏日常日记流与清单体验；
3. **第三方服务隐私顾虑**：将待办同步到不可信的第三方云服务存在隐私泄露风险。

**本方案的核心优势**：
- 🎯 **行内极速轻量**：直接在当前日记或笔记中输入任务，打上触发词即刻同步，任务行尾仅追加一行精简注释标签（如 `<!-- gcal: eventId -->`），笔记清爽干净；
- 🔒 **隐私完全自控**：通过 Google 官方提供的免费 **Google Apps Script** 独立运行，数据仅在你的 Obsidian 与你个人的 Google 账号之间点对点加密传输；
- 🔔 **系统级强提醒**：日程直接归入 Google 日历，受 Android / iOS 系统级日历通道守护，即便手机息屏、杀死后台也能百分百准时弹出锁屏强提醒并伴随系统日历闹铃；
- 🔄 **全闭环双向生命周期**：支持 **新建推送**、**原地修改实时同步**、**勾选完成自动清理** 以及 **Google 端修改反向回传 (Pull)**。

---

### ✨ 核心特性

- **行内关键词触发新建**：任意行输入 `!gcal`（支持自定义触发词）并按回车或停顿，自动推送到 Google 日历，自动移除触发词并回写日历 ID；
- **异步版本化队列原地更新 (Queue-Based Sync Engine)**：
  - 自由修改任务标题、日期或具体时间，系统原地更新 Google 日历，无需销毁重建；
  - 内置防抖与请求队列，打字过程中绝不丢失修改，前序请求在途时自动合并最新输入，杜绝网络竞争与丢字；
- **智能多时间戳消歧与白昼默认补偿**：
  - 同时支持 Obsidian Reminder 格式 `(@YYYY-MM-DD HH:mm)` 与 Tasks 插件格式（`⏰`、`📅`、`⏳`）及纯文本日期；
  - 行内若同时存在多个日期/时间标记，自动检测并优先提取用户刚修改的那处时间；
  - **全天日程白昼提醒**：仅写日期未写时刻的待办，自动使用白天默认时间（如 `09:00`）提醒，彻底解决 Google 日历全天日程因起始于凌晨 00:00 而在“前一天深夜 23:45”误响铃的缺陷；
- **任务完成自动同步**：在 Obsidian 中将待办勾选为 `- [x]` 时，自动从 Google 日历中彻底删除（或置灰标记完成并撤销提醒）；
- **双向拉取回传 (Pull)**：通过快捷键或左侧功能栏按钮，一键将 Google 日历中手机修改的内容、时间反向更新到 Obsidian 笔记中；
- **右下角状态栏指示器**：实时常驻提示（就绪 / 正在更新 / 已同步 / 异常），同步状态一目了然。

---

### 🚀 极速部署指南（5 分钟完成）

整个系统由两部分组成：
1. **Google Apps Script 服务端**（免服务器，在 Google 云端运行）
2. **Obsidian 插件端**（本地运行）

---

#### 第一步：部署 Google Apps Script 服务端

1. 打开浏览器并访问 [Google Apps Script 官网](https://script.google.com/home/start)（需登录你的 Google 账号）；
2. 点击左上角的 **“新建项目”**（New project），将项目名称重命名为 `GCal-Reminder-Sync`；
3. 将项目内默认的 `Code.gs` 文本清空，将本项目仓库中 [`google-apps-script/Code.gs`](./google-apps-script/Code.gs) 的全部代码**完整复制并粘贴**进去；
4. 点击工具栏的 **保存图标 (💾)**；
5. 点击右上角蓝色的 **“部署” (Deploy) ➔ “新建部署” (New deployment)**；
6. 在弹出的配置窗口中：
   - 点击左侧齿轮图标选择 **“Web 应用” (Web app)**；
   - **说明 (Description)**：填写如 `v1.0`；
   - **执行身份 (Execute as)**：选择 **“我” (Me - 你的 Google 邮箱)**；
   - **谁有权访问 (Who has access)**：选择 **“所有人” (Anyone)**； *(必选，供 Obsidian 发送 Webhook 授权调用)*
7. 点击右下角 **“部署” (Deploy)** 按钮；
8. 首次部署会弹出 **“需要授予访问权限” (Authorization Required)**：
   - 点击 **“查看权限” (Review permissions)** ➔ 选择你的 Google 账号；
   - 若出现 “Google 尚未验证此应用” 的警告提示，点击左下角的小字 **“高级” (Advanced)** ➔ 点击底部的 **“转到 GCal-Reminder-Sync（不安全）”**；
   - 点击右下角 **“允许” (Allow)**；
9. 部署成功后，Google 会生成一个 **Web 应用网址 (Web app URL)**，格式如下：
   ```text
   https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
   ```
   👉 **点击“复制”该网址，妥善保存，下一步需要用到。**

---

#### 第二步：安装 Obsidian 插件

##### 方法 A：手动安装（推荐）
1. 打开你的 Obsidian 笔记库所在目录；
2. 进入 `.obsidian/plugins/` 文件夹（若为隐藏文件夹需开启“显示隐藏文件”）；
3. 新建名为 `gcal-reminder-sync` 的文件夹；
4. 将本仓库 Release 或主分支中的以下文件复制到该文件夹中：
   - `main.js`
   - `manifest.json`
5. 打开 Obsidian，进入 **设置 ➔ 第三方插件 ➔ 重新载入插件**，找到 **GCal Reminder Sync** 并将其**开启**。

##### 方法 B：使用 BRAT 插件安装
1. 安装并启用 [Obsidian42 - BRAT](https://github.com/TfTHacker/obsidian42-brat)；
2. 在 BRAT 设置中添加 Beta 仓库：`yuangr/obsidian-gcal-reminder-sync` 即可自动安装。

---

#### 第三步：插件参数配置

进入 Obsidian **设置 ➔ 找到最下方的“GCal Reminder Sync”**：

| 配置项 | 推荐设置 | 说明 |
| :--- | :--- | :--- |
| **Google Apps Script Webhook URL** | 粘贴第一步复制的 URL | 必填，格式为 `https://script.google.com/macros/s/.../exec` |
| **专属目标日历名称（可选）** | `Obsidian提醒` 或留空 | 留空则写入默认主日历；若在 Google 日历中新建了“Obsidian提醒”独立日历，填写该名称可专库专存 |
| **行内新建触发词** | `!gcal` | 在行内输入此关键词时触发推送到日历 |
| **仅写日期时的默认提醒时间** | `09:00` | 当待办只写了日期未写时刻时，自动以此时间点作为日程开始时间 |
| **仅写日期时自动转为默认时间** | 开启 | 彻底解决全天日程起始于 00:00 导致“前一天深夜 23:45”误响铃的缺陷 |
| **修改任务或时间自动更新日历** | 开启 | 在 Obsidian 中修改标题、日期或时间，原地同步更新 Google 日历 |
| **修改停顿防抖时间（秒）** | `2.0` | 打字停顿指定秒数后触发同步，避免打字中途频繁调用 |
| **光标跳行时立即同步** | 开启 | 改完某行按回车或上下键跳走时立即认为修改完成 |
| **完成任务时的日历动作** | 彻底从日历删除 | 勾选 `[x]` 时彻底从 Google 日历删除，日历更清爽 |
| **提前提醒时间（分钟）** | `15` | 日历弹窗提醒提前分钟数（默认提前 15 分钟） |

配置完成后，点击面板中的 **“测试 Google Webhook 连接状态”**，看到成功弹窗提示即代表打通！

---

### 📝 待办语法支持示例

本插件具有极强的格式兼容性，无论你习惯哪种待办书写语法均可完美识别：

#### 1. Obsidian Reminder 插件语法
```markdown
- [ ] 部门周例会 (@2026-09-20 14:30) !gcal
```

#### 2. Obsidian Tasks 插件语法
```markdown
- [ ] 提交项目财务报表 ⏰ 2026-09-21 17:00 📅 2026-09-21 !gcal
```

#### 3. 仅含日期的待办（自动白昼提醒）
```markdown
- [ ] 朋友生日买礼物 📅 2026-09-22 !gcal
```
*(自动以当天 09:00 安排日程，提前 15 分钟于当天 08:45 响铃)*

#### 4. 纯文本自然书写
```markdown
- [ ] 去车管所换驾照 2026-09-23 10:00 !gcal
```

> **同步效果**：
> 输入上述内容后按回车，插件自动推送日历并转为：
> `- [ ] 部门周例会 (@2026-09-20 14:30) <!-- gcal: xxxxxxxx@google.com -->`

---

### 常见问题排查 (FAQ)

#### Q1: Google 授权时提示“Google 尚未验证此应用 (Google hasn't verified this app)”？
- **正常现象**：因为该脚本是你自己在个人账号名下创建的私有脚本，未经 Google 商业认证审核；
- **解决办法**：在授权页面点击小字 **“高级” (Advanced)** ➔ 点击底部的 **“转到 ...（不安全）”** ➔ 点击 **“允许” (Allow)** 即可。数据完全存放在你自己的 Google 空间中，绝对安全。

#### Q2: 在国内网络环境下无法访问 Google 怎么办？
- Google Apps Script 域名为 `script.google.com`；
- Obsidian 桌面端与移动端若处于科学网络环境中，可顺畅进行 HTTPS 传输；
- 建议配置分流规则，将 `script.google.com`、`calendar.google.com` 走代理节点。

#### Q3: 为什么有的日程提醒显示“提前 15 分钟”，有的日程显示“前一天 23:45”？
- **原因**：带有具体时间（如 13:00）的日程，Google 以 13:00 倒推 15 分钟（12:45），显示为“提前 15 分钟”；而没有写具体时间的全天日程，Google 日历将其起点定义为当天凌晨 00:00，提前 15 分钟即落在了前一天 23:45；
- **解决办法**：在插件设置中保持开启 **“仅写日期时自动转为默认时间（默认 09:00）”**，系统会自动将其修正为当天白昼日程，统一在当天上午正常提醒。

#### Q4: 如何在多设备（PC / Android / iPhone）间协同？
- 借助常用的 Obsidian 同步方案（如 Remotely Save、WebDAV、Git、iCloud 等）同步笔记库；
- 任务行尾带有 `<!-- gcal: eventId -->`，任意设备上勾选 `[x]` 即可通过插件自动在 Google 日历中销毁对应日程。

---

## 📄 开源许可证

本项目基于 [MIT License](./LICENSE) 开源。欢迎提交 Issue 或 Pull Request！