"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const PressureData = require("../android/app/src/main/assets/data.js");
const source = fs.readFileSync(path.resolve(__dirname, "../android/app/src/main/assets/app.js"), "utf8");

const oldRecord = Object.freeze({
  id: "existing-reading", at: "2024-09-20T08:30:12.000Z",
  sys: 118, dia: 76, pulse: 64, note: "Существующая запись"
});
const csv = "timestamp;systolic;diastolic;pulse;note\r\n" +
  "2024-09-21T08:30:00Z;122;80;67;Утреннее измерение\r\n" +
  "2024-09-21T18:45:00Z;120;78;66;Вечернее измерение\r\n";

function openDiary(raw = JSON.stringify({ records: [oldRecord] })) {
  const writes = [];
  const requests = [];
  const handlers = new Map();
  let failWrites = false;
  let persisted = raw;
  const root = {
    dataset: { demo: "false" }, innerHTML: "",
    addEventListener(type, handler) { handlers.set(type, handler); },
    dispatchEvent() {}
  };
  const window = { Android: { importCsv(requestId) { requests.push(requestId); } } };
  const context = vm.createContext({
    PressureData, window,
    document: { getElementById() { return root; }, querySelector() { return null; } },
    localStorage: {
      getItem() { return persisted; },
      setItem(key, value) {
        if (failWrites) throw new Error("QuotaExceededError");
        writes.push({ key, value }); persisted = value;
      }
    },
    CustomEvent: class CustomEvent {}
  });
  vm.runInContext(source, context, { filename: "app.js" });
  function click(attribute, value = "") {
    const name = attribute.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const button = {
      dataset: { [name]: value }, disabled: false,
      hasAttribute(candidate) { return candidate === attribute; }
    };
    handlers.get("click")({ target: { closest(selector) { assert.equal(selector, "button"); return button; } } });
  }
  function begin() {
    click("data-page", "settings");
    click("data-import");
    return requests[requests.length - 1];
  }
  function receive(text = csv, name = "измерения.csv", requestId = requests[requests.length - 1]) {
    window.pressureReceiveCsv({ requestId, text, name });
  }
  return {
    root, window, writes, requests, handlers, click, begin, receive,
    state() { return root.pressureDiary.getState(); },
    persisted() { return persisted; },
    failWrites(value) { failWrites = value; }
  };
}

test("CSV selection previews records without writing, and cancelling discards the preview", () => {
  const diary = openDiary();
  const original = diary.persisted();
  assert.equal(typeof diary.handlers.get("change"), "function");
  assert.equal(typeof diary.handlers.get("submit"), "function");
  diary.begin();
  assert.equal(diary.requests.length, 1, "Import must invoke the native file picker");
  diary.receive();
  assert.match(diary.root.innerHTML, /Утреннее измерение/);
  assert.match(diary.root.innerHTML, /data-import-confirm/);
  assert.equal(diary.state().count, 1);
  assert.equal(diary.writes.length, 0);
  diary.click("data-import-cancel");
  assert.equal(diary.state().page, "settings");
  assert.equal(diary.state().count, 1);
  assert.equal(diary.persisted(), original);
  assert.equal(diary.writes.length, 0);
  // A stale confirm action cannot revive a cancelled preview.
  diary.click("data-import-confirm");
  assert.equal(diary.writes.length, 0);
});

test("confirming CSV appends all new records in one write and retains existing records", () => {
  const diary = openDiary();
  diary.begin();
  diary.receive();
  diary.click("data-import-confirm");
  assert.equal(diary.writes.length, 1, "The whole batch is persisted atomically");
  const saved = JSON.parse(diary.writes[0].value);
  assert.equal(diary.writes[0].key, "pressure-diary-v1");
  assert.equal(saved.records.length, 3);
  assert.deepEqual(saved.records.find(record => record.id === oldRecord.id), oldRecord);
  assert.deepEqual(saved.records.filter(record => record.id !== oldRecord.id).map(record => [record.sys, record.dia, record.pulse, record.note]), [
    [122, 80, 67, "Утреннее измерение"], [120, 78, 66, "Вечернее измерение"]
  ]);
  assert.equal(new Set(saved.records.map(record => record.id)).size, 3);
  assert.equal(diary.state().page, "history");
  assert.equal(diary.state().count, 3);
  assert.match(diary.root.innerHTML, /Добавлено измерений: 2/);
});

test("importing the same CSV again does not add or save duplicate readings", () => {
  const diary = openDiary();
  diary.begin(); diary.receive(); diary.click("data-import-confirm");
  const original = diary.persisted();
  diary.begin(); diary.receive();
  assert.match(diary.root.innerHTML, /Новых измерений нет/);
  assert.doesNotMatch(diary.root.innerHTML, /data-import-confirm/);
  diary.click("data-import-confirm");
  assert.equal(diary.state().count, 3);
  assert.equal(diary.writes.length, 1);
  assert.equal(diary.persisted(), original);
});

test("one invalid CSV row prevents the entire import, including valid rows", () => {
  const diary = openDiary();
  const original = diary.persisted();
  diary.begin();
  diary.receive(csv + "2024-09-22T08:30:00Z;120;80;not-a-number;Ошибка\r\n");
  assert.match(diary.root.innerHTML, /Файл не импортирован/);
  assert.match(diary.root.innerHTML, /Строка 4:/);
  assert.doesNotMatch(diary.root.innerHTML, /data-import-confirm/);
  diary.click("data-import-confirm");
  assert.equal(diary.state().count, 1);
  assert.equal(diary.writes.length, 0);
  assert.equal(diary.persisted(), original);
});

