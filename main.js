const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, MarkdownView } = require('obsidian');

const DEFAULT_SETTINGS = {
    webhookUrl: '',
    triggerKeyword: '!gcal',
    reminderMinutes: 15,
    calendarName: 'Obsidian提醒',
    defaultDuration: 30,
    defaultTime: '09:00',       // 仅写日期时的默认提醒时间
    treatAllDayAsTimed: true,   // 仅写日期时自动转为默认时间提醒（彻底解决全天日程在“前一天 23:45”误响问题）
    autoTriggerOnType: true,
    completeAction: 'delete',   // 'delete' (从日历彻底删除) 或 'markDone' (置灰标记完成)
    autoUpdateOnEdit: true,     // 修改内容或日期时间自动原地更新日历
    editDebounceSeconds: 2.0,   // 编辑停顿防抖秒数
    syncOnLineLeave: true,      // 光标离开行时立即同步
    syncedSignatures: {}        // 持久化存储 eventId -> lineSignature
};

function safeParseJson(response) {
    if (!response) return null;
    if (response.json && typeof response.json === 'object') {
        return response.json;
    }
    if (response.text) {
        try {
            return JSON.parse(response.text);
        } catch (e) {
            console.error('[GCal JSON Parse Error]', e, response.text);
        }
    }
    return null;
}

