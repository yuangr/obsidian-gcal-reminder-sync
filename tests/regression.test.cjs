const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadClient, memorySource, backend, fixture, deferred } = require('./helpers.cjs');
const ID = '1'.repeat(32);
const linked = (state = '', done = false) => '- [' + (done ? 'x' : ' ') + '] Meeting (@2026-09-22 09:00) <!-- gcal-task: ' + ID + ' --> <!-- gcal' + (state ? '-' + state : '') + ': existing -->';
async function sync(h, force = false) { await h.engine.scan(h.source, force); await h.engine.idle(); }
function stop(t, h) { t.after(() => h.engine.stop()); return h; }

test('normal creation uses a stable task ID, explicit timezone and one remote event', async t => {
    const h = stop(t, fixture()); await sync(h); await sync(h);
    assert.equal(h.server.active().length, 1);
    assert.equal(h.server.active()[0].start.dateTime, '2026-09-22T01:00:00.000Z');
    assert.match(h.source.text, /gcal-task:/); assert.doesNotMatch(h.source.text, /!gcal|gcal-syncing/);
    assert.equal(h.requests.length, 1);
});
test('creation during editing follows up with the newest time', async t => {
    const gate = deferred(), reached = deferred(); let first = true;
    const h = stop(t, fixture({ send: async (payload, server) => {
        if (first) { first = false; const result = await server.send(payload); reached.resolve(); await gate.promise; return result; }
        return server.send(payload);
    } }));
    await h.engine.scan(h.source); await reached.promise;
    h.source.text = h.source.text.replace('09:00', '10:00'); gate.resolve(); await h.engine.idle();
    assert.equal(h.server.active()[0].start.dateTime, '2026-09-22T02:00:00.000Z');
    assert.deepEqual(h.requests.map(p => p.action), ['create', 'update']);
});
test('completion during an update is serialized after the update', async t => {
    const gate = deferred(), reached = deferred();
    const h = stop(t, fixture({ text: linked(), send: async (p, s) => {
        if (p.action === 'update') { const r = await s.send(p); reached.resolve(); await gate.promise; return r; }
        return s.send(p);
    } })); h.server.seed(ID);
    await h.engine.scan(h.source, true); await reached.promise;
    h.source.text = h.source.text.replace('[ ]', '[x]'); await h.engine.scan(h.source);
    gate.resolve(); await h.engine.idle();
    assert.equal(h.server.active().length, 0);
    assert.deepEqual(h.requests.map(p => p.action), ['update', 'complete']);
    assert.match(h.source.text, /gcal-done:/);
});
test('same title tasks get distinct IDs without swapping associations', async t => {
    const h = stop(t, fixture({ text: '- [ ] Meeting (@2026-09-22 09:00) !gcal\n- [ ] Meeting (@2026-09-23 10:00) !gcal' }));
    await sync(h);
    const rows = h.source.text.split('\n');
    for (const row of rows) {
        const m = h.metadata(row), task = h.parseTask(row, h.settings), remote = h.server.events.get(m.eventId);
        assert.equal(remote.extendedProperties.private.ogrsTaskId, m.id);
        assert.equal(remote.start.dateTime.slice(0,10), task.date);
    }
    assert.equal(h.server.active().length,2);
});
test('pull relocates a task by ID after a line is inserted', async t => {
    const gate = deferred(), reached = deferred();
    const h = stop(t, fixture({ text: linked(), send: async (p,s) => {
        const r=await s.send(p); reached.resolve(); await gate.promise; return r;
    } })); h.server.seed(ID, 'existing', { summary:'Remote' });
    const run=h.engine.pull(h.source); await reached.promise;
    h.source.text='- [ ] Unrelated (@2026-10-01 17:00)\n'+h.source.text;
    gate.resolve(); await run;
    assert.match(h.source.text.split('\n')[0],/Unrelated/);
    assert.match(h.source.text.split('\n')[1],/Remote/);
});
test('pull does not overwrite an edit made during the request', async t => {
    const gate=deferred(),reached=deferred();
    const h=stop(t,fixture({text:linked(),send:async(p,s)=>{const r=await s.send(p);reached.resolve();await gate.promise;return r;}}));
    h.server.seed(ID,'existing',{summary:'Remote'});
    const run=h.engine.pull(h.source);await reached.promise;
    h.source.text=h.source.text.replace('Meeting','Local edit');gate.resolve();await run;
    assert.match(h.source.text,/Local edit/);
    assert.equal(h.settings.syncState[ID],undefined);
});
test('changing active source cannot redirect an update writeback', async t => {
    const gate=deferred(), reached=deferred();
    const h=stop(t,fixture({send:async(p,s)=>{const r=await s.send(p);reached.resolve();await gate.promise;return r;}}));
    await h.engine.scan(h.source);await reached.promise;
    const other=memorySource('Unrelated note','other.md');await h.engine.scan(other);
    gate.resolve();await h.engine.idle();
    assert.match(h.source.text,/<!-- gcal:/);assert.equal(other.text,'Unrelated note');
});
test('lost create response retries the same deterministic event', async t => {
    let first=true;
    const h=stop(t,fixture({send:async(p,s)=>{const r=await s.send(p);if(first){first=false;throw Object.assign(Error('Lost response'),{retryable:true});}return r;}}));
    await sync(h);assert.equal(h.server.active().length,1);assert.match(h.source.text,/gcal-syncing/);
    await h.advance(2000);await h.engine.idle();
    assert.equal(h.server.active().length,1);assert.doesNotMatch(h.source.text,/gcal-syncing/);
});
test('editing after a lost create response updates the committed original event', async t => {
    let first=true;
    const h=stop(t,fixture({send:async(p,s)=>{const r=await s.send(p);if(first){first=false;throw Object.assign(Error('Lost response'),{retryable:true});}return r;}}));
    await sync(h);h.source.text=h.source.text.replace('09:00','11:00');await sync(h);
    assert.equal(h.server.active().length,1);
    assert.equal(h.server.active()[0].start.dateTime,'2026-09-22T03:00:00.000Z');
});
test('permanent errors are not retried automatically', async t => {
    const h=stop(t,fixture({send:async()=>{throw Object.assign(Error('Bad credentials'),{retryable:false});}}));
    await sync(h);await sync(h);await h.advance(100000);await h.engine.idle();
    assert.equal(h.requests.length,1);assert.equal(h.timers.size,0);
    await sync(h,true);assert.equal(h.requests.length,2);
});
test('transient retries have backoff and a finite attempt limit', async t => {
    const h=stop(t,fixture({send:async()=>{throw Object.assign(Error('Offline'),{retryable:true});}}));
    await sync(h);
    for(const ms of [2000,10000,30000,100000]){await h.advance(ms);await h.engine.idle();}
    assert.equal(h.requests.length,4);assert.equal(h.timers.size,0);
    assert.equal(Object.values(h.settings.failures)[0].terminal,true);
});
test('delete API failure preserves the task link and the event', async t => {
    const h=stop(t,fixture({text:linked('',true)}));h.server.seed(ID);
    h.server.inject((_url,options)=>options.method==='delete'?{status:503}:null);
    await sync(h);
    assert.equal(h.server.active().length,1);assert.doesNotMatch(h.source.text,/gcal-done/);
    assert.equal(h.settings.failures[ID].terminal,false);
    h.server.inject(null);await h.advance(2000);await h.engine.idle();
    assert.equal(h.server.active().length,0);assert.match(h.source.text,/gcal-done/);
});
test('update API failure never creates a replacement event', async t => {
    const h=stop(t,fixture({text:linked()}));h.server.seed(ID);
    h.server.inject((_u,o)=>o.method==='patch'?{status:503}:null);
    await sync(h,true);
    assert.equal(h.server.active().length,1);
    assert.equal(h.server.calls.filter(c=>c.method==='post').length,0);
});
test('lookup errors do not mark an existing event as deleted', async t => {
    const h=stop(t,fixture({text:linked()}));h.server.seed(ID);
    h.server.inject(url=>url.endsWith('/events/existing')?{status:503}:null);
    await h.engine.pull(h.source);
    assert.doesNotMatch(h.source.text,/gcal-deleted/);assert.match(h.source.text,/gcal: existing/);
});
test('all supported date forms preserve remote time on pull', async t => {
    const forms=['(@2026-09-22 09:00)','2026-09-22 09:00','⏳ 2026-09-22 09:00','📅 2026-09-22 09:00','⏰ 09:00 📅 2026-09-22'];
    for(const form of forms){
        const h=stop(t,fixture({text:'- [ ] Meeting '+form+' <!-- gcal-task: '+ID+' --> <!-- gcal: existing -->'}));
        h.server.seed(ID,'existing',{start:{dateTime:'2026-09-23T03:30:00Z'}});
        await h.engine.pull(h.source);
        const task=h.parseTask(h.source.text,h.settings);
        assert.equal(task.date,'2026-09-23');assert.equal(task.time,'11:30');
    }
});
test('a remote all-day event is not converted back to default time', async t => {
    const h=stop(t,fixture({text:linked()}));h.server.seed(ID,'existing',{start:{date:'2026-09-23'},end:{date:'2026-09-24'}});
    await h.engine.pull(h.source);assert.equal(h.parseTask(h.source.text,h.settings).time,null);
    await sync(h);assert.equal(h.requests.filter(p=>p.action==='update').length,0);
});
test('reopening a deleted completed task creates a new generation', async t => {
    const h=stop(t,fixture());await sync(h);
    h.source.text=h.source.text.replace('[ ]','[x]');await sync(h);assert.equal(h.server.active().length,0);
    h.source.text=h.source.text.replace('[x]','[ ]');await sync(h);
    assert.equal(h.server.active().length,1);assert.match(h.source.text,/gcal-cycle: 1/);
});
test('reopening a marked-done task restores the same event and reminders', async t => {
    const h=stop(t,fixture({settings:{completeAction:'markDone'}}));await sync(h);
    const id=h.metadata(h.source.text).eventId;
    h.source.text=h.source.text.replace('[ ]','[x]');await sync(h);
    assert.equal(h.server.events.get(id).reminders.overrides.length,0);
    h.source.text=h.source.text.replace('[x]','[ ]');await sync(h);
    assert.equal(h.metadata(h.source.text).eventId,id);
    assert.equal(h.server.events.get(id).summary,'Meeting');assert.equal(h.server.events.get(id).reminders.overrides[0].minutes,15);
});
test('a v2 pending task recovers after restart without duplicating', async t => {
    const h=stop(t,fixture());await sync(h);
    const m=h.metadata(h.source.text), text='- [ ] Meeting (@2026-09-22 09:00) <!-- gcal-task: '+m.id+' --> <!-- gcal-syncing -->';
    const restarted=stop(t,fixture({text,send:p=>h.server.send(p)}));await sync(restarted);
    assert.equal(h.server.active().length,1);assert.match(restarted.source.text,/<!-- gcal:/);
});
test('old syncing without an ID is not blindly recreated', async t => {
    const h=stop(t,fixture({text:'- [ ] Meeting (@2026-09-22 09:00) <!-- gcal-syncing -->'}));await sync(h);
    assert.equal(h.requests.length,0);assert.match(h.source.text,/gcal-syncing/);
});
test('code blocks and completed unlinked tasks never create events', async t => {
    const fence=String.fromCharCode(96).repeat(3);
    const h=stop(t,fixture({text:fence+'md\n- [ ] Example (@2026-09-22 09:00) !gcal\n'+fence+'\n- [x] Done (@2026-09-22 09:00) !gcal\nprose 2026-09-22 !gcal'}));
    await sync(h);assert.equal(h.requests.length,0);assert.doesNotMatch(h.source.text,/gcal-task/);
});
test('invalid date, time and settings cause no remote writes', async t => {
    for(const text of ['- [ ] Task (@2026-02-30 09:00) !gcal','- [ ] Task (@2026-09-22 25:00) !gcal']){
        const h=stop(t,fixture({text}));await sync(h);assert.equal(h.requests.length,0);
    }
    const h=stop(t,fixture({settings:{reminderMinutes:50000}}));await sync(h);assert.equal(h.requests.length,0);
});
test('zero-minute and disabled reminders are explicitly supported by REST', async t => {
    for(const value of [0,-1]){
        const h=stop(t,fixture({settings:{reminderMinutes:value}}));await sync(h);
        const overrides=h.server.active()[0].reminders.overrides;
        assert.equal(overrides.length,value===-1?0:1);if(value===0)assert.equal(overrides[0].minutes,0);
    }
});
test('removing a task during creation cleans up the newly created event', async t => {
    const gate=deferred(),reached=deferred();let first=true;
    const h=stop(t,fixture({send:async(p,s)=>{const r=await s.send(p);if(first){first=false;reached.resolve();await gate.promise;}return r;}}));
    await h.engine.scan(h.source);await reached.promise;h.source.text='';gate.resolve();await h.engine.idle();
    assert.equal(h.server.active().length,0);
});
test('stopping the engine cancels retries and prevents late note writes', async t => {
    const gate=deferred(),reached=deferred();
    const h=stop(t,fixture({send:async(p,s)=>{const r=await s.send(p);reached.resolve();await gate.promise;return r;}}));
    await h.engine.scan(h.source);await reached.promise;const before=h.source.text;
    h.engine.stop();gate.resolve();await h.engine.idle();assert.equal(h.source.text,before);assert.equal(h.timers.size,0);
});
test('duplicate task IDs are rejected before mutation', async t => {
    const h=stop(t,fixture({text:linked()+'\n'+linked()}));h.server.seed(ID);
    await sync(h,true);assert.equal(h.requests.length,0);
});
test('authentication happens before any Calendar API request', () => {
    const s=backend();const result=s.post({protocol:2,action:'ping',secret:'wrong'},false);
    assert.equal(result.code,'UNAUTHORIZED');assert.equal(s.calls.length,0);
});
test('server pins calendar and rejects events belonging to other tasks', () => {
    const s=backend();s.seed('2'.repeat(32));
    const result=s.post({action:'complete',taskId:ID,eventId:'existing',completeMode:'delete',calendarName:'Other'});
    assert.equal(result.code,'OWNERSHIP');assert.equal(s.active().length,1);
    assert.ok(s.calls.every(c=>c.suffix.startsWith('/calendars/test-calendar')));
});
test('ping is read-only and validates the configured calendar', () => {
    const s=backend();const result=s.post({action:'ping'});
    assert.equal(result.status,'success');assert.equal(s.active().length,0);
    assert.ok(s.calls.every(c=>c.method==='get'));
    s.properties.CALENDAR_ID='missing';assert.equal(s.post({action:'ping'}).status,'error');
});
test('legacy event adoption requires explicit server allowlist', () => {
    const s=backend();s.seed(null,'legacy',{iCalUID:'legacy@google.com',extendedProperties:{}});
    assert.equal(s.post({action:'adopt',taskId:ID,eventId:'legacy@google.com'}).code,'LEGACY_NOT_ALLOWED');
    s.properties.LEGACY_EVENT_IDS='legacy@google.com';
    assert.equal(s.post({action:'adopt',taskId:ID,eventId:'legacy@google.com'}).status,'success');
    assert.equal(s.events.get('legacy').extendedProperties.private.ogrsTaskId,ID);
});
test('invalid server payload is rejected before creating any event', () => {
    const s=backend();
    const result=s.post({action:'create',taskId:ID,title:'Task',date:'2026-02-30',time:'09:00',timeZone:'Asia/Shanghai',durationMinutes:30,reminderMinutes:15});
    assert.equal(result.code,'INVALID_REQUEST');assert.equal(s.active().length,0);assert.equal(s.calls.filter(c=>c.method==='post').length,0);
});
test('server refuses stale ETags and never replaces missing events on update', () => {
    const s=backend();s.seed(ID);
    const request={action:'update',taskId:ID,eventId:'existing',title:'New',date:'2026-09-22',time:'10:00',timeZone:'Asia/Shanghai',durationMinutes:30,reminderMinutes:15,expectedEtag:'stale'};
    assert.equal(s.post(request).code,'CONFLICT');
    request.eventId='missing';assert.equal(s.post(request).code,'NOT_FOUND');assert.equal(s.active().length,1);
});
test('all-day dates remain date-only and duration is configurable', async t => {
    const h=stop(t,fixture({text:'- [ ] Meeting 📅 2026-09-22 !gcal',settings:{treatAllDayAsTimed:false}}));await sync(h);
    assert.equal(h.server.active()[0].start.date,'2026-09-22');assert.equal(h.server.active()[0].end.date,'2026-09-23');
    const timed=stop(t,fixture({settings:{defaultDuration:90}}));await sync(timed);
    const event=timed.server.active()[0];assert.equal(Date.parse(event.end.dateTime)-Date.parse(event.start.dateTime),90*60000);
});
test('DST gaps are rejected instead of silently moving the reminder', () => {
    const s=backend();const result=s.post({action:'create',taskId:ID,title:'Gap',date:'2026-03-08',time:'02:30',timeZone:'America/Los_Angeles',durationMinutes:30,reminderMinutes:15});
    assert.equal(result.code,'INVALID_REQUEST');assert.equal(s.active().length,0);
});
test('source adapter writes the original file after the editor changes tabs', async () => {
    const c=loadClient(), plugin=new c.Plugin(), file={path:'a.md'}, other={path:'b.md'};
    const view=new c.api.MarkdownView();view.file=other;view.editor={getValue:()=> 'OTHER',replaceRange:()=>assert.fail('must not write other tab')};
    let stored='ORIGINAL';
    plugin.sources=new WeakMap();plugin.stopped=false;
    plugin.app={workspace:{iterateAllLeaves:fn=>fn({view})},vault:{read:async()=>stored,process:async(_file,fn)=>{assert.equal(_file,file);stored=fn(stored);}}};
    const source=plugin.source(file);await source.transform(text=>text+' UPDATED');assert.equal(stored,'ORIGINAL UPDATED');
});
test('non-JSON webhook responses produce a controlled error', () => {
    const c=loadClient();assert.throws(()=>c.readJson({text:'<html>login</html>'}),/非 JSON/);
});

