/**
 * Minimal VT100-subset screen buffer for live Out-box streaming.
 *
 * Interprets exactly the escape repertoire real Python output emits on a
 * non-tty stream (validated against tqdm 4.70.1 / rich 15 in R2's research):
 *
 * - C0: `\r` (col→0), `\n` (newline, col→0 — cooked-mode ONLCR semantics),
 *   `\b`, `\t` (8-column stops); every other C0 byte is dropped.
 * - CSI: `ESC[K` / `ESC[0K` / `1K` / `2K` (EL), `ESC[2J` / `ESC[3J` (ED clear),
 *   `ESC[nA` / `nB` / `nC` / `nD` (cursor moves), `ESC[nG` / `` ESC[n` `` and
 *   `ESC[H` / `ESC[n;mH` / `f` (absolute positioning).
 * - SGR (`ESC[…m`), private-mode (`ESC[?…h/l`), and any unknown CSI final byte
 *   are consumed and STRIPPED — never passed through, so the box can never be
 *   corrupted by a sequence it does not understand.
 * - OSC / DCS / SOS / PM / APC strings are consumed up to their terminator
 *   (BEL or ST).
 *
 * Design decisions (deliberate divergences from a full VT emulator):
 * - **No wrapping.** Lines grow unboundedly; the renderer (cell-view) applies
 *   its own hard-truncation at paint time with the real terminal width. A
 *   fixed-width wrap grid would bake one width into the persisted geometry;
 *   truncation keeps resize behavior in the renderer where it belongs.
 * - **One cell per code point.** Width accounting matches cell-view's
 *   `visibleWidth`, so cursor positioning and render-time padding can never
 *   disagree. (tqdm/rich progress output on a non-tty is ASCII in practice.)
 * - **Scrollback by growth.** `\n` on the last row appends a row; cursor-up
 *   moves back into the buffer and later `\r`-overwrites mutate the active
 *   tail. Cursor-down past the last row clamps (no scrolling semantics).
 *
 * The state machine holds partially received escape sequences across `feed()`
 * calls, so chunk boundaries mid-sequence are safe.
 */

/** State machine states for escape-sequence parsing. */
const enum ParseState {
  Ground = 0,
  /** Just saw ESC. */
  Escape = 1,
  /** Inside CSI: collecting param/intermediate bytes until a final byte. */
  Csi = 2,
  /** Inside an OSC string: terminated by BEL or ST (ESC \). */
  Osc = 3,
  /** Inside a DCS/SOS/PM/APC string: terminated by ST (ESC \). */
  Str = 4,
  /** Saw ESC while inside a string: possibly the ST terminator. */
  StrEscape = 5,
}

const TAB_STOP = 8;

/** A mutable screen: an append-only list of rows plus a cursor. */
export class TerminalBuffer {
  private rows: string[] = [""];
  private row = 0;
  private col = 0;
  private state: ParseState = ParseState.Ground;
  /** Partial CSI byte accumulation (params + intermediates). */
  private csiBytes = "";

  /** Drop all content and cursor state (start of a new cell). */
  reset(): void {
    this.rows = [""];
    this.row = 0;
    this.col = 0;
    this.state = ParseState.Ground;
    this.csiBytes = "";
  }

  /** Current screen contents, one entry per row (control-free by construction). */
  getLines(): string[] {
    return this.rows.slice();
  }

  /** True once anything printable has been written since the last reset. */
  hasContent(): boolean {
    return this.rows.some((rowText) => rowText.length > 0);
  }

