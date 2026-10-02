"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const modulePath = path.resolve(__dirname, "../android/app/src/main/assets/data.js");
const D = require(modulePath);
const now = new Date("2030-01-01T00:00:00Z");
const header = "Дата;Время;Верхнее;Нижнее;Пульс;Заметка";
const english = "date,time,sys,dia,pulse,note";
const row = "21.09.2026;08:30;120;80;65;После отдыха";
const parse = (csv, existing = []) => D.importCsv(csv, existing, now);

test("own CSV imports without changing notes and repeated import is idempotent at minute precision", () => {
  const original = [{ id: "original", sys: 120, dia: 80, pulse: 65, at: new Date(2026, 8, 21, 8, 30, 49, 123).toISOString(), note: ' Утро; "отдых", спокойно\r\nВторая строка ' }];
  const snapshot = JSON.stringify(original);
  const csv = D.toCsv(original);
  const imported = parse(csv);
  assert.equal(imported.ok, true);
  assert.equal(imported.delimiter, ";");
  assert.equal(imported.total, 1);
  assert.equal(imported.records[0].note, original[0].note);
  assert.equal(Date.parse(imported.records[0].at), Math.floor(Date.parse(original[0].at) / 60000) * 60000);
  assert.equal(imported.records[0].sys, 120);
  assert.notEqual(imported.records[0].id, original[0].id);
  for (const existing of [original, imported.records]) {
    const again = parse(csv, existing);
    assert.equal(again.ok, true);
    assert.equal(again.duplicates, 1);
    assert.deepEqual(again.records, []);
  }
  assert.equal(JSON.stringify(original), snapshot);
});

test("explicit note format round-trips protected formulas and literal apostrophes without collisions", () => {
  const notes = ["=1+1", "'=1+1", "''=1+1", " +1", "-1", "@sum", "\ttext", "\r\nline", "'ordinary", "plain", "a".repeat(500), "=" + "a".repeat(499)];
  const original = notes.map((note, i) => ({ id: "n" + i, sys: 120, dia: 80, pulse: 65, at: new Date(2026, 8, 21, 8, 30, i).toISOString(), note }));
  const csv = D.toCsv(original);
  assert.ok(csv.startsWith("\uFEFF" + header + ";Формат заметки\r\n"));
  assert.ok(csv.includes(";escaped-v1"));
  assert.ok(csv.includes(";literal-v1"));
  const imported = parse(csv);
  assert.equal(imported.ok, true, JSON.stringify(imported.errors));
  assert.equal(imported.records.length, notes.length);
  assert.deepEqual(imported.records.map(r => r.note).sort(), notes.slice().sort());
  const again = parse(csv, imported.records);
  assert.equal(again.duplicates, notes.length);
  assert.deepEqual(again.records, []);
  const exact = parse(header + ";Формат заметки\n21.09.2026;08:30;120;80;65;'=1+1;literal-v1", [original[0]]);
  assert.equal(exact.records.length, 1, "Explicit literal apostrophe must not collapse into a formula note");
});

test("legacy formula escaping is only a dedup fallback against existing records and does not edit imported text", () => {
  const legacy = header + "\n21.09.2026;08:30;120;80;65;'=1+1";
  assert.equal(parse(legacy).records[0].note, "'=1+1");
  const existing = [{ id: "one", at: new Date(2026, 8, 21, 8, 30, 45).toISOString(), sys: 120, dia: 80, pulse: 65, note: "=1+1" }];
  const imported = parse(legacy, existing);
  assert.equal(imported.duplicates, 1);
  assert.deepEqual(imported.records, []);
  assert.equal(existing[0].note, "=1+1");
  const distinct = parse(legacy + "\n21.09.2026;08:30;120;80;65;=1+1");
  assert.equal(distinct.records.length, 2, "Different unmarked notes within one file remain distinct");
});

test("semicolon, comma and tab imports allow reordered English aliases, optional notes and quoted separators", () => {
  for (const delimiter of [";", ",", "\t"]) {
    const csv = [" pulse ", "Diastolic", "DATE", "Systolic", "Time", "NOTES"].join(delimiter) + "\n" +
      ["65", "80", "2026-09-21", "120", "08:30:59", '"Содержит; запятую, табуляцию\tи ""кавычки"""'].join(delimiter);
    const result = parse(csv);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.delimiter, delimiter);
    assert.equal(result.records[0].note, 'Содержит; запятую, табуляцию\tи "кавычки"');
    assert.equal(new Date(result.records[0].at).getSeconds(), 59);
  }
  assert.equal(parse("date,time,sys,dia,pulse\n2026-09-21,08:30,120,80,65").records[0].note, "");
});

