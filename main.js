const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, MarkdownView, Modal } = require('obsidian');

const DEFAULT_SETTINGS = {
    webhookUrl: '', sharedSecret: '', triggerKeyword: '!gcal',
    reminderMinutes: 15, defaultDuration: 30, defaultTime: '09:00',
    timeZone: '', treatAllDayAsTimed: true, autoTriggerOnType: true,
    autoUpdateOnEdit: true, completeAction: 'delete', editDebounceSeconds: 2, syncOnLineLeave: true,
    syncFolder: '', syncState: {}, failures: {}
};
const MARKERS = /<!--\s*gcal(?:-task|-cycle|-syncing|-deleting|-done|-deleted|-all-day)?(?:\s*:[^>]*?)?\s*-->/g;
const RETRY_DELAYS = [2000, 10000, 30000];

function newTaskId() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function metadata(line) {
    const id = line.match(/<!--\s*gcal-task:\s*([a-f0-9]{32})\s*-->/);
    const binding = line.match(/<!--\s*gcal(-deleting|-done|-deleted)?:\s*([^>\s]+)\s*-->/);
    const cycle = line.match(/<!--\s*gcal-cycle:\s*(\d+)\s*-->/);
    return { id: id && id[1], eventId: binding && binding[2],
        state: binding ? (binding[1] || '').replace('-', '') : '',
        cycle: cycle ? Number(cycle[1]) : 0,
        pending: /<!--\s*gcal-syncing\s*-->/.test(line),
        allDay: /<!--\s*gcal-all-day\s*-->/.test(line) };
}
function visible(line) { return line.replace(MARKERS, '').trim(); }
function taskRows(text) {
    const rows = [], lines = text.split('\n');
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^\s*([~]{3,}|[\x60]{3,})/);
        if (match) {
            if (!fence) fence = match[1];
            else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
            continue;
        }
        if (!fence && /^\s*[-*+]\s+\[[ xX]\]\s*/.test(lines[i])) rows.push({ index: i, line: lines[i] });
    }
    return rows;
}
function validDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
    const value = new Date(date + 'T00:00:00Z');
    return !isNaN(value) && value.toISOString().slice(0, 10) === date;
}
function validTime(time) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(time || ''); }
function config(settings) {
    const minutes = Number(settings.reminderMinutes), duration = Number(settings.defaultDuration);
    if (!Number.isInteger(minutes) || minutes < -1 || minutes > 40320) throw new Error('提醒分钟数应为 0–40320，或 -1（关闭提醒）');
    if (!Number.isInteger(duration) || duration < 1 || duration > 1440) throw new Error('时长应为 1–1440 分钟');
    if (!validTime(settings.defaultTime)) throw new Error('默认时间必须为有效的 HH:mm');
    const timeZone = settings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try { new Intl.DateTimeFormat('en', { timeZone }).format(); }
    catch (_) { throw new Error('无效的 IANA 时区，例如 Asia/Shanghai'); }
    return { reminderMinutes: minutes, durationMinutes: duration, timeZone };
}
// A single parser is used by both push and pull. Explicit reminders take priority.
function parseTask(line, settings) {
    const prefix = line.match(/^(\s*[-*+]\s+\[([ xX])\]\s*)/);
    if (!prefix) return null;
    const m = metadata(line), tokens = [];
    const body = line.slice(prefix[0].length).replace(MARKERS, '');
    const pattern = /\(@(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?\)|([📅⏰⏳🛫])\s*(?:(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?|(\d{2}:\d{2}))|(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?/gu;
    for (const match of body.matchAll(pattern)) {
        const kind = match[1] ? 'reminder' : (match[3] || 'plain');
        tokens.push({ start: match.index, end: match.index + match[0].length, raw: match[0], kind,
            date: match[1] || match[4] || match[7] || null,
            time: match[2] || match[5] || match[6] || match[8] || null });
    }
    const rank = { reminder: 0, '⏰': 1, '📅': 2, '⏳': 3, '🛫': 4, plain: 5 };
    const sorted = tokens.slice().sort((a, b) => rank[a.kind] - rank[b.kind]);
    const selectedDate = sorted.find(t => t.date);
    const selectedTime = sorted.find(t => t.time);
    let title = body;
    for (const t of tokens.slice().reverse()) title = title.slice(0, t.start) + title.slice(t.end);
    if (settings.triggerKeyword) title = title.split(settings.triggerKeyword).join('');
    title = title.replace(/\s+/g, ' ').trim() || 'Obsidian 提醒任务';
    const date = selectedDate ? selectedDate.date : null;
    let time = selectedTime ? selectedTime.time : null;
    if (date && !validDate(date)) throw new Error('任务日期无效：' + date);
    if (time && !validTime(time)) throw new Error('任务时间无效：' + time);
    if (!time && !m.allDay && settings.treatAllDayAsTimed) time = settings.defaultTime;
    return { title, date, time, done: prefix[2].toLowerCase() === 'x', prefix: prefix[0],
        tokens, selectedDate, selectedTime, meta: m };
}
function withBinding(line, state, eventId, id, cycle) {
    const allDay = metadata(line).allDay;
    const clean = line.replace(MARKERS, '').trimEnd();
    return clean + ' <!-- gcal-task: ' + id + ' -->' +
        (cycle ? ' <!-- gcal-cycle: ' + cycle + ' -->' : '') +
        (allDay ? ' <!-- gcal-all-day -->' : '') +
        (eventId ? ' <!-- gcal' + (state ? '-' + state : '') + ': ' + eventId + ' -->' : ' <!-- gcal-syncing -->');
}
function renderRemote(line, event, settings) {
    const task = parseTask(line, settings);
    if (!task || !validDate(event.date) || (event.time !== null && !validTime(event.time))) throw new Error('日历返回了无效日期或时间');
    const chosen = task.selectedDate || task.selectedTime;
    let tokens = task.tokens.map(t => {
        if (t !== chosen && t !== task.selectedTime) return t.raw;
        if (t === task.selectedTime && t !== chosen) return event.time ? '⏰ ' + event.time : '';
        const suffix = event.time ? ' ' + event.time : '';
        if (t.kind === 'reminder') return '(@' + event.date + suffix + ')';
        if (t.kind === 'plain') return event.date + suffix;
        return t.kind + ' ' + event.date + suffix;
    }).filter(Boolean);
    if (!chosen) tokens = ['(@' + event.date + (event.time ? ' ' + event.time : '') + ')'];
    const prefix = event.completed ? task.prefix.replace('[ ]', '[x]') : task.prefix;
    let next = prefix + String(event.title).replace(/[\r\n]/g, ' ') + ' ' + tokens.join(' ');
    next = withBinding(next, event.completed ? 'done' : '', event.eventId || task.meta.eventId, task.meta.id, task.meta.cycle);
    if (event.time === null) next += ' <!-- gcal-all-day -->';
    return next;
}
function fingerprint(task, settings) {
    return JSON.stringify([task.title, task.date, task.time, task.done, task.meta.cycle,
        config(settings), settings.completeAction]);
}
function replaceTask(text, id, transform) {
    const rows = taskRows(text).filter(r => metadata(r.line).id === id);
    if (rows.length > 1) throw new Error('检测到重复任务标识，请移除复制任务的 gcal 注释后重新同步');
    if (!rows.length) return text;
    const lines = text.split('\n'), next = transform(rows[0].line);
    if (typeof next === 'string') lines[rows[0].index] = next;
    return lines.join('\n');
}
function readJson(response) {
    try {
        const parsed = response.text ? JSON.parse(response.text) : response.json;
        if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) { /* Avoid logging payloads or shared secrets. */ }
    throw Object.assign(new Error('Webhook 返回非 JSON；请检查部署地址和访问权限'), { retryable: false });
}

class SyncEngine {
    constructor(options) {
        Object.assign(this, options);
        this.queue = new Map(); this.retryTimers = new Map(); this.locations = new Map();
        this.running = false; this.stopped = false; this.idleWaiters = [];
    }
    async prepare(source) {
        await source.transform(text => {
            const lines = text.split('\n');
            for (const row of taskRows(text)) {
                const m = metadata(row.line);
                const eligible = m.eventId || (this.settings.autoTriggerOnType && this.settings.triggerKeyword && row.line.includes(this.settings.triggerKeyword));
                if (!eligible || m.id || m.pending) continue;
                const task = parseTask(row.line, this.settings);
                if (!m.eventId && (task.done || !task.date)) continue;
                lines[row.index] = row.line + ' <!-- gcal-task: ' + this.newId() + ' -->';
            }
            return lines.join('\n');
        });
    }
    async scan(source, force = false) {
        if (this.stopped) return;
        try {
            config(this.settings);
            await this.prepare(source);
            const seen = new Set();
            for (const row of taskRows(await source.read())) {
                const m = metadata(row.line);
                if (!m.id) continue;
                if (seen.has(m.id)) throw new Error('同一笔记内存在重复任务标识');
                seen.add(m.id);
                const previous = this.locations.get(m.id);
                if (previous && previous !== source && await this.find(previous, m.id)) throw new Error('两篇笔记包含相同任务标识，请清理复制任务的关联注释');
                this.locations.set(m.id, source);
            }
            for (const id of seen) this.enqueue(id, source, force);
        } catch (error) { this.notify(error.message, true); }
    }
    enqueue(id, source, force = false) {
        if (this.stopped) return;
        const old = this.queue.get(id);
        this.queue.set(id, { id, source, force: force || !!old?.force });
        void this.pump();
    }
    async find(source, id) {
        const rows = taskRows(await source.read()).filter(r => metadata(r.line).id === id);
        if (rows.length > 1) throw new Error('重复任务标识，已暂停同步');
        return rows.length ? rows[0].line : null;
    }
    async change(source, id, transform) {
        if (!this.stopped) await source.transform(text => replaceTask(text, id, transform));
    }
    async pump() {
        if (this.running || this.stopped) return;
        this.running = true;
        try {
            while (this.queue.size && !this.stopped) {
                const [key, job] = this.queue.entries().next().value;
                this.queue.delete(key);
                try {
                    if (job.pull) await this.pullNow(job.source);
                    else if (job.adopt) await this.adoptNow(job.source);
                    else await this.run(job);
                } catch (error) { this.notify(error.message, true); }
            }
        } finally {
            this.running = false;
            this.idleWaiters.splice(0).forEach(resolve => resolve());
        }
    }
    idle() { return !this.running ? Promise.resolve() : new Promise(resolve => this.idleWaiters.push(resolve)); }
    async run({ id, source, force }) {
        const line = await this.find(source, id);
        if (!line || this.stopped) return;
        const task = parseTask(line, this.settings), m = task.meta;
        const operationSettings = { ...this.settings };
        const signature = fingerprint(task, operationSettings);
        const failed = this.settings.failures[id];
        if (failed && failed.signature === signature && !force) {
            if (failed.terminal) return;
            if (failed.nextAt > Date.now()) { this.armRetry(id, source, failed.nextAt); return; }
        } else if (failed) {
            delete this.settings.failures[id];
            this.cancelRetry(id);
        }
        const prior = this.settings.syncState[id];
        if (m.state === 'deleted' && !force) return; // An explicit remote deletion is never silently resurrected.
        if (task.done && ((!m.eventId && !m.pending) || m.state === 'done' || m.state === 'deleted')) return;
        if (!task.done && !task.date) return;
        if (!force && !task.done && m.eventId && !m.state &&
            (!this.settings.autoUpdateOnEdit || (prior && prior.signature === signature))) return;
        // Unknown old links must first be pulled/migrated, rather than assuming local text was synced.
        if (!force && m.eventId && !prior && !m.state && !task.done) return;
        // A pending create may already exist remotely even if its response was lost.
        // Resolve its deterministic ID first, then apply a newly checked completion.
        let action = m.eventId ? (task.done ? 'complete' : 'update') : 'create';
        let cycle = m.cycle;
        if (m.state === 'deleted' || (force && failed?.code === 'DELETED_GENERATION') || (m.state === 'done' && prior?.completionMode === 'delete')) {
            cycle++;
            await this.change(source, id, l => withBinding(l, '', null, id, cycle));
            action = 'create';
        }
        const payload = { action, taskId: id, cycle, eventId: m.eventId,
            title: task.title, date: task.date, time: task.time, ...config(operationSettings),
            completeMode: operationSettings.completeAction, expectedEtag: force ? null : prior?.etag };
        if (action === 'create') {
            payload.eventId = null;
            await this.change(source, id, l => withBinding(
                this.settings.triggerKeyword ? l.split(this.settings.triggerKeyword).join('') : l, '', null, id, cycle));
        }
        try {
            let result;
            try { result = await this.send(payload); }
            catch (error) {
                // Reopening a task completed on another device: absence was explicitly confirmed.
                if (error.code === 'NOT_FOUND' && m.state === 'done' && !task.done) {
                    await this.change(source, id, l => withBinding(l, '', null, id, cycle + 1));
                    this.enqueue(id, source);
                    return;
                }
                if (error.code === 'NOT_FOUND' && m.eventId && !task.done) {
                    await this.change(source, id, l => withBinding(l, 'deleted', m.eventId, id, cycle));
                }
                throw error;
            }
            if (this.stopped) return;
            if (!result.eventId) throw Object.assign(new Error('响应缺少事件 ID'), { retryable: false });
            const found = await this.find(source, id);
            if (!found) {
                if (action === 'create') await this.send({ action: 'complete', taskId: id, eventId: result.eventId, completeMode: 'delete' });
                return;
            }
            await this.change(source, id, l => withBinding(l, action === 'complete' ? 'done' : '', result.eventId, id, cycle));
            const sentTask = { ...task,
                done: action === 'complete',
                title: result.event ? result.event.title : task.title,
                date: result.event ? result.event.date : task.date,
                time: result.event ? result.event.time : task.time,
                meta: { ...m, cycle } };
            this.settings.syncState[id] = { signature: fingerprint(sentTask, operationSettings), line: visible(line),
                eventId: result.eventId, etag: result.etag || null,
                completionMode: action === 'complete' ? operationSettings.completeAction : null };
            delete this.settings.failures[id]; this.cancelRetry(id);
            await this.save();
            this.notify(action === 'complete' ? '完成状态已同步' : '任务已同步');
            const current = await this.find(source, id);
            if (current && fingerprint(parseTask(current, this.settings), this.settings) !== fingerprint(sentTask, operationSettings)) {
                this.enqueue(id, source);
            }
        } catch (error) {
            if (this.stopped) return;
            const previous = this.settings.failures[id];
            const attempts = previous?.signature === signature ? previous.attempts + 1 : 1;
            const terminal = !error.retryable || attempts > RETRY_DELAYS.length;
            const nextAt = terminal ? 0 : Date.now() + RETRY_DELAYS[attempts - 1];
            this.settings.failures[id] = { signature, attempts, terminal, nextAt, message: error.message, code: error.code };
            await this.save();
            if (!terminal) this.armRetry(id, source, nextAt);
            this.notify(error.message + (terminal ? '；修正后手动重试' : '；稍后重试'), true);
        }
    }
    armRetry(id, source, at) {
        if (this.stopped || this.retryTimers.has(id)) return;
        this.retryTimers.set(id, setTimeout(() => {
            this.retryTimers.delete(id); this.enqueue(id, source);
        }, Math.max(0, at - Date.now())));
    }
    cancelRetry(id) {
        if (this.retryTimers.has(id)) clearTimeout(this.retryTimers.get(id));
        this.retryTimers.delete(id);
    }
    pull(source) { this.queue.set('pull:' + source.key, { source, pull: true }); void this.pump(); return this.idle(); }
    adopt(source) { this.queue.set('adopt:' + source.key, { source, adopt: true }); void this.pump(); return this.idle(); }
    async adoptNow(source) {
        await this.prepare(source);
        for (const row of taskRows(await source.read())) {
            const m = metadata(row.line);
            if (!m.id || !m.eventId) continue;
            await this.send({ action: 'adopt', taskId: m.id, eventId: m.eventId });
        }
        await this.pullNow(source);
    }
    async pullNow(source) {
        await this.prepare(source);
        const snapshots = new Map();
        for (const row of taskRows(await source.read())) {
            const m = metadata(row.line);
            if (!m.id || !m.eventId || m.state === 'done' || m.state === 'deleted') continue;
            if (snapshots.has(m.id)) throw new Error('重复任务标识，无法安全拉取');
            const task = parseTask(row.line, this.settings), prior = this.settings.syncState[m.id];
            if (prior && prior.signature !== fingerprint(task, this.settings)) {
                this.notify('任务有未同步本地修改，已跳过拉取：' + task.title, true); continue;
            }
            snapshots.set(m.id, { line: row.line, task });
        }
        // Bounded batches keep Apps Script executions below service/runtime limits.
        const entries = Array.from(snapshots.entries());
        for (let offset = 0; offset < entries.length; offset += 50) {
            const batch = entries.slice(offset, offset + 50);
            const result = await this.send({ action: 'pull', timeZone: config(this.settings).timeZone,
                tasks: batch.map(([id, s]) => ({ taskId: id, eventId: s.task.meta.eventId })) });
            if (this.stopped) return;
            for (const [id, snapshot] of batch) {
                const event = result.events && result.events[id];
                if (!event || event.error) { this.notify(event?.error || '缺少日历查询结果', true); continue; }
                let applied = null;
                await this.change(source, id, current => {
                    if (current !== snapshot.line) { this.notify('拉取期间任务已修改，已保留本地内容', true); return current; }
                    applied = event.exists === false ?
                        withBinding(current, 'deleted', snapshot.task.meta.eventId, id, snapshot.task.meta.cycle) :
                        renderRemote(current, event, this.settings);
                    return applied;
                });
                if (applied) {
                    delete this.settings.failures[id]; this.cancelRetry(id);
                    if (event.exists === false) delete this.settings.syncState[id];
                    else this.settings.syncState[id] = { signature: fingerprint(parseTask(applied, this.settings), this.settings),
                        line: visible(applied), eventId: event.eventId, etag: event.etag, completionMode: event.completed ? 'markDone' : null };
                }
            }
            await this.save();
        }
        this.notify('拉取完成；冲突或失败的任务保留本地内容');
    }
    stop() {
        this.stopped = true; this.queue.clear();
        for (const id of this.retryTimers.keys()) this.cancelRetry(id);
    }
}

class ConfirmModal extends Modal {
    constructor(app, message, resolve) { super(app); this.message = message; this.resolve = resolve; this.accepted = false; }
    onOpen() {
        this.contentEl.createEl('p', { text: this.message });
        new Setting(this.contentEl).addButton(b => b.setButtonText('取消').onClick(() => this.close()))
            .addButton(b => b.setButtonText('确认继续').setCta().onClick(() => { this.accepted = true; this.close(); }));
    }
    onClose() { this.resolve(this.accepted); }
}

class GCalReminderSyncPlugin extends Plugin {
    async onload() {
        const data = await this.loadData();
        this.settings = { ...DEFAULT_SETTINGS, ...data,
            syncState: { ...data?.syncState }, failures: { ...data?.failures } };
        this.sources = new WeakMap(); this.debounces = new Map(); this.lastLines = new WeakMap(); this.saveChain = Promise.resolve();
        this.stopped = false; this.session = null; this.status = this.addStatusBarItem();
        this.engine = new SyncEngine({ settings: this.settings, newId: newTaskId,
            send: data => this.send(data), save: () => this.saveSettings(),
            notify: (text, error) => this.notify(text, error) });
        this.addSettingTab(new GCalSettingTab(this.app, this));
        this.addRibbonIcon('calendar-check', '拉取当前笔记的 Google 日历变更', () => this.current(source => this.engine.pull(source)));
        this.addCommand({ id: 'sync-current-line-to-gcal', name: '同步当前行（重试／恢复）', callback: () => void this.syncCurrentLine() });
        this.addCommand({ id: 'pull-tasks-from-gcal', name: '从 Google 日历拉取当前笔记', callback: () => this.current(s => this.engine.pull(s)) });
        this.addCommand({ id: 'force-sync-all-tasks', name: '重试当前笔记全部已关联任务', callback: () => this.current(s => this.engine.scan(s, true)) });
        this.addCommand({ id: 'test-gcal-webhook', name: '测试 Webhook 连接（不创建事件）', callback: () => void this.testConnection() });
        this.addCommand({ id: 'adopt-legacy-tasks', name: '迁移当前笔记的旧版事件关联', callback: () => void this.adoptLegacy() });
        this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
            if (!info?.file) return;
            const previous = this.lastLines.get(editor), current = editor.getCursor().line;
            this.lastLines.set(editor, current);
            this.schedule(info.file, this.settings.syncOnLineLeave && previous !== undefined && previous !== current ? 0 : null);
        }));
        if (typeof document !== 'undefined') {
            const cursorMoved = () => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view?.editor || !view.file) return;
                const current = view.editor.getCursor().line, previous = this.lastLines.get(view.editor);
                this.lastLines.set(view.editor, current);
                if (this.settings.syncOnLineLeave && previous !== undefined && previous !== current &&
                    this.debounces.has(this.source(view.file))) this.schedule(view.file, 0);
            };
            this.registerDomEvent(document, 'keyup', cursorMoved);
            this.registerDomEvent(document, 'mouseup', cursorMoved);
            this.registerDomEvent(document, 'selectionchange', cursorMoved);
        }
        this.registerEvent(this.app.workspace.on('file-open', file => { if (file) this.schedule(file); }));
        this.registerEvent(this.app.vault.on('modify', file => this.schedule(file)));
        this.app.workspace.onLayoutReady(() => {
            if (this.stopped) return;
            for (const file of this.app.vault.getMarkdownFiles()) this.schedule(file);
        });
        this.notify('就绪');
    }
    inScope(file) {
        const folder = this.settings.syncFolder.trim().replace(/^\/|\/$/g, '');
        return file?.extension === 'md' && (!folder || file.path.startsWith(folder + '/'));
    }
    source(file) {
        if (this.sources.has(file)) return this.sources.get(file);
        const openEditor = () => {
            let editor = null;
            this.app.workspace.iterateAllLeaves(leaf => {
                if (leaf.view instanceof MarkdownView && leaf.view.file === file && leaf.view.editor) editor = leaf.view.editor;
            });
            return editor;
        };
        const source = {
            get key() { return file.path; },
            read: async () => {
                if (this.app.vault.getAbstractFileByPath && this.app.vault.getAbstractFileByPath(file.path) !== file) return '';
                const editor = openEditor();
                return editor ? editor.getValue() : this.app.vault.read(file);
            },
            transform: async fn => {
                if (this.app.vault.getAbstractFileByPath && this.app.vault.getAbstractFileByPath(file.path) !== file) return;
                const editor = openEditor();
                if (!editor) {
                    await this.app.vault.process(file, text => this.stopped ? text : fn(text));
                    return;
                }
                if (this.stopped) return;
                const before = editor.getValue(), after = fn(before);
                if (after === before) return;
                // Smallest contiguous replacement preserves unrelated lines and editor selections.
                let start = 0, end = before.length, nextEnd = after.length;
                while (start < end && start < nextEnd && before[start] === after[start]) start++;
                while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
                editor.replaceRange(after.slice(start, nextEnd), editor.offsetToPos(start), editor.offsetToPos(end));
            }
        };
        this.sources.set(file, source); return source;
    }
    schedule(file, delay = null) {
        if (this.stopped || !this.inScope(file)) return;
        const source = this.source(file);
        clearTimeout(this.debounces.get(source));
        this.debounces.set(source, setTimeout(() => {
            this.debounces.delete(source); void this.engine.scan(source);
        }, delay === null ? Math.max(500, Number(this.settings.editDebounceSeconds) * 1000 || 2000) : delay));
    }
    current(fn) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file || !view.editor) return this.notify('请先打开一个 Markdown 笔记', true);
        if (!this.inScope(view.file)) return this.notify('当前笔记不在同步文件夹范围内', true);
        return Promise.resolve(fn(this.source(view.file), view)).catch(e => this.notify(e.message, true));
    }
    async syncCurrentLine() {
        return this.current(async (source, view) => {
            const index = view.editor.getCursor().line, original = view.editor.getLine(index);
            if (!taskRows(view.editor.getValue()).some(row => row.index === index)) throw new Error('请选择代码块外的待办任务');
            const task = parseTask(original, this.settings);
            if (!task || (!task.date && !task.done)) throw new Error('任务缺少有效日期');
            if (task.meta.pending && !task.meta.id) {
                const confirmed = await new Promise(resolve => new ConfirmModal(this.app,
                    '旧版 syncing 标记没有请求 ID，无法判断日历是否已创建。请先核对并清理重复日程；确认后将重新创建此任务。', resolve).open());
                if (!confirmed) return;
            }
            const id = task.meta.id || newTaskId();
            let prepared = false;
            await source.transform(text => {
                const lines = text.split('\n');
                if (lines[index] !== original) return text;
                let line = original;
                if (!task.meta.id) line += ' <!-- gcal-task: ' + id + ' -->';
                if (!task.meta.eventId && !task.done) line = withBinding(line, '', null, id, task.meta.cycle);
                lines[index] = line; prepared = true; return lines.join('\n');
            });
            if (!prepared) throw new Error('任务在操作期间已移动或修改，请重试');
            this.engine.enqueue(id, source, true);
        });
    }
    async adoptLegacy() {
        return this.current(async source => {
            const confirmed = await new Promise(resolve => new ConfirmModal(this.app,
                '将关联当前笔记中的旧版事件。请先在 Apps Script 的 LEGACY_EVENT_IDS 中列出允许迁移的事件 ID，随后将拉取远端内容。', resolve).open());
            if (confirmed) await this.engine.adopt(source);
        });
    }
    notify(text, error = false) {
        if (this.stopped) return;
        this.status?.setText((error ? '❌ ' : '📅 ') + 'GCal: ' + text);
        if (error) new Notice(text, 6000);
    }
    async saveSettings() {
        const snapshot = JSON.parse(JSON.stringify(this.settings));
        const next = this.saveChain.catch(() => {}).then(() => this.saveData(snapshot));
        this.saveChain = next; return next;
    }
    async rawRequest(payload) {
        let response;
        try {
            response = await requestUrl({ url: this.settings.webhookUrl, method: 'POST',
                headers: { 'Content-Type': 'application/json' }, throw: false,
                body: JSON.stringify({ ...payload, protocol: 2, secret: this.settings.sharedSecret }) });
        } catch (_) { throw Object.assign(new Error('网络请求失败'), { retryable: true }); }
        if (response.status >= 400) throw Object.assign(new Error('Webhook HTTP ' + response.status),
            { retryable: response.status === 429 || response.status >= 500 });
        const result = readJson(response);
        if (result.protocol !== 2) throw Object.assign(new Error('服务端版本不兼容，请先重新部署新版 Code.gs'), { retryable: false });
        if (result.status !== 'success') throw Object.assign(new Error(result.message || '服务端操作失败'),
            { code: result.code, retryable: result.retryable === true });
        return result;
    }
    async send(payload) {
        if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/?#]+\/exec$/.test(this.settings.webhookUrl)) {
            throw Object.assign(new Error('请填写 Google Apps Script 的 HTTPS /exec 部署地址'), { retryable: false });
        }
        if (this.settings.sharedSecret.length < 32) throw Object.assign(new Error('请配置至少 32 个字符的共享密钥'), { retryable: false });
        const key = this.settings.webhookUrl + '\n' + this.settings.sharedSecret;
        if (payload.action === 'ping' || this.session !== key) {
            const ping = await this.rawRequest({ action: 'ping' });
            this.session = key;
            if (payload.action === 'ping') return ping;
        }
        return this.rawRequest(payload);
    }
    async testConnection() {
        try {
            const result = await this.send({ action: 'ping' });
            new Notice('连接成功，目标日历：' + result.calendarName);
            this.notify('连接正常');
        } catch (error) { this.notify(error.message, true); }
    }
    onunload() {
        this.stopped = true; this.engine.stop();
        for (const timer of this.debounces.values()) clearTimeout(timer);
        this.debounces.clear();
    }
}
class GCalSettingTab extends PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
    display() {
        this.containerEl.empty();
        this.containerEl.createEl('h2', { text: 'Google 日历提醒同步' });
        this.containerEl.createEl('p', { text: '需部署协议 v2 服务端，并配置 SYNC_SECRET、CALENDAR_ID；旧事件须显式迁移。' });
        const text = (key, name, desc, numeric = false, secret = false) => {
            new Setting(this.containerEl).setName(name).setDesc(desc).addText(input => {
                input.setValue(String(this.plugin.settings[key] ?? ''));
                if (secret) input.inputEl.type = 'password';
                input.onChange(async value => {
                    if (numeric && (value.trim() === '' || !Number.isFinite(Number(value)))) return;
                    this.plugin.settings[key] = numeric ? Number(value) : value.trim();
                    this.plugin.session = null;
                    await this.plugin.saveSettings();
                });
            });
        };
        text('webhookUrl', 'Webhook URL', 'Google Apps Script 的 /exec 部署地址');
        text('sharedSecret', '共享密钥', '与服务端 SYNC_SECRET 相同，至少 32 个字符。保存在本地插件配置中。', false, true);
        text('syncFolder', '同步文件夹', 'Vault 内相对路径；留空表示所有 Markdown 笔记。代码块不参与同步。');
        text('triggerKeyword', '新建触发词', '默认 !gcal；只有未完成任务会触发新建。');
        text('timeZone', '时区', '例如 Asia/Shanghai；留空使用当前设备时区。多设备建议固定相同值。');
        text('defaultTime', '日期任务的默认时间', 'HH:mm，例如 09:00');
        text('defaultDuration', '默认时长（分钟）', '1–1440', true);
        text('reminderMinutes', '提前提醒（分钟）', '0 表示准点，-1 关闭；最大 40320', true);
        text('editDebounceSeconds', '编辑防抖（秒）', '最小 0.5 秒，默认 2', true);
        for (const [key, name] of [['treatAllDayAsTimed', '日期任务使用默认时间'], ['autoTriggerOnType', '自动新建带触发词的任务'], ['autoUpdateOnEdit', '自动推送任务修改'], ['syncOnLineLeave', '光标离开编辑行时立即同步']]) {
            new Setting(this.containerEl).setName(name).addToggle(t => t.setValue(this.plugin.settings[key]).onChange(async value => {
                this.plugin.settings[key] = value; await this.plugin.saveSettings();
            }));
        }
        new Setting(this.containerEl).setName('完成任务后').addDropdown(d => d
            .addOption('delete', '删除日程').addOption('markDone', '保留日程并关闭提醒')
            .setValue(this.plugin.settings.completeAction).onChange(async value => {
                this.plugin.settings.completeAction = value; await this.plugin.saveSettings();
            }));
        new Setting(this.containerEl).setName('测试连接').addButton(b => b.setButtonText('测试（不创建事件）').onClick(() => this.plugin.testConnection()));
    }
}
module.exports = GCalReminderSyncPlugin;
module.exports._test = { SyncEngine, metadata, taskRows, parseTask, renderRemote, fingerprint, config, replaceTask, DEFAULT_SETTINGS, readJson };