  /**
   * Feed a raw stdout chunk. Safe to call with arbitrary chunk boundaries:
   * partial escape sequences are buffered until their remaining bytes arrive.
   */
  feed(text: string): void {
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      switch (this.state) {
        case ParseState.Ground:
          this.consumeGround(ch, code);
          break;
        case ParseState.Escape:
          this.consumeEscape(ch);
          break;
        case ParseState.Csi:
          this.consumeCsi(ch, code);
          break;
        case ParseState.Osc:
          if (code === 0x07) this.state = ParseState.Ground;
          else if (ch === "\x1b") this.state = ParseState.StrEscape;
          break;
        case ParseState.Str:
          if (ch === "\x1b") this.state = ParseState.StrEscape;
          break;
        case ParseState.StrEscape:
          // Only ESC \ terminates a string; anything else keeps us in it.
          this.state = ch === "\\" ? ParseState.Ground : ParseState.Str;
          break;
      }
    }
  }

  private consumeGround(ch: string, code: number): void {
    if (ch === "\x1b") {
      this.state = ParseState.Escape;
      return;
    }
    if (ch === "\r") {
      this.col = 0;
      return;
    }
    if (ch === "\n") {
      this.col = 0; // cooked-mode semantics: LF implies CR
      this.row += 1;
      if (this.row >= this.rows.length) this.rows.push("");
      return;
    }
    if (ch === "\b") {
      this.col = Math.max(0, this.col - 1);
      return;
    }
    if (ch === "\t") {
      this.col = (Math.floor(this.col / TAB_STOP) + 1) * TAB_STOP;
      return;
    }
    if (code < 0x20 || code === 0x7f) {
      return; // other C0 controls and DEL: dropped
    }
    this.writeChar(ch);
  }

  private writeChar(ch: string): void {
    const rowText = this.rows[this.row]!;
    if (this.col < rowText.length) {
      // Overwrite semantics (a terminal, not an editor): the character under
      // the cursor is replaced; everything after it is preserved.
      this.rows[this.row] = rowText.slice(0, this.col) + ch + rowText.slice(this.col + 1);
    } else {
      this.rows[this.row] = rowText + " ".repeat(this.col - rowText.length) + ch;
    }
    this.col += 1;
  }

  private consumeEscape(ch: string): void {
    if (ch === "[") {
      this.state = ParseState.Csi;
      this.csiBytes = "";
      return;
    }
    if (ch === "]") {
      this.state = ParseState.Osc;
      return;
    }
    if (ch === "P" || ch === "X" || ch === "^" || ch === "_") {
      this.state = ParseState.Str;
      return;
    }
    // Any other escape sequence (charset selection, ESC 7/8, ESC M, ...):
    // consumed and dropped.
    this.state = ParseState.Ground;
  }

  private consumeCsi(ch: string, code: number): void {
    if (code >= 0x30 && code <= 0x3f) {
      this.csiBytes += ch; // parameter bytes (digits, `;`, `?`, `<`, `=`, `>`)
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.csiBytes += ch; // intermediate bytes: collected, then dropped
      return;
    }
    // Final byte 0x40–0x7E: dispatch.
    this.state = ParseState.Ground;
    // Private-mode sequences (?…h/l etc.) and any unrecognized final byte are
    // consumed silently — strip, never passthrough.
    if (this.csiBytes.startsWith("?")) return;
    const params = this.csiBytes
      .split(";")
      .map((part) => (/^\d+$/.test(part) ? parseInt(part, 10) : undefined));
    const n = (index: number, fallback: number): number => {
      const value = params[index];
      return typeof value === "number" ? value : fallback;
    };
    switch (ch) {
      case "K": {
        const mode = n(0, 0);
        const rowText = this.rows[this.row]!;
        if (mode === 0) {
          // EL/0: clear from the cursor to the end of the line.
          this.rows[this.row] = rowText.slice(0, this.col);
        } else if (mode === 1) {
          // EL/1: clear from the start of the line THROUGH the cursor; the
          // text after the cursor keeps its column (blank padding, not a
          // shift), so subsequent cursor-addressed writes stay aligned.
          const cleared = Math.min(this.col + 1, rowText.length);
          this.rows[this.row] = " ".repeat(cleared) + rowText.slice(cleared);
        } else if (mode === 2) {
          this.rows[this.row] = "";
        }
        return;
      }
      case "J": {
        const mode = n(0, 0);
        if (mode === 2 || mode === 3) {
          this.rows = this.rows.map(() => "");
        }
        return;
      }
      case "A":
        this.row = Math.max(0, this.row - Math.max(1, n(0, 1)));
        return;
      case "B": {
        const maxRow = this.rows.length - 1;
        this.row = Math.min(maxRow, this.row + Math.max(1, n(0, 1)));
        return;
      }
      case "C":
        this.col += Math.max(1, n(0, 1));
        return;
      case "D":
        this.col = Math.max(0, this.col - Math.max(1, n(0, 1)));
        return;
      case "G":
      case "`":
        this.col = Math.max(0, n(0, 1) - 1);
        return;
      case "H":
      case "f": {
        const targetRow = Math.max(1, n(0, 1)) - 1;
        this.row = Math.min(this.rows.length - 1, targetRow);
        this.col = Math.max(0, n(1, 1) - 1);
        return;
      }
      default:
        return; // SGR (`m`) and everything else: stripped
    }
  }
}
