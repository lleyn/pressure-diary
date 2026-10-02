(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PressureData = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function integer(value) {
    if (typeof value === "number") return Number.isInteger(value) ? value : NaN;
    if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return NaN;
    var parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : NaN;
  }

  function parseDate(value) {
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
    }
    if (typeof value !== "string") return null;
    // Validate calendar components before parsing: Date alone accepts 30 February.
    var match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value.trim());
    if (!match) return null;
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    var monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1]) return null;
    if (Number(match[4] || 0) > 23 || Number(match[5] || 0) > 59 || Number(match[6] || 0) > 59) return null;
    var date = new Date(value.trim());
    if (!Number.isFinite(date.getTime())) return null;
    // Reject nonexistent local times at a daylight-saving transition.
    if (match[4] && !match[8] && (date.getFullYear() !== year || date.getMonth() !== month - 1 ||
        date.getDate() !== day || date.getHours() !== Number(match[4]) || date.getMinutes() !== Number(match[5]))) return null;
    return date;
  }

  function newId() {
    if (typeof globalThis !== "undefined" && globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return "reading-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function validate(input, now) {
    input = input || {};
    now = now === undefined ? new Date() : new Date(now);
    var errors = {};
    var sys = integer(input.sys);
    var dia = integer(input.dia);
    var pulse = integer(input.pulse);
    // These limits constrain data entry; they are not clinical classifications.
    if (!Number.isFinite(sys) || sys < 50 || sys > 300) errors.sys = "Введите целое число от 50 до 300.";
    if (!Number.isFinite(dia) || dia < 30 || dia > 200) errors.dia = "Введите целое число от 30 до 200.";
    if (!Number.isFinite(pulse) || pulse < 20 || pulse > 250) errors.pulse = "Введите целое число от 20 до 250.";
    if (!errors.sys && !errors.dia && dia >= sys) errors.dia = "Нижнее давление должно быть меньше верхнего.";
    var at = parseDate(input.at);
    if (!at) errors.at = "Укажите корректные дату и время.";
    else if (!Number.isFinite(now.getTime()) || at.getTime() > now.getTime() + 60000) errors.at = "Дата и время не могут быть в будущем.";
    var note = input.note == null ? "" : input.note;
    if (typeof note !== "string") errors.note = "Введите заметку текстом.";
    else if (note.length > 500) errors.note = "Заметка должна содержать не более 500 символов.";
    if (Object.keys(errors).length) return { ok: false, errors: errors };
    return {
      ok: true,
      errors: {},
      record: {
        id: typeof input.id === "string" && input.id.trim() ? input.id : newId(),
        sys: sys,
        dia: dia,
        pulse: pulse,
        at: at.toISOString(),
        note: note
      }
    };
  }

  function sortRecords(records) {
    return records.slice().sort(function (a, b) { return new Date(b.at).getTime() - new Date(a.at).getTime(); });
  }

  function summarize(records) {
    if (!records.length) return { count: 0, sys: null, dia: null, pulse: null };
    var total = records.reduce(function (sum, record) {
      sum.sys += record.sys;
      sum.dia += record.dia;
      sum.pulse += record.pulse;
      return sum;
    }, { sys: 0, dia: 0, pulse: 0 });
    return {
      count: records.length,
      sys: Math.round(total.sys / records.length),
      dia: Math.round(total.dia / records.length),
      pulse: Math.round(total.pulse / records.length)
    };
  }

  function periodRecords(records, days, now) {
    now = now === undefined ? new Date() : new Date(now);
    if (!Number.isInteger(days) || days < 1 || !Number.isFinite(now.getTime())) return [];
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    start.setDate(start.getDate() - days + 1);
    var end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return sortRecords(records.filter(function (record) {
      var at = new Date(record.at).getTime();
      return at >= start.getTime() && at < end.getTime();
    }));
  }

  function pad(value) { return String(value).padStart(2, "0"); }

  function csvCell(value) {
    var text = String(value);
    return /[;"\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function safeNote(note) {
    var text = note == null ? "" : String(note);
    // Excel and other spreadsheet readers may interpret these prefixes as formulas.
    if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return text;
  }

  function toCsv(records) {
    var rows = ["Дата;Время;Верхнее;Нижнее;Пульс;Заметка"];
    sortRecords(records).forEach(function (record) {
      var at = new Date(record.at);
      rows.push([
        pad(at.getDate()) + "." + pad(at.getMonth() + 1) + "." + at.getFullYear(),
        pad(at.getHours()) + ":" + pad(at.getMinutes()),
        record.sys, record.dia, record.pulse, safeNote(record.note)
      ].map(csvCell).join(";"));
    });
    return "\uFEFF" + rows.join("\r\n") + "\r\n";
  }

  return Object.freeze({
    validate: validate,
    sortRecords: sortRecords,
    summarize: summarize,
    periodRecords: periodRecords,
    toCsv: toCsv
  });
});
