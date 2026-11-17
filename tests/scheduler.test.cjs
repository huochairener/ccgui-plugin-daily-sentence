const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8")
  .replace("export default function activate", "function activate")
  .replace(
    'ctx.ui.registerSettingsSection({ key: "daily-sentence-settings", label: () => "每日一句", component: SettingsSection });',
    'ctx.ui.registerSettingsSection({ key: "daily-sentence-settings", label: () => "每日一句", component: SettingsSection });\n' +
      "globalThis.__test = { normalize, nextDue, isFresh, retryDelay, PRESETS, configIssue, fetchSentence };"
  ) +
  "\nactivate({ react: {}, ui: { registerStatusBarItem() {}, registerSettingsSection() {} } });";
const context = { URL };
vm.runInNewContext(source, context, { filename: "main.js" });
const scheduler = context.__test;

test("normalize migrates the legacy daily flag and trims configuration fields", () => {
  assert.equal(scheduler.normalize({ daily: false, url: " https://example.com ", textField: " data.text " }).interval, "off");
  assert.equal(scheduler.normalize({ daily: true }).interval, "daily");
  assert.equal(scheduler.normalize({ url: "  ", textField: "  " }).url, "https://v1.hitokoto.cn/");
  assert.equal(scheduler.normalize({ url: "x", fromField: " from " }).fromField, "from");
});

test("the anime preset requests animation and manga categories", () => {
  const preset = scheduler.PRESETS.find((item) => item.id === "hitokoto-anime");
  assert.deepEqual(new URL(preset.url).searchParams.getAll("c"), ["a", "b"]);
});

test("fetchSentence rejects a host that is not on the manifest mirror allowlist", async () => {
  await assert.rejects(
    scheduler.fetchSentence({ url: "https://unapproved.example/sentence", textField: "text" }),
    /尚未授权/
  );
  assert.match(scheduler.configIssue("https://unapproved.example/sentence"), /尚未授权/);
  assert.match(scheduler.configIssue("ftp://v1.hitokoto.cn/"), /仅支持 http\/https/);
});

test("nextDue skips a minute boundary less than one second away", () => {
  const now = new Date(2025, 0, 2, 12, 34, 59, 500).getTime();
  const expected = new Date(2025, 0, 2, 12, 36, 0, 0).getTime();
  assert.equal(scheduler.nextDue("minute", now, now), expected);
});

test("nextDue schedules after now when the cached timestamp is stale", () => {
  const now = new Date(2025, 0, 2, 12, 34, 10, 0).getTime();
  const oldAt = new Date(2025, 0, 2, 11, 0, 0, 0).getTime();
  const expected = new Date(2025, 0, 2, 12, 35, 0, 0).getTime();
  assert.equal(scheduler.nextDue("minute", oldAt, now), expected);
});

test("nextDue skips midnight when it is less than one second away", () => {
  const now = new Date(2025, 0, 2, 23, 59, 59, 500).getTime();
  const expected = new Date(2025, 0, 4, 0, 0, 0, 0).getTime();
  assert.equal(scheduler.nextDue("daily", now, now), expected);
});

test("isFresh expires an interval cache exactly at its next boundary", () => {
  const at = new Date(2025, 0, 2, 12, 0, 0, 100).getTime();
  const rec = { at };
  assert.equal(scheduler.isFresh(rec, "minute", at + 59_899), true);
  assert.equal(scheduler.isFresh(rec, "minute", at + 59_900), false);
});

test("isFresh expires a daily cache when the local calendar day changes", () => {
  const beforeMidnight = new Date(2025, 0, 2, 23, 59, 59, 999).getTime();
  const afterMidnight = new Date(2025, 0, 3, 0, 0, 0, 0).getTime();
  const rec = { at: beforeMidnight, date: "2025-01-02" };
  assert.equal(scheduler.isFresh(rec, "daily", beforeMidnight), true);
  assert.equal(scheduler.isFresh(rec, "daily", afterMidnight), false);
});

test("retryDelay grows exponentially and respects the selected interval cap", () => {
  assert.equal(scheduler.retryDelay("hour", 10), 30 * 60 * 1000);
  assert.equal(scheduler.retryDelay("5min", 10), 5 * 60 * 1000);
  assert.equal(scheduler.retryDelay("minute", 3), 60 * 1000);
});