test('completion after a lost creation response resolves and removes the committed event', async t => {
    let drop=true;
    const h=stop(t,fixture({send:async(p,s)=>{
        const r=await s.send(p);
        if(drop&&p.action==='create'){drop=false;throw Object.assign(Error('Lost create response'),{retryable:true});}
        return r;
    }}));await sync(h);assert.equal(h.server.active().length,1);
    h.source.text=h.source.text.replace('[ ]','[x]');await sync(h);
    assert.equal(h.server.active().length,0);assert.match(h.source.text,/gcal-done/);
    assert.equal(Object.keys(h.settings.failures).length,0);
});

test('checked pending creates recover after restart without leaving a reminder behind', async t => {
    const h=stop(t,fixture({text:'- [x] Meeting (@2026-09-22 09:00) <!-- gcal-task: '+ID+' --> <!-- gcal-syncing -->'}));
    await sync(h);assert.equal(h.server.active().length,0);assert.match(h.source.text,/gcal-done/);
});

test('lost update replay tolerates reminder property ordering in Google responses', async t => {
    let drop=false;
    const h=stop(t,fixture({send:async(p,s)=>{
        const r=await s.send(p);
        if(drop&&p.action==='update'){
            drop=false;s.events.get(r.eventId).reminders.overrides=[{minutes:p.reminderMinutes,method:'popup'}];
            throw Object.assign(Error('Lost update response'),{retryable:true});
        }
        return r;
    }}));await sync(h);drop=true;h.source.text=h.source.text.replace('09:00','10:00');await sync(h);
    await h.advance(2000);await h.engine.idle();
    assert.equal(Object.keys(h.settings.failures).length,0);
});

