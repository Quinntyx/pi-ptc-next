import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Vendored shimmer sweep, ported from pi-tool-tree's activity-label painter
 * (`shimmerText`) so the running-subagent animation works without pi-tool-tree
 * installed. Same mechanics as the original: a highlight band travels left to
 * right over the label with a cosine falloff, repainting every
 * SHIMMER_INTERVAL_MS. Colors derive from the active pi theme (truecolor or
 * 256-color ANSI, parsed back to RGB) instead of pi-tool-tree's internal
 * palette; the thinking-level tint is dropped (no session-runtime dependency).
 *
 * When the caller has no theme, callers should fall back to a muted paint (see
 * `shimmerWord` in subagent-panel.ts).
 */

type Rgb = { r: number; g: number; b: number };

const SHIMMER_PERIOD_MS = 1800;
/** Repaint cadence the sweep expects (exported so host repaints can match). */
export const SHIMMER_INTERVAL_MS = 80;
/** Highlight band half-width, as a fraction of the label length. */
const SHIMMER_BAND_RATIO = 0.65;
/** Mix toward the band color at the band's center. */
const SHIMMER_PEAK_MIX = 1;
/** Exponent on the cosine falloff; >1 keeps the tint in a hot core. */
const SHIMMER_FALLOFF_POW = 1.5;
/** Minimum RGB distance between the band and the label's own color. */
const SHIMMER_MIN_BAND_DELTA = 72;
/** Minimum distance between the band and the base for a visible sweep. */
const SHIMMER_MIN_SWEEP_DELTA = 40;
/** Minimum W3C contrast ratio between the band and the panel background. */
const SHIMMER_MIN_CONTRAST = 1.6;
/** Theme keys tried, in order, for the band's hot color. */
const SWEEP_COLOR_KEYS = ["accent", "borderAccent", "mdLink", "success"] as const;
/** Label base color when the theme exposes no text/muted key. */
const DEFAULT_LABEL_FG_ANSI = "\x1b[38;2;212;212;212m";

const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
const TRANSPARENT_RESET = "\x1b[39m\x1b[49m";

function safeFgAnsi(theme: Theme | undefined, key: string): string | null {
  try {
    const ansi = (theme as unknown as { getFgAnsi?: (k: string) => string } | undefined)?.getFgAnsi?.(key);
    return typeof ansi === "string" && ansi.length > 0 ? ansi : null;
  } catch {
    return null;
  }
}

function safeBgAnsi(theme: Theme | undefined, key: string): string | null {
  try {
    const ansi = (theme as unknown as { getBgAnsi?: (k: string) => string } | undefined)?.getBgAnsi?.(key);
    return typeof ansi === "string" && ansi.length > 0 ? ansi : null;
  } catch {
    return null;
  }
}

