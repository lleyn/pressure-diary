"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const modulePath = path.resolve(__dirname, "../android/app/src/main/assets/data.js");
const data = require(modulePath);
const now = new Date("2026-09-21T12:00:00Z");
const input = { sys: "120", dia: "80", pulse: "65", at: "2026-09-21T08:35:00Z", note: "После отдыха" };

test("validates form text, preserves IDs and notes, emits numeric values and ISO time", () => {
  const result = data.validate({ ...input, id: "saved-1", at: "2026-09-21T13:35:00+05:00" }, now);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.record, { id: "saved-1", sys: 120, dia: 80, pulse: 65, at: "2026-09-21T08:35:00.000Z", note: "После отдыха" });
  const a = data.validate(input, now).record;
  const b = data.validate(input, now).record;
  assert.ok(a.id);
  assert.notEqual(a.id, b.id);
});

test("rejects empty, non-integer, coercible and out-of-range readings", () => {
  for (const value of ["", "  ", null, undefined, true, "120.0", "1e2", "0x78", "120 мм", 120.5, NaN, Infinity, 49, 301]) {
    const result = data.validate({ ...input, sys: value }, now);
    assert.equal(result.ok, false, `sys=${String(value)}`);
    assert.ok(result.errors.sys);
    assert.equal(result.record, undefined);
  }
  for (const [field, values] of Object.entries({ dia: [29, 201], pulse: [19, 251] })) {
    for (const value of values) assert.ok(data.validate({ ...input, [field]: value }, now).errors[field]);
  }
  assert.equal(data.validate({ ...input, sys: 50, dia: 30, pulse: 20 }, now).ok, true);
  assert.equal(data.validate({ ...input, sys: 300, dia: 200, pulse: 250 }, now).ok, true);
  assert.ok(data.validate({ ...input, dia: 120 }, now).errors.dia);
  assert.ok(data.validate({ ...input, dia: 121 }, now).errors.dia);
});

test("rejects impossible dates and future timestamps while allowing one minute of clock drift", () => {
  for (const at of ["", "nonsense", "2026-02-30T10:00", "2025-02-29T10:00", "2026-04-31T10:00", "2026-09-21T24:00", "2026-09-21T12:60", "2026-09-21T12:00:60Z", "2026-13-01", "2026-09-00", "2026-09-21T12:01:00.001Z", new Date(NaN)]) {
    assert.ok(data.validate({ ...input, at }, now).errors.at, String(at));
  }
  assert.equal(data.validate({ ...input, at: "2024-02-29T10:00:00Z" }, now).ok, true);
  assert.equal(data.validate({ ...input, at: "2026-09-21T12:01:00Z" }, now).ok, true);
  assert.equal(data.validate({ ...input, at: new Date("2026-09-21T12:00:00Z") }, now).ok, true);
});

test("never silently loses an overlong note", () => {
  assert.equal(data.validate({ ...input, note: "a".repeat(500) }, now).ok, true);
  assert.ok(data.validate({ ...input, note: "a".repeat(501) }, now).errors.note);
  assert.ok(data.validate({ ...input, note: {} }, now).errors.note);
  assert.equal(data.validate({ ...input, note: undefined }, now).record.note, "");
});

test("sorts without mutating storage and calculates rounded averages", () => {
  const records = [
    { sys: 121, dia: 81, pulse: 61, at: "2026-09-20T12:00:00Z" },
    { sys: 120, dia: 80, pulse: 64, at: "2026-09-21T12:00:00Z" }
  ];
  assert.deepEqual(data.sortRecords(records), [records[1], records[0]]);
  assert.equal(records[0].sys, 121);
  assert.deepEqual(data.summarize(records), { count: 2, sys: 121, dia: 81, pulse: 63 });
  assert.deepEqual(data.summarize([]), { count: 0, sys: null, dia: null, pulse: null });
});

test("calendar periods use local midnight, include today, and exclude tomorrow", () => {
  const localNow = new Date(2026, 8, 21, 12);
  const records = [
    { id: "too-old", at: new Date(2026, 8, 14, 23, 59, 59, 999).toISOString() },
    { id: "start", at: new Date(2026, 8, 15, 0).toISOString() },
    { id: "morning", at: new Date(2026, 8, 21, 0).toISOString() },
    { id: "evening", at: new Date(2026, 8, 21, 23, 59, 59, 999).toISOString() },
    { id: "tomorrow", at: new Date(2026, 8, 22, 0).toISOString() }
  ];
  assert.deepEqual(data.periodRecords(records, 7, localNow).map(r => r.id), ["evening", "morning", "start"]);
  assert.deepEqual(data.periodRecords(records, 1, localNow).map(r => r.id), ["evening", "morning"]);
  assert.deepEqual(data.periodRecords(records, 0, localNow), []);
});

test("calendar filtering remains correct across daylight-saving transitions", () => {
  const script = `const assert = require('node:assert/strict');
    const data = require(${JSON.stringify(modulePath)});
    const now = new Date(2026, 2, 9, 12);
    const records = [
      { id: 'before', at: new Date(2026, 2, 7, 23, 59, 59, 999).toISOString() },
      { id: 'start', at: new Date(2026, 2, 8, 0).toISOString() },
      { id: 'today', at: new Date(2026, 2, 9, 0).toISOString() }
    ];
    assert.equal(now.getTimezoneOffset(), 240);
    assert.deepEqual(data.periodRecords(records, 2, now).map(r => r.id), ['today', 'start']);
    assert.equal(data.validate({ sys: 120, dia: 80, pulse: 60, at: '2026-03-08T02:30' }, now).ok, false);`;
  execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: "America/New_York" } });
});

test("CSV has an Excel-compatible BOM, Russian headings, local dates, and safe escaping", () => {
  const at = new Date(2026, 8, 21, 9, 5).toISOString();
  const record = { sys: 120, dia: 80, pulse: 65, at, note: 'Утро; "отдых"\nВторая строка' };
  assert.equal(data.toCsv([record]), '\uFEFFДата;Время;Верхнее;Нижнее;Пульс;Заметка\r\n21.09.2026;09:05;120;80;65;"Утро; ""отдых""\nВторая строка"\r\n');
  for (const note of ["=1+1", "+1+1", "-1+1", "@SUM(A1)", "  =1+1", "\t=1+1", "\n=1+1"]) {
    const csv = data.toCsv([{ ...record, note }]);
    assert.ok(csv.includes("'" + note), JSON.stringify(note));
  }
  assert.equal(data.toCsv([]), "\uFEFFДата;Время;Верхнее;Нижнее;Пульс;Заметка\r\n");
});

test("loads in a browser without CommonJS and generates IDs without crypto", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(modulePath, "utf8"), context);
  const result = context.PressureData.validate(input, now.toISOString());
  assert.equal(result.ok, true);
  assert.match(result.record.id, /^reading-/);
  assert.equal(typeof context.PressureData.toCsv, "function");
});
