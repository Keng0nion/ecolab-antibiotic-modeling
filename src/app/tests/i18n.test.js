import test from "node:test";
import assert from "node:assert/strict";
import { MESSAGES, createI18n } from "../i18n.js";

test("Chinese and English dictionaries contain identical keys", () => {
  assert.deepEqual(Object.keys(MESSAGES["zh-CN"]).sort(), Object.keys(MESSAGES.en).sort());
});

test("translations interpolate values and localized registry text", () => {
  const i18n = createI18n("en");
  assert.equal(i18n.t("course.step", { current: 2, total: 7 }), "Step 2 of 7");
  assert.equal(i18n.text({ en: "English", "zh-CN": "中文" }), "English");
  i18n.locale = "zh-CN";
  assert.equal(i18n.text({ en: "English", "zh-CN": "中文" }), "中文");
});

test("Stage 5 accessibility and Research states are bilingual and use held-out terminology", () => {
  assert.equal(MESSAGES.en["app.skipToMain"], "Skip to main content");
  assert.equal(MESSAGES["zh-CN"]["app.skipToMain"], "跳到主要内容");
  assert.equal(MESSAGES.en["fatal.reload"], "Reload");
  assert.equal(MESSAGES["zh-CN"]["fatal.reload"], "重新加载");
  assert.match(MESSAGES.en["research.analysis.cancelling"], /Cancelling/);
  assert.match(MESSAGES["zh-CN"]["research.analysis.cancelling"], /正在取消/);
  assert.match(MESSAGES.en["research.results.validationUnit"], /Locked held-out unit/);
  assert.match(MESSAGES["zh-CN"]["research.results.validationUnit"], /锁定留出单元/);
  for (const messages of Object.values(MESSAGES)) {
    assert.doesNotMatch(Object.values(messages).join("\n"), /independent validation unit|独立验证单元/i);
  }
});
