const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cachedCellHighlights,
  cellHighlightKey,
  highlightCellCode,
  resolveShikiThemeName,
  reuseCellHighlights,
  StreamingCellHighlights,
  STREAM_HIGHLIGHT_INTERVAL_MS,
} = require("../dist/execution/code-highlight.js");

function theme(rgb) {
  return {
    colors: {
      toolSuccessBg: { kind: "rgb", ...rgb },
      selectedBg: { kind: "rgb", r: 0, g: 0, b: 0 },
    },
    appearance: "dark",
  };
}
const LIGHT = theme({ r: 250, g: 250, b: 235 });
const DARK = theme({ r: 20, g: 20, b: 25 });
test("streaming coalesces 200 source updates into one active and one latest job", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const jobs = [];
  const completed = [];
  const scheduler = new StreamingCellHighlights((code) => new Promise((resolve) => jobs.push({ code, resolve })));
  t.after(() => scheduler.cancelPending());
  const request = (code) => scheduler.request({ key: code, code, theme: LIGHT, onResult: () => completed.push(code) });
  request("value = 0");
  for (let i = 1; i <= 200; i++) request(`value = ${i}`);
  assert.equal(jobs.length, 1, "never tokenize all the intermediate versions");
  jobs[0].resolve(["first"]);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  t.mock.timers.tick(STREAM_HIGHLIGHT_INTERVAL_MS - 1);
  assert.equal(jobs.length, 1);
  t.mock.timers.tick(1);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1].code, "value = 200");
  jobs[1].resolve(["latest"]);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.deepEqual(completed, ["value = 0", "value = 200"]);
});

test("settling cancels queued streaming work", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let resolve;
  let calls = 0;
  const scheduler = new StreamingCellHighlights(() => { calls++; return new Promise((done) => { resolve = done; }); });
  const request = (code) => scheduler.request({ key: code, code, theme: LIGHT, onResult: () => {} });
  request("first");
  request("second");
  scheduler.cancelPending();
  resolve([]);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
});

test("retained highlights color only the unchanged prefix, including partial and shortened lines", () => {
  const red = (text) => "\x1b[31m" + text + "\x1b[0m";
  assert.deepEqual(reuseCellHighlights("abcDEF", "abc", [red("abc")]), [red("abc") + "DEF"]);
  assert.deepEqual(reuseCellHighlights("abX", "abc", [red("abc")]), [red("ab") + "X"]);
  assert.deepEqual(reuseCellHighlights("ab", "abc", [red("abc")]), [red("ab")]);
  assert.deepEqual(reuseCellHighlights("abc\nnew", "abc", [red("abc")]), [red("abc"), "new"]);
  assert.deepEqual(reuseCellHighlights("new", "old", [red("old")]), ["new"]);
  assert.deepEqual(reuseCellHighlights("🦊y", "🦊", [red("🦊")]), [red("🦊") + "y"]);
  assert.deepEqual(reuseCellHighlights("🦊", "🦁", [red("🦁")]), ["🦊"]);
});

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("Shiki follows main tool-pane luma, not selectedBg, text, or theme name", () => {
  assert.equal(resolveShikiThemeName(LIGHT), "github-light");
  assert.equal(resolveShikiThemeName(DARK), "github-dark");
  assert.equal(resolveShikiThemeName({ ...DARK, appearance: "light" }), "github-dark");
});

test("terminal-default resolved backgrounds and palette colors select the correct theme", () => {
  assert.equal(resolveShikiThemeName({ colors: { toolSuccessBg: { kind: "indexed", index: 255 } } }), "github-light");
  assert.equal(resolveShikiThemeName({ colors: { toolSuccessBg: { kind: "indexed", index: 232 } } }), "github-dark");
});

test("older-host ANSI backgrounds and appearance fallback remain supported", () => {
  assert.equal(resolveShikiThemeName({ getBgAnsi: () => "\x1b[48;2;240;240;240m" }), "github-light");
  assert.equal(resolveShikiThemeName({ getBgAnsi: () => "\x1b[48;5;232m" }), "github-dark");
  assert.equal(resolveShikiThemeName({ appearance: "light", getBgAnsi: () => "\x1b[49m" }), "github-light");
  assert.equal(resolveShikiThemeName(), "github-dark");
});

test("explicit PTC_CODE_THEME overrides automatic selection", () => {
  const previous = process.env.PTC_CODE_THEME;
  try {
    process.env.PTC_CODE_THEME = "github-dark";
    assert.equal(resolveShikiThemeName(LIGHT), "github-dark");
  } finally {
    if (previous === undefined) delete process.env.PTC_CODE_THEME;
    else process.env.PTC_CODE_THEME = previous;
  }
});

test("highlight caches are keyed by code and theme, including light/dark changes", async () => {
  const code = "x = 1\nprint(x)";
  const light = await highlightCellCode(code, LIGHT);
  const dark = await highlightCellCode(code, DARK);
  assert.ok(light && dark);
  assert.notEqual(cellHighlightKey(code, LIGHT), cellHighlightKey(code, DARK));
  assert.notDeepEqual(light, dark);
  assert.deepEqual(light.map(stripAnsi), code.split("\n"));
  assert.deepEqual(dark.map(stripAnsi), code.split("\n"));
  assert.equal(cachedCellHighlights(code, LIGHT), light);
  assert.equal(cachedCellHighlights(code, DARK), dark);
  assert.equal(await highlightCellCode(code, LIGHT), light);
});

test("visible historical highlights survive a stream of new cache entries", async () => {
  const visible = "cache_lru_visible = 1";
  const expected = await highlightCellCode(visible, LIGHT);
  for (let i = 0; i < 150; i++) {
    assert.strictEqual(cachedCellHighlights(visible, LIGHT), expected);
    await highlightCellCode(`cache_lru_streaming = ${i}`, LIGHT);
  }
  assert.strictEqual(cachedCellHighlights(visible, LIGHT), expected);
});

test("light-theme readability guard does not replace already-dark readable ink", async () => {
  const lines = await highlightCellCode("identifier = 123", LIGHT);
  assert.ok(lines);
  assert.ok(lines[0].includes("\x1b[38;2;36;41;46m"), lines[0]);
  for (const match of lines.join("\n").matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)) {
    const luma = 0.2126 * +match[1] + 0.7152 * +match[2] + 0.0722 * +match[3];
    assert.ok(luma <= 140, `washed-out light-theme ink: ${match[0]}`);
  }
});
