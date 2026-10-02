const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FULLSCREEN_VIEWPORT_LINES,
  NORMAL_VIEWPORT_LINES,
  applyViewport,
  diffLines,
  moreLinesHint,
  renderClearedCell,
  renderDeletedCell,
  renderEditedCell,
  renderExecutedCell,
  renderInCell,
  renderOutCell,
  visibleWidth,
} = require("../dist/execution/cell-view.js");

/** Duck-typed theme stub: records the color token around every styled span. */
function stubTheme() {
  return {
    fg: (color, text) => `\u0001${color}\u0002${text}\u0003`,
  };
}

/** Fake synchronous "shiki" output: same visible text, ANSI-decorated. */
function fakeHighlight(code) {
  return code.split("\n").map((line) => `\u001b[38;2;80;160;255m${line}\u001b[0m`);
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

const OPTS = { cellNumber: 1, width: 40, mode: "expanded" };

function codeOf(n) {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
}

// ---------------------------------------------------------------------------
// Basic geometry
// ---------------------------------------------------------------------------

test("In box: label floats in the gutter outside a square fence with numbered rows", () => {
  const lines = renderInCell("import os\nos.getcwd()", { ...OPTS });
  assert.equal(lines.length, 2 + 2); // top + 2 body + bottom
  assert.match(lines[0], /^ {14}┌─+┐$/); // blank gutter on the fence row
  assert.match(lines[1], /^ In\[1\]: {7}│1 │ import os +│$/); // label aligns with the first content row; rail after the number
  assert.match(lines[2], /^ {14}│2 │ os\.getcwd\(\) +│$/);
  assert.match(lines[3], /^ {14}└─+┘$/);
  // Every row has the same visible width.
  const widths = lines.map(visibleWidth);
  assert.deepEqual(widths, [40, 40, 40, 40]);
});

test("Out box: Out[N]: gutter with line numbers, same fence column as In", () => {
  const inLines = renderInCell("x = 1", { ...OPTS });
  const outLines = renderOutCell("1", { ...OPTS });
  assert.match(outLines[0], /^ {14}┌─+┐$/);
  assert.match(outLines[1], /^ Out\[1\]: {6}│1 │ 1 +│$/); // Out rows are numbered too, rail included
  assert.equal(outLines.length, 3);
  // Fences align despite Out's wider label.
  assert.equal(inLines[0].indexOf("┌"), outLines[0].indexOf("┌"));
});

test("executed cell renders the In block followed by the Out block", () => {
  const lines = renderExecutedCell("x = 1\nprint(x)", "1", { ...OPTS });
  assert.match(lines[0], /^ {14}┌/);
  assert.match(lines[1], /^ In\[1\]: {7}│/);
  assert.match(lines[3], /^ {14}└─+┘$/);
  assert.match(lines[4], /^ {14}┌/);
  assert.match(lines[5], /^ Out\[1\]: {6}│/);
  assert.equal(lines.length, 4 + 3);
});

test("rows are padded to the interior width so the right fence stays in one column", () => {
  const lines = renderInCell(codeOf(12), { ...OPTS });
  for (const line of lines) assert.equal(visibleWidth(line), 40);
});

// ---------------------------------------------------------------------------
// Gutter alignment across cell-number digit counts
// ---------------------------------------------------------------------------

test("cellNumberWidth keeps the fence column fixed as In[N] gains digits", () => {
  const columns = [9, 99, 999].map((n) =>
    renderInCell("x = 1", { cellNumber: n, cellNumberWidth: 3, width: 40, mode: "expanded" })[0].indexOf("┌"),
  );
  assert.deepEqual(columns, [columns[0], columns[0], columns[0]]);
  // And every label fits the shared gutter (padded after the colon).
  const first = renderInCell("x = 1", { cellNumber: 9, cellNumberWidth: 3, width: 40, mode: "expanded" })[1];
  assert.match(first, /^ In\[9\]: {7}│/);
});

test("In and Out fences align inside a single executed render without extra hints", () => {
  const lines = renderExecutedCell("x = 1", "1", { cellNumber: 12, width: 40, mode: "expanded" });
  assert.equal(lines[0].indexOf("┌"), lines[3].indexOf("┌"));
});

test("line-number field width comes from the full line count, so scrolling cannot shift the fence", () => {
  const twenty = codeOf(20);
  const top = renderInCell(twenty, { ...OPTS, mode: "fullscreen" })[0];
  const scrolled = renderInCell(twenty, { ...OPTS, mode: "fullscreen", viewStart: 12 });
  assert.equal(top.indexOf("┌"), scrolled[0].indexOf("┌"));
  // 20 lines -> 2-digit number field for both windows.
  assert.match(scrolled[1], /│12 │ line 12/);
});

// ---------------------------------------------------------------------------
// Viewport rules
// ---------------------------------------------------------------------------

test("constants pin the spec: 8 fullscreen lines, 7 normal lines", () => {
  assert.equal(FULLSCREEN_VIEWPORT_LINES, 8);
  assert.equal(NORMAL_VIEWPORT_LINES, 7);
});

test("collapsed + fullscreen draws an 8-line scrollable box with no more-hint", () => {
  const lines = renderInCell(codeOf(20), { ...OPTS, mode: "fullscreen" });
  assert.equal(lines.length, 2 + FULLSCREEN_VIEWPORT_LINES); // no hint row
  assert.ok(!lines.some((l) => l.includes("more lines")));
});

test("fullscreen box honors viewStart and clamps it", () => {
  const opts = { ...OPTS, mode: "fullscreen" };
  const at6 = renderInCell(codeOf(20), { ...opts, viewStart: 6 });
  assert.match(at6[1], /│ 6 │ line 6/);
  assert.match(at6[8], /│13 │ line 13/);
  const clampedLow = renderInCell(codeOf(20), { ...opts, viewStart: -5 });
  assert.match(clampedLow[1], /│ 1 │ line 1/);
  const clampedHigh = renderInCell(codeOf(20), { ...opts, viewStart: 500 });
  assert.match(clampedHigh[8], /│20 │ line 20/);
});

test("collapsed + normal shows the first 7 lines plus a below-box more-hint", () => {
  const lines = renderInCell(codeOf(20), { ...OPTS, mode: "normal" });
  assert.equal(lines.length, 2 + NORMAL_VIEWPORT_LINES + 1);
  assert.match(lines[1], /│ 1 │ line 1/);
  assert.match(lines[7], /│ 7 │ line 7/);
  assert.match(lines[9], /^ {14}\.\.\. 13 more lines >\.\.\.$/);
});

test("collapsed + normal with 7 or fewer lines shows everything and no hint", () => {
  const lines = renderInCell(codeOf(7), { ...OPTS, mode: "normal" });
  assert.equal(lines.length, 2 + 7);
  assert.ok(!lines.some((l) => l.includes("more lines")));
});

test("expanded mode draws the full text regardless of length", () => {
  const lines = renderInCell(codeOf(30), { ...OPTS, mode: "expanded" });
  assert.equal(lines.length, 2 + 30);
  assert.ok(!lines.some((l) => l.includes("more lines")));
});

test("tail viewports show line counts beneath the label without hint rows", () => {
  const code = Array.from({ length: 11 }, (_, i) => `tail_${i} = ${i}`).join("\n");
  for (const [mode, hidden] of [["normal", 4], ["fullscreen", 3]]) {
    const lines = renderInCell(code, { width: 80, mode, followTail: true });
    assert.ok(lines[0].includes("┌"));
    assert.ok(lines[2].includes("(11 lines)"));
    assert.equal(lines.length, (mode === "normal" ? 7 : 8) + 2);
    assert.ok(lines.some((line) => line.includes("tail_10 =")));
    assert.ok(!lines.some((line) => line.includes("tail_0 =")));
    assert.ok(!lines.some((line) => line.includes("more lines")));
    assert.ok(lines.every((line) => visibleWidth(line) <= 80));
    const narrow = renderInCell(code, { width: 20, mode, followTail: true });
    assert.ok(narrow.every((line) => visibleWidth(line) <= 20));
  }
  const expanded = renderInCell(code, { width: 80, mode: "expanded", followTail: true });
  assert.ok(!expanded.some((line) => line.includes("lines above")));
  assert.ok(expanded.some((line) => line.includes("tail_0 =")));
  assert.ok(expanded.some((line) => line.includes("tail_10 =")));
});

test("applyViewport is the shared slicing primitive behind the rules", () => {
  const rows = codeOf(10).split("\n").map((text, i) => ({ text, num: i + 1 }));
  assert.equal(applyViewport(rows, "expanded").rows.length, 10);
  assert.equal(applyViewport(rows, "fullscreen").rows.length, 8);
  assert.deepEqual(applyViewport(rows, "normal").rows.map((r) => r.num), [1, 2, 3, 4, 5, 6, 7]);
  const window = applyViewport(rows, "fullscreen", 3); // 10 rows cap 8 -> start clamps to 3
  assert.equal(window.rows[0].num, 3);
  assert.equal(window.rows.length, 8);
});

// ---------------------------------------------------------------------------
// Height stability (highlighted vs plain paths)
// ---------------------------------------------------------------------------

test("highlighted and plain renders are byte-identical in shape (zero vertical jitter)", () => {
  const code = "import os\n\nx = os.getcwd()\nprint(x)";
  const plain = renderInCell(code, { ...OPTS });
  const highlighted = renderInCell(code, { ...OPTS, highlightLines: fakeHighlight(code) });
  assert.equal(plain.length, highlighted.length);
  for (let i = 0; i < plain.length; i++) {
    // Same visible text (ANSI is the only difference)...
    assert.equal(stripAnsi(plain[i]), stripAnsi(highlighted[i]));
    // ...and identical gutter/fence geometry.
    assert.equal(plain[i].indexOf("┌"), highlighted[i].indexOf("┌"));
    assert.equal(plain[i].indexOf("│"), highlighted[i].indexOf("│"));
  }
});

test("highlighted and plain renders agree even when lines are truncated", () => {
  const code = `x = "${"9".repeat(60)}"\ny = 1`;
  const plain = renderInCell(code, { ...OPTS });
  const highlighted = renderInCell(code, { ...OPTS, highlightLines: fakeHighlight(code) });
  assert.equal(plain.length, highlighted.length);
  assert.equal(stripAnsi(plain[1]), stripAnsi(highlighted[1]));
  assert.ok(stripAnsi(plain[1]).includes("…"));
});

test("a highlightLines length mismatch falls back to plain (never a short render)", () => {
  const code = "a = 1\nb = 2";
  const lines = renderInCell(code, { ...OPTS, highlightLines: ["only one line"] });
  assert.equal(lines.length, 4);
  assert.equal(stripAnsi(lines[2]), " ".repeat(14) + "│2 │ b = 2" + " ".repeat(15) + "│");
});

test("moreLinesHint matches the built-in hint text", () => {
  assert.equal(moreLinesHint(13), "... 13 more lines >...");
  assert.equal(moreLinesHint(13, stubTheme()), "\u0001muted\u0002... 13 more lines >...\u0003");
});

// ---------------------------------------------------------------------------
// Long lines: hard truncation with an ellipsis marker
// ---------------------------------------------------------------------------

test("long lines are hard-truncated with a … marker, never wrapped", () => {
  const long = `x = ${"9".repeat(60)}`;
  const lines = renderInCell(long, { ...OPTS });
  assert.equal(lines.length, 3); // one body row only — no wrap rows
  const body = stripAnsi(lines[1]);
  assert.ok(body.endsWith("…".padEnd(1) + " ".repeat(0) + "│") || body.includes("…│"));
  assert.ok(body.includes("…"));
  assert.equal(visibleWidth(lines[1]), 40);
});

test("tabs are expanded before measurement", () => {
  const lines = renderInCell("if x:\n\treturn 1", { ...OPTS });
  assert.match(stripAnsi(lines[2]), /│2 │ {5}return 1/);
});

// ---------------------------------------------------------------------------
// Diff rendering (edit op)
// ---------------------------------------------------------------------------

test("diffLines produces a minimal unified diff with old/new numbering", () => {
  const rows = diffLines("a = 1\nb = 2\nc = 3", "a = 1\nb = 22\nc = 3\nd = 4");
  assert.deepEqual(
    rows.map((r) => `${r.kind}:${r.num}:${r.text}`),
    ["context:1:a = 1", "del:2:b = 2", "add:2:b = 22", "context:3:c = 3", "add:4:d = 4"],
  );
});

test("diffLines keeps common lines adjacent across hunks", () => {
  const rows = diffLines("x\ny", "y");
  assert.deepEqual(
    rows.map((r) => `${r.kind}:${r.text}`),
    ["del:x", "context:y"],
  );
});

test("edited cell renders removed lines red+struck and added lines green", () => {
  const theme = stubTheme();
  const lines = renderEditedCell("a = 1\nb = 2\nc = 3", "a = 1\nb = 22\nc = 3", {
    ...OPTS,
    cellNumber: 4,
    theme,
  });
  // Top fence row + 4 diff rows + bottom fence.
  assert.equal(lines.length, 6);
  const removed = lines.find((l) => l.includes("toolDiffRemoved"));
  assert.ok(removed.includes("\u0001toolDiffRemoved\u0002"), "removed row carries toolDiffRemoved");
  assert.ok(removed.includes("\u001b[9m"), "removed row is struck through");
  const added = lines.find((l) => l.includes("b = 22"));
  assert.ok(added.includes("\u0001toolDiffAdded\u0002"), "added row carries toolDiffAdded");
  const context = lines.find((l) => l.includes("a = 1"));
  assert.ok(!context.includes("\u0001toolDiff"), "context row is not diff-colored");
});

test("diff washes cover every interior column and stop before the fences", () => {
  const { backgroundAnsi, mixColors, parseColor } = require("@earendil-works/pi-tui");
  function backgroundCells(text) {
    const cells = [];
    let background = null;
    for (let i = 0; i < text.length;) {
      const sgr = /^\u001b\[([0-9;]*)m/.exec(text.slice(i));
      if (!sgr) { cells.push(background); i++; continue; }
      const codes = sgr[1] === "" ? [0] : sgr[1].split(";").map(Number);
      for (let j = 0; j < codes.length; j++) {
        if (codes[j] === 0 || codes[j] === 49) background = null;
        else if ([38, 48, 58].includes(codes[j])) {
          const size = codes[j + 1] === 2 ? 5 : 3;
          if (codes[j] === 48) background = codes.slice(j, j + size).join(";");
          j += size - 1;
        }
      }
      i += sgr[0].length;
    }
    return cells;
  }
  for (const appearance of ["light", "dark"]) {
    for (const mode of ["truecolor", "256"]) {
      const host = backgroundAnsi(parseColor(appearance === "dark" ? "#202020" : "#eeeeee"), mode);
      const theme = {
        appearance,
        colors: { toolDiffAdded: parseColor("#208020"), toolDiffRemoved: parseColor("#d02020") },
        getColorMode: () => mode,
        fg: (_token, text) => `\u001b[38;2;100;110;120m${text}\u001b[0m`,
        getBgAnsi: () => host,
        bg: (_token, text) => `${host}${text}\u001b[49m`,
      };
      for (const width of [32, 80]) {
        const lines = renderEditedCell("keep\nb = 2", "keep\nb = 22", {
          ...OPTS, width, theme, labelBackground: "toolSuccessBg",
        });
        for (const [needle, token] of [["b = 2", "toolDiffRemoved"], ["b = 22", "toolDiffAdded"]]) {
          const line = lines.find((row) => stripAnsi(row).trimEnd().includes(needle) &&
            (needle === "b = 22" || !stripAnsi(row).includes("b = 22")));
          const plain = stripAnsi(line);
          assert.equal(visibleWidth(line), width);
          const leftFence = plain.indexOf("│");
          const rightFence = plain.lastIndexOf("│");
          const base = parseColor(appearance === "dark" ? "#1a1a1a" : "#fbfbf8");
          const expected = /\u001b\[([0-9;]*)m/.exec(backgroundAnsi(
            mixColors(theme.colors[token], base, 0.82), mode,
          ))[1];
          const colors = backgroundCells(line);
          assert.ok(colors.slice(leftFence + 1, rightFence).every((bg) => bg === expected),
            "number, rail, code and trailing spaces must share the full diff wash");
          assert.notEqual(colors[leftFence], expected, "left fence keeps the tool background");
          assert.notEqual(colors[rightFence], expected, "right fence keeps the tool background");
        }
        const context = lines.find((row) => stripAnsi(row).includes("keep"));
        assert.ok(backgroundCells(context).every((bg) => bg === backgroundCells(lines[0])[0]),
          "unchanged rows retain the host tool background");
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Red modes: delete vs clear
// ---------------------------------------------------------------------------

test("deleted cell paints the whole cell red, including the In[N]: gutter", () => {
  const theme = stubTheme();
  const lines = renderDeletedCell("a = 1", { ...OPTS, cellNumber: 5, theme });
  assert.ok(lines[0].includes("\u0001error\u0002┌"), "top fence is error-styled");
  assert.ok(lines[1].includes("\u0001error\u0002In[5]: "), "gutter label is error-styled");
  assert.ok(lines[1].includes("\u0001error\u0002a = 1"), "content is error-styled");
  assert.ok(lines[2].includes("\u0001error\u0002└"), "bottom fence is error-styled");
});

test("cleared cell paints only the internal content red; gutter and fence stay normal", () => {
  const theme = stubTheme();
  const lines = renderClearedCell("a = 1", { ...OPTS, cellNumber: 5, theme });
  assert.ok(lines[0].includes("\u0001muted\u0002┌"), "fence keeps the normal style");
  assert.ok(lines[1].includes("\u0001muted\u0002In[5]: "), "gutter label keeps the normal style");
  assert.ok(lines[1].includes("\u0001error\u0002a = 1"), "content is error-styled");
  // The error style must not leak into the fence columns of the body row.
  const bodyRow = lines[1];
  const rightFence = bodyRow.lastIndexOf("│");
  const before = bodyRow.slice(Math.max(0, rightFence - 12), rightFence + 6);
  assert.ok(before.includes("\u0001muted\u0002│"), "right fence is not error-styled");
});

// ---------------------------------------------------------------------------
// Unnumbered variant (scratch_run) and theme degradation
// ---------------------------------------------------------------------------

test("omitting cellNumber renders the unnumbered In:/Out: scratch_run variant", () => {
  const lines = renderExecutedCell("x = 1", "1", { width: 40, mode: "expanded" });
  assert.match(lines[0], /^ {14}┌/);
  assert.match(lines[1], /^ In: {10}│/);
  assert.match(lines[4], /^ Out: {9}│1 │/); // Out rows are numbered even in the scratch variant
  assert.equal(lines[0].indexOf("┌"), lines[3].indexOf("┌"));
});

test("an undefined theme degrades to fully unstyled text", () => {
  const lines = renderDeletedCell("a = 1", { ...OPTS, cellNumber: 2 });
  for (const line of lines) {
    assert.ok(!line.includes("\u001b["), `no ANSI in: ${JSON.stringify(line)}`);
  }
});

test("viewport rules apply to the Out box too, so chatty output stays bounded", () => {
  const lines = renderOutCell(codeOf(20), { ...OPTS, mode: "normal" });
  assert.equal(lines.length, 2 + NORMAL_VIEWPORT_LINES + 1);
  assert.match(lines.at(-1), /more lines/);
});

// ---------------------------------------------------------------------------
// Error output + success rows + generic labeled box (I1 core extensions)
// ---------------------------------------------------------------------------

test("renderOutCell outputStyle=error styles only the content, fences stay normal", () => {
  const lines = renderOutCell("boom", { ...OPTS, outputStyle: "error", theme: stubTheme() });
  assert.ok(lines[1].includes("\u0001error\u0002boom\u0003"), JSON.stringify(lines[1]));
  assert.ok(lines[0].includes("\u0001muted\u0002"), "top fence stays gutter-styled");
  assert.ok(!lines[0].includes("\u0001error"), "top fence is not error-styled");
});

test("BodyStyle success maps to the success theme token", () => {
  const { renderLabeledBox } = require("../dist/execution/cell-view.js");
  const lines = renderLabeledBox(
    "Run:",
    [{ text: "ok cell", style: "success" }],
    { width: 40, mode: "expanded", theme: stubTheme() },
  );
  assert.ok(lines[1].includes("\u0001success\u0002ok cell\u0003"), JSON.stringify(lines[1]));
});

test("renderLabeledBox: generic label, square fence, viewport + hint in normal mode", () => {
  const { renderLabeledBox } = require("../dist/execution/cell-view.js");
  const rows = codeOf(20).split("\n").map((text, i) => ({ text, num: i + 1 }));
  const lines = renderLabeledBox("Run:", rows, { width: 40, mode: "normal" });
  assert.equal(lines.length, 2 + NORMAL_VIEWPORT_LINES + 1);
  assert.match(lines[0], /^ {5}┌─+┐$/); // label rides the first content row, not the fence
  assert.match(lines[1], /^Run: │line 1/);
  assert.match(lines.at(-1), /more lines/);
  // Box rows share one visible width (the hint line below the box is exempt).
  const boxRows = lines.slice(0, -1).map(visibleWidth);
  assert.deepEqual([...new Set(boxRows)], [40]);
});

test("newline snapshots retain prior colors without adding a blank visible row", () => {
  const code = "print(123)\n";
  const highlighted = fakeHighlight(code);
  const lines = renderInCell(code, { ...OPTS, highlightLines: highlighted });
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes(highlighted[0]));
  assert.equal(stripAnsi(lines[1]), stripAnsi(renderInCell(code, OPTS)[1]));
});

test("In and Out gutters show total line counts only above seven lines", () => {
  for (const render of [renderInCell, renderOutCell]) {
    for (const count of [1, 7, 8, 12, 123, 1000]) {
      const lines = render(codeOf(count), { ...OPTS, cellNumber: 8, followTail: true });
      assert.equal(lines.some((line) => line.includes(`(${count} lines)`)), count > 7);
      if (count > 7) assert.ok(lines[2].includes(`(${count} lines)`));
      assert.ok(!lines.some((line) => line.includes("lines above")));
    }
  }
  const short = renderInCell(codeOf(1), { ...OPTS, cellNumber: 1 });
  const long = renderOutCell(codeOf(12), { ...OPTS, cellNumber: 123 });
  assert.equal(short[0].indexOf("┌"), long[0].indexOf("┌"));
});
