const test = require("node:test");
const assert = require("node:assert/strict");
const { TerminalBuffer } = require("../dist/execution/terminal-emulator.js");

function screen(feedTexts: string[]): string[] {
  const buffer = new TerminalBuffer();
  for (const text of feedTexts) buffer.feed(text);
  return buffer.getLines();
}

test("accumulates plain lines", () => {
    assert.deepEqual(screen(["hello\nworld\n"]), ["hello", "world", ""]);
  });

test("emits one row per newline and keeps a trailing partial line", () => {
    assert.deepEqual(screen(["a\nb", "c"]), ["a", "bc"]);
  });

test("treats \\n as newline + carriage return (cooked-mode semantics)", () => {
    // After writing to column 5, a bare LF must still start the next row at 0.
    assert.deepEqual(screen(["abcde\nf"]), ["abcde", "f"]);
  });

test("renders tqdm-style \\r overwrites as the final screen state", () => {
    const tqdm = "\r  0%|          | 0/3\r 33%|###3      | 1/3\r100%|##########| 3/3\nafter";
    assert.deepEqual(screen([tqdm]), ["100%|##########| 3/3", "after"]);
  });

test("\\r overwrites only up to the new text length (terminal overwrite, no shift)", () => {
    assert.deepEqual(screen(["abcdef\rXY"]), ["XYcdef"]);
  });

test("\\r on a fresh row stays put", () => {
    assert.deepEqual(screen(["\rhello"]), ["hello"]);
  });

test("ESC[K clears from the cursor to end of line", () => {
    assert.deepEqual(screen(["abcdef\x1b[2D\x1b[K"]), ["abcd"]);
  });

test("ESC[K preserves text before the cursor", () => {
    assert.deepEqual(screen(["0123456789\b\b\b\b\x1b[K"]), ["012345"]);
  });

test("ESC[1K clears from start through the cursor, padding instead of shifting", () => {
    assert.deepEqual(screen(["abcdef\b\b\x1b[1K"]), ["     f"]);
  });

test("ESC[2K clears the whole row", () => {
    assert.deepEqual(screen(["visible\r\x1b[2Knew"]), ["new"]);
  });

test("ESC[2J clears the screen but keeps the cursor position", () => {
    assert.deepEqual(screen(["a\nb\nc\x1b[2J\rdone"]), ["", "", "done"]);
  });

test("ESC[A moves up and later writes overwrite the earlier row", () => {
    // tqdm positioned bars: newline to scroll, cursor-up, rewrite in place.
    assert.deepEqual(screen(["top\nbottom\n\x1b[A\rX"]), ["top", "Xottom", ""]);
  });

test("ESC[A clamps at the top row", () => {
    assert.deepEqual(screen(["abc\x1b[5A\rX"]), ["Xbc"]);
  });

test("ESC[B clamps at the last row", () => {
    assert.deepEqual(screen(["a\nb\x1b[9B\rX"]), ["a", "X"]);
  });

test("ESC[C and ESC[D move within the row", () => {
    // \r (col 0) → +2 (col 2) → -1 (col 1): space overwrites 'b', X overwrites 'c'.
    assert.deepEqual(screen(["abcdef\r\x1b[2C\x1b[1D X"]), ["a Xdef"]);
  });

test("ESC[G moves to an absolute column", () => {
    assert.deepEqual(screen(["abcdef\r\x1b[3GXY"]), ["abXYef"]);
  });

test("ESC[H homes the cursor", () => {
    assert.deepEqual(screen(["one\ntwo\x1b[H\rX"]), ["Xne", "two"]);
  });

test("ESC[row;colH addresses both axes", () => {
    assert.deepEqual(screen(["one\ntwo\n\x1b[2;2HX"]), ["one", "tXo", ""]);
  });

test("tabs advance to 8-column stops", () => {
    assert.deepEqual(screen(["a\tb"]), ["a       b"]);
  });

test("backspace moves the cursor left without erasing", () => {
    assert.deepEqual(screen(["abc\bX"]), ["abX"]);
  });

test("strips SGR sequences entirely", () => {
    assert.deepEqual(screen(["\x1b[31mred\x1b[0m plain"]), ["red plain"]);
  });

test("strips private-mode sequences (?1049 alt screen, ?25l cursor hide)", () => {
    assert.deepEqual(screen(["\x1b[?1049h\x1b[?25ltext\x1b[?25h\x1b[?1049l"]), ["text"]);
  });

test("strips unknown CSI finals without corrupting the row", () => {
    assert.deepEqual(screen(["ok\x1b[38;5;196m!\x1b[?12;25hdone"]), ["ok!done"]);
  });

test("consumes OSC strings terminated by BEL", () => {
    assert.deepEqual(screen(["\x1b]0;window title\x07visible"]), ["visible"]);
  });

test("consumes OSC strings terminated by ST", () => {
    assert.deepEqual(screen(["\x1b]8;;https://x\x1b\\link"]), ["link"]);
  });

test("consumes DCS strings to ST", () => {
    assert.deepEqual(screen(["\x1bP1$r\x1b\\after"]), ["after"]);
  });

test("drops other C0 controls and DEL", () => {
    assert.deepEqual(screen(["a\x00b\x07c\x7fd"]), ["abcd"]);
  });

test("holds a partial escape sequence across feed boundaries", () => {
    assert.deepEqual(screen(["abc\x1b", "[K"]), ["abc"]);
    // EL does not move the cursor: the row is blank, then 'd' lands at col 3.
    assert.deepEqual(screen(["abc\x1b[", "2Kd"]), ["   d"]);
    assert.deepEqual(screen(["\x1b]0;ti", "tle\x07x"]), ["x"]);
  });

test("holds a mid-params CSI across feed boundaries", () => {
    assert.deepEqual(screen(["hello\r\x1b[", "3", "GX"]), ["heXlo"]);
  });

test("nested tqdm moveto pattern (newlines + cursor-up + EL) stays bounded", () => {
    const buffer = new TerminalBuffer();
    // Simulate two positioned bars (positions 0 and 1).
    buffer.feed("bar0\r\x1b[K 10%\nbar1\r\x1b[K 20%\n\x1b[A\x1b[A");
    buffer.feed("\r\x1b[K 50%\r\x1b[K 90%\n\x1b[A");
    buffer.feed("\r\x1b[K 100%\n");
    const lines = buffer.getLines();
    // Bar 0's row was rewritten twice; bar 1's row keeps its last state. The
    // buffer never grew past the three rows the newlines created.
    assert.deepEqual(lines, [" 100%", " 20%", ""]);
    assert.equal(lines.length, 3);
  });

test("reset returns to a blank one-row screen", () => {
    const buffer = new TerminalBuffer();
    buffer.feed("a\nb\n");
    buffer.reset();
    assert.deepEqual(buffer.getLines(), [""]);
    assert.equal(buffer.hasContent(), false);
  });

test("hasContent reflects printable writes only", () => {
    const buffer = new TerminalBuffer();
    buffer.feed("\n\n\r\x1b[K");
    assert.equal(buffer.hasContent(), false);
    buffer.feed("x");
    assert.equal(buffer.hasContent(), true);
  });

test("overwriting shortens nothing: writes past the row end extend it", () => {
    assert.deepEqual(screen(["ab\x1b[5GX"]), ["ab  X"]);
  });