function parseAnsiRgb(ansi: string): Rgb | null {
  if (!ansi) return null;
  const esc = "\u001b";
  // Truecolor: \e[38;2;R;G;Bm or \e[48;2;R;G;Bm
  const tc = ansi.match(new RegExp(`${esc}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
  if (tc) return { r: +tc[1], g: +tc[2], b: +tc[3] };
  // 256-color: \e[38;5;Nm or \e[48;5;Nm (Apple Terminal, screen, …)
  const idx = ansi.match(new RegExp(`${esc}\\[(?:38|48);5;(\\d+)m`));
  if (idx) return xterm256ToRgb(+idx[1]);
  return null;
}

function xterm256ToRgb(index: number): Rgb | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < 16) {
    // Standard 16 ANSI colors — terminal-defined; approximate with VS Code defaults.
    const basic: Array<[number, number, number]> = [
      [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
      [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
      [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
      [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
    ];
    const [r, g, b] = basic[index];
    return { r, g, b };
  }
  if (index < 232) {
    const i = index - 16;
    return {
      r: CUBE_VALUES[Math.floor(i / 36) % 6],
      g: CUBE_VALUES[Math.floor(i / 6) % 6],
      b: CUBE_VALUES[i % 6],
    };
  }
  const level = 8 + (index - 232) * 10;
  return { r: level, g: level, b: level };
}

function themeFgRgb(theme: Theme | undefined, key: string): Rgb | null {
  const ansi = safeFgAnsi(theme, key);
  return ansi ? parseAnsiRgb(ansi) : null;
}

function themePanelBgRgb(theme: Theme | undefined): Rgb | null {
  return themeBgRgb(theme, "toolSuccessBg") || themeBgRgb(theme, "userMessageBg") || themeBgRgb(theme, "selectedBg");
}

function themeBgRgb(theme: Theme | undefined, key: string): Rgb | null {
  const ansi = safeBgAnsi(theme, key);
  return ansi ? parseAnsiRgb(ansi) : null;
}

function isLightThemeBackground(theme: Theme | undefined): boolean {
  const panel = themePanelBgRgb(theme);
  if (panel) {
    const lum = 0.2126 * panel.r + 0.7152 * panel.g + 0.0722 * panel.b;
    return lum > 165;
  }
  const fg = themeFgRgb(theme, "text") || themeFgRgb(theme, "fg");
  if (fg) {
    const lum = 0.2126 * fg.r + 0.7152 * fg.g + 0.0722 * fg.b;
    return lum < 95;
  }
  return false;
}

function mixRgb(a: Rgb, b: Rgb, ratio: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * ratio,
    g: a.g + (b.g - a.g) * ratio,
    b: a.b + (b.b - a.b) * ratio,
  };
}

function rgbDistance(a: Rgb, b: Rgb): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function relativeLuminance(c: Rgb): number {
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Label base color: the theme's primary text color (falls back to muted, then a neutral grey). */
function shimmerBaseRgb(theme: Theme | undefined): Rgb {
  const rgb = themeFgRgb(theme, "text") || themeFgRgb(theme, "muted");
  if (rgb) return rgb;
  return parseAnsiRgb(DEFAULT_LABEL_FG_ANSI) ?? { r: 212, g: 212, b: 212 };
}

/** The band's hot color: the theme's accent, falling back through its keys. */
function shimmerSweepRgb(theme: Theme | undefined): Rgb | null {
  for (const key of SWEEP_COLOR_KEYS) {
    const rgb = themeFgRgb(theme, key);
    if (rgb) return rgb;
  }
  return null;
}

/** Keep a band color visible against the panel; muted accents step toward the panel's opposite. */
function readableOnPanel(rgb: Rgb, panel: Rgb | null, light: boolean): Rgb {
  if (!panel) return rgb;
  if (contrastRatio(rgb, panel) >= SHIMMER_MIN_CONTRAST) return rgb;
  const target = light ? { r: 12, g: 16, b: 18 } : { r: 255, g: 255, b: 255 };
  for (const push of [0.25, 0.45, 0.65]) {
    const candidate = mixRgb(rgb, target, push);
    if (contrastRatio(candidate, panel) >= SHIMMER_MIN_CONTRAST) return candidate;
  }
  return mixRgb(rgb, target, 0.65);
}

/** Keep the band visibly different from the label's own color. */
function ensureBandContrast(base: Rgb, band: Rgb, light: boolean): Rgb {
  if (rgbDistance(base, band) >= SHIMMER_MIN_BAND_DELTA) return band;
  const away = light ? { r: 12, g: 16, b: 18 } : { r: 255, g: 255, b: 255 };
  let out = band;
  for (const push of [0.3, 0.5, 0.7, 0.85]) {
    out = mixRgb(band, away, push);
    if (rgbDistance(base, out) >= SHIMMER_MIN_BAND_DELTA) return out;
  }
  return out;
}

function shimmerHighlightRgb(theme: Theme | undefined, base: Rgb): Rgb {
  const light = isLightThemeBackground(theme);
  const sweep = shimmerSweepRgb(theme);
  const band =
    sweep && rgbDistance(base, sweep) >= SHIMMER_MIN_SWEEP_DELTA
      ? readableOnPanel(sweep, themePanelBgRgb(theme), light)
      : light
        ? mixRgb(base, { r: 12, g: 16, b: 18 }, 0.75)
        : mixRgb(base, { r: 255, g: 255, b: 255 }, 0.92);
  return ensureBandContrast(base, band, light);
}

/**
 * Paint `text` with a highlight band part-way across it. The band travels left
 * to right and wraps, so each re-render of a running label advances the wave.
 * Time-phased: repaint on SHIMMER_INTERVAL_MS and the band advances on its own.
 */
export function shimmerText(text: string, theme?: Theme): string {
  const length = text.length;
  if (length === 0) return "";
  const base = shimmerBaseRgb(theme);
  const highlight = shimmerHighlightRgb(theme, base);
  const band = Math.max(2, length * SHIMMER_BAND_RATIO);
  const phase = (Date.now() % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS;
  const center = -band + phase * (length + band * 2);
  let out = "";
  let lastAnsi = "";
  for (let i = 0; i < length; i++) {
    const distance = Math.abs(i + 0.5 - center) / band;
    // Cosine falloff: 1 at the band center, 0 past the band edge. The exponent
    // tightens the skirt so the band reads as a comet with a hot core.
    const falloff =
      distance >= 1 ? 0 : Math.pow(0.5 * (1 + Math.cos(Math.PI * distance)), SHIMMER_FALLOFF_POW);
    const rgb = mixRgb(base, highlight, falloff * SHIMMER_PEAK_MIX);
    const ansi = `\x1b[38;2;${Math.round(rgb.r)};${Math.round(rgb.g)};${Math.round(rgb.b)}m`;
    if (ansi !== lastAnsi) {
      out += ansi;
      lastAnsi = ansi;
    }
    out += text[i];
  }
  return `${out}${TRANSPARENT_RESET}`;
}
