/**
 * GCal Reminder Sync protocol 2.
 * Script properties: SYNC_SECRET (>=32 chars), CALENDAR_ID.
 * Enable the Google Calendar API; see README_zh.md before upgrading.
 */
function output(data) {
  return ContentService.createTextOutput(JSON.stringify(Object.assign({ protocol: 2 }, data)))
    .setMimeType(ContentService.MimeType.JSON);
}
function fail(code, message, retryable) {
  var error = new Error(message);
  error.code = code; error.retryable = retryable === true;
  throw error;
}
function doGet() { return output({ status: 'ok', message: 'GCal Reminder Sync v2' }); }
function doPost(e) {
  var lock;
  try {
    var data;
    try { data = JSON.parse(e.postData.contents); }
    catch (_) { fail('INVALID_REQUEST', 'Invalid JSON request', false); }
    var properties = PropertiesService.getScriptProperties();
    var secret = properties.getProperty('SYNC_SECRET') || '';
    if (secret.length < 32) fail('NOT_CONFIGURED', 'Configure SYNC_SECRET (at least 32 characters)', false);
    var supplied = String(data.secret || ''), difference = secret.length ^ supplied.length;
    for (var i = 0; i < secret.length; i++) difference |= secret.charCodeAt(i) ^ (supplied.charCodeAt(i) || 0);
    if (difference !== 0) fail('UNAUTHORIZED', 'Invalid shared secret', false);
    if (data.protocol !== 2) fail('PROTOCOL', 'Upgrade the Obsidian plugin and server together', false);
    var actions = ['ping', 'create', 'update', 'complete', 'pull', 'adopt'];
    if (actions.indexOf(data.action) === -1) fail('INVALID_ACTION', 'Unknown action', false);
    var calendarId = properties.getProperty('CALENDAR_ID');
    if (!calendarId) fail('NOT_CONFIGURED', 'Configure CALENDAR_ID with the exact calendar ID', false);
    // Validate calendar access before interpreting any event-level 404 as deletion.
    var calendar = api('get', '/calendars/' + encodeURIComponent(calendarId));
    var base = '/calendars/' + encodeURIComponent(calendarId) + '/events';
    if (data.action === 'ping') return output({ status: 'success', calendarId: calendar.id, calendarName: calendar.summary });
    lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) fail('BUSY', 'Another sync is running', true);
    if (data.action === 'pull') {
      if (!Array.isArray(data.tasks) || data.tasks.length > 50) fail('INVALID_REQUEST', 'Pull accepts at most 50 tasks', false);
      validateZone(data.timeZone);
      var events = {};
      data.tasks.forEach(function (task) {
        try {
          validateTaskId(task.taskId);
          var event = getEvent(base, task.eventId);
          if (!event) events[task.taskId] = { exists: false };
          else {
            assertOwner(event, task.taskId);
            events[task.taskId] = describe(event, data.timeZone);
          }
        } catch (error) {
          events[task.taskId] = { error: error.message, code: error.code || 'SERVICE_ERROR' };
        }
      });
      return output({ status: 'success', events: events });
    }
    validateTaskId(data.taskId);
    if (data.action === 'adopt') {
      var legacy = getEvent(base, data.eventId);
      if (!legacy) fail('NOT_FOUND', 'Legacy event does not exist', false);
      var owner = (legacy.extendedProperties || {}).private || {};
      if (owner.ogrsTaskId && owner.ogrsTaskId !== data.taskId) fail('OWNERSHIP', 'Event belongs to another task', false);
      if (!owner.ogrsTaskId) {
        var allowed = (properties.getProperty('LEGACY_EVENT_IDS') || '').split(/[\s,]+/);
        if (allowed.indexOf(data.eventId) === -1 && allowed.indexOf(legacy.id) === -1) {
          fail('LEGACY_NOT_ALLOWED', 'Add this legacy event ID to LEGACY_EVENT_IDS before migrating', false);
        }
        legacy = api('patch', base + '/' + encodeURIComponent(legacy.id), {
          extendedProperties: { private: Object.assign({}, owner, { ogrsTaskId: data.taskId, ogrsCycle: '0' }) }
        }, legacy.etag);
      }
      return output({ status: 'success', action: 'adopted', eventId: legacy.id, etag: legacy.etag });
    }
    var resource, event;
    if (data.action === 'create') {
      // Validate the entire event before performing any calendar mutation.
      resource = eventResource(data);
      resource.id = deterministicId(data.taskId, data.cycle || 0);
      resource.extendedProperties = { private: { ogrsTaskId: data.taskId, ogrsCycle: String(data.cycle || 0), ogrsCompleted: 'false' } };
      event = getEvent(base, resource.id);
      if (!event) {
        try { event = api('post', base, resource); }
        catch (error) {
          if (error.code !== 'DUPLICATE') throw error;
          event = getEvent(base, resource.id);
          if (!event) fail('DELETED_GENERATION', 'This task generation was deleted; explicitly reopen or resync it', false);
        }
      }
      assertOwner(event, data.taskId);
      if ((event.extendedProperties.private || {}).ogrsCompleted === 'true') {
        fail('CONFLICT', 'This task is already completed remotely; pull before reopening', false);
      }
      // Return the committed content, including on replay, so an edited retry is not falsely acknowledged.
      return output({ status: 'success', action: 'created', eventId: event.id, etag: event.etag,
        event: describe(event, data.timeZone) });
    }
    if (data.action === 'update') resource = eventResource(data);
    event = getEvent(base, data.eventId);
    if (!event) {
      if (data.action === 'complete') return output({ status: 'success', action: 'already_deleted', eventId: data.eventId });
      fail('NOT_FOUND', 'Event was deleted remotely; pull or explicitly recreate the task', false);
    }
    assertOwner(event, data.taskId);
    var mutation = mutationId(data);
    var replay = event.extendedProperties.private.ogrsLastMutation === mutation;
    if (replay && data.action === 'update' && sameResource(resource, event)) {
      return output({ status: 'success', action: 'updated', eventId: event.id, etag: event.etag,
        event: describe(event, data.timeZone) });
    }
    if (replay && data.action === 'complete' && data.completeMode === 'markDone' &&
        event.extendedProperties.private.ogrsCompleted === 'true' &&
        event.reminders && !event.reminders.useDefault && !(event.reminders.overrides || []).length) {
      return output({ status: 'success', action: 'marked_done', eventId: event.id, etag: event.etag });
    }
    if (data.expectedEtag && data.expectedEtag !== event.etag) fail('CONFLICT', 'Calendar event changed; pull before retrying', false);
    if (data.action === 'complete') {
      if (data.completeMode !== 'delete' && data.completeMode !== 'markDone') fail('INVALID_REQUEST', 'Invalid completion mode', false);
      if (data.completeMode === 'delete') {
        api('delete', base + '/' + encodeURIComponent(event.id), null, event.etag);
        return output({ status: 'success', action: 'deleted', eventId: event.id });
      }
      var title = event.summary || '';
      event = api('patch', base + '/' + encodeURIComponent(event.id), {
        summary: title.indexOf('✔️ ') === 0 ? title : '✔️ ' + title,
        reminders: { useDefault: false, overrides: [] },
        extendedProperties: { private: Object.assign({}, event.extendedProperties.private, { ogrsCompleted: 'true', ogrsLastMutation: mutation }) }
      }, event.etag);
      return output({ status: 'success', action: 'marked_done', eventId: event.id, etag: event.etag });
    }
    resource.extendedProperties = { private: Object.assign({}, event.extendedProperties.private, { ogrsCompleted: 'false', ogrsLastMutation: mutation }) };
    // If-Match prevents overwriting a change made after the read above.
    event = api('patch', base + '/' + encodeURIComponent(event.id), resource, event.etag);
    return output({ status: 'success', action: 'updated', eventId: event.id, etag: event.etag });
  } catch (error) {
    return output({ status: 'error', code: error.code || 'SERVICE_ERROR', message: error.message || 'Service error',
      retryable: error.retryable === true });
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}
function validateTaskId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) fail('INVALID_REQUEST', 'Invalid task ID', false);
}
function mutationId(data) {
  var value = JSON.stringify([data.action, data.taskId, data.eventId, data.title, data.date, data.time,
    data.timeZone, data.durationMinutes, data.reminderMinutes, data.completeMode, data.expectedEtag]);
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value).map(function (b) {
    return ('0' + ((b + 256) % 256).toString(16)).slice(-2);
  }).join('');
}
function sameResource(expected, actual) {
  function instant(value) { return value.date || new Date(value.dateTime).toISOString(); }
  function reminders(value) {
    return (value || []).map(function (item) { return [item.method, item.minutes]; }).sort();
  }
  return expected.summary === actual.summary &&
    instant(expected.start) === instant(actual.start) && instant(expected.end) === instant(actual.end) &&
    actual.reminders && actual.reminders.useDefault === false &&
    JSON.stringify(reminders(expected.reminders.overrides)) === JSON.stringify(reminders(actual.reminders.overrides));
}
function validateZone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 100) fail('INVALID_REQUEST', 'Explicit IANA timezone required', false);
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); Utilities.formatDate(new Date(), zone, 'yyyy-MM-dd'); }
  catch (_) { fail('INVALID_REQUEST', 'Invalid timezone', false); }
}
function deterministicId(taskId, cycle) {
  if (!Number.isSafeInteger(cycle) || cycle < 0) fail('INVALID_REQUEST', 'Invalid task generation', false);
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, taskId + ':' + cycle);
  return 'ogrs' + bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}
