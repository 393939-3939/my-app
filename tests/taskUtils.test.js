import test from "node:test";
import assert from "node:assert/strict";
import { clampProgress, getTaskDisplayState } from "../lib/taskUtils.js";

test("clampProgress keeps values within 0 and 100", () => {
  assert.equal(clampProgress(-10), 0);
  assert.equal(clampProgress(42), 42);
  assert.equal(clampProgress(150), 100);
});

test("getTaskDisplayState marks tasks as urgent when the deadline is close", () => {
  const now = new Date("2026-07-01T12:00:00.000Z");
  const dueDate = new Date("2026-07-01T13:00:00.000Z");

  const state = getTaskDisplayState({ dueDate }, now);

  assert.equal(state.isUrgent, true);
  assert.equal(state.remainingSeconds, 3600);
  assert.equal(state.remainingText, "0日 1時間 0分 0秒");
});
