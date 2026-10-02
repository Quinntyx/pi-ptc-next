const test = require("node:test");
const assert = require("node:assert/strict");
const {
  renderNotebookCall,
  renderNotebookResult,
  setNotebookTuiModeProvider,
} = require("../dist/execution/notebook-render.js");
const { renderInCell, renderOutCell, visibleWidth } = require("../dist/execution/cell-view.js");
const { highlightCellCode } = require("../dist/execution/code-highlight.js");

const THEME = {
  fg: (_color, text) => text,
  bg: (color, text) => `\x1b[48;2;240;240;230m${text}\x1b[49m`,
  colors: { toolSuccessBg: { kind: "rgb", r: 250, g: 250, b: 235 } },
};
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const result = (details, text = "done") => ({ content: [{ type: "text", text }], details });
const wheel = (y, delta) => ({
  type: "wheel", button: "none", x: 15, y, screenX: 15, screenY: y,
  width: 80, height: 40, shift: false, alt: false, ctrl: false, wheelDelta: delta,
});
const source = Array.from({ length: 40 }, (_, i) => `line_${i} = ${i}`);
const output = Array.from({ length: 40 }, (_, i) => `output_${i}`);

function frame(details, state, partial = false, expanded = false) {
  return renderNotebookResult("exec_cell", result(details), { isPartial: partial, expanded }, THEME, { state });
}
function labelRow(lines, label) {
  return lines.findIndex((line) => stripAnsi(line).startsWith(` ${label}`));
}

test("default gutters align one/two/three digits, pending, and scratch cells with a one-column inset", () => {
  for (const n of [1, 12, 123, null, undefined]) {
    for (const render of [renderInCell, renderOutCell]) {
      const lines = render("x", { width: 50, mode: "expanded", cellNumber: n });
      assert.equal(lines[0].indexOf("┌"), 11);
      assert.match(lines[1], /^ (In|Out)/);
      assert.equal(visibleWidth(lines[1]), 50);
    }
  }
  assert.equal(renderInCell("x", { width: 50, mode: "expanded", cellNumber: 1234 })[0].indexOf("┌"), 12);
});

test("labels have the normal tool background while borders and code remain unshaded", () => {
  const calls = [];
  const theme = { ...THEME, bg: (color, text) => { calls.push({ color, text }); return THEME.bg(color, text); } };
  const lines = renderInCell("x = 1", { width: 50, mode: "expanded", cellNumber: 12, theme });
  assert.deepEqual(calls, [{ color: "toolSuccessBg", text: "In[12]:  " }]);
  assert.ok(lines[1].startsWith(" \x1b[48;2;"));
  assert.ok(!lines[0].includes("\x1b[48;"));
  assert.ok(lines[1].indexOf("\x1b[49m") < lines[1].indexOf("│"));
  assert.equal(visibleWidth(lines[1]), 50);
});

test("the first partial result replaces the argument preview in Pi's call-then-result paint order", () => {
  const state = {};
  const context = { state };
  const call = renderNotebookCall("print(1)", undefined, THEME, context);
  assert.equal(labelRow(call.render(80), "In[ ]:"), 1);
  // The host builds the call component before the result callback, then paints both.
  const preview = renderNotebookCall("print(1)", undefined, THEME, context);
  const partial = renderNotebookResult("exec_cell", result({ userCode: ["print(1)"], liveOutput: ["1"] }), { isPartial: true }, THEME, context);
  const lines = [...preview.render(80), ...partial.render(80)].map(stripAnsi);
  assert.equal(lines.filter((line) => /^ In/.test(line)).length, 1);
  const settledPreview = renderNotebookCall("print(1)", undefined, THEME, context);
  const settled = renderNotebookResult("exec_cell", result({ userCode: ["print(1)"], cellIdx: 43 }), {}, THEME, context);
  const final = [...settledPreview.render(80), ...settled.render(80)].map(stripAnsi);
  assert.equal(final.filter((line) => /^ In/.test(line)).length, 1);
  assert.ok(final.some((line) => /^ In\[43\]:/.test(line)));
  assert.ok(!final.some((line) => /^ In\[ \]:/.test(line)));
  assert.equal(final[0].indexOf("┌"), lines[0].indexOf("┌"));
});

