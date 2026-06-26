import type { Locale } from "../i18n.js";
import type { AspectRatio } from "../types.js";

/**
 * Common output ratios offered in the picker. Matches CapCut's roster
 * so users coming from CapCut find their muscle memory intact. Ordered
 * landscape → portrait → square → classic to mirror what the popover
 * shows visually.
 */
export const ASPECT_OPTIONS: ReadonlyArray<{
  value: AspectRatio;
  label: string;
  /** Aspect for the preview tile inside the menu — width-major. */
  tileW: number;
  tileH: number;
}> = [
  { value: "16:9", label: "16:9", tileW: 22, tileH: 12 },
  { value: "9:16", label: "9:16", tileW: 12, tileH: 22 },
  { value: "1:1", label: "1:1", tileW: 18, tileH: 18 },
  { value: "4:3", label: "4:3", tileW: 22, tileH: 16 },
  { value: "3:4", label: "3:4", tileW: 16, tileH: 22 },
  { value: "4:5", label: "4:5", tileW: 16, tileH: 20 },
  { value: "21:9", label: "21:9", tileW: 24, tileH: 10 },
];

export interface AspectPickerCallbacks {
  onChange: (aspect: AspectRatio | null) => void;
}

/**
 * Built-in aspect-ratio picker. Renders a chip-style button that opens
 * a popover with the common ratios listed in `ASPECT_OPTIONS`. The
 * "Original" entry clears `Project.aspect`. Popover positioning uses
 * `position: fixed` to escape the toolbar's overflow clipping.
 */
export class AspectPicker {
  readonly element: HTMLDivElement;
  private button: HTMLButtonElement;
  private valueLabel: HTMLSpanElement;
  private popover: HTMLDivElement | null = null;
  private cb: AspectPickerCallbacks;
  private locale: Locale;
  private value: AspectRatio | null = null;
  private docClick: ((e: MouseEvent) => void) | null = null;
  private docKey: ((e: KeyboardEvent) => void) | null = null;
  private docResize: (() => void) | null = null;