test('lost update response can be acknowledged without a false ETag conflict', async t => {
    let drop=false;
    const h=stop(t,fixture({send:async(p,s)=>{
        const r=await s.send(p);
        if(drop&&p.action==='update'){drop=false;throw Object.assign(Error('Lost update response'),{retryable:true});}
        return r;
    }}));await sync(h);drop=true;h.source.text=h.source.text.replace('09:00','10:00');await sync(h);
    assert.equal(h.server.active()[0].start.dateTime,'2026-09-22T02:00:00.000Z');
    await h.advance(2000);await h.engine.idle();
    assert.equal(Object.keys(h.settings.failures).length,0);assert.equal(h.server.active().length,1);
});
test('lost markDone response can be acknowledged without a false ETag conflict', async t => {
    let drop=false;
    const h=stop(t,fixture({settings:{completeAction:'markDone'},send:async(p,s)=>{
        const r=await s.send(p);
        if(drop&&p.action==='complete'){drop=false;throw Object.assign(Error('Lost completion response'),{retryable:true});}
        return r;
    }}));await sync(h);drop=true;h.source.text=h.source.text.replace('[ ]','[x]');await sync(h);
    await h.advance(2000);await h.engine.idle();
    assert.match(h.source.text,/gcal-done/);assert.equal(Object.keys(h.settings.failures).length,0);
});
test('external changes after a lost update are still a conflict', async t => {
    let drop=false;
    const h=stop(t,fixture({send:async(p,s)=>{
        const r=await s.send(p);
        if(drop&&p.action==='update'){
            drop=false;const e=s.events.get(r.eventId);e.summary='Externally changed';e.etag='outside';
            throw Object.assign(Error('Lost update response'),{retryable:true});
        }return r;
    }}));await sync(h);drop=true;h.source.text=h.source.text.replace('09:00','10:00');await sync(h);
    await h.advance(2000);await h.engine.idle();
    assert.equal(h.server.active()[0].summary,'Externally changed');
    assert.equal(Object.values(h.settings.failures)[0].code,'CONFLICT');
});
test('restart does not reset exhausted retry state', async t => {
    const h=stop(t,fixture({send:async()=>{throw Object.assign(Error('Invalid deployment'),{retryable:false});}}));await sync(h);
    const restarted=stop(t,fixture({text:h.source.text,settings:JSON.parse(JSON.stringify(h.settings))}));
    await sync(restarted);assert.equal(restarted.requests.length,0);
    await sync(restarted,true);assert.equal(restarted.server.active().length,1);
});
test('settings changes while a request is running are followed up', async t => {
    const reached=deferred(),gate=deferred();let first=true;
    const h=stop(t,fixture({send:async(p,s)=>{const r=await s.send(p);if(first){first=false;reached.resolve();await gate.promise;}return r;}}));
    await h.engine.scan(h.source);await reached.promise;h.settings.reminderMinutes=0;gate.resolve();await h.engine.idle();
    assert.equal(h.server.active()[0].reminders.overrides[0].minutes,0);
});
test('pull skips a locally dirty task before any remote request', async t => {
    const h=stop(t,fixture());await sync(h);h.source.text=h.source.text.replace('09:00','11:00');
    const count=h.requests.length;await h.engine.pull(h.source);
    assert.equal(h.requests.length,count);assert.match(h.source.text,/11:00/);
});
test('confirmed remote deletion requires explicit recreation', async t => {
    const h=stop(t,fixture());await sync(h);
    const old=h.metadata(h.source.text).eventId;h.server.events.get(old).status='cancelled';
    await h.engine.pull(h.source);assert.match(h.source.text,/gcal-deleted/);
    await sync(h);assert.equal(h.server.active().length,0);
    await sync(h,true);assert.equal(h.server.active().length,1);assert.notEqual(h.metadata(h.source.text).eventId,old);
});
test('an event query permission error is not interpreted as deletion', async t => {
    const h=stop(t,fixture({text:linked()}));h.server.seed(ID);
    h.server.inject(url=>url.endsWith('/events/existing')?{status:403}:null);
    await h.engine.pull(h.source);assert.doesNotMatch(h.source.text,/gcal-deleted/);
});
test('pull converts timed events to all-day and back without stale time fields', async t => {
    const h=stop(t,fixture());await sync(h);let event=h.server.active()[0];
    h.source.text=h.source.text.replace('(@2026-09-22 09:00)','(@2026-09-22)')+' <!-- gcal-all-day -->';
    await sync(h);event=h.server.active()[0];assert.equal(event.start.date,'2026-09-22');assert.equal(event.start.dateTime,null);
    h.source.text=h.source.text.replace('(@2026-09-22)','(@2026-09-22 10:00)');await sync(h);
    event=h.server.active()[0];assert.equal(event.start.date,null);assert.equal(event.start.dateTime,'2026-09-22T02:00:00.000Z');
});
