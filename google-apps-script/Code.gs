/**
 * GCal Reminder Sync - Google Apps Script Webhook
 * 
 * 适用于 Obsidian GCal Reminder Sync 插件的服务端脚本
 * 支持操作：create (新建), update (原地修改), delete/complete (完成/删除), pull (双向拉取)
 */

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: "ok",
    message: "GCal Reminder Sync Webhook 运行正常！"
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action || "create";
    var calendarName = data.calendarName;

    // 1. 获取目标日历（若配置专属日历名称则使用专属日历，否则使用默认主日历）
    var cal = CalendarApp.getDefaultCalendar();
    if (calendarName) {
      var cals = CalendarApp.getCalendarsByName(calendarName);
      if (cals.length > 0) cal = cals[0];
    }

    function findEvent(id) {
      if (!id) return null;
      var evt = null;
      try { evt = cal.getEventById(id); } catch(err) {}
      if (!evt) {
        try { evt = CalendarApp.getEventById(id); } catch(err) {}
      }
      return evt;
    }

    // ================= 1. PULL 双向回传查询 =================
    if (action === "pull") {
      var eventIds = data.eventIds || [];
      var resultEvents = {};
      var timeZone = Session.getScriptTimeZone();

      for (var i = 0; i < eventIds.length; i++) {
        var id = eventIds[i];
        var evt = findEvent(id);
        if (evt) {
          try {
            var start = evt.getStartTime();
            var isAllDay = evt.isAllDayEvent();
            var dateStr = Utilities.formatDate(start, timeZone, "yyyy-MM-dd");
            var timeStr = isAllDay ? null : Utilities.formatDate(start, timeZone, "HH:mm");
            resultEvents[id] = {
              exists: true,
              title: evt.getTitle(),
              date: dateStr,
              time: timeStr,
              isAllDay: isAllDay
            };
          } catch(err) {
            resultEvents[id] = { exists: false };
          }
        } else {
          resultEvents[id] = { exists: false };
        }
      }

      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        action: "pulled",
        events: resultEvents
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // ================= 2. DELETE / COMPLETE 标记完成 =================
    if (action === "delete" || action === "complete") {
      var eventId = data.eventId;
      var mode = data.completeMode || "delete";
      var evt = findEvent(eventId);

      if (evt) {
        if (mode === "markDone") {
          try {
            var currTitle = evt.getTitle();
            if (currTitle.indexOf("✔️") !== 0) {
              evt.setTitle("✔️ " + currTitle);
            }
            evt.removeAllReminders(); // 撤销提醒，防止已完成日程误响
          } catch(e) {}
          return ContentService.createTextOutput(JSON.stringify({
            status: "success",
            action: "marked_done",
            eventId: eventId
          })).setMimeType(ContentService.MimeType.JSON);
        } else {
          try {
            evt.deleteEvent();
          } catch(e) {
            // 已在回收站或已被远程删除，均属预期内的成功完成状态
          }
          return ContentService.createTextOutput(JSON.stringify({
            status: "success",
            action: "deleted",
            eventId: eventId
          })).setMimeType(ContentService.MimeType.JSON);
        }
      } else {
        return ContentService.createTextOutput(JSON.stringify({
          status: "success",
          action: "already_deleted",
          eventId: eventId
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // ================= 3. UPDATE 原地全量更新 =================
    if (action === "update") {
      var eventId = data.eventId;
      var title = data.title || "Obsidian 提醒任务";
      var dateStr = data.date;
      var timeStr = data.time;
      var reminderMinutes = data.reminderMinutes !== undefined ? data.reminderMinutes : 15;
      var evt = findEvent(eventId);

      if (!evt) {
        return createNewEvent(cal, title, dateStr, timeStr, reminderMinutes);
      }

      try {
        evt.setTitle(title);
        if (timeStr) {
          var startTime = new Date(dateStr + "T" + timeStr + ":00");
          var endTime = new Date(startTime.getTime() + 30 * 60 * 1000);
          evt.setTime(startTime, endTime);
        } else {
          evt.setAllDayDate(new Date(dateStr));
        }

        evt.removeAllReminders();
        if (reminderMinutes >= 0) {
          if (!timeStr && reminderMinutes < 60) {
            // 全天日程起始为 00:00，避免前一天深夜 23:45 响铃，全天默认优化为前一天上午 09:00
            evt.addPopupReminder(900);
          } else {
            evt.addPopupReminder(reminderMinutes);
          }
        }

        return ContentService.createTextOutput(JSON.stringify({
          status: "success",
          action: "updated",
          eventId: eventId
        })).setMimeType(ContentService.MimeType.JSON);
      } catch(e) {
        // 若修改已被远程删除的日程，自动重新创建
        return createNewEvent(cal, title, dateStr, timeStr, reminderMinutes);
      }
    }

    // ================= 4. CREATE 新建日程 =================
    var title = data.title || "Obsidian 提醒任务";
    var dateStr = data.date;
    var timeStr = data.time;
    var reminderMinutes = data.reminderMinutes !== undefined ? data.reminderMinutes : 15;
    return createNewEvent(cal, title, dateStr, timeStr, reminderMinutes);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function createNewEvent(cal, title, dateStr, timeStr, reminderMinutes) {
  var newEvent;
  if (timeStr) {
    var startTime = new Date(dateStr + "T" + timeStr + ":00");
    var endTime = new Date(startTime.getTime() + 30 * 60 * 1000);
    newEvent = cal.createEvent(title, startTime, endTime);
    newEvent.removeAllReminders();
    if (reminderMinutes >= 0) {
      newEvent.addPopupReminder(reminderMinutes);
    }
  } else {
    newEvent = cal.createAllDayEvent(title, new Date(dateStr));
    newEvent.removeAllReminders();
    if (reminderMinutes >= 0) {
      if (reminderMinutes < 60) {
        // 全天日程起始为 00:00，若设提前 15 分钟会导致前一天深夜 23:45 响铃。
        // 全天日程自动优化为前一天上午 09:00 (提前 15 小时 = 900 分钟) 提醒
        newEvent.addPopupReminder(900);
      } else {
        newEvent.addPopupReminder(reminderMinutes);
      }
    }
  }

  return ContentService.createTextOutput(JSON.stringify({
    status: "success",
    action: "created",
    eventId: newEvent.getId()
  })).setMimeType(ContentService.MimeType.JSON);
}