  constructor(cb: AspectPickerCallbacks, locale: Locale) {
    this.cb = cb;
    this.locale = locale;
    this.element = document.createElement("div");
    this.element.className = "aicut-aspect-picker";
    this.element.setAttribute("data-testid", "aicut-aspect-picker");

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "aicut-aspect-trigger";
    this.button.setAttribute("aria-haspopup", "menu");
    this.button.setAttribute("aria-expanded", "false");
    this.button.setAttribute("data-testid", "aicut-aspect-trigger");

    // Dropped the leading frame icon — the ratio label ("16:9" /
    // "1:1" / etc.) is more informative AND tabular, so the chip
    // stays compact and self-explanatory without the extra glyph.
    this.valueLabel = document.createElement("span");
    this.valueLabel.className = "aicut-aspect-trigger-label";

    const caret = document.createElement("span");
    caret.className = "aicut-aspect-trigger-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.innerHTML =
      `<svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 4l3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

    this.button.append(this.valueLabel, caret);
    this.button.addEventListener("click", () => this.toggle());
    this.element.appendChild(this.button);

    this.applyLocale();
    this.applyValue();
  }

  setLocale(locale: Locale): void {
    this.locale = locale;
    this.applyLocale();
    if (this.popover) {
      this.closePopover();
      this.openPopover();
    }
  }

  setValue(value: AspectRatio | null): void {
    if (value === this.value) return;
    this.value = value;
    this.applyValue();
    if (this.popover) this.refreshSelectedState();
  }

  destroy(): void {
    this.closePopover();
    this.element.remove();
  }

  private applyLocale(): void {
    this.button.title = this.locale.aspectTitle;
    this.button.setAttribute("aria-label", this.locale.aspectTitle);
  }

  private applyValue(): void {
    this.valueLabel.textContent = this.value ?? this.locale.aspectOriginal;
  }

  private toggle(): void {
    if (this.popover) this.closePopover();
    else this.openPopover();
  }

  private openPopover(): void {
    if (this.popover) return;
    const pop = document.createElement("div");
    pop.className = "aicut-aspect-menu";
    pop.setAttribute("role", "menu");
    pop.setAttribute("data-testid", "aicut-aspect-menu");

    const header = document.createElement("div");
    header.className = "aicut-aspect-menu-header";
    header.textContent = this.locale.aspectMenuLabel;
    pop.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "aicut-aspect-menu-grid";

    for (const opt of ASPECT_OPTIONS) {
      grid.appendChild(this.makeOption(opt.value, opt.label, opt.tileW, opt.tileH));
    }
    // "Original" is a separate option at the end — picking it clears
    // `Project.aspect` so the host falls back to whatever default it
    // was using before the picker existed.
    grid.appendChild(this.makeOption(null, this.locale.aspectOriginal, 20, 16));

    pop.appendChild(grid);
    document.body.appendChild(pop);
    this.popover = pop;
    this.button.setAttribute("aria-expanded", "true");
    // Popover lives outside `.aicut-root`, so the editor's CSS
    // custom properties don't cascade in. Copy the ones the popover
    // styles depend on so the theme follows the editor that opened it.
    const cs = getComputedStyle(this.button);
    for (const name of [
      "--aicut-controls-bg",
      "--aicut-controls-border",
      "--aicut-controls-text",
      "--aicut-controls-hover",
      "--aicut-controls-active",
      "--color-brand",
    ]) {
      const v = cs.getPropertyValue(name).trim();
      if (v) pop.style.setProperty(name, v);
    }
    this.positionPopover();
    this.refreshSelectedState();

    this.docClick = (e) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (this.popover?.contains(t)) return;
      if (this.button.contains(t)) return;
      this.closePopover();
    };
    this.docKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closePopover();
        this.button.focus();
      }
    };
    this.docResize = () => this.positionPopover();
    // Defer until after this click event finishes so the synthetic
    // toggle click doesn't immediately close us.
    setTimeout(() => {
      if (!this.docClick) return;
      document.addEventListener("mousedown", this.docClick, true);
    }, 0);
    document.addEventListener("keydown", this.docKey);
    window.addEventListener("resize", this.docResize);
    window.addEventListener("scroll", this.docResize, true);
  }

  private closePopover(): void {
    if (!this.popover) return;
    this.popover.remove();
    this.popover = null;
    this.button.setAttribute("aria-expanded", "false");
    if (this.docClick) {
      document.removeEventListener("mousedown", this.docClick, true);
      this.docClick = null;
    }
    if (this.docKey) {
      document.removeEventListener("keydown", this.docKey);
      this.docKey = null;
    }
    if (this.docResize) {
      window.removeEventListener("resize", this.docResize);
      window.removeEventListener("scroll", this.docResize, true);
      this.docResize = null;
    }
  }

  private positionPopover(): void {
    if (!this.popover) return;
    const r = this.button.getBoundingClientRect();
    const padding = 8;
    // Default: open below, left-aligned with the button.
    let top = r.bottom + 6;
    let left = r.left;
    const popRect = this.popover.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (left + popRect.width + padding > vw) {
      left = Math.max(padding, vw - popRect.width - padding);
    }
    if (top + popRect.height + padding > vh) {
      // Flip above when there's no room below.
      top = Math.max(padding, r.top - popRect.height - 6);
    }
    this.popover.style.position = "fixed";
    this.popover.style.top = `${Math.round(top)}px`;
    this.popover.style.left = `${Math.round(left)}px`;
  }

  private refreshSelectedState(): void {
    if (!this.popover) return;
    const items = this.popover.querySelectorAll<HTMLButtonElement>(
      ".aicut-aspect-option",
    );
    for (const el of items) {
      const v = el.getAttribute("data-aspect");
      const matches = v === (this.value ?? "__original__");
      el.classList.toggle("aicut-aspect-option-active", matches);
      el.setAttribute("aria-checked", matches ? "true" : "false");
    }
  }

  private makeOption(
    value: AspectRatio | null,
    label: string,
    tileW: number,
    tileH: number,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "aicut-aspect-option";
    btn.setAttribute("role", "menuitemradio");
    btn.setAttribute("data-aspect", value ?? "__original__");
    btn.setAttribute("data-testid", `aicut-aspect-option-${value ?? "original"}`);

    const tileWrap = document.createElement("span");
    tileWrap.className = "aicut-aspect-option-tile-wrap";
    const tile = document.createElement("span");
    tile.className = "aicut-aspect-option-tile";
    tile.style.width = `${tileW}px`;
    tile.style.height = `${tileH}px`;
    tileWrap.appendChild(tile);

    const text = document.createElement("span");
    text.className = "aicut-aspect-option-label";
    text.textContent = label;

    btn.append(tileWrap, text);
    btn.addEventListener("click", () => {
      this.cb.onChange(value);
      this.closePopover();
    });
    return btn;
  }
}