test("an early error/rejection keeps exactly one submitted input box", () => {
  const state = {};
  const call = renderNotebookCall("dangerous()", undefined, THEME, { state });
  const failed = renderNotebookResult("exec_cell", { ...result({}, "Cell rejected by user."), isError: true }, {}, THEME, { state });
  const lines = [...call.render(80), ...failed.render(80)].map(stripAnsi);
  assert.equal(lines.filter((line) => /^ In/.test(line)).length, 1);
  assert.ok(lines.some((line) => line.includes("dangerous()")));
  assert.ok(lines.some((line) => line.includes("Cell rejected by user.")));
});

test("call streaming highlights asynchronously and keeps identical geometry; live/final boxes share it", async () => {
  const code = "streaming_example = 7\nprint(streaming_example)";
  const state = {};
  let redraws = 0;
  const context = { state, invalidate: () => { redraws++; } };
  const call = renderNotebookCall(code, undefined, THEME, context);
  const plain = call.render(80).map(stripAnsi);
  await highlightCellCode(code, THEME);
  await new Promise((resolve) => setImmediate(resolve));
  const colored = call.render(80);
  assert.ok(redraws > 0);
  assert.ok(colored.some((line) => line.includes("\x1b[38;2;")));
  assert.deepEqual(colored.map(stripAnsi), plain);
  for (const isPartial of [true, false]) {
    const component = renderNotebookResult("exec_cell", result({ userCode: code.split("\n"), cellIdx: 4 }), { isPartial }, THEME, context);
    assert.ok(component.render(80).some((line) => line.includes("\x1b[38;2;")));
  }
});

test("fullscreen input and output wheel windows scroll independently and persist across redraw/resize", () => {
  setNotebookTuiModeProvider(() => "fullscreen");
  try {
    const state = {};
    const details = { userCode: source, cellIdx: 12 };
    const component = renderNotebookResult("exec_cell", result(details, output.join("\n")), {}, THEME, { state });
    let lines = component.render(80);
    assert.ok(lines.some((line) => line.includes("line_0 =")));
    assert.deepEqual(component.handleMouse(wheel(2, 4)), { handled: true, render: true });
    lines = component.render(80);
    assert.ok(lines.some((line) => line.includes("line_4 =")));
    assert.ok(!lines.some((line) => line.includes("line_0 =")));
    const outRow = labelRow(lines, "Out[12]:");
    component.handleMouse(wheel(outRow, 3));
    lines = component.render(80);
    assert.ok(lines.some((line) => line.includes("output_3")));
    assert.ok(lines.some((line) => line.includes("line_4 =")));
    const recreated = renderNotebookResult("exec_cell", result(details, output.join("\n")), {}, THEME, { state });
    lines = recreated.render(55);
    assert.ok(lines.some((line) => line.includes("line_4 =")));
    assert.ok(lines.some((line) => line.includes("output_3")));
    assert.ok(recreated.handleMouse(wheel(0, -100))?.handled);
    recreated.render(55);
    assert.equal(recreated.handleMouse(wheel(0, -100)), undefined);
    assert.equal(recreated.handleMouse({ ...wheel(2, 1), type: "press", button: "left" }), undefined);
  } finally { setNotebookTuiModeProvider(undefined); }
});

test("live output follows the tail, pauses while scrolled up, and resumes at the bottom", () => {
  setNotebookTuiModeProvider(() => "fullscreen");
  try {
    const state = {};
    const details = (count) => ({ userCode: ["print('logs')"], liveOutput: output.slice(0, count) });
    let component = frame(details(20), state, true);
    let lines = component.render(80);
    let row = labelRow(lines, "Out[ ]:");
    assert.ok(lines[row].includes("output_12"));
    component.handleMouse(wheel(row, -4));
    component = frame(details(22), state, true);
    lines = component.render(80);
    row = labelRow(lines, "Out[ ]:");
    assert.ok(lines[row].includes("output_8"));
    component.handleMouse(wheel(row, 100));
    component = frame(details(24), state, true);
    lines = component.render(80);
    row = labelRow(lines, "Out[ ]:");
    assert.ok(lines[row].includes("output_16"));
  } finally { setNotebookTuiModeProvider(undefined); }
});

