import type { Theme } from "@earendil-works/pi-coding-agent";
import { colorToRgb } from "@earendil-works/pi-tui";
import type { Highlighter } from "shiki";
import { debugLog } from "../utils";

/** Match the main tool pane, not the selection highlight or foreground color. */
export function resolveShikiThemeName(theme?: Theme): string {
  if (process.env.PTC_CODE_THEME) return process.env.PTC_CODE_THEME;
  let rgb: { r: number; g: number; b: number } | undefined;
  try {
    const color = theme?.colors?.toolSuccessBg;
    if (color) rgb = colorToRgb(color);
  } catch { /* Older hosts may only expose ANSI theme colors. */ }
  if (!rgb) {
    try { rgb = parseBackground(theme?.getBgAnsi("toolSuccessBg")); } catch { /* No UI. */ }
  }
  if (rgb) {
    const luma = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
    return luma > 128 ? "github-light" : "github-dark";
  }
  return theme?.appearance === "light" ? "github-light" : "github-dark";
}

function parseBackground(ansi?: string): { r: number; g: number; b: number } | undefined {
  const rgb = ansi?.match(/\x1b\[48;2;(\d+);(\d+);(\d+)m/);
  if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
  const indexed = ansi?.match(/\x1b\[48;5;(\d+)m/);
  if (!indexed) return undefined;
  const n = +indexed[1];
  if (n < 16 || n > 255) return undefined;
  if (n >= 232) {
    const level = 8 + (n - 232) * 10;
    return { r: level, g: level, b: level };
  }
  const cube = [0, 95, 135, 175, 215, 255];
  const i = n - 16;
  return { r: cube[Math.floor(i / 36)], g: cube[Math.floor(i / 6) % 6], b: cube[i % 6] };
}

const highlighters = new Map<string, Promise<Highlighter | null>>();
const highlights = new Map<string, string[]>();
const pending = new Map<string, Promise<string[] | null>>();

export function cellHighlightKey(code: string, theme?: Theme): string {
  return JSON.stringify([resolveShikiThemeName(theme), code]);
}

export function cachedCellHighlights(code: string, theme?: Theme): string[] | undefined {
  return highlights.get(cellHighlightKey(code, theme));
}

/** Keep colors on the unchanged source prefix while a newer Shiki result is pending. */
export function reuseCellHighlights(code: string, previousCode: string, previous: string[]): string[] {
  let common = 0;
  while (common < code.length && common < previousCode.length && code[common] === previousCode[common]) common++;
  // Never preserve half of a changed surrogate pair.
  if (common > 0 && /[\uD800-\uDBFF]/.test(code[common - 1]!)) common--;
  const previousLines = previousCode.split("\n");
  return code.split("\n").map((line, index) => {
    const keep = Math.max(0, Math.min(line.length, common));
    common = Math.max(0, common - line.length - 1);
    const old = previous[index];
    if (!keep || old === undefined) return line;
    if (keep === line.length && line === previousLines[index]) return old;
    let prefix = "";
    let length = 0;
    for (const match of old.matchAll(/\x1b\[[0-9;]*m|[^\n]/gu)) {
      const part = match[0];
      if (part.startsWith("\x1b[")) prefix += part;
      else {
        if (length + part.length > keep) break;
        prefix += part;
        length += part.length;
      }
      if (length >= keep) break;
    }
    return prefix + "\x1b[0m" + line.slice(keep);
  });
}

function getHighlighter(name: string): Promise<Highlighter | null> {
  let promise = highlighters.get(name);
  if (!promise) {
    // Keep a real dynamic import: jiti supplies the ESM interop for Shiki.
    promise = import("shiki")
      .then((shiki) => shiki.createHighlighter({ themes: [name], langs: ["python"] }))
      .catch((error: unknown) => {
        highlighters.delete(name);
        debugLog(`shiki unavailable; using plain code: ${String(error)}`);
        return null;
      });
    highlighters.set(name, promise);
  }
  return promise;
}

function hexRgb(hex: string): { r: number; g: number; b: number } | undefined {
  const match = /^#([\da-f]{6}|[\da-f]{3})$/i.exec(hex);
  if (!match) return undefined;
  const full = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) };
}

/** Shared by approval, argument streaming, executing frames, and settled cells. */
export async function highlightCellCode(code: string, theme?: Theme): Promise<string[] | null> {
  const key = cellHighlightKey(code, theme);
  const cached = highlights.get(key);
  if (cached) return cached;
  const active = pending.get(key);
  if (active) return active;
  const name = resolveShikiThemeName(theme);
  const task = (async () => {
    try {
      const highlighter = await getHighlighter(name);
      if (!highlighter) return null;
      const { tokens } = highlighter.codeToTokens(code, { lang: "python", theme: name });
      const onLight = name.includes("light");
      const lines = tokens.map((line) => line.map((token) => {
        let rgb = token.color ? hexRgb(token.color) : undefined;
        if (rgb) {
          const luma = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
          // Bright colors wash out on light backgrounds; dark colors disappear
          // on dark backgrounds. Do not replace dark, readable light-theme ink.
          if (onLight ? luma > 140 : luma < 72) {
            rgb = hexRgb(onLight ? "#57606a" : "#8b949e");
          }
        }
        const color = rgb ? `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m` : "";
        const style = token.fontStyle ?? 0;
        const font = (style & 1 ? "\x1b[3m" : "") + (style & 2 ? "\x1b[1m" : "") + (style & 4 ? "\x1b[4m" : "");
        return color || font ? color + font + token.content + "\x1b[0m" : token.content;
      }).join(""));
      if (highlights.size >= 32) highlights.clear();
      highlights.set(key, lines);
      return lines;
    } catch (error) {
      debugLog(`shiki highlighting failed; using plain code: ${String(error)}`);
      return null;
    }
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
