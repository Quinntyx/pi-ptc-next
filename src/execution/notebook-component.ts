import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { FULLSCREEN_VIEWPORT_LINES, NORMAL_VIEWPORT_LINES, type CellRenderOptions } from "./cell-view";
import type { NotebookRenderState } from "./notebook-render";

interface ScrollRegion {
  key: string;
  top: number;
  bottom: number;
  start: number;
  maximum: number;
  followsTail: boolean;
}

/** Build each box with its own persistent viewport and local mouse hit region. */
export class NotebookBoxLayout {
  readonly regions: ScrollRegion[] = [];
  constructor(private readonly state: NotebookRenderState) {}

  box(
    key: string,
    totalLines: number,
    options: CellRenderOptions,
    render: (options: CellRenderOptions) => string[],
    top = 0,
    followsTail = false,
    scrollable = true,
  ): string[] {
    const cap = options.mode === "normal" ? NORMAL_VIEWPORT_LINES : FULLSCREEN_VIEWPORT_LINES;
    const maximum = Math.max(1, totalLines - cap + 1);
    const position = this.state.scrollPositions?.[key] ?? options.viewStart ?? (followsTail ? maximum : 1);
    const start = Math.max(1, Math.min(maximum, position));
    const lines = render({ ...options, viewStart: start });
    if (scrollable && options.mode === "fullscreen" && maximum > 1) {
      this.regions.push({ key, top, bottom: top + lines.length, start, maximum, followsTail });
    }
    return lines;
  }
}

/** Width-aware, mouse-scrollable tool component. Regular mode keeps terminal scrollback. */
export class NotebookComponent implements Component {
  private regions: ScrollRegion[] = [];
  constructor(
    private readonly build: (width: number, layout: NotebookBoxLayout) => string[],
    private readonly state: NotebookRenderState = {},
    private readonly redraw?: () => void,
  ) {}

  render(width: number): string[] {
    const layout = new NotebookBoxLayout(this.state);
    const lines = this.build(width, layout);
    this.regions = layout.regions;
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Preserve transcript selection/clicks and let unhandled events reach the
    // outer ScrollView. Ctrl+o remains the keyboard path to the complete cell.
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    const region = this.regions.find((box) => event.y >= box.top && event.y < box.bottom);
    if (!region) return undefined;
    const next = Math.max(1, Math.min(region.maximum, region.start + event.wheelDelta));
    if (next === region.start) return { handled: true, render: false };
    const positions = this.state.scrollPositions ??= {};
    if (region.followsTail && next === region.maximum) delete positions[region.key];
    else positions[region.key] = next;
    region.start = next;
    this.redraw?.();
    return { handled: true, render: true };
  }

  // Keep the last painted hit regions until repaint: host invalidation can occur
  // between consecutive wheel events, which must not leak into transcript scrolling.
  invalidate(): void {}
}