test("regular mode and expanded cells leave wheel events to transcript scrolling", () => {
  const state = {};
  setNotebookTuiModeProvider(() => "regular");
  try {
    for (const partial of [false, true]) {
      const component = frame({ userCode: source, liveOutput: output }, state, partial);
      component.render(80);
      assert.equal(component.handleMouse(wheel(2, 3)), undefined);
    }
    setNotebookTuiModeProvider(() => "fullscreen");
    const expanded = frame({ userCode: source }, state, false, true);
    expanded.render(80);
    assert.equal(expanded.handleMouse(wheel(2, 3)), undefined);
  } finally { setNotebookTuiModeProvider(undefined); }
});

test("write/read/delete/batch boxes also expose fullscreen scrolling", () => {
  setNotebookTuiModeProvider(() => "fullscreen");
  try {
    const cases = [
      ["write_cell", { cellSource: source.join("\n") }],
      ["delete_cell", { cellSource: source.join("\n"), n: 1 }],
      ["read_cell", { cells: [{ source: source.join("\n"), cellType: "code", outputText: "", executionCount: 3 }] }],
      ["run_all", { runSteps: source.map((_, i) => ({ index: i + 1, ok: true })) }],
    ];
    for (const [tool, details] of cases) {
      const state = {};
      const component = renderNotebookResult(tool, result(details), {}, THEME, { state });
      component.render(80);
      assert.ok(component.handleMouse(wheel(2, 3))?.handled, tool);
      assert.equal(Object.values(state.scrollPositions)[0], 4, tool);
    }
  } finally { setNotebookTuiModeProvider(undefined); }
});


test("real Pi tool shell replaces its call preview and routes fullscreen wheel events into the box", async () => {
  const { initTheme, ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
  initTheme("light", false);
  setNotebookTuiModeProvider(() => "fullscreen");
  let redraws = 0;
  try {
    const definition = {
      renderShell: "self",
      renderCall: (args, theme, context) => renderNotebookCall(args.code, undefined, theme, context),
      renderResult: (value, options, theme, context) => renderNotebookResult("exec_cell", value, options, theme, context),
    };
    const host = new ToolExecutionComponent("exec_cell", "renderer-regression", { code: source.join("\n") }, {}, definition,
      { requestRender: () => { redraws++; } }, process.cwd());
    host.setArgsComplete();
    host.markExecutionStarted();
    assert.equal(host.render(80).map(stripAnsi).filter((line) => /^ In/.test(line)).length, 1);
    host.updateResult(result({ userCode: source, liveOutput: output.slice(0, 12) }), true);
    let lines = host.render(80).map(stripAnsi);
    assert.equal(lines.filter((line) => /^ In/.test(line)).length, 1);
    assert.ok(host.handleMouse(wheel(labelRow(lines, "In[ ]:"), 4))?.handled);
    lines = host.render(80).map(stripAnsi);
    assert.ok(lines.some((line) => line.includes("line_4 =")));
    host.updateResult(result({ userCode: source, cellIdx: 43 }, output.join("\n")), false);
    lines = host.render(80).map(stripAnsi);
    assert.equal(lines.filter((line) => /^ In/.test(line)).length, 1);
    assert.ok(lines.some((line) => /^ In\[43\]:/.test(line)));
    assert.ok(!lines.some((line) => /^ In\[ \]:/.test(line)));
    assert.ok(lines.some((line) => line.includes("line_4 =")));
    assert.ok(redraws > 0);
  } finally { setNotebookTuiModeProvider(undefined); }
});