function eventResource(data) {
  var date = data.date, time = data.time;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('INVALID_REQUEST', 'Invalid date', false);
  var day = new Date(date + 'T00:00:00Z');
  if (isNaN(day) || day.toISOString().slice(0, 10) !== date) fail('INVALID_REQUEST', 'Invalid calendar date', false);
  validateZone(data.timeZone);
  if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 1000 || /[\r\n]/.test(data.title)) fail('INVALID_REQUEST', 'Invalid title', false);
  if (!Number.isInteger(data.reminderMinutes) || data.reminderMinutes < -1 || data.reminderMinutes > 40320) {
    fail('INVALID_REQUEST', 'Reminder must be -1 or an integer from 0 to 40320', false);
  }
  if (!Number.isInteger(data.durationMinutes) || data.durationMinutes < 1 || data.durationMinutes > 1440) {
    fail('INVALID_REQUEST', 'Duration must be between 1 and 1440 minutes', false);
  }
  var resource = { summary: data.title, reminders: { useDefault: false,
    overrides: data.reminderMinutes < 0 ? [] : [{ method: 'popup', minutes: data.reminderMinutes }] } };
  if (time !== null && time !== undefined && time !== '') {
    if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail('INVALID_REQUEST', 'Invalid time', false);
    var start;
    try { start = Utilities.parseDate(date + ' ' + time, data.timeZone, 'yyyy-MM-dd HH:mm'); }
    catch (_) { fail('INVALID_REQUEST', 'Invalid date/time in timezone', false); }
    if (Utilities.formatDate(start, data.timeZone, 'yyyy-MM-dd HH:mm') !== date + ' ' + time) {
      fail('INVALID_REQUEST', 'This local time does not exist (daylight saving transition)', false);
    }
    resource.start = { date: null, dateTime: start.toISOString(), timeZone: data.timeZone };
    resource.end = { date: null, dateTime: new Date(start.getTime() + data.durationMinutes * 60000).toISOString(), timeZone: data.timeZone };
  } else {
    resource.start = { date: date, dateTime: null, timeZone: null };
    resource.end = { date: new Date(day.getTime() + 86400000).toISOString().slice(0, 10), dateTime: null, timeZone: null };
  }
  return resource;
}
function assertOwner(event, taskId) {
  if (!event.extendedProperties || !event.extendedProperties.private || event.extendedProperties.private.ogrsTaskId !== taskId) {
    fail('OWNERSHIP', 'Event is not linked to this task; migrate explicitly if it is a legacy event', false);
  }
}
function getEvent(base, id) {
  if (typeof id !== 'string' || !id || id.length > 1024) fail('INVALID_REQUEST', 'Missing or invalid event ID', false);
  try {
    var event;
    if (id.indexOf('@') !== -1) {
      var result = api('get', base + '?iCalUID=' + encodeURIComponent(id) + '&maxResults=2');
      var items = (result.items || []).filter(function (item) { return item.status !== 'cancelled'; });
      if (items.length > 1 || (items[0] && items[0].recurrence)) fail('UNSUPPORTED', 'Recurring legacy events require manual migration', false);
      event = items[0] || null;
    } else event = api('get', base + '/' + encodeURIComponent(id));
    return event && event.status !== 'cancelled' ? event : null;
  } catch (error) {
    if (error.code === 'NOT_FOUND') return null;
    throw error;
  }
}
function describe(event, zone) {
  var allDay = !!event.start.date, privateData = (event.extendedProperties || {}).private || {};
  return { exists: true, eventId: event.id, etag: event.etag, title: event.summary || '',
    date: allDay ? event.start.date : Utilities.formatDate(new Date(event.start.dateTime), zone, 'yyyy-MM-dd'),
    time: allDay ? null : Utilities.formatDate(new Date(event.start.dateTime), zone, 'HH:mm'),
    completed: privateData.ogrsCompleted === 'true' };
}
function api(method, path, body, etag) {
  var options = { method: method, muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } };
  if (etag) options.headers['If-Match'] = etag;
  if (body) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
  var response;
  try { response = UrlFetchApp.fetch('https://www.googleapis.com/calendar/v3' + path, options); }
  catch (_) { fail('NETWORK', 'Google Calendar request failed', true); }
  var status = response.getResponseCode(), content = response.getContentText(), result = {};
  try { if (content) result = JSON.parse(content); } catch (_) { fail('INVALID_RESPONSE', 'Google returned invalid JSON', true); }
  if (status >= 200 && status < 300) return result;
  var reasons = ((result.error || {}).errors || []).map(function (item) { return item.reason; });
  var retry = status === 429 || status >= 500 || reasons.some(function (reason) {
    return ['rateLimitExceeded', 'userRateLimitExceeded', 'backendError'].indexOf(reason) !== -1;
  });
  var code = status === 404 || status === 410 ? 'NOT_FOUND' : status === 409 ? 'DUPLICATE' : status === 412 ? 'CONFLICT' : 'GOOGLE_API';
  fail(code, 'Google Calendar HTTP ' + status + ': ' + ((result.error || {}).message || 'request failed'), retry);
}
