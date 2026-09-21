# GCal Reminder Sync for Obsidian

English | [简体中文](README_zh.md)

Sync inline Markdown tasks to Google Calendar events and use Calendar notifications. Task text stays in your vault; titles, dates, times and reminder settings are sent to your Google account.

## Upgrading to 2.0

**Upgrade both the plugin and Apps Script. Updating the local plugin does not secure an old public webhook.**

1. Back up your notes and plugin settings; disable the old plugin.
2. Deploy the new Code.gs and appsscript.json, configure SYNC_SECRET and CALENDAR_ID.
3. Replace main.js and manifest.json, then configure the webhook URL, shared secret and timezone.
4. Run the read-only connection test.
5. Explicitly migrate existing event links as described below. Retire old deployments that still run unauthenticated code.

Requires Obsidian 1.5.0+. Desktop and mobile use the same plugin files; no runtime npm installation is required.

## Behavior

- Creates events for unfinished tasks containing the trigger keyword, then updates edits and synchronizes completion.
- Supports Reminder syntax, 📅, ⏰, ⏳, 🛫, and plain dates.
- Skips fenced code examples, prose, and completed unlinked tasks.
- Uses hidden stable task IDs and deterministic Google event IDs to avoid title collisions and duplicate creation after lost responses.
- Serializes operations and preserves edits made while a request is running.
- Retries transient failures after 2, 10 and 30 seconds (four attempts total). Permanent errors stop automatic retries.
- Pull targets the current note, relocates tasks by ID, and skips locally changed/conflicting tasks.
- Reopening a completed task restores reminders. A deleted event uses a new generation when explicitly recreated.
- A remotely deleted event is not silently recreated by ordinary editing.
- Deleting an already-linked task line or note does not automatically delete its event: complete and sync the task first. Removal during the first in-flight creation triggers best-effort cleanup.
- The plugin runs only while Obsidian is running. Events already delivered to Google can notify independently, subject to Calendar permissions, account sync, network and device settings. Notification delivery is not guaranteed.
- These are Calendar events, not Google Tasks. There is no recurring-task engine, per-task reminder syntax, full-field synchronization, unattended offline service or automatic multi-device conflict merge.

## Deploy the backend

1. Create a [Google Apps Script project](https://script.google.com/home/start).
2. Paste google-apps-script/Code.gs into Code.gs.
3. In the left sidebar, open the gear-shaped Project Settings icon and check “Show appsscript.json manifest file in editor” (the third checkbox below “Enable Chrome V8 runtime”, as shown in the Chinese UI). Return to the script editor, open appsscript.json from the file list, and replace its contents with [the supplied manifest](google-apps-script/appsscript.json), then save. It declares Calendar and external-request scopes and the Calendar v3 service.
4. Save appsscript.json and reload the editor; Calendar should then appear under Services automatically. Do not click “+” and add it again, or Apps Script reports that the Calendar service identifier is used more than once. This manifest already contains the single Calendar API v3 declaration. If it still does not appear after saving, use “+” to add Calendar API v3 only after removing the existing Calendar object from enabledAdvancedServices; use one method or the other, never both. With the default GCP project, enabling the service enables the API automatically. Only a custom Google Cloud project requires enabling Google Calendar API separately in Cloud Console.
5. Add these Script properties:

| Property | Value |
| --- | --- |
| SYNC_SECRET | A password-manager-generated random secret of at least 32 characters; do not publish or commit it |
| CALENDAR_ID | Exact destination calendar ID from Calendar settings → Integrate calendar |
| LEGACY_EVENT_IDS | Temporary allowlist for migration only, separated by commas or newlines |

A dedicated calendar is recommended. Calendar selection is pinned on the server; there is no name lookup or fallback to the primary calendar.

6. Deploy as a Web app, executing as yourself, accessible to Anyone. Every operational request must also authenticate with the configured secret.
7. Authorize the script and copy its HTTPS /exec URL. For an existing deployment, select a new version in Manage deployments; changed scopes may require reauthorization.
8. Disable obsolete deployments still serving the old unauthenticated endpoint.

## Install and configure

Copy main.js and manifest.json to .obsidian/plugins/gcal-reminder-sync/ in the vault, then enable the community plugin.

Configure the new webhook URL and matching shared secret. The timezone can be an explicit IANA name such as Asia/Shanghai; otherwise the current device timezone is used. Use the same explicit timezone on all devices.

| Setting | Default / range |
| --- | --- |
| Sync folder | Empty: all Markdown; otherwise a vault-relative folder |
| Trigger | !gcal |
| Date-only fallback time | 09:00 |
| Duration | 30 minutes; 1–1440 |
| Reminder | 15 minutes; 0 at event time, -1 disabled, maximum 40320 |
| Completion | Delete the event, or keep it with notifications disabled |

The shared secret is stored in local plugin data.json. Do not publish that file. Synchronizing plugin settings also synchronizes the secret. The backend does not receive note paths or full note bodies.

The connection test reads the configured calendar and creates no event. It does not test phone notification delivery.

## Migrate 1.x links

Legacy comments such as <!-- gcal: abc@google.com --> contain an iCalUID without ownership metadata. Version 2 refuses to modify unowned events.

1. Point CALENDAR_ID at the actual calendar containing those events.
2. Add the exact legacy IDs from the current note to the server's LEGACY_EVENT_IDS allowlist.
3. Run “迁移当前笔记的旧版事件关联” (migrate legacy links in the current note) and confirm.
4. The plugin assigns task identities and pulls the remote content. Back up unsent local edits before migration.
5. Clear the allowlist after successful migration; owned events continue to work.

For old <!-- gcal-syncing --> markers without task IDs, check Calendar for an already-created event before confirming manual recovery using the current-line sync command. New pending requests have stable IDs and can recover automatically.

The old calendarName setting no longer selects a destination. The old syncedSignatures map is not used as proof of synchronization.

## Task examples

~~~markdown
- [ ] Team meeting (@2026-09-25 14:30) !gcal
- [ ] Submit report ⏰ 2026-09-25 17:00 📅 2026-09-25 !gcal
- [ ] Buy gift 📅 2026-09-26 !gcal
- [ ] Study ⏳ 2026-09-26 10:00 !gcal
- [ ] Appointment 2026-09-27 10:00 !gcal
~~~

Timestamp precedence is deterministic: Reminder → ⏰ → 📅 → ⏳ → 🛫 → plain date. Avoid conflicting timestamps on one task. Pull preserves the supported date style and exact time; remote all-day events retain an all-day marker.

When copying a task as a new independent task, remove all its gcal comments and add the trigger again. Copies retaining the same task ID are not separate tasks.

## Conflicts and recovery

- Edits are debounced; the optional line-leave setting flushes earlier.
- Completion is queued after in-flight updates. Done markers are written only after server confirmation.
- Pull skips unsent local edits and tasks changed during the request.
- After comparing both sides, manual current-line sync or “retry all linked tasks” explicitly pushes local fields over the remote version. Preserve remote changes you want to keep first.
- On another device, Pull first to establish a baseline. Unknown existing active links do not overwrite Google on startup.
- Fix permanent errors, then run a manual retry. Reloading the plugin does not reset persisted retry exhaustion.
- A 1.x client cannot call the v2 backend because it lacks authentication and protocol fields.

## Development

Node.js 18+; no third-party test dependencies:

~~~sh
npm test
npm run check
~~~

Tests execute the real client and server sources with simulated Obsidian/Google APIs. They never access a live account. Before publishing, use a separate test calendar to verify desktop/mobile creation, editing, Pull, completion, reopening, OAuth authorization and phone notification delivery.

[MIT License](LICENSE)
