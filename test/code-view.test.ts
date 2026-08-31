const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CODE_VIEW_HEIGHT,
  CODE_VIEW_MARGIN,
  CODE_VIEW_FULL_THRESHOLD,
  computeCodeViewStart,
} = require("../dist/execution/code-view.js");

const TOP_ROW = CODE_VIEW_MARGIN + 1; // first row the marker may occupy
const BOTTOM_ROW = CODE_VIEW_HEIGHT - CODE_VIEW_MARGIN; // last row the marker may occupy

test("code-view exposes a 10-line window with a 3-line scroll margin", () => {
  assert.equal(CODE_VIEW_HEIGHT, 10);
  assert.equal(CODE_VIEW_MARGIN, 3);
  assert.equal(CODE_VIEW_FULL_THRESHOLD, 12);
});

test("computeCodeViewStart anchors the marker at the top margin on first render", () => {
  // First visible line = currentLine - margin, so the marker sits 3 lines from the top.
  assert.equal(computeCodeViewStart(9, 20, undefined), 6);
  assert.equal(computeCodeViewStart(1, 20, undefined), 1); // clamped at the top of the file
  assert.equal(computeCodeViewStart(20, 20, undefined), 11); // clamped so the window stays full
});

test("computeCodeViewStart keeps the window stationary while the marker stays in the band", () => {
  let start = computeCodeViewStart(9, 20, undefined);
  assert.equal(start, 6);

  // Marker rows 4..7: no scrolling at all.
  for (const line of [10, 11, 12]) {
    start = computeCodeViewStart(line, 20, start);
    assert.equal(start, 6);
  }

  // A small loop jumping back up stays inside the band, so the code never moves.
  start = computeCodeViewStart(9, 20, start);
  assert.equal(start, 6);
});

test("computeCodeViewStart scrolls only once the marker would cross the bottom margin", () => {
  let start = computeCodeViewStart(6, 20, undefined); // marker at row 4
  assert.equal(start, 3);

  start = computeCodeViewStart(9, 20, start); // marker at row 7: still fine
  assert.equal(start, 3);

  start = computeCodeViewStart(10, 20, start); // marker would be row 8: scroll by one
  assert.equal(start, 4);
  assert.equal(10 - start + 1, BOTTOM_ROW);
});

test("computeCodeViewStart scrolls back when the marker would cross the top margin", () => {
  let start = computeCodeViewStart(20, 20, 11);

  start = computeCodeViewStart(13, 20, start); // marker at row 3: scroll up by one
  assert.equal(start, 10);
  assert.equal(13 - start + 1, TOP_ROW);

  // Iterating a loop after settling produces no further motion.
  for (const line of [14, 15, 16, 13, 14, 15, 16, 13]) {
    start = computeCodeViewStart(line, 20, start);
  }
  assert.equal(start, 10);
});

test("computeCodeViewStart pins the window at the end of the file when out of content", () => {
  let start = computeCodeViewStart(20, 20, undefined);
  assert.equal(start, 11); // cannot scroll past the last line

  // Once the marker passes the bottom margin there is nothing left to scroll:
  // the window stays pinned and the marker keeps moving through the tail lines.
  start = computeCodeViewStart(18, 20, start);
  assert.equal(start, 11);
  assert.equal(18 - start + 1, 8);
  start = computeCodeViewStart(20, 20, start);
  assert.equal(20 - start + 1, 10);
});

test("computeCodeViewStart is stable when the current line repeats (tight loops)", () => {
  let start = computeCodeViewStart(5, 20, undefined);
  assert.equal(start, 2);
  for (let i = 0; i < 5; i++) {
    start = computeCodeViewStart(5, 20, start);
  }
  assert.equal(start, 2);
});

test("computeCodeViewStart settles a 5-line loop after one edge adjustment", () => {
  // Loop spanning lines 12-16 in a 20-line file: the span exceeds the 4-row
  // band by one, so the first crossing scrolls once; afterwards the marker
  // moves within the band and the window stays put.
  let start = computeCodeViewStart(12, 20, undefined);
  assert.equal(start, 9);
  const seen = [];
  for (const line of [13, 14, 15, 16, 12, 13, 14, 15, 16, 12]) {
    start = computeCodeViewStart(line, 20, start);
    seen.push(start);
  }
  assert.deepEqual(seen, [9, 9, 9, 10, 9, 9, 9, 9, 10, 9]);
});