class GCalReminderSyncPlugin extends Plugin {
    async onload() {
        await this.loadSettings();

        this.debounceTimer = null;
        this.activeEditingLine = -1;
        this.inFlightUpdates = new Set();
        this.inFlightCreations = new Set();
        this.pendingUpdates = new Map(); // eventId -> { task, signature }
        this.failedEvents = new Set();
        this.isProcessingQueue = false;

        // 1. 状态栏状态指示器 (Status Bar)
        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar('ready');

        // 2. 左侧边栏快捷功能按钮 (Ribbon Icon)
        this.addRibbonIcon('calendar-sync', '从 Google 日历双向同步拉取 (Pull)', () => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!view || !view.editor) {
                new Notice('⚠️ 请先打开或聚焦一个待办笔记！');
                return;
            }
            this.pullTasksFromGCal(view.editor);
        });

        // 3. 打开笔记或切换标签页时：建立签名索引，并自动补偿扫描遗留草稿
        this.registerEvent(
            this.app.workspace.on('file-open', () => {
                this.indexActiveEditorSignatures();
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (view && view.editor && this.settings.autoTriggerOnType) {
                    setTimeout(() => {
                        this.checkNewDraftTasks(view.editor);
                    }, 500);
                }
            })
        );

        // 4. 编辑器内容变化监听
        this.registerEvent(
            this.app.workspace.on('editor-change', (editor) => {
                this.handleEditorChange(editor);
            })
        );

        // 5. 命令：同步当前光标所在行（新建或强制修改）
        this.addCommand({
            id: 'sync-current-line-to-gcal',
            name: '同步当前行待办到 Google 日历 (新建/更新)',
            callback: () => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.editor) {
                    new Notice('⚠️ 请先打开或聚焦一个 Markdown 笔记！');
                    return;
                }
                this.syncCurrentLine(view.editor, true);
            }
        });

        // 6. 命令：从 Google 日历双向回传拉取 (Pull)
        this.addCommand({
            id: 'pull-tasks-from-gcal',
            name: '从 Google 日历拉取并更新当前笔记待办 (双向回传)',
            callback: () => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.editor) {
                    new Notice('⚠️ 请先打开或聚焦一个 Markdown 笔记！');
                    return;
                }
                this.pullTasksFromGCal(view.editor);
            }
        });

        // 7. 命令：全量强制检查并同步当前笔记所有活动待办
        this.addCommand({
            id: 'force-sync-all-tasks',
            name: '全量检查并同步当前笔记所有已关联待办到 Google 日历',
            callback: () => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.editor) {
                    new Notice('⚠️ 请先打开或聚焦一个 Markdown 笔记！');
                    return;
                }
                this.forceSyncAllActiveTasks(view.editor);
            }
        });

        // 8. 命令：测试 Google Webhook 连接
        this.addCommand({
            id: 'test-gcal-webhook',
            name: '测试 Google Webhook 连接状态',
            callback: () => {
                this.testConnection();
            }
        });

        // 9. 注册配置面板
        this.addSettingTab(new GCalSettingTab(this.app, this));

        // 10. 界面布局就绪时首次初始化
        this.app.workspace.onLayoutReady(() => {
            this.indexActiveEditorSignatures();
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view && view.editor && this.settings.autoTriggerOnType) {
                setTimeout(() => this.checkNewDraftTasks(view.editor), 600);
            }
        });
    }

    onunload() {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.pendingUpdates.clear();
        this.inFlightUpdates.clear();
        this.inFlightCreations.clear();
        this.failedEvents.clear();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        if (!this.settings.syncedSignatures || typeof this.settings.syncedSignatures !== 'object') {
            this.settings.syncedSignatures = {};
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    updateStatusBar(state, text = '') {
        if (!this.statusBarItem) return;
        if (state === 'ready') {
            this.statusBarItem.setText('📅 GCal: 就绪');
        } else if (state === 'syncing') {
            this.statusBarItem.setText(`⏳ GCal: ${text || '同步中...'}`);
        } else if (state === 'success') {
            this.statusBarItem.setText(`✅ GCal: ${text || '已同步'}`);
            setTimeout(() => this.updateStatusBar('ready'), 4000);
        } else if (state === 'error') {
            this.statusBarItem.setText(`❌ GCal: ${text || '同步异常'}`);
            setTimeout(() => this.updateStatusBar('ready'), 5000);
        }
    }

    // 核心内容特征签名（剔除 <!-- gcal:... --> 后的净文本内容）
    getLineSignature(line) {
        if (!line) return '';
        return line
            .replace(/<!-- gcal(?:-deleting|-done|-deleted)?:\s*[^>]+\s*-->/g, '')
            .replace(/<!-- gcal-syncing -->/g, '')
            .trim();
    }

    // 为当前活动笔记中的所有已关联待办建立初始签名索引
    indexActiveEditorSignatures() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.editor) return;
        const editor = view.editor;
        const count = editor.lineCount();
        let changed = false;

        for (let i = 0; i < count; i++) {
            const line = editor.getLine(i);
            const match = line.match(/<!-- gcal:\s*([^>\s]+)\s*-->/);
            if (match) {
                const eventId = match[1];
                const sig = this.getLineSignature(line);
                if (!this.settings.syncedSignatures[eventId]) {
                    this.settings.syncedSignatures[eventId] = sig;
                    changed = true;
                }
            }
        }
        if (changed) {
            this.saveSettings();
        }
    }

    handleEditorChange(editor) {
        const cursor = editor.getCursor();

        // 1. 光标切行 (Line Leave) 检测：光标离开正在编辑的行时，立即认为该行修改完毕并触发同步
        if (this.settings.syncOnLineLeave && this.activeEditingLine !== -1 && this.activeEditingLine !== cursor.line) {
            const prevLineNum = this.activeEditingLine;
            if (prevLineNum < editor.lineCount()) {
                this.checkSpecificLine(editor, prevLineNum);
            }
        }
        this.activeEditingLine = cursor.line;

        // 2. 防抖定时器：连续键盘打字停顿后自动触发检测
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        const debounceMs = Math.max(1000, (Number(this.settings.editDebounceSeconds) || 2.0) * 1000);

        this.debounceTimer = setTimeout(() => {
            this.handleDebouncedRun(editor);
        }, debounceMs);
    }

    handleDebouncedRun(editor) {
        // 先检查勾选完成状态
        const completedHandled = this.checkCompletedTasks(editor);
        if (completedHandled) return;

        // 再检查原地修改更新
        if (this.settings.autoUpdateOnEdit) {
            this.checkModifiedTasks(editor);
        }

        // 最后检查未同步草稿 (!gcal)
        if (this.settings.autoTriggerOnType) {
            this.checkNewDraftTasks(editor);
        }
    }

    findLineByEventId(editor, eventId, prefixes = ['<!-- gcal:', '<!-- gcal-deleting:', '<!-- gcal-done:']) {
        const count = editor.lineCount();
        for (let i = 0; i < count; i++) {
            const l = editor.getLine(i);
            if (l.includes(eventId)) {
                for (const p of prefixes) {
                    if (l.includes(p)) return i;
                }
            }
        }
        return -1;
    }

    checkSpecificLine(editor, lineNum) {
        const line = editor.getLine(lineNum);
        if (!line) return;

        // 1. 勾选完成检测
        const completeMatch = line.match(/^(\s*-\s*\[[xX]\].*?)<!-- gcal(?:-deleting)?:\s*([^>\s]+)\s*-->/);
        if (completeMatch) {
            const eventId = completeMatch[2];
            if (!this.failedEvents.has(eventId)) {
                this.completeGCalEvent(editor, lineNum, eventId);
                return;
            }
        }

        // 2. 新草稿触发词检测
        if (this.settings.autoTriggerOnType) {
            const trigger = (this.settings.triggerKeyword || '!gcal').trim();
            if (trigger && line.includes(trigger) && !line.includes('<!-- gcal:') && !line.includes('<!-- gcal-syncing') && !line.includes('<!-- gcal-deleting:')) {
                const task = this.parseTaskLine(line);
                if (task) {
                    if (this.debounceTimer) {
                        clearTimeout(this.debounceTimer);
                        this.debounceTimer = null;
                    }
                    this.syncLineAt(editor, lineNum, false);
                    return;
                }
            }
        }

        // 3. 内容原地修改检测
        if (this.settings.autoUpdateOnEdit) {
            const modMatch = line.match(/^\s*-\s*\[ \](.*?)<!-- gcal:\s*([^>\s]+)\s*-->/);
            if (modMatch) {
                const eventId = modMatch[2];
                this.failedEvents.delete(eventId);
                const currentSig = this.getLineSignature(line);
                const lastSig = this.settings.syncedSignatures[eventId];

                if (!lastSig || lastSig !== currentSig) {
                    const task = this.parseTaskLine(line, lastSig);
                    if (task) {
                        this.queueTaskUpdate(eventId, task, currentSig);
                    }
                }
            }
        }
    }

    // ====================== 1. 完成状态同步 (Delete / Mark Done) ======================
    checkCompletedTasks(editor) {
        const lineCount = editor.lineCount();
        for (let i = 0; i < lineCount; i++) {
            const line = editor.getLine(i);
            const match = line.match(/^(\s*-\s*\[[xX]\].*?)<!-- gcal(?:-deleting)?:\s*([^>\s]+)\s*-->/);
            if (match) {
                const eventId = match[2];
                if (this.failedEvents.has(eventId) || this.inFlightUpdates.has(eventId)) continue;
                this.completeGCalEvent(editor, i, eventId);
                return true;
            }
        }
        return false;
    }

    async completeGCalEvent(editor, lineNum, eventId) {
        this.inFlightUpdates.add(eventId);
        this.updateStatusBar('syncing', '完成清理中');

        let targetLine = this.findLineByEventId(editor, eventId, ['<!-- gcal:', '<!-- gcal-deleting:']);
        if (targetLine === -1) targetLine = lineNum;

        if (targetLine >= 0 && targetLine < editor.lineCount()) {
            const currentLine = editor.getLine(targetLine);
            if (currentLine.includes(`<!-- gcal: ${eventId} -->`)) {
                editor.setLine(targetLine, currentLine.replace(`<!-- gcal: ${eventId} -->`, `<!-- gcal-deleting: ${eventId} -->`));
            }
        }

        const actionText = this.settings.completeAction === 'delete' ? '从 Google 日历删除' : '标记已完成';
        const notice = new Notice(`⏳ 待办已勾选，正在${actionText}...`, 2500);

        try {
            const response = await requestUrl({
                url: this.settings.webhookUrl,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'delete',
                    eventId: eventId,
                    completeMode: this.settings.completeAction,
                    calendarName: this.settings.calendarName.trim()
                })
            });

            notice.hide();
            const result = safeParseJson(response);
            const resultMsg = String(result?.message || '');

            const isSuccess = result && (result.status === 'success');
            const isAlreadyGone = result && (
                result.action === 'already_deleted' ||
                resultMsg.includes('不存在') ||
                resultMsg.includes('已删除') ||
                resultMsg.includes('日历活动') ||
                resultMsg.includes('does not exist') ||
                resultMsg.includes('already') ||
                resultMsg.includes('not found') ||
                resultMsg.includes('404')
            );

            if (isSuccess || isAlreadyGone) {
                this.failedEvents.delete(eventId);
                delete this.settings.syncedSignatures[eventId];
                await this.saveSettings();

                if (this.settings.completeAction === 'delete') {
                    new Notice('🗑️ 任务已完成，已从 Google 日历中移除日程！', 3000);
                } else {
                    new Notice('✔️ 任务已完成，已在 Google 日历中置灰并撤销闹铃！', 3000);
                }
                this.updateStatusBar('success', '已完成清理');

                const finalLineNum = this.findLineByEventId(editor, eventId, ['<!-- gcal:', '<!-- gcal-deleting:']);
                if (finalLineNum !== -1) {
                    const lineAfter = editor.getLine(finalLineNum);
                    editor.setLine(finalLineNum, lineAfter.replace(new RegExp(`<!-- gcal(?:-deleting)?:\\s*${eventId}\\s*-->`), `<!-- gcal-done: ${eventId} -->`));
                }
            } else {
                this.failedEvents.add(eventId);
                new Notice('⚠️ 同步完成状态失败: ' + (result?.message || '未知错误'), 5000);
                this.updateStatusBar('error', '清理失败');

                const finalLineNum = this.findLineByEventId(editor, eventId, ['<!-- gcal:', '<!-- gcal-deleting:']);
                if (finalLineNum !== -1) {
                    const lineAfter = editor.getLine(finalLineNum);
                    editor.setLine(finalLineNum, lineAfter.replace(`<!-- gcal-deleting: ${eventId} -->`, `<!-- gcal: ${eventId} -->`));
                }
            }
        } catch (err) {
            notice.hide();
            console.error('[GCal Complete Error]', err);
            const errMsg = String(err?.message || '');
            if (
                errMsg.includes('404') || 
                errMsg.includes('不存在') || 
                errMsg.includes('已删除') || 
                errMsg.includes('does not exist') || 
                errMsg.includes('already')
            ) {
                this.failedEvents.delete(eventId);
                delete this.settings.syncedSignatures[eventId];
                await this.saveSettings();

                new Notice('🗑️ 任务已完成，Google 日历已确认清理！', 3000);
                this.updateStatusBar('success', '日历已清理');

                const finalLineNum = this.findLineByEventId(editor, eventId, ['<!-- gcal:', '<!-- gcal-deleting:']);
                if (finalLineNum !== -1) {
                    const lineAfter = editor.getLine(finalLineNum);
                    editor.setLine(finalLineNum, lineAfter.replace(new RegExp(`<!-- gcal(?:-deleting)?:\\s*${eventId}\\s*-->`), `<!-- gcal-done: ${eventId} -->`));
                }
            } else {
                this.failedEvents.add(eventId);
                new Notice('❌ 同步完成状态异常: ' + err.message, 5000);
                this.updateStatusBar('error', '完成同步异常');

                const finalLineNum = this.findLineByEventId(editor, eventId, ['<!-- gcal:', '<!-- gcal-deleting:']);
                if (finalLineNum !== -1) {
                    const lineAfter = editor.getLine(finalLineNum);
                    editor.setLine(finalLineNum, lineAfter.replace(`<!-- gcal-deleting: ${eventId} -->`, `<!-- gcal: ${eventId} -->`));
                }
            }
        } finally {
            this.inFlightUpdates.delete(eventId);
        }
    }

    // ====================== 2. 队列化原地更新 (Queue-Based Edit Sync) ======================
    checkModifiedTasks(editor) {
        const lineCount = editor.lineCount();
        for (let i = 0; i < lineCount; i++) {
            const line = editor.getLine(i);
            const match = line.match(/^\s*-\s*\[ \](.*?)<!-- gcal:\s*([^>\s]+)\s*-->/);
            if (match) {
                const eventId = match[2];
                const currentSig = this.getLineSignature(line);
                const lastSig = this.settings.syncedSignatures[eventId];

                if (!lastSig || lastSig !== currentSig) {
                    const task = this.parseTaskLine(line, lastSig);
                    if (task) {
                        this.queueTaskUpdate(eventId, task, currentSig);
                    }
                }
            }
        }
    }

    queueTaskUpdate(eventId, task, signature) {
        this.pendingUpdates.set(eventId, { task, signature });
        this.processUpdateQueue();
    }

    async processUpdateQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        try {
            for (const [eventId, update] of Array.from(this.pendingUpdates.entries())) {
                if (this.inFlightUpdates.has(eventId)) continue;

                // 提取最新待办版本并标记在途网络锁
                this.pendingUpdates.delete(eventId);
                this.inFlightUpdates.add(eventId);

                // 发起网络更新
                this.executeGCalUpdate(eventId, update.task, update.signature);
            }
        } finally {
            this.isProcessingQueue = false;
        }
    }

    async executeGCalUpdate(eventId, task, signature) {
        this.updateStatusBar('syncing', '正在更新日历');

        try {
            const response = await requestUrl({
                url: this.settings.webhookUrl,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'update',
                    eventId: eventId,
                    title: task.title,
                    date: task.date,
                    time: task.time,
                    reminderMinutes: Number(this.settings.reminderMinutes) || 15,
                    calendarName: this.settings.calendarName.trim()
                })
            });

            const result = safeParseJson(response);

            if (result && result.status === 'success') {
                const timeDesc = task.time ? ` ${task.time}` : ' (全天)';
                new Notice(`✅ 日历已更新: ${task.title} (${task.date}${timeDesc})`, 3000);
                this.updateStatusBar('success', '更新完成');

                this.settings.syncedSignatures[eventId] = signature;

                // 如果后端因为原日程在日历端被误删而重新创建，回写新 eventId
                if (result.eventId && result.eventId !== eventId) {
                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (view && view.editor) {
                        const targetLine = this.findLineByEventId(view.editor, eventId, ['<!-- gcal:']);
                        if (targetLine !== -1) {
                            const l = view.editor.getLine(targetLine);
                            view.editor.setLine(targetLine, l.replace(`<!-- gcal: ${eventId} -->`, `<!-- gcal: ${result.eventId} -->`));
                        }
                    }
                    delete this.settings.syncedSignatures[eventId];
                    this.settings.syncedSignatures[result.eventId] = signature;
                }

                await this.saveSettings();
            } else {
                new Notice('⚠️ 更新日历日程失败: ' + (result?.message || '未知错误'), 5000);
                this.updateStatusBar('error', '更新失败');
            }
        } catch (err) {
            console.error('[GCal Update Error]', err);
            new Notice('❌ 原地更新日历异常: ' + err.message, 5000);
            this.updateStatusBar('error', '更新异常');
        } finally {
            this.inFlightUpdates.delete(eventId);

            // 如果在网络传输期间，用户又打入了新的文字，无缝衔接自动同步最新版
            if (this.pendingUpdates.has(eventId)) {
                this.processUpdateQueue();
            }
        }
    }

    // ====================== 3. 新建草稿同步 (!gcal) ======================
    findDraftLine(editor, trigger, title) {
        const count = editor.lineCount();
        for (let i = 0; i < count; i++) {
            const line = editor.getLine(i);
            if (line.includes(trigger) && !line.includes('<!-- gcal:') && !line.includes('<!-- gcal-syncing') && !line.includes('<!-- gcal-deleting:')) {
                if (!title || line.includes(title)) return i;
            }
        }
        return -1;
    }

    findSyncingLine(editor, title) {
        const count = editor.lineCount();
        for (let i = 0; i < count; i++) {
            const line = editor.getLine(i);
            if (line.includes('<!-- gcal-syncing -->')) {
                if (!title || line.includes(title)) return i;
            }
        }
        return -1;
    }

    restoreSyncingLine(editor, title, trigger) {
        const lineIdx = this.findSyncingLine(editor, title);
        if (lineIdx !== -1) {
            const line = editor.getLine(lineIdx);
            editor.setLine(lineIdx, line.replace('<!-- gcal-syncing -->', '').trimRight() + ` ${trigger}`);
        }
    }

    async deleteEventSilently(eventId) {
        if (!this.settings.webhookUrl || !eventId) return;
        try {
            await requestUrl({
                url: this.settings.webhookUrl,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'delete',
                    eventId: eventId,
                    completeMode: 'delete',
                    calendarName: this.settings.calendarName.trim()
                })
            });
        } catch (e) {
            console.error('[GCal Silent Delete Error]', e);
        }
    }

    checkNewDraftTasks(editor) {
        const trigger = (this.settings.triggerKeyword || '!gcal').trim();
        if (!trigger) return false;

        const lineCount = editor.lineCount();
        for (let i = 0; i < lineCount; i++) {
            const line = editor.getLine(i);
            if (line.includes(trigger) && !line.includes('<!-- gcal:') && !line.includes('<!-- gcal-syncing') && !line.includes('<!-- gcal-deleting:')) {
                const task = this.parseTaskLine(line);
                if (task) {
                    const draftKey = `${task.title}:::${task.date}:::${task.time || ''}`;
                    if (this.inFlightCreations.has(draftKey)) continue;

                    this.syncLineAt(editor, i, false);
                    return true;
                }
            }
        }
        return false;
    }

    async syncCurrentLine(editor, manual = false) {
        const cursor = editor.getCursor();
        const lineText = editor.getLine(cursor.line);

        const match = lineText.match(/<!-- gcal:\s*([^>\s]+)\s*-->/);
        if (match) {
            const task = this.parseTaskLine(lineText);
            if (task) {
                const sig = this.getLineSignature(lineText);
                await this.executeGCalUpdate(match[1], task, sig);
                return;
            }
        }
        await this.syncLineAt(editor, cursor.line, manual);
    }

    async syncLineAt(editor, lineNum, manual = false) {
        const lineText = editor.getLine(lineNum);
        if (!lineText) return;

        if (lineText.includes('<!-- gcal:') || lineText.includes('<!-- gcal-syncing') || lineText.includes('<!-- gcal-deleting:')) {
            if (manual) new Notice('ℹ️ 该任务已同步或正在同步 Google 日历。');
            return;
        }

        const task = this.parseTaskLine(lineText);
        if (!task) {
            if (manual) {
                new Notice('⚠️ 未检测到有效日期或时间！请确保待办包含 (@YYYY-MM-DD HH:mm) 或 📅 ⏰ 格式。');
            }
            return;
        }

        const draftKey = `${task.title}:::${task.date}:::${task.time || ''}`;
        if (this.inFlightCreations.has(draftKey)) {
            console.log('[GCal] Task creation already in flight for:', draftKey);
            return;
        }

        if (!this.settings.webhookUrl || !this.settings.webhookUrl.startsWith('http')) {
            new Notice('❌ 请先在插件设置中填入有效的 Google Apps Script Webhook URL！');
            return;
        }

        // 1. 立即上锁
        this.inFlightCreations.add(draftKey);

        // 2. 立即将编辑区中的 !gcal 替换为 <!-- gcal-syncing --> 占位标签
        // 彻底消除后续光标切行、防抖定时器等并发触发的重复扫描漏洞
        const trigger = (this.settings.triggerKeyword || '!gcal').trim();
        let targetLine = lineNum;
        let originalLine = editor.getLine(targetLine);
        if (trigger && originalLine.includes(trigger)) {
            editor.setLine(targetLine, originalLine.replace(trigger, '').trimRight() + ' <!-- gcal-syncing -->');
        } else {
            editor.setLine(targetLine, originalLine.trimRight() + ' <!-- gcal-syncing -->');
        }

        const notice = new Notice('⏳ 正在同步到 Google 日历...', 0);
        this.updateStatusBar('syncing', '正在新建日程');

        try {
            const response = await requestUrl({
                url: this.settings.webhookUrl,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'create',
                    title: task.title,
                    date: task.date,
                    time: task.time,
                    reminderMinutes: Number(this.settings.reminderMinutes) || 15,
                    calendarName: this.settings.calendarName.trim()
                })
            });

            notice.hide();
            const result = safeParseJson(response);

            if (result && result.status === 'success') {
                const timeDesc = task.time ? ` ${task.time}` : ' (全天)';
                new Notice(`✅ 已成功同步到 Google 日历！\n📅 ${task.date}${timeDesc}\n🔔 提前 ${this.settings.reminderMinutes} 分钟强提醒`, 4000);
                this.updateStatusBar('success', '新建日程成功');

                // 动态重新定位行号（优先按 <!-- gcal-syncing --> 精准匹配当前行）
                let currentIdx = this.findSyncingLine(editor, task.title);
                if (currentIdx === -1) {
                    currentIdx = this.findDraftLine(editor, trigger, task.title);
                }
                if (currentIdx === -1 && targetLine < editor.lineCount()) {
                    currentIdx = targetLine;
                }

                if (currentIdx !== -1) {
                    const currentLine = editor.getLine(currentIdx);

                    // 关键防御：如果当前行已经被附加上了有效的 <!-- gcal: ... --> 标签（说明其他并发操作已完成写入）
                    if (currentLine.includes('<!-- gcal:') && !currentLine.includes('<!-- gcal-syncing')) {
                        console.warn('[GCal] Line already has an active gcal tag! Deleting duplicate event silently:', result.eventId);
                        this.deleteEventSilently(result.eventId);
                        return;
                    }

                    let newLine = currentLine;
                    newLine = newLine.replace(/<!-- gcal-done:[^>]+-->/g, '');

                    if (newLine.includes('<!-- gcal-syncing -->')) {
                        newLine = newLine.replace('<!-- gcal-syncing -->', `<!-- gcal: ${result.eventId} -->`);
                    } else if (trigger && newLine.includes(trigger)) {
                        newLine = newLine.replace(trigger, '').trimRight() + ` <!-- gcal: ${result.eventId} -->`;
                    } else {
                        // 确保只追加一次，如果已有其他 gcal 标签则替换，绝不并列追加两个
                        newLine = newLine.replace(/<!-- gcal:[^>]+-->/g, '').trimRight() + ` <!-- gcal: ${result.eventId} -->`;
                    }

                    editor.setLine(currentIdx, newLine);

                    const finalSig = this.getLineSignature(newLine);
                    this.settings.syncedSignatures[result.eventId] = finalSig;
                    await this.saveSettings();
                }
            } else {
                new Notice('❌ Google 同步失败: ' + (result?.message || '未知错误'), 6000);
                this.updateStatusBar('error', '新建失败');
                this.restoreSyncingLine(editor, task.title, trigger);
            }
        } catch (err) {
            notice.hide();
            console.error('[GCal Reminder Sync Error]', err);
            new Notice('❌ 同步异常: ' + err.message, 6000);
            this.updateStatusBar('error', '新建异常');
            this.restoreSyncingLine(editor, task.title, trigger);
        } finally {
            this.inFlightCreations.delete(draftKey);

            // 自动循环检查当前笔记中是否还有其他未同步的 !gcal 草稿任务
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view && view.editor && this.settings.autoTriggerOnType) {
                setTimeout(() => this.checkNewDraftTasks(view.editor), 400);
            }
        }
    }

    // ====================== 4. Google 端回传 (Pull) ======================
    async pullTasksFromGCal(editor) {
        if (!this.settings.webhookUrl) {
            new Notice('❌ 请先在设置中填写 Google Webhook URL！');
            return;
        }

        const lineCount = editor.lineCount();
        const eventIdToLine = new Map();

        for (let i = 0; i < lineCount; i++) {
            const line = editor.getLine(i);
            const match = line.match(/<!-- gcal:\s*([^>\s]+)\s*-->/);
            if (match) {
                eventIdToLine.set(match[1], i);
            }
        }

        if (eventIdToLine.size === 0) {
            new Notice('ℹ️ 当前笔记中没有已关联 Google 日历的待办任务。');
            return;
        }

        const notice = new Notice(`⏳ 正在从 Google 日历比对并拉取 ${eventIdToLine.size} 条待办...`, 0);
        this.updateStatusBar('syncing', '拉取比对中');

        try {
            const response = await requestUrl({
                url: this.settings.webhookUrl,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'pull',
                    eventIds: Array.from(eventIdToLine.keys()),
                    calendarName: this.settings.calendarName.trim()
                })
            });

            notice.hide();
            const result = safeParseJson(response);

            if (result && result.status === 'success' && result.events) {
                let updatedCount = 0;
                for (const [eventId, gEvent] of Object.entries(result.events)) {
                    const lineNum = eventIdToLine.get(eventId);
                    if (lineNum === undefined) continue;
                    const oldLine = editor.getLine(lineNum);

                    if (!gEvent.exists) {
                        editor.setLine(lineNum, oldLine.replace(`<!-- gcal: ${eventId} -->`, `<!-- gcal-deleted: ${eventId} -->`));
                        delete this.settings.syncedSignatures[eventId];
                        updatedCount++;
                        continue;
                    }

                    const localTask = this.parseTaskLine(oldLine);
                    if (localTask) {
                        const titleDiff = localTask.title !== gEvent.title;
                        const dateDiff = localTask.date !== gEvent.date;
                        const timeDiff = (localTask.time || '') !== (gEvent.time || '');

                        if (titleDiff || dateDiff || timeDiff) {
                            let newLine = oldLine;
                            
                            // 更新标题
                            if (titleDiff && localTask.title) {
                                newLine = newLine.replace(localTask.title, gEvent.title);
                            }
                            
                            // 更新时间
                            const timePart = gEvent.time ? ` ${gEvent.time}` : '';
                            if (newLine.includes('(@')) {
                                newLine = newLine.replace(/\(@\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?\)/, `(@${gEvent.date}${timePart})`);
                            } else if (newLine.includes('📅') || newLine.includes('⏰')) {
                                newLine = newLine.replace(/📅 ?\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/, `📅 ${gEvent.date}`);
                                if (newLine.includes('⏰')) {
                                    newLine = newLine.replace(/⏰ ?(?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}/, `⏰ ${gEvent.date}${timePart}`);
                                }
                            }

                            editor.setLine(lineNum, newLine);
                            this.settings.syncedSignatures[eventId] = this.getLineSignature(newLine);
                            updatedCount++;
                        }
                    }
                }

                await this.saveSettings();

                if (updatedCount > 0) {
                    new Notice(`🎉 成功从 Google 日历回传更新了 ${updatedCount} 条待办！`, 4000);
                    this.updateStatusBar('success', `拉取更新${updatedCount}条`);
                } else {
                    new Notice('✨ 所有待办与 Google 日历完全一致，无需更新。', 3000);
                    this.updateStatusBar('ready');
                }
            } else {
                new Notice('⚠️ 拉取失败: ' + (result?.message || '未知响应内容'), 6000);
                this.updateStatusBar('error', '拉取失败');
            }
        } catch (err) {
            notice.hide();
            console.error('[GCal Pull Error]', err);
            new Notice('❌ 拉取异常: ' + err.message, 6000);
            this.updateStatusBar('error', '拉取异常');
        }
    }

    // ====================== 5. 全量强制同步 ======================
    async forceSyncAllActiveTasks(editor) {
        const lineCount = editor.lineCount();
        let queueCount = 0;
        for (let i = 0; i < lineCount; i++) {
            const line = editor.getLine(i);
            const match = line.match(/^\s*-\s*\[ \](.*?)<!-- gcal:\s*([^>\s]+)\s*-->/);
            if (match) {
                const eventId = match[2];
                const lastSig = this.settings.syncedSignatures[eventId];
                const task = this.parseTaskLine(line, lastSig);
                if (task) {
                    const sig = this.getLineSignature(line);
                    this.queueTaskUpdate(eventId, task, sig);
                    queueCount++;
                }
            }
        }
        if (queueCount > 0) {
            new Notice(`🚀 已将当前笔记 ${queueCount} 条待办加入同步队列！`, 3000);
        } else {
            new Notice('ℹ️ 当前笔记未检测到需要同步的活动待办。', 3000);
        }
    }

    // ====================== 6. 智能多格式解析器 ======================
    parseTaskLine(line, lastSig = null) {
        let dateStr = null;
        let timeStr = null;

        // 1. Reminder 格式: (@YYYY-MM-DD HH:mm) 或 (@YYYY-MM-DD)
        const remMatch = line.match(/\(@(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?\)/);
        if (remMatch) {
            dateStr = remMatch[1];
            if (remMatch[2]) timeStr = remMatch[2];
        }

        // 2. 闹铃/排程格式: ⏰ [YYYY-MM-DD ]HH:mm 或 ⏰ YYYY-MM-DD
        const clockMatch = line.match(/⏰ ?(?:(\d{4}-\d{2}-\d{2}) )?(\d{2}:\d{2})/);
        const clockDateMatch = line.match(/⏰ ?(\d{4}-\d{2}-\d{2})/);
        const clockTime = clockMatch ? clockMatch[2] : null;
        const clockDate = clockMatch ? clockMatch[1] : (clockDateMatch ? clockDateMatch[1] : null);

        // 3. 截止日期格式: 📅 YYYY-MM-DD [HH:mm]
        const dueMatch = line.match(/📅 ?(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?/);
        const dueDate = dueMatch ? dueMatch[1] : null;
        const dueTime = dueMatch ? dueMatch[2] : null;

        // 4. 排程日期格式: ⏳ YYYY-MM-DD [HH:mm]
        const schedMatch = line.match(/⏳ ?(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?/);
        const schedDate = schedMatch ? schedMatch[1] : null;
        const schedTime = schedMatch ? schedMatch[2] : null;

        // 日期智能判定与消歧
        if (!dateStr) {
            if (dueDate && clockDate && dueDate !== clockDate && lastSig) {
                // 如果两处日期冲突，看用户刚才具体改了哪一处
                const lastDue = lastSig.match(/📅 ?(\d{4}-\d{2}-\d{2})/);
                if (lastDue && lastDue[1] !== dueDate) dateStr = dueDate;
                else dateStr = clockDate;
            } else {
                dateStr = dueDate || clockDate || schedDate;
            }
        }

        // 时间智能判定与消歧
        if (!timeStr) {
            if (clockTime && dueTime && clockTime !== dueTime && lastSig) {
                // 如果两处时间冲突（如 ⏰ 06:30 📅 07:30），看用户刚才具体改了哪一处
                const lastDueTimeMatch = lastSig.match(/📅 ?\d{4}-\d{2}-\d{2} (\d{2}:\d{2})/);
                const lastDueTime = lastDueTimeMatch ? lastDueTimeMatch[1] : null;
                if (lastDueTime && lastDueTime !== dueTime) timeStr = dueTime;
                else timeStr = clockTime;
            } else {
                timeStr = clockTime || dueTime || schedTime;
            }
        }

        // 5. 裸日期与时间匹配兜底: YYYY-MM-DD 与可选 HH:mm
        if (!dateStr) {
            const plainDateMatch = line.match(/\b(\d{4}-\d{2}-\d{2})\b/);
            if (plainDateMatch) dateStr = plainDateMatch[1];
        }
        if (!timeStr) {
            const plainTimeMatch = line.match(/\b(\d{2}:\d{2})\b/);
            if (plainTimeMatch) timeStr = plainTimeMatch[1];
        }

        // 6. 若未指定具体时间点，且配置了自动使用默认时间提醒（避免全天日程 00:00 导致前一天深夜 23:45 响铃）
        if (!timeStr && this.settings.treatAllDayAsTimed && this.settings.defaultTime) {
            timeStr = this.settings.defaultTime.trim();
        }

        if (!dateStr) return null;

        // 清洗 title
        let title = line;
        const trigger = (this.settings.triggerKeyword || '!gcal').trim();
        if (trigger) title = title.replace(trigger, '');

        // 去除复选框
        title = title.replace(/^\s*-\s*\[[ xX]\]\s*/, '');

        // 去除各种日期时间格式
        title = title.replace(/\(@\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?\)/g, '');
        title = title.replace(/📅 ?\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/g, '');
        title = title.replace(/⏰ ?(?:(?:\d{4}-\d{2}-\d{2}) )?\d{2}:\d{2}/g, '');
        title = title.replace(/⏰ ?\d{4}-\d{2}-\d{2}/g, '');
        title = title.replace(/⏳ ?\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/g, '');
        title = title.replace(/🛫 ?\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/g, '');

        // 去除 gcal 相关的注释标签
        title = title.replace(/<!-- gcal:[^>]+-->/g, '');
        title = title.replace(/<!-- gcal-syncing -->/g, '');
        title = title.replace(/<!-- gcal-done:[^>]+-->/g, '');
        title = title.replace(/<!-- gcal-deleting:[^>]+-->/g, '');
        title = title.replace(/<!-- gcal-deleted:[^>]+-->/g, '');

        // 如果提取到了纯文本裸日期与时间，从标题中剥除
        title = title.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '');
        title = title.replace(/\b\d{2}:\d{2}\b/g, '');

        title = title.trim();
        if (!title) title = "Obsidian 提醒任务";

        return { title, date: dateStr, time: timeStr };
    }

    async testConnection() {
        if (!this.settings.webhookUrl) {
            new Notice('❌ 请先在设置中填写 Google Webhook URL！');
            return;
        }
        const notice = new Notice('⏳ 正在测试 Google Webhook 连接...', 0);
        this.updateStatusBar('syncing', '测试连接中');

        try {
            const today = new Date().toISOString().split('T')[0];
            const response = await requestUrl({
                url: this.settings.webhookUrl,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'create',
                    title: '【测试连接】来自 Obsidian',
                    date: today,
                    time: '12:00',
                    reminderMinutes: 10,
                    calendarName: this.settings.calendarName.trim()
                })
            });
            notice.hide();
            let res = safeParseJson(response);
            if (res && res.status === 'success') {
                new Notice('🎉 Webhook 连接成功！已在 Google 日历创建一条测试日程。', 5000);
                this.updateStatusBar('success', '连接正常');
            } else {
                new Notice('⚠️ Webhook 连接失败: ' + (res?.message || '未知返回'), 6000);
                this.updateStatusBar('error', '连接失败');
            }
        } catch (err) {
            notice.hide();
            new Notice('❌ 连接失败: ' + err.message, 6000);
            this.updateStatusBar('error', '连接异常');
        }
    }
}

class GCalSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Google 日历全闭环同步设置' });

        new Setting(containerEl)
            .setName('Google Apps Script Webhook URL')
            .setDesc('粘贴你在 Google Apps Script 部署获得的 Web 应用网址')
            .addText(text => text
                .setPlaceholder('https://script.google.com/macros/s/.../exec')
                .setValue(this.plugin.settings.webhookUrl)
                .onChange(async (value) => {
                    this.plugin.settings.webhookUrl = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('专属目标日历名称（可选）')
            .setDesc('留空则写入默认主日历；建议填入专属日历（如“Obsidian提醒”），让所有待办统一归类')
            .addText(text => text
                .setPlaceholder('留空为默认主日历')
                .setValue(this.plugin.settings.calendarName)
                .onChange(async (value) => {
                    this.plugin.settings.calendarName = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('行内新建触发词')
            .setDesc('输入此触发词（如 !gcal）并回车或停顿，将自动把待办推送到 Google 日历')
            .addText(text => text
                .setPlaceholder('!gcal')
                .setValue(this.plugin.settings.triggerKeyword)
                .onChange(async (value) => {
                    this.plugin.settings.triggerKeyword = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('修改任务或日期时间时自动更新日历')
            .setDesc('开启后，直接在 Obsidian 修改已同步任务的文字、日期或时间，会自动原地同步到 Google 日历')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoUpdateOnEdit)
                .onChange(async (value) => {
                    this.plugin.settings.autoUpdateOnEdit = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('修改停顿防抖时间（秒）')
            .setDesc('打字停顿多少秒后触发日历同步（默认 2.0 秒，避免输入一半误触发）')
            .addText(text => text
                .setPlaceholder('2.0')
                .setValue(String(this.plugin.settings.editDebounceSeconds || 2.0))
                .onChange(async (value) => {
                    const num = parseFloat(value);
                    this.plugin.settings.editDebounceSeconds = isNaN(num) ? 2.0 : num;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('光标跳行时立即同步')
            .setDesc('开启后，改完某行按回车换行或跳到其他行时，立即认为该行修改完成并触发同步')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncOnLineLeave)
                .onChange(async (value) => {
                    this.plugin.settings.syncOnLineLeave = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('完成任务时的日历动作')
            .setDesc('当你在 Obsidian 勾选任务为 [x] 时，Google 日历的处理动作')
            .addDropdown(dropdown => dropdown
                .addOption('delete', '彻底从 Google 日历删除（日历清爽干净）')
                .addOption('markDone', '保留在日历，标题加 ✔️ 并撤销闹铃')
                .setValue(this.plugin.settings.completeAction)
                .onChange(async (value) => {
                    this.plugin.settings.completeAction = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('提前提醒时间（分钟）')
            .setDesc('写入 Google 日历时的强提醒弹窗提前分钟数（默认 15 分钟）')
            .addText(text => text
                .setPlaceholder('15')
                .setValue(String(this.plugin.settings.reminderMinutes))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    this.plugin.settings.reminderMinutes = isNaN(num) ? 15 : num;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('仅写日期时的默认提醒时间')
            .setDesc('当待办只写了日期没写具体时刻时（如 2026-09-21），自动设为此时间点提醒（默认 09:00），彻底避免全天日程在“前一天深夜 23:45”误响')
            .addText(text => text
                .setPlaceholder('09:00')
                .setValue(this.plugin.settings.defaultTime || '09:00')
                .onChange(async (value) => {
                    this.plugin.settings.defaultTime = value.trim() || '09:00';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('仅写日期时自动转为默认时间')
            .setDesc('开启后，未写具体时刻的待办自动转为上述时间点（如 09:00），并统一按“提前 15 分钟”正常提醒；关闭后则直接作为全天日程同步')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.treatAllDayAsTimed !== false)
                .onChange(async (value) => {
                    this.plugin.settings.treatAllDayAsTimed = value;
                    await this.plugin.saveSettings();
                }));
    }
}

module.exports = GCalReminderSyncPlugin;
