# Real Dataset Test Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the optional Figshare source-workbook integration test skip with an explicit reason when the public source workbooks are absent, while failing clearly for a partial or corrupt source set.

**Architecture:** Keep the full workbook admission test intact. Check source availability before reading; skip only if all three external source workbooks are absent. A partial set remains an error so incomplete downloads do not look like successful validation.

**Tech Stack:** Node.js ES modules, `node:test`, existing filesystem APIs.

## Global Constraints

- Do not add third-party dependencies.
- Preserve Ecolab app version `6.0.0`.
- Do not modify or stage unrelated existing index changes.

---

### Task 1: Gate the raw-source integration test

**Files:**
- Modify: `src/tests/real-dataset.test.js`

- [x] Reproduce the unavailable-source `ENOENT` failure before changing the test.
- [x] Check all three workbook paths before opening them.
- [x] Call `t.skip()` with an explicit public-repository/source-download explanation only when all three are absent.
- [x] Fail with a missing-filenames message when only part of the source set exists.
- [x] Run the test directly and through `npm test`; both report one skip and zero failures for this integration test.

