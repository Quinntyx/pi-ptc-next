/**
 * Execution code viewport.
 *
 * Keeps the executing-line marker visible using a scroll-margin model instead
 * of pinning the marker at a fixed row: the marker moves freely while it stays
 * at least CODE_VIEW_MARGIN lines from the top/bottom of the window, and the
 * content only scrolls when the marker would enter that margin. Small jumps
 * (e.g. loop iterations) therefore move the marker while the code stays
 * stationary, while long jumps scroll the window just enough to bring the
 * marker back into the band.
 */

/** Maximum number of user-code lines shown while windowed. */
export const CODE_VIEW_HEIGHT = 10;

/** Code longer than this many lines is shown in a scrollable window. */
export const CODE_VIEW_FULL_THRESHOLD = 12;

/** The marker is kept at least this many lines from the window edges. */
export const CODE_VIEW_MARGIN = 3;

export interface CodeViewState {
  /** 1-based index of the first user-code line currently visible. */
  viewStartLine?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Compute the 1-based first visible line for the given currently-executing
 * line. `previousStart` is the first visible line from the last render; it is
 * reused whenever the marker stays within the scroll margins so the content
 * does not jump around for small movements.
 */
export function computeCodeViewStart(
  currentLine: number,
  totalLines: number,
  previousStart: number | undefined
): number {
  const maxStart = Math.max(1, totalLines - CODE_VIEW_HEIGHT + 1);

  if (previousStart === undefined) {
    // First render: anchor the marker at the top margin.
    return clamp(currentLine - CODE_VIEW_MARGIN, 1, maxStart);
  }

  const markerRow = currentLine - previousStart + 1; // 1-based row within the window
  if (markerRow < CODE_VIEW_MARGIN + 1) {
    // Marker would sit inside the top margin: scroll it back to the margin.
    return clamp(currentLine - CODE_VIEW_MARGIN, 1, maxStart);
  }
  if (markerRow > CODE_VIEW_HEIGHT - CODE_VIEW_MARGIN) {
    // Marker would sit inside the bottom margin: scroll it back to the margin.
    return clamp(currentLine - (CODE_VIEW_HEIGHT - CODE_VIEW_MARGIN) + 1, 1, maxStart);
  }
  return previousStart;
}