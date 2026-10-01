#!/usr/bin/env node
// Preview harness for the notebook cell renderer (brief 40, item 3).
// Renders representative outputs through cell-view for all viewport modes and
// prints them, so a human can eyeball the design without running pi.
//
//   node scripts/cell-preview.mjs [width]
//
// Width defaults to 100. No theme (plain text) so the output is greppable.

import { renderInCell, renderExecutedCell, renderEditedCell, renderDeletedCell, renderClearedCell } from "../dist/execution/cell-view.js";

const width = Number(process.argv[2] ?? 100);
const section = (title) => console.log(`\n${"=".repeat(width)}\n${title}\n${"=".repeat(width)}`);

const short = `import json\nrows = json.load(open("data/events.json"))\nlen(rows)`;
const long = Array.from({ length: 23 }, (_, i) => `step(${i + 1})  # line ${i + 1}`).join("\n");

const MODES = ["normal", "fullscreen", "expanded"];

for (const mode of MODES) {
  section(`exec_cell — short output — mode=${mode}`);
  console.log(renderExecutedCell(short, "42\n", { cellNumber: 12, width, mode }).join("\n"));

  section(`exec_cell — long output (23 lines) — mode=${mode}`);
  console.log(renderExecutedCell(long, "done\n", { cellNumber: 13, width, mode }).join("\n"));
}

section("write_cell — new cell (In box only)");
console.log(renderInCell(short, { cellNumber: 14, width, mode: "normal" }).join("\n"));

section("write_cell — replacing a cell (inline diff)");
console.log(renderEditedCell(short, `import json\nrows = json.load(open("data/events.json"))\nprint(len(rows), "events")`, { cellNumber: 14, width, mode: "normal" }).join("\n"));

section("delete_cell — whole cell red (gutter included)");
console.log(renderDeletedCell(short, { cellNumber: 14, width, mode: "normal" }).join("\n"));

section("cleared contents — content red, gutter normal");
console.log(renderClearedCell(short, { cellNumber: 14, width, mode: "normal" }).join("\n"));

section("gutter alignment — cells 9, 10, 99, 100 in one column (padded)");
for (const n of [9, 10, 99, 100]) {
  console.log(renderInCell(`x = ${n}`, { cellNumber: n, cellNumberWidth: 3, width, mode: "normal" }).join("\n"));
}

section("terminal emulation sample — what a tqdm-style stream collapses to");
// The emulator's output as it would arrive in the Out box: three \r overwrites
// collapse to the final screen state.
const emulated = "0%|          | 0/10\n" +
  "\r40%|████▏     | 4/10\n\r90%|█████████ | 9/10\n\r100%|██████████| 10/10\n";
console.log(renderExecutedCell(`from tqdm import tqdm\nfor _ in tqdm(range(10)): pass`, emulated, { cellNumber: 15, width, mode: "normal" }).join("\n"));
