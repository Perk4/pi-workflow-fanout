import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp } from "./clamp.js";

test("clamps below min", () => {
  assert.equal(clamp(-1, 0, 10), 0);
});

test("clamps above max", () => {
  assert.equal(clamp(99, 0, 10), 10);
});

test("passes through in range", () => {
  assert.equal(clamp(5, 0, 10), 5);
});
