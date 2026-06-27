import type { Locale } from "../i18n.js";
import { fmtClock } from "./format.js";
import { ICONS } from "./icons.js";

/**
 * Playback controls rendered as an overlay inside the preview area
 * (CapCut-desktop style). Owns the time / play / duration /
 * fullscreen affordances that used to live in the top toolbar's
 * center cluster. Mounting these inside the preview lets the
 * toolbar collapse to its edit + viewport clusters, frees up
 * vertical pixels, and gives the playback chrome a contextual home
 * next to the video it controls.
 */
export interface PreviewControlsCallbacks {
  onPlayToggle: () => void;
  onFullscreen: () => void;
}

export interface PreviewControlsState {
  playing: boolean;
  time: number;
  duration: number;
}

export class PreviewControls {
  readonly element: HTMLDivElement;
  private playBtn: HTMLButtonElement;
  private playIcon: HTMLSpanElement;
  private timeLabel: HTMLSpanElement;
  private durationLabel: HTMLSpanElement;
  private fullscreenBtn: HTMLButtonElement;
  private locale: Locale;
  private lastState: PreviewControlsState | null = null;

  constructor(cb: PreviewControlsCallbacks, locale: Locale) {
    this.locale = locale;
    this.element = document.createElement("div");
    this.element.className = "aicut-preview-controls";
    this.element.setAttribute("data-testid", "aicut-preview-controls");

    this.timeLabel = document.createElement("span");
    this.timeLabel.className = "aicut-time-current";
    this.timeLabel.setAttribute("data-testid", "aicut-time-current");
    this.timeLabel.textContent = "00:00";

    this.playBtn = document.createElement("button");
    this.playBtn.type = "button";
    this.playBtn.className = "aicut-play-btn";
    this.playBtn.title = locale.playPause;
    this.playBtn.setAttribute("aria-label", locale.playPause);
    this.playBtn.setAttribute("data-testid", "aicut-play");
    this.playIcon = document.createElement("span");
    this.playIcon.innerHTML = ICONS.play;
    this.playBtn.appendChild(this.playIcon);
    this.playBtn.addEventListener("click", () => cb.onPlayToggle());

    this.durationLabel = document.createElement("span");
    this.durationLabel.className = "aicut-time-total";
    this.durationLabel.setAttribute("data-testid", "aicut-time-total");
    this.durationLabel.textContent = "00:00";

    this.fullscreenBtn = document.createElement("button");
    this.fullscreenBtn.type = "button";
    this.fullscreenBtn.className = "aicut-icon-btn aicut-fullscreen";
    this.fullscreenBtn.title = locale.fullscreen;
    this.fullscreenBtn.setAttribute("aria-label", locale.fullscreen);
    this.fullscreenBtn.setAttribute("data-testid", "aicut-fullscreen");
    this.fullscreenBtn.innerHTML = ICONS.fullscreen;
    this.fullscreenBtn.addEventListener("click", () => cb.onFullscreen());

    this.element.append(
      this.timeLabel,
      this.playBtn,
      this.durationLabel,
      this.fullscreenBtn,
    );
  }

  render(state: PreviewControlsState): void {
    if (!this.lastState || this.lastState.time !== state.time) {
      this.timeLabel.textContent = fmtClock(state.time);
    }
    if (!this.lastState || this.lastState.duration !== state.duration) {
      this.durationLabel.textContent = fmtClock(state.duration);
    }
    if (!this.lastState || this.lastState.playing !== state.playing) {
      this.playIcon.innerHTML = state.playing ? ICONS.pause : ICONS.play;
      this.playBtn.setAttribute(
        "data-state",
        state.playing ? "playing" : "paused",
      );
    }
    this.lastState = { ...state };
  }

  setLocale(locale: Locale): void {
    this.locale = locale;
    this.playBtn.title = locale.playPause;
    this.playBtn.setAttribute("aria-label", locale.playPause);
    this.fullscreenBtn.title = locale.fullscreen;
    this.fullscreenBtn.setAttribute("aria-label", locale.fullscreen);
  }

  destroy(): void {
    this.element.remove();
  }
}
