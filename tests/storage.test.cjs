"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const PressureData = require("../android/app/src/main/assets/data.js");
const source = fs.readFileSync(path.resolve(__dirname, "../android/app/src/main/assets/app.js"), "utf8");

function openDiary(raw) {
  const writes = [];
  const handlers = new Map();
  const root = {
    dataset: { demo: "false" },
    innerHTML: "",
    addEventListener(type, handler) { handlers.set(type, handler); },
    dispatchEvent() {}
  };
  const context = vm.createContext({
    PressureData,
    document: {
      getElementById() { return root; },
      querySelector() { return null; }
    },
    localStorage: {
      getItem() { return raw; },
      setItem(key, value) { writes.push({ key, value }); }
    },
    FormData: class FormData {
      constructor(form) { this.form = form; }
      *[Symbol.iterator]() {
        for (const [name, element] of Object.entries(this.form.elements)) yield [name, element.value];
      }
    },
    window: {},
    CustomEvent: class CustomEvent {}
  });
  vm.runInContext(source, context, { filename: "app.js" });
  function submitNewRecord() {
    const values = { sys: "124", dia: "81", pulse: "67", at: new Date(Date.now() - 60000).toISOString(), note: "Новое измерение" };
    const error = { textContent: "" };
    const hints = Object.fromEntries(Object.keys(values).map(name => [name, { textContent: "", classList: { toggle() {} } }]));
    const form = {
      elements: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value, setAttribute() {} }])),
      querySelector(selector) {
        if (selector === "[data-form-error]") return error;
        const match = /^\[data-error="([a-z]+)"\]$/.exec(selector);
        if (match) return hints[match[1]];
        if (selector === "[aria-invalid=true]") return null;
        throw new Error("Unexpected form selector: " + selector);
      }
    };
    assert.equal(PressureData.validate(values).ok, true, "The storage check must submit valid readings");
    const submit = handlers.get("submit");
    assert.equal(typeof submit, "function", "The application's real submit handler must be registered");
    submit({ preventDefault() {}, target: form });
    return error.textContent;
  }
  return { root, writes, submitNewRecord };
}

function assertProtected(raw) {
  const { root, writes, submitNewRecord } = openDiary(raw);
  assert.match(root.innerHTML, /Не удалось прочитать дневник/);
  const error = submitNewRecord();
  assert.deepEqual(writes, [], "Saving a new reading must not replace unreadable saved records");
  assert.match(error, /Не удалось прочитать дневник/, "The form must explain why the new reading was not saved");
  assert.match(root.innerHTML, /Не удалось прочитать дневник/, "The read error must remain visible");
}

test("submitting a new reading cannot overwrite corrupted diary JSON", () => {
  // Positive control: the same public action really reaches persistence on a healthy store.
  const healthy = openDiary(JSON.stringify({ records: [] }));
  assert.equal(healthy.submitNewRecord(), "");
  assert.equal(healthy.writes.length, 1);
  const saved = JSON.parse(healthy.writes[0].value);
  assert.equal(saved.records.length, 1);
  assert.equal(saved.records[0].sys, 124);
  assert.equal(saved.records[0].note, "Новое измерение");

  assertProtected('{"records":[BROKEN');
});

test("submitting a new reading cannot overwrite valid JSON with invalid diary records", () => {
  assertProtected(JSON.stringify({ records: "not-an-array", theme: "clarity" }));
  assertProtected(JSON.stringify({
    records: [
      { id: "valid", sys: 120, dia: 80, pulse: 65, at: "2026-09-21T08:35:00Z", note: "Сохранённая запись" },
      { id: "damaged", sys: 122, dia: 82, at: "2026-09-21T08:40:00Z" }
    ],
    theme: "clarity"
  }));
});

test("readings saved with a legacy design survive loading and the next save", () => {
  const legacyRecord = { id: "legacy-reading", sys: 120, dia: 80, pulse: 65, at: "2024-09-21T08:35:00Z", note: "Старая запись" };
  const diary = openDiary(JSON.stringify({ records: [legacyRecord], theme: "night" }));
  assert.equal(diary.root.pressureDiary.getState().count, 1);
  assert.equal(diary.submitNewRecord(), "");
  assert.equal(diary.writes.length, 1);
  const saved = JSON.parse(diary.writes[0].value);
  assert.equal(saved.records.length, 2);
  assert.deepEqual(saved.records.find(record => record.id === legacyRecord.id), legacyRecord);
  assert.equal(saved.records.find(record => record.id !== legacyRecord.id).sys, 124);
  assert.equal(Object.hasOwn(saved, "theme"), false);
});
