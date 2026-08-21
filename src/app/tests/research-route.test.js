import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const mainSource = await readFile(new URL("../main.js", import.meta.url), "utf8");
const indexSource = await readFile(new URL("../../../index.html", import.meta.url), "utf8");

test("main integrates exact Research navigation and delegates the modular shell", () => {
  assert.match(mainSource, /href="#\/research"/);
  assert.match(mainSource, /i18n\.t\("nav\.research"\)/);
  assert.match(mainSource, /if \(state\.route === "research"\) \{\s*renderResearchShell\(\)/);
  assert.match(mainSource, /\$\{state\.research\.render\(\)\}/);
  assert.match(mainSource, /state\.research\.afterRender\(\)/);
  assert.match(mainSource, /state\.route === "research" && await state\.research\.handleClick/);
  assert.match(mainSource, /state\.route === "research" && await state\.research\.handleChange/);
});

test("route changes stop playback and the Research shell has one delegated main content", () => {
  assert.match(mainSource, /if \(nextRoute === state\.route\) return;\s*stopPlayback\(false\)/);
  const shellMatch = mainSource.match(/function renderResearchShell\(\) \{([\s\S]*?)\n\}/);
  assert.ok(shellMatch);
  assert.equal((shellMatch[1].match(/id="main-content"/g) ?? []).length, 0);
  assert.match(shellMatch[1], /state\.research\.render\(\)/);
});

test("Learn and Sandbox use APG tabs with roving keyboard behavior and one tabpanel", () => {
  assert.match(mainSource, /class="route-tab-list" role="tablist"/);
  assert.match(mainSource, /id="learn-route-tab"[^>]*role="tab"[^>]*aria-controls="main-content"[^>]*aria-selected=/);
  assert.match(mainSource, /id="sandbox-route-tab"[^>]*role="tab"[^>]*aria-controls="main-content"[^>]*aria-selected=/);
  assert.match(mainSource, /tabindex="\$\{state\.route === "learn" \? "0" : "-1"\}"/);
  assert.match(mainSource, /tabindex="\$\{state\.route === "sandbox" \? "0" : "-1"\}"/);
  assert.match(mainSource, /role="tabpanel" aria-labelledby="\$\{routeIsLearn \? "learn-route-tab" : "sandbox-route-tab"\}"/);
  assert.match(mainSource, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.match(mainSource, /tabs\[nextIndex\]\.click\(\)/);
});

test("full rerenders preserve stable focus and scroll while intentional route changes target headings", () => {
  assert.match(mainSource, /document\.activeElement\?\.dataset\?\.focusKey/);
  assert.match(mainSource, /const scrollPositions = captureScrollPositions\(app\);[\s\S]*app\.innerHTML = markup/);
  assert.match(mainSource, /restoreScrollPositions\(app, scrollPositions\)/);
  assert.match(mainSource, /assignStableFocusKeys\(app\)/);
  assert.match(mainSource, /pendingFocusKey = routeHeadingFocusKey\(nextRoute\)/);
  assert.match(mainSource, /focusTarget\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(mainSource, /renderLinkedCharts\(chartContainer,[\s\S]*finally \{\s*restoreViewState\(\)/);
  assert.match(mainSource, /state\.research\.afterRender\(\);\s*\} finally \{\s*restoreViewState\(\)/);
  assert.match(mainSource, /requestFocus\(key\) \{\s*pendingFocusKey = key/);
  assert.match(mainSource, /data-focus-key="action-language"/);
  assert.match(mainSource, /data-focus-key="mobile-\$\{panel\}"/);
  assert.match(mainSource, /data-scroll-key="experiment-panel"/);
  assert.match(mainSource, /data-scroll-key="explain-panel"/);
  assert.match(mainSource, /data-scroll-key="trajectory-table"/);
  assert.match(mainSource, /data-scroll-key="course-progress"/);
});

test("document metadata, fatal reload, and reduced-motion playback are accessible", () => {
  assert.match(indexSource, /class="skip-link"[^>]*data-focus-key="skip-link"/);
  assert.match(mainSource, /document\.documentElement\.lang = i18n\.locale/);
  assert.match(mainSource, /skipLink\.textContent = i18n\.t\("app\.skipToMain"\)/);
  assert.match(mainSource, /document\.title = `\$\{i18n\.t\("app\.title"\)\} · \$\{routeLabel\}`/);
  assert.match(mainSource, /data-action="reload"/);
  assert.doesNotMatch(mainSource, /onclick=/);
  assert.doesNotMatch(indexSource, /onclick=/);
  assert.match(mainSource, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(mainSource, /if \(event\.matches\) stopPlayback\(\)/);
  assert.match(mainSource, /if \(reducedMotionQuery\.matches\)/);
});

test("main does not embed Stage 4 view implementation or alter Stage 3 chart delegation", () => {
  assert.doesNotMatch(mainSource, /function renderResearchWorkspace/);
  assert.match(mainSource, /renderLinkedCharts\(chartContainer/);
  assert.match(mainSource, /serializeChartDashboard\(chartContainer, payload\.manifest\)/);
});