test("timestamp aliases accept ISO offsets and deduplicate the same absolute minute", () => {
  const csv = "timestamp,sys,dia,pulse,notes\n2026-09-21T08:30:59+05:00,120,80,65,одинаково\n2026-09-21T03:30:00Z,120,80,65,одинаково";
  const result = parse(csv);
  assert.equal(result.ok, true);
  assert.equal(result.records[0].at, "2026-09-21T03:30:59.000Z");
  assert.equal(result.records.length, 1);
  assert.equal(result.duplicates, 1);
  for (const alias of ["at", "datetime"]) assert.equal(parse(csv.replace("timestamp", alias)).ok, true);
});

test("notes and multiline physical row numbers survive BOM, blank lines and CRLF", () => {
  const csv = "\uFEFF\r\n  \r\n" + header + '\r\n21.09.2026;08:30;120;80;65;"Первая\r\nВторая"\r\n\r\n31.02.2026;08:30;120;80;65;Неверная дата\r\n';
  const result = parse(csv);
  assert.equal(result.total, 2);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map(e => e.line), [7]);
  assert.deepEqual(result.records, [], "Any invalid record prevents a partial import");
  const good = parse(csv.replace("31.02.2026", "28.02.2026"));
  assert.equal(good.records[0].note, "Первая\r\nВторая");
  assert.equal(good.records.length, 2);
});

test("malformed quoting is rejected with the physical source line", () => {
  for (const [content, line] of [
    ['21.09.2026;08:30;120;80;65;"unterminated\ntext', 2],
    ['21.09.2026;08:30;120;80;65;plain"quote', 2],
    ['21.09.2026;08:30;120;80;65;"closed"garbage', 2],
    ['21.09.2026;08:30;120;80;65;"one\ntwo"garbage', 3]
  ]) {
    const result = parse(header + "\n" + content);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].line, line);
    assert.deepEqual(result.records, []);
  }
});

test("missing, duplicate and competing required column definitions are rejected", () => {
  for (const csv of [
    "", "\n \n", row,
    "date,time,sys,dia\n2026-09-21,08:30,120,80",
    "date,time,sys,systolic,dia,pulse\n2026-09-21,08:30,120,120,80,65",
    "date,time,sys,dia,pulse,pulse\n2026-09-21,08:30,120,80,65,65",
    "date,time,timestamp,sys,dia,pulse\n2026-09-21,08:30,2026-09-21T08:30Z,120,80,65",
    "at,datetime,sys,dia,pulse\n2026-09-21T08:30Z,2026-09-21T08:30Z,120,80,65",
    "date,time,sys,dia,pulse,note,notes\n2026-09-21,08:30,120,80,65,a,b",
    "date,time,sys,dia,pulse,note_format\n2026-09-21,08:30,120,80,65,literal-v1"
  ]) {
    const result = parse(csv);
    assert.equal(result.ok, false, csv);
    assert.ok(result.errors.length);
    assert.deepEqual(result.records, []);
  }
});

test("invalid dates, times, numbers, future readings and note limits use form validation", () => {
  const baseline = ["2026-09-21", "08:30", "120", "80", "65", "note"];
  for (const [index, value] of [
    [0, "09/21/2026"], [0, "21/09/2026"], [0, "2026-02-30"], [0, "2025-02-29"], [0, "2026-13-01"],
    [0, "2031-01-01"], [1, "24:00"], [1, "08:60"], [1, "08:30:60"], [1, "8:30"],
    [2, "120.5"], [2, "1e2"], [2, "49"], [2, "301"], [2, ""], [3, "120"], [4, "0"], [5, "a".repeat(501)]
  ]) {
    const values = baseline.slice(); values[index] = value;
    const result = parse(english + "\n" + values.join(","));
    assert.equal(result.ok, false, `${index}: ${value}`);
    assert.equal(result.errors[0].line, 2);
  }
  for (const at of ["2026-09-21", "2026-02-30T08:30Z", "2026-09-21T08:30+25:00"]) {
    assert.equal(parse("at,sys,dia,pulse\n" + at + ",120,80,65").ok, false);
  }
  assert.equal(parse(english + "\n2024-02-29,08:30,120,80,65," + "a".repeat(500)).ok, true);
});

