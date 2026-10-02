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
    // Older six-column CSVs cannot distinguish a protective apostrophe from a
    // literal one. Add an explicit format only when protection is necessary.
    var encodedNotes = records.some(function (record) { return safeNote(record.note) !== (record.note == null ? "" : String(record.note)); });
    var rows = ["Дата;Время;Верхнее;Нижнее;Пульс;Заметка" + (encodedNotes ? ";Формат заметки" : "")];
    sortRecords(records).forEach(function (record) {
      var at = new Date(record.at);
      var note = record.note == null ? "" : String(record.note);
      var cells = [
        pad(at.getDate()) + "." + pad(at.getMonth() + 1) + "." + at.getFullYear(),
        pad(at.getHours()) + ":" + pad(at.getMinutes()),
        record.sys, record.dia, record.pulse, safeNote(note)
      ];
      if (encodedNotes) cells.push(safeNote(note) === note ? "literal-v1" : "escaped-v1");
      rows.push(cells.map(csvCell).join(";"));
    });
    return "\uFEFF" + rows.join("\r\n") + "\r\n";
  }

  var csvAliases = Object.freeze({
    "дата": "date", "date": "date",
    "время": "time", "time": "time",
    "верхнее": "sys", "systolic": "sys", "sys": "sys",
    "нижнее": "dia", "diastolic": "dia", "dia": "dia",
    "пульс": "pulse", "pulse": "pulse",
    "заметка": "note", "note": "note", "notes": "note",
    "timestamp": "at", "at": "at", "datetime": "at",
    "формат заметки": "noteFormat", "note_format": "noteFormat"
  });

  function csvAlias(header) {
    var name = header.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(csvAliases, name) ? csvAliases[name] : null;
  }

  function parseCsv(text, delimiter, headerOnly) {
    var rows = [], cells = [], cell = "", state = "start";
    var line = 1, rowLine = 1, quoteLine = 1, rowTouched = false;
    function fail(message, errorLine, tooMany) {
      return { rows: rows, errors: [{ line: errorLine, message: message }], tooMany: !!tooMany };
    }
    function finishRow() {
      cells.push(cell);
      // Ignore physical blank lines, including lines consisting only of spaces.
      // An explicit row of empty CSV cells is still an invalid measurement.
      if (rowTouched || cells.length > 1 || cell.trim()) rows.push({ line: rowLine, cells: cells });
      cells = []; cell = ""; state = "start"; rowTouched = false;
    }
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      var newline = ch === "\r" || ch === "\n";
      if (state === "quoted") {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; }
          else state = "closed";
        } else {
          cell += ch;
          if (newline) {
            if (ch === "\r" && text[i + 1] === "\n") { cell += "\n"; i++; }
            line++;
          }
        }
        continue;
      }
      if (newline) {
        finishRow();
        if (headerOnly && rows.length) return { rows: rows, errors: [] };
        if (rows.length > 5001) return fail("В CSV больше 5000 измерений.", rowLine, true);
        if (ch === "\r" && text[i + 1] === "\n") i++;
        line++; rowLine = line;
      } else if (ch === delimiter) {
        cells.push(cell); cell = ""; state = "start"; rowTouched = true;
      } else if (state === "closed") {
        if (ch !== " " && ch !== "\t") return fail("После закрывающей кавычки ожидается разделитель или конец строки.", line);
      } else if (ch === '"') {
        if (state !== "start") return fail("Кавычка внутри незакавыченного поля CSV.", line);
        state = "quoted"; quoteLine = line; rowTouched = true;
      } else {
        cell += ch; state = "plain";
        if (ch.trim()) rowTouched = true;
      }
    }
    if (state === "quoted") return fail("Незакрытая кавычка в CSV.", quoteLine);
    if (cells.length || cell.length || rowTouched) finishRow();
    if (rows.length > 5001) return fail("В CSV больше 5000 измерений.", rowLine, true);
    return { rows: rows, errors: [] };
  }

  function importCsv(text, existingRecords, now) {
    existingRecords = existingRecords === undefined ? [] : existingRecords;
    now = now === undefined ? new Date() : now;
    var result = { ok: false, records: [], duplicates: 0, errors: [], total: 0, delimiter: "" };
    function error(line, message) { result.errors.push({ line: line, message: message }); }
    if (typeof text !== "string") { error(1, "Не удалось прочитать текст CSV."); return result; }
    if (text.length > 1024 * 1024) { error(1, "CSV превышает ограничение в 1 МиБ символов."); return result; }
    var nul = text.indexOf("\u0000");
    if (nul !== -1) { error(text.slice(0, nul).split(/\r\n|\r|\n/).length, "CSV содержит недопустимый нулевой символ."); return result; }
    text = text.replace(/^\uFEFF/, "");
    var candidates = [";", ",", "\t"].map(function (delimiter) {
      var parsed = parseCsv(text, delimiter, true);
      var header = parsed.rows[0];
      var score = header ? header.cells.reduce(function (sum, name) { return sum + (csvAlias(name) ? 1 : 0); }, 0) : 0;
      return { delimiter: delimiter, score: score, parsed: parsed };
    });
    candidates.sort(function (a, b) { return b.score - a.score; });
    if (!candidates[0].score) {
      var malformed = candidates.find(function (candidate) { return candidate.parsed.errors.length; });
      if (malformed) result.errors = malformed.parsed.errors;
      else error(1, "Нужна строка заголовков CSV: дата, время, верхнее, нижнее и пульс.");
      return result;
    }
    if (candidates[0].score === candidates[1].score) {
      error(candidates[0].parsed.rows[0].line, "Неоднозначный разделитель CSV. Используйте точку с запятой, запятую или табуляцию.");
      return result;
    }
    result.delimiter = candidates[0].delimiter;
    var parsed = parseCsv(text, result.delimiter, false);
    if (parsed.errors.length) { result.errors = parsed.errors; return result; }
    var header = parsed.rows[0], columns = Object.create(null);
    result.total = parsed.rows.length - 1;
    header.cells.forEach(function (name, index) {
      var alias = csvAlias(name);
      if (!alias) return;
      if (columns[alias] !== undefined) error(header.line, "Повторяющийся столбец: " + name.trim() + ".");
      else columns[alias] = index;
    });
    ["sys", "dia", "pulse"].forEach(function (field) {
      if (columns[field] === undefined) error(header.line, "Отсутствует обязательный столбец: " + ({ sys: "Верхнее", dia: "Нижнее", pulse: "Пульс" })[field] + ".");
    });
    if (columns.at !== undefined && (columns.date !== undefined || columns.time !== undefined)) {
      error(header.line, "Укажите либо timestamp, либо отдельные столбцы Дата и Время, без сочетания обоих форматов.");
    } else if (columns.at === undefined && (columns.date === undefined || columns.time === undefined)) {
      error(header.line, "Нужны столбцы Дата и Время или один столбец timestamp.");
    }
    if (columns.noteFormat !== undefined && columns.note === undefined) error(header.line, "Столбец «Формат заметки» требует столбец «Заметка».");
    if (result.errors.length) return result;
    if (!result.total) { error(header.line + 1, "В CSV нет измерений."); return result; }

    function key(record, note) {
      return JSON.stringify([Math.floor(new Date(record.at).getTime() / 60000), record.sys, record.dia, record.pulse, note]);
    }
    var exact = new Set(), legacy = new Set();
    existingRecords.forEach(function (record) {
      var note = record.note == null ? "" : String(record.note);
      exact.add(key(record, note));
      legacy.add(key(record, safeNote(note)));
    });
    parsed.rows.slice(1).forEach(function (row) {
      if (row.cells.length !== header.cells.length) {
        error(row.line, "Количество полей не совпадает с заголовком CSV."); return;
      }
      function value(field) { return columns[field] === undefined ? "" : row.cells[columns[field]]; }
      var at = value("at").trim();
      if (columns.at !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(at)) {
          error(row.line, "В timestamp ожидается дата и время ISO, например 2026-09-21T08:30:00+05:00."); return;
        }
      } else {
        var date = value("date").trim(), time = value("time").trim();
        var localDate = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date);
        if (localDate) date = localDate[3] + "-" + localDate[2] + "-" + localDate[1];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(time)) {
          error(row.line, "Дата должна иметь формат ДД.ММ.ГГГГ или ГГГГ-ММ-ДД, время — ЧЧ:ММ или ЧЧ:ММ:СС."); return;
        }
        at = date + "T" + time;
      }
      var note = value("note");
      if (columns.noteFormat !== undefined) {
        var format = value("noteFormat").trim();
        if (format !== "literal-v1" && format !== "escaped-v1") {
          error(row.line, "Неизвестный формат заметки: ожидается literal-v1 или escaped-v1."); return;
        }
        if (format === "escaped-v1") {
          if (note[0] !== "'" || safeNote(note.slice(1)) !== note) {
            error(row.line, "Заметка не соответствует формату escaped-v1."); return;
          }
          note = note.slice(1);
        }
      }
      var checked = validate({ sys: value("sys"), dia: value("dia"), pulse: value("pulse"), at: at, note: note }, now);
      if (!checked.ok) {
        Object.keys(checked.errors).forEach(function (field) {
          error(row.line, ({ sys: "Верхнее", dia: "Нижнее", pulse: "Пульс", at: "Дата и время", note: "Заметка" })[field] + ": " + checked.errors[field]);
        });
        return;
      }
      var record = checked.record, exactKey = key(record, record.note);
      // Unmarked, older exports are inherently ambiguous. Keep their text
      // intact; only use safeNote as a fallback against pre-existing records.
      if (exact.has(exactKey) || (columns.noteFormat === undefined && legacy.has(key(record, safeNote(record.note))))) {
        result.duplicates++; return;
      }
      exact.add(exactKey);
      result.records.push(record);
    });
    result.ok = result.errors.length === 0;
    if (!result.ok) result.records = [];
    return result;
  }

  return Object.freeze({
    validate: validate,
    sortRecords: sortRecords,
    summarize: summarize,
    periodRecords: periodRecords,
    toCsv: toCsv,
    importCsv: importCsv
  });
});