test("failed persistence leaves memory and saved records unchanged and allows preview retry", () => {
  const diary = openDiary();
  const original = diary.persisted();
  diary.begin(); diary.receive(); diary.failWrites(true);
  diary.click("data-import-confirm");
  assert.equal(diary.state().page, "import");
  assert.equal(diary.state().count, 1, "Failed writes must not update in-memory readings");
  assert.equal(diary.persisted(), original);
  assert.equal(diary.writes.length, 0);
  assert.match(diary.root.innerHTML, /Не удалось сохранить запись/);
  assert.match(diary.root.innerHTML, /Утреннее измерение/);
  assert.match(diary.root.innerHTML, /data-import-confirm/);
  diary.failWrites(false);
  diary.click("data-import-confirm");
  assert.equal(diary.writes.length, 1);
  assert.equal(diary.state().count, 3);
  assert.equal(diary.state().page, "history");
  assert.equal(JSON.parse(diary.persisted()).records.length, 3);
  assert.doesNotMatch(diary.root.innerHTML, /Не удалось сохранить запись/);
});

test("CSV import cannot overwrite a corrupted diary even if an enabled click is dispatched", () => {
  for (const raw of ['{"records":[BROKEN', '{"records":"invalid"}']) {
    const diary = openDiary(raw);
    diary.begin();
    assert.equal(diary.state().page, "settings");
    assert.match(diary.root.innerHTML, /data-import disabled/);
    assert.match(diary.root.innerHTML, /Не удалось прочитать дневник/);
    assert.equal(diary.requests.length, 0);
    diary.receive(csv, "данные.csv", "1");
    diary.click("data-import-confirm");
    assert.equal(diary.writes.length, 0);
    assert.equal(diary.persisted(), raw);
  }
});

test("late picker callbacks are ignored after cancellation and cannot replace a newer preview", () => {
  const diary = openDiary();
  const firstRequest = diary.begin();
  diary.click("data-import-cancel");
  diary.receive(csv, "cancelled.csv", firstRequest);
  assert.equal(diary.state().page, "settings");
  assert.doesNotMatch(diary.root.innerHTML, /cancelled\.csv/);
  const secondRequest = diary.begin();
  assert.notEqual(secondRequest, firstRequest);
  diary.receive(csv, "stale.csv", firstRequest);
  assert.match(diary.root.innerHTML, /Выбираем и проверяем файл/);
  assert.doesNotMatch(diary.root.innerHTML, /stale\.csv/);
  diary.receive(csv, "current.csv", secondRequest);
  assert.match(diary.root.innerHTML, /current\.csv/);
  assert.equal(diary.writes.length, 0);
  assert.equal(diary.state().count, 1);
});

test("CSV filename and note are escaped as text in preview HTML", () => {
  const diary = openDiary();
  const name = '<svg onload="alert(1)">&.csv';
  const note = '<img src=x onerror="alert(2)"> & "quoted"';
  const maliciousCsv = "timestamp;systolic;diastolic;pulse;note\n" +
    '2024-09-21T08:30:00Z;122;80;67;"' + note.replace(/"/g, '""') + '"\n';
  diary.begin(); diary.receive(maliciousCsv, name);
  assert.match(diary.root.innerHTML, /data-import-confirm/);
  assert.ok(diary.root.innerHTML.includes('&lt;svg onload=&quot;alert(1)&quot;&gt;&amp;.csv'));
  assert.ok(diary.root.innerHTML.includes('&lt;img src=x onerror=&quot;alert(2)&quot;&gt; &amp; &quot;quoted&quot;'));
  assert.doesNotMatch(diary.root.innerHTML, /<svg onload|<img src=x/);
  assert.equal(diary.writes.length, 0);
});

test("native file-picker cancellation returns to settings without changing saved records", () => {
  const diary = openDiary();
  const original = diary.persisted();
  const requestId = diary.begin();
  assert.equal(diary.state().page, "import");
  diary.window.pressureReceiveCsv({ requestId, cancelled: true });
  assert.equal(diary.state().page, "settings");
  assert.doesNotMatch(diary.root.innerHTML, /Выбираем и проверяем файл/);
  assert.equal(diary.state().count, 1);
  assert.equal(diary.writes.length, 0);
  assert.equal(diary.persisted(), original);
});

test("native picker errors allow another selection and stale callbacks cannot replace it", () => {
  const diary = openDiary();
  const firstRequest = diary.begin();
  diary.click("data-import-cancel");
  const busyRequest = diary.begin();
  diary.window.pressureReceiveCsv({ requestId: busyRequest, error: "Выбор файла уже открыт." });
  assert.equal(diary.state().page, "import");
  assert.match(diary.root.innerHTML, /Выбор файла уже открыт/);
  assert.doesNotMatch(diary.root.innerHTML, /data-import-confirm/);
  diary.receive(csv, "old.csv", firstRequest);
  assert.doesNotMatch(diary.root.innerHTML, /old\.csv/);
  assert.match(diary.root.innerHTML, /Выбор файла уже открыт/);
  diary.click("data-import");
  const retryRequest = diary.requests[diary.requests.length - 1];
  assert.notEqual(retryRequest, busyRequest);
  diary.receive(csv, "retry.csv", retryRequest);
  assert.match(diary.root.innerHTML, /retry\.csv/);
  assert.match(diary.root.innerHTML, /data-import-confirm/);
  assert.doesNotMatch(diary.root.innerHTML, /Выбор файла уже открыт/);
  assert.equal(diary.writes.length, 0);
  assert.equal(diary.state().count, 1);
});