test("unknown or inconsistent note encoding markers are rejected without guessing", () => {
  for (const [note, marker] of [["'=1", "unknown"], ["'=1", ""], ["=1", "escaped-v1"], ["'ordinary", "escaped-v1"]]) {
    const result = parse(header + ";Формат заметки\n21.09.2026;08:30;120;80;65;" + note + ";" + marker);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].line, 2);
    assert.deepEqual(result.records, []);
  }
});

test("dedup includes note and every reading field and never mutates input records", () => {
  const existing = Object.freeze([Object.freeze({ id: "kept", at: new Date(2026, 8, 21, 8, 30, 40).toISOString(), sys: 120, dia: 80, pulse: 65, note: "same" })]);
  const result = parse(header + "\n" + [
    "21.09.2026;08:30:00;120;80;65;same",
    "21.09.2026;08:30:59;120;80;65;same",
    "21.09.2026;08:30;120;80;65;different",
    "21.09.2026;08:30;121;80;65;same",
    "21.09.2026;08:30;120;81;65;same",
    "21.09.2026;08:30;120;80;66;same",
    "21.09.2026;08:31;120;80;65;same",
    "21.09.2026;08:31:55;120;80;65;same"
  ].join("\n"), existing);
  assert.equal(result.ok, true);
  assert.equal(result.total, 8);
  assert.equal(result.duplicates, 3);
  assert.equal(result.records.length, 5);
  assert.equal(existing.length, 1);
  assert.equal(existing[0].id, "kept");
  assert.equal(new Set(result.records.map(r => r.id)).size, 5);
});

test("oversized input and too many measurement rows each return exactly one error", () => {
  const large = parse("x".repeat(1024 * 1024 + 1));
  assert.equal(large.ok, false);
  assert.equal(large.errors.length, 1);
  assert.deepEqual(large.records, []);
  const many = parse(header + "\n" + Array(5001).fill(row).join("\n"));
  assert.equal(many.ok, false);
  assert.equal(many.errors.length, 1);
  assert.match(many.errors[0].message, /5000/);
  assert.deepEqual(many.records, []);
  const boundary = parse(header + "\n" + Array(5000).fill(row).join("\n"));
  assert.equal(boundary.ok, true);
  assert.equal(boundary.total, 5000);
  assert.equal(boundary.records.length, 1);
  assert.equal(boundary.duplicates, 4999);
});

test("header-only exports explain that no measurements exist and uneven rows are rejected", () => {
  const empty = parse(D.toCsv([]));
  assert.equal(empty.ok, false);
  assert.match(empty.errors[0].message, /нет измерений/);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.records, []);
  for (const content of ["21.09.2026;08:30;120;80;65", row + ";extra", ";;;;;"]) {
    assert.equal(parse(header + "\n" + content).ok, false);
  }
});

test("NUL is rejected anywhere with its physical line number", () => {
  for (const [csv, line] of [["\u0000" + header + "\n" + row, 1], [header + "\r\n" + row + "\u0000", 2], [header + '\n21.09.2026;08:30;120;80;65;"первая\n\u0000вторая"', 3]]) {
    const result = parse(csv);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].line, line);
    assert.deepEqual(result.records, []);
  }
});

test("local date/time uses the device timezone, ISO offsets remain absolute, and nonexistent local DST times fail", () => {
  const script = `const assert=require('node:assert/strict'); const D=require(${JSON.stringify(modulePath)});
    const now=new Date('2030-01-01T00:00:00Z');
    const local=D.importCsv('date,time,sys,dia,pulse\\n2026-09-21,08:30,120,80,65',[],now);
    assert.equal(local.records[0].at,'2026-09-21T12:30:00.000Z');
    const offset=D.importCsv('at,sys,dia,pulse\\n2026-09-21T08:30+05:00,120,80,65',[],now);
    assert.equal(offset.records[0].at,'2026-09-21T03:30:00.000Z');
    const dst=D.importCsv('date,time,sys,dia,pulse\\n2026-03-08,02:30,120,80,65',[],now);
    assert.equal(dst.ok,false);`;
  execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: "America/New_York" } });
});
