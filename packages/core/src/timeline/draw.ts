import { formatLabel, type Locale } from "../i18n.js";
import type {
  Clip,
  Keyframe,
  MediaSource,
  Project,
  Track,
} from "../types.js";
import { fmtClockMs } from "../ui/format.js";
import type { ThumbnailRibbon } from "../ui/thumbnails.js";
import {
  CLIP_INSET,
  HEADER_WIDTH,
  RULER_HEIGHT,
  SCROLLBAR_INSET,
  SCROLLBAR_MIN_THUMB,
  SCROLLBAR_THICKNESS,
  TRACK_HEIGHT,
  contentHeight,
  contentLeftX,
  contentWidth,
  formatRulerLabel,
  pickRulerTicks,
  trackY,
  uncoveredIntervals,
} from "./layout.js";
import { projectFps } from "../model.js";

export interface DrawStyle {
  bg: string;
  border: string;
  text: string;
  textMuted: string;
  trackBg: string;
  brand: string;
  brandTo: string;
  info: string;
  clipText: string;
  selectedRing: string;
  playhead: string;
}

export interface DrawState {
  project: Project;
  pxPerSec: number;
  scrollLeft: number;
  scrollTop: number;
  timeMs: number;
  selectedClipId: string | null;
  hoveredClipId: string | null;
  hoveredTrackIndex: number | null;
  dropTargetTrackIndex: number | null;
  /** While any drag is in flight, draw a "+ 新轨道" phantom row at the
   *  bottom that the user can drop into to explicitly create a track. */
  isDragging: boolean;
  snapX: number | null;
  showHeader: boolean;
  viewportWidth: number;
  viewportHeight: number;
  /** 0–1 fade opacity for each scrollbar. 0 hides it entirely. */
  scrollbarOpacityY: number;
  scrollbarOpacityX: number;
  /** Active = currently being dragged → render at full opacity + emphasized. */
  scrollbarActiveY: boolean;
  scrollbarActiveX: boolean;
  /** Resolved locale used for canvas-painted labels. */
  locale: Locale;
  /** Minimum pixel gap between ruler major ticks — drives the auto
   *  picker. Mirrored from `TimelineOptions.rulerMinTickPx` (default 80). */
  rulerMinTickPx: number;
  /** When true, paint a diamond marker on each clip per keyframe.
   *  Wired to `Editor.isKeyframesEnabled()`. */
  keyframesEnabled: boolean;
  /** Currently selected keyframe (rendered with brand-color fill). */
  selectedKeyframe: { clipId: string; keyframeId: string } | null;
  /** Currently hovered keyframe (rendered with brand outline). */
  hoveredKeyframe: { clipId: string; keyframeId: string } | null;
  /** While a keyframe-drag is in flight, the dragged diamond paints
   *  at this ghost time instead of its committed time so the visual
   *  follows the cursor. */
  keyframeDragGhost: {
    clipId: string;
    keyframeId: string;
    ghostTimeMs: number;
  } | null;
  /**
   * In-flight drag preview. While set, the clip with `clipId` is
   * drawn faded at its real position AND a fully-opaque "ghost" of it
   * is drawn at (ghostStart, ghostTrackIndex). `wouldOverlap` flips
   * the ghost to a warning color so users see auto-split coming.
   */
  dragGhost: {
    clipId: string;
    ghostStart: number;
    ghostTrackIndex: number;
    wouldOverlap: boolean;
  } | null;
}

/**
 * Paint the entire timeline. Stateless — given the same DrawState
 * twice you get the same pixels.
 *
 * Layout has FOUR regions with different sticky behavior:
 *   - Ruler band  (top, scrolls X only)
 *   - Headers col (left, scrolls Y only — when showHeader)
 *   - Tracks      (the main grid, scrolls both)
 *   - Scrollbars  (edge overlays, never scroll)
 *
 * We render in passes; each pass `clip`s to its region and (where
 * needed) translates by `-scrollTop` so paint functions can keep
 * working in their natural untranslated coordinates.
 */
export function drawAll(
  ctx: CanvasRenderingContext2D,
  state: DrawState,
  style: DrawStyle,
  thumbs: ThumbnailRibbon,
): void {
  const { viewportWidth: W, viewportHeight: H } = state;
  ctx.fillStyle = style.bg;
  ctx.fillRect(0, 0, W, H);

  const baseX = contentLeftX(state.showHeader);
  const trackAreaW = W - baseX - SCROLLBAR_THICKNESS;
  const trackAreaH = H - RULER_HEIGHT - SCROLLBAR_THICKNESS;

  // --- Pass 1: Track grid (scrolls X + Y) -----------------------------
  ctx.save();
  ctx.beginPath();
  ctx.rect(baseX, RULER_HEIGHT, trackAreaW, trackAreaH);
  ctx.clip();
  ctx.translate(0, -state.scrollTop);
  drawTracks(ctx, state, style, thumbs);
  if (state.isDragging) {
    drawPhantomRow(ctx, state.project.tracks.length, baseX, state, style);
  }
  if (state.dragGhost) drawDragGhost(ctx, state, style, thumbs);
  ctx.restore();

  // --- Pass 2: Headers column (sticky X, scrolls Y) -------------------
  if (state.showHeader) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_HEIGHT, HEADER_WIDTH, trackAreaH);
    ctx.clip();
    ctx.translate(0, -state.scrollTop);
    drawHeaders(ctx, state, style);
    ctx.restore();
  }

  // --- Pass 3: Ruler (sticky Y, scrolls X) ----------------------------
  ctx.save();
  ctx.beginPath();
  ctx.rect(baseX, 0, trackAreaW, RULER_HEIGHT);
  ctx.clip();
  drawRuler(ctx, state, style);
  ctx.restore();

  // --- Pass 4: Coverage-gap warning (scrolls X, full visible height) --
  // Painted AFTER both tracks and the ruler so the amber tint + the
  // diagonal "broken teeth" hatch sit on top of timecode markings —
  // that's what makes a missing segment instantly catchable when the
  // user is scanning the ruler row.
  ctx.save();
  ctx.beginPath();
  ctx.rect(baseX, 0, trackAreaW, H - SCROLLBAR_THICKNESS);
  ctx.clip();
  drawCoverageGaps(ctx, state, style);
  ctx.restore();

  // --- Pass 5: Snap guide only (playhead moves to the top layer) -----
  ctx.save();
  ctx.beginPath();
  ctx.rect(baseX, 0, trackAreaW, H - SCROLLBAR_THICKNESS);
  ctx.clip();
  drawSnapGuide(ctx, state, style);
  ctx.restore();

  // --- Pass 6: Scrollbars (no clip — overlay at edges) ---------------
  drawScrollbarV(ctx, state, style);
  drawScrollbarH(ctx, state, style);

  // --- Pass 7: Playhead — drawn LAST so it sits on top of every
  // other layer (ruler ticks, scrollbar gutters, coverage tint).
  // Clip excludes the header column but INCLUDES the left/right
  // padding, so the time-bubble at t=0 can extend into the pad zone
  // instead of being half-eaten by a tight clip anchored at baseX.
  // The bubble itself is still clamped inside the playable area in
  // drawPlayhead so it never crosses the header edge regardless.
  const playheadLeft = state.showHeader ? HEADER_WIDTH : 0;
  ctx.save();
  ctx.beginPath();
  ctx.rect(playheadLeft, 0, W - playheadLeft, H);
  ctx.clip();
  drawPlayhead(ctx, state, style);
  ctx.restore();
}

/**
 * Highlight time spans where no video clip is present anywhere on any
 * track — a warning to the user that the export will have a hard cut
 * to black at this point. Painted as a translucent amber vertical
 * strip spanning the full track stack, plus a slightly more saturated
 * strip in the ruler band so it's catchable even when the user is
 * scanning the timecode row.
 */
function drawCoverageGaps(
  ctx: CanvasRenderingContext2D,
  state: DrawState,
  style: DrawStyle,
): void {
  const gaps = uncoveredIntervals(state.project);
  if (gaps.length === 0) return;
  const baseX = contentLeftX(state.showHeader);
  // Span the visible track area, not the (potentially huge) total —
  // pre-clipped by drawAll's pass-2 region anyway, but explicit
  // height keeps the hatch math clean.
  const trackStackH =
    state.viewportHeight - RULER_HEIGHT - SCROLLBAR_THICKNESS;
  for (const [s, e] of gaps) {
    const x1 = Math.max(
      baseX,
      baseX + (s / 1000) * state.pxPerSec - state.scrollLeft,
    );
    const x2 = Math.min(
      state.viewportWidth,
      baseX + (e / 1000) * state.pxPerSec - state.scrollLeft,
    );
    if (x2 <= x1) continue;
    // Ruler band — stronger so it's the first thing the eye catches.
    ctx.fillStyle = "rgba(250, 167, 0, 0.35)";
    ctx.fillRect(x1, 0, x2 - x1, RULER_HEIGHT);
    // Track band — faint so it doesn't fight the clip thumbnails on
    // adjacent rows.
    ctx.fillStyle = "rgba(250, 167, 0, 0.12)";
    ctx.fillRect(x1, RULER_HEIGHT, x2 - x1, trackStackH);
    // Hatched marker on the ruler so it reads as a problem, not a
    // selection. Diagonal lines at 6px spacing.
    ctx.save();
    ctx.strokeStyle = "rgba(250, 167, 0, 0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let hx = Math.floor(x1); hx < x2; hx += 6) {
      ctx.moveTo(hx, RULER_HEIGHT - 1);
      ctx.lineTo(hx + 6, RULER_HEIGHT - 7);
    }
    ctx.stroke();
    ctx.restore();
    void style;
  }
}

function drawDragGhost(
  ctx: CanvasRenderingContext2D,
  state: DrawState,
  style: DrawStyle,
  thumbs: ThumbnailRibbon,
): void {
  const ghost = state.dragGhost!;
  // Locate the real clip so the ghost reuses its source / duration.
  let real: Clip | null = null;
  for (const t of state.project.tracks) {
    const c = t.clips.find((c) => c.id === ghost.clipId);
    if (c) {
      real = c;
      break;
    }
  }
  if (!real) return;

  const baseX = contentLeftX(state.showHeader);
  const widthPx = Math.max(2, ((real.out - real.in) / 1000) * state.pxPerSec);
  const startX =
    baseX + (ghost.ghostStart / 1000) * state.pxPerSec - state.scrollLeft;

  // ---- Drop-slot outline ------------------------------------------------
  // Always paint a dashed rectangle where the clip will land — the
  // outline is the "slot" and the solid ghost above it is the clip.
  // When the drop would overlap (→ Editor will auto-split onto a
  // brand-new track below), draw an ADDITIONAL phantom row at the
  // bottom + outline there, so the user sees the new track coming.
  const overlap = ghost.wouldOverlap;
  // Phantom row is now drawn unconditionally during drag (see drawAll);
  // we only need the dashed drop outline here, on whichever row the
  // ghost is currently above.
  drawDropOutline(
    ctx,
    startX,
    overlap ? state.project.tracks.length : ghost.ghostTrackIndex,
    widthPx,
    style.info,
    overlap,
  );

  // ---- Ghost clip body --------------------------------------------------
  // Slight transparency so the user reads it as "preview" rather than
  // the committed clip. The drop outline + phantom row carry the rest
  // of the wayfinding.
  ctx.save();
  ctx.globalAlpha = 0.85;
  drawClipAt(
    ctx,
    real,
    overlap ? state.project.tracks.length : ghost.ghostTrackIndex,
    ghost.ghostStart,
    state.project.sources,
    state,
    style,
    thumbs,
    /* dim = */ false,
    /* warn = */ overlap,
  );
  ctx.restore();
}

function drawDropOutline(
  ctx: CanvasRenderingContext2D,
  startX: number,
  trackIndex: number,
  widthPx: number,
  color: string,
  emphasized: boolean,
): void {
  // 1px solid info-tinted outline — present, but doesn't shout.
  // `emphasized` (used when the drop would land on the phantom new
  // track) bumps to a slightly thicker stroke + a faint glow halo.
  const y = trackY(trackIndex) + CLIP_INSET - 1;
  const h = TRACK_HEIGHT - CLIP_INSET * 2 + 2;
  ctx.save();
  if (emphasized) {
    ctx.shadowColor = withAlpha(color, 0.45);
    ctx.shadowBlur = 6;
  }
  ctx.strokeStyle = withAlpha(color, emphasized ? 0.9 : 0.7);
  ctx.lineWidth = 1;
  roundRect(ctx, startX - 0.5, y, widthPx + 1, h, 6);
  ctx.stroke();
  ctx.restore();
}

/**
 * Hairline placeholder row beneath the existing tracks, visible only
 * while a drag is active. Deliberately understated — top + bottom
 * dashed borders + a tiny label, no fill — so it reads as "available
 * slot" rather than "selection target".
 */
function drawPhantomRow(
  ctx: CanvasRenderingContext2D,
  trackIndex: number,
  baseX: number,
  state: DrawState,
  style: DrawStyle,
): void {
  const y = trackY(trackIndex);
  const w = state.viewportWidth - baseX;
  ctx.save();
  // Very faint background tint — keeps the row visually grouped with
  // the rest of the timeline without competing with clip thumbnails.
  ctx.fillStyle = withAlpha(style.info, 0.04);
  ctx.fillRect(baseX, y, w, TRACK_HEIGHT);
  // Dashed top + bottom hairlines so the eye reads it as a slot.
  ctx.strokeStyle = withAlpha(style.info, 0.35);
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(baseX, y + 0.5);
  ctx.lineTo(baseX + w, y + 0.5);
  ctx.moveTo(baseX, y + TRACK_HEIGHT - 0.5);
  ctx.lineTo(baseX + w, y + TRACK_HEIGHT - 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
  if (state.showHeader) {
    ctx.fillStyle = withAlpha(style.info, 0.7);
    ctx.font = "10px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(state.locale.newTrack, 12, y + TRACK_HEIGHT / 2);
  }
  ctx.restore();
}

// ---- ruler ----------------------------------------------------------------

function drawRuler(
  ctx: CanvasRenderingContext2D,
  state: DrawState,
  style: DrawStyle,
): void {
  const { pxPerSec, scrollLeft, viewportWidth: W } = state;
  const baseX = contentLeftX(state.showHeader);
  const rulerW = W - baseX;

  ctx.fillStyle = style.bg;
  ctx.fillRect(baseX, 0, rulerW, RULER_HEIGHT);

  // Bottom border under the ruler.
  ctx.strokeStyle = style.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(baseX, RULER_HEIGHT - 0.5);
  ctx.lineTo(W, RULER_HEIGHT - 0.5);
  ctx.stroke();

  const minPx = state.rulerMinTickPx;
  const fps = projectFps(state.project);
  const { majorSec, subSec } = pickRulerTicks(minPx / pxPerSec, fps, pxPerSec);
  // Sub-ticks per major. Round to int because sub-tick spacing is
  // 1/fps at high zoom and the division isn't exact in binary.
  const subDiv = Math.max(1, Math.round(majorSec / subSec));

  const firstVisibleSec = Math.max(0, scrollLeft / pxPerSec - subSec);
  const lastVisibleSec = (scrollLeft + rulerW) / pxPerSec + subSec;

  ctx.textBaseline = "bottom";
  ctx.font = "10px system-ui, -apple-system, sans-serif";

  // Sub + major ticks in one pass.
  const startStep = Math.floor(firstVisibleSec / subSec);
  const endStep = Math.ceil(lastVisibleSec / subSec);

  for (let i = startStep; i <= endStep; i++) {
    const s = i * subSec;
    if (s < 0) continue;
    const x = baseX + s * pxPerSec - scrollLeft;
    if (x < baseX || x > W) continue;
    // Index within the current major (0 → at a whole-second boundary).
    // Integer modulo dodges the float-mod glitch where e.g.
    // `0.6 / 0.2 = 2.9999…` would miss a label like 0.6s.
    const subIdx = ((i % subDiv) + subDiv) % subDiv;
    const isMajor = subIdx === 0;
    // Frame mode (subDiv > 5) gets secondary labels every 5 frames
    // inside the second — keeps "5f / 10f / 15f / …" visible even
    // when the next whole-second mark is off-screen. Low-zoom mode
    // (subDiv === 5) already has labels at every major, no secondary
    // needed.
    const isMidLabel = !isMajor && subDiv > 5 && subIdx % 5 === 0;
    ctx.strokeStyle = isMajor
      ? withAlpha(style.text, 0.5)
      : isMidLabel
        ? withAlpha(style.text, 0.35)
        : withAlpha(style.text, 0.22);
    ctx.lineWidth = 1;
    const h = isMajor ? 10 : isMidLabel ? 8 : 5;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, RULER_HEIGHT - h);
    ctx.lineTo(x + 0.5, RULER_HEIGHT - 1);
    ctx.stroke();
    if (isMajor) {
      ctx.fillStyle = withAlpha(style.textMuted, 0.85);
      ctx.fillText(formatRulerLabel(s), x + 3, RULER_HEIGHT - 12);
    } else if (isMidLabel) {
      ctx.fillStyle = withAlpha(style.textMuted, 0.55);
      ctx.fillText(`${subIdx}f`, x + 3, RULER_HEIGHT - 12);
    }
  }
}

// ---- tracks + clips -------------------------------------------------------

function drawTracks(
  ctx: CanvasRenderingContext2D,
  state: DrawState,
  style: DrawStyle,
  thumbs: ThumbnailRibbon,
): void {
  const { project } = state;
  for (let ti = 0; ti < project.tracks.length; ti++) {
    drawTrackRow(ctx, ti, project.tracks[ti]!, project.sources, state, style, thumbs);
  }
}

function drawTrackRow(
  ctx: CanvasRenderingContext2D,
  trackIndex: number,
  track: Track,
  sources: MediaSource[],
  state: DrawState,
  style: DrawStyle,
  thumbs: ThumbnailRibbon,
): void {
  const { viewportWidth: W } = state;
  const baseX = contentLeftX(state.showHeader);
  const y = trackY(trackIndex);

  // Track surface: just the default tint. Drop-target highlight is now
  // limited to a 1px top + bottom info-tinted hairline (instead of a
  // brand-color flood) so the dragged ghost reads as primary content
  // and the row hint stays quiet.
  ctx.fillStyle = style.trackBg;
  ctx.fillRect(baseX, y, W - baseX, TRACK_HEIGHT);

  // Row separator (bottom border).
  ctx.strokeStyle = style.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(baseX, y + TRACK_HEIGHT - 0.5);
  ctx.lineTo(W, y + TRACK_HEIGHT - 0.5);
  ctx.stroke();

  if (state.dropTargetTrackIndex === trackIndex) {
    ctx.strokeStyle = withAlpha(style.info, 0.45);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(baseX, y + 0.5);
    ctx.lineTo(W, y + 0.5);
    ctx.moveTo(baseX, y + TRACK_HEIGHT - 0.5);
    ctx.lineTo(W, y + TRACK_HEIGHT - 0.5);
    ctx.stroke();
  }

  for (const clip of track.clips) {
    const dim = state.dragGhost?.clipId === clip.id;
    drawClipAt(
      ctx,
      clip,
      trackIndex,
      clip.start,
      sources,
      state,
      style,
      thumbs,
      dim,
      false,
    );
  }
}

/**
 * Paint a clip at a virtual `(trackIndex, startMs)` that may differ
 * from its data position. Used for both normal clip rendering (passing
 * the clip's real `start` + `trackIndex`) and for the in-flight drag
 * ghost (where the values come from pointer position).
 *
 *   `dim`  — render at low opacity (the "leave-behind" at the drag's
 *            origin so the user sees where the clip will return if
 *            they release without moving).
 *   `warn` — paint the body in warning color (orange-ish) to telegraph
 *            "if you drop here, this will create a new track because
 *            of the overlap rule."
 */
function drawClipAt(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  trackIndex: number,
  startMs: number,
  sources: MediaSource[],
  state: DrawState,
  style: DrawStyle,
  thumbs: ThumbnailRibbon,
  dim: boolean,
  warn: boolean,
): void {
  const { pxPerSec, scrollLeft } = state;
  const baseX = contentLeftX(state.showHeader);
  const startX = baseX + (startMs / 1000) * pxPerSec - scrollLeft;
  const widthPx = Math.max(2, ((clip.out - clip.in) / 1000) * pxPerSec);
  const y = trackY(trackIndex) + CLIP_INSET;
  const h = TRACK_HEIGHT - CLIP_INSET * 2;
  if (startX + widthPx < baseX || startX > state.viewportWidth) return;

  ctx.save();
  if (dim) ctx.globalAlpha = 0.3;

  // Body fill — brand gradient by default. `warn` (drop would
  // auto-create a new track) tints toward a soft amber rather than
  // the previous loud red/orange.
  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  if (warn) {
    grad.addColorStop(0, "rgba(250, 175, 70, 0.7)");
    grad.addColorStop(1, "rgba(240, 145, 50, 0.62)");
  } else {
    grad.addColorStop(0, withAlpha(style.brand, 0.8));
    grad.addColorStop(1, withAlpha(style.brandTo, 0.7));
  }
  ctx.fillStyle = grad;
  roundRect(ctx, startX, y, widthPx, h, 6);
  ctx.fill();

  // Thumbnail strip — passes the clip body height so thumbs stretch
  // to fill when trackHeight is configured above the default. Otherwise
  // the brand gradient (purple-ish on dark themes) shows through the
  // bottom band of tall tracks.
  ctx.save();
  roundRect(ctx, startX, y, widthPx, h, 6);
  ctx.clip();
  ctx.translate(startX, y);
  thumbs.paintStrip(ctx, clip.sourceId, clip.in, clip.out, widthPx, h);
  ctx.restore();

  // Inner highlight (1px white inset).
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 1;
  roundRect(ctx, startX + 0.5, y + 0.5, widthPx - 1, h - 1, 6);
  ctx.stroke();

  // Label.
  const src = sources.find((s) => s.id === clip.sourceId);
  const label = src?.name ?? src?.url.split("/").pop() ?? clip.id;
  ctx.font = "11px system-ui, -apple-system, sans-serif";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillText(label, startX + 9, y + 5);
  ctx.fillStyle = "#fff";
  ctx.fillText(label, startX + 8, y + 4);

  // Selection ring (skip when dimmed — selection has no meaning on a
  // ghost source clip; the ghost itself draws its own ring if you add
  // one later).
  if (!dim && state.selectedClipId === clip.id) {
    ctx.strokeStyle = style.selectedRing;
    ctx.lineWidth = 2;
    roundRect(ctx, startX - 1, y - 1, widthPx + 2, h + 2, 7);
    ctx.stroke();
  }

  // Edge handles on hover or selection.
  const showHandles =
    !dim && (state.selectedClipId === clip.id || state.hoveredClipId === clip.id);
  if (showHandles) {
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.fillRect(startX + 2, y + 12, 2, h - 24);
    ctx.fillRect(startX + widthPx - 4, y + 12, 2, h - 24);
  }

  // Keyframe markers — one diamond per UNIQUE moment in time (a
  // moment is a cluster of per-prop keyframes at the same time —
  // typically the panX/panY/scale trio from a single toolbar click).
  // Painted on the clip body vertical center; selected = brand fill,
  // hovered = brighter + slightly bigger.
  // Keyframes paint on BOTH the real (possibly dim) clip and any
  // ghost clip during a drag — skipping them on dim made the diamond
  // appear to vanish the moment a user clicked just outside the kf
  // hit radius (their click drags the clip, the real clip dims, and
  // the diamond on the ORIGINAL position quietly drops out of the
  // canvas — looks like "I dragged the kf and it disappeared"). The
  // ghost clip painted underneath still carries its own diamonds at
  // the drag offset, so the user can see both the residual position
  // and the destination.
  if (
    state.keyframesEnabled &&
    clip.keyframes &&
    clip.keyframes.length > 0
  ) {
    const diamondY = y + h / 2;
    const halfSize = 5; // visible diamond is 10 × 10 px
    // Group keyframes by time (within 16 ms of each other = "same moment").
    const moments = groupKeyframesByTime(clip.keyframes, 16);
    const ghost = state.keyframeDragGhost;
    for (const moment of moments) {
      // The dragged kf within this moment (if any) carries the
      // ghost time. We just paint one diamond per moment though, so
      // any one kf belonging to it is enough to detect the ghost.
      const draggedHere = ghost
        ? moment.kfs.find(
            (k) => ghost.clipId === clip.id && ghost.keyframeId === k.id,
          )
        : undefined;
      const effectiveTime = draggedHere ? ghost!.ghostTimeMs : moment.time;
      const kfX = startX + (effectiveTime / 1000) * pxPerSec;
      if (kfX < baseX - halfSize || kfX > state.viewportWidth + halfSize) continue;
      const isSelected =
        state.selectedKeyframe?.clipId === clip.id &&
        moment.kfs.some((k) => k.id === state.selectedKeyframe?.keyframeId);
      const isHovered =
        state.hoveredKeyframe?.clipId === clip.id &&
        moment.kfs.some((k) => k.id === state.hoveredKeyframe?.keyframeId);
      const drawSize = isHovered ? halfSize + 1.5 : halfSize;
      ctx.beginPath();
      ctx.moveTo(kfX, diamondY - drawSize);
      ctx.lineTo(kfX + drawSize, diamondY);
      ctx.lineTo(kfX, diamondY + drawSize);
      ctx.lineTo(kfX - drawSize, diamondY);
      ctx.closePath();
      // Dim clips paint diamonds at reduced opacity — visible but
      // muted, so the user sees both the "where it WAS" residual on
      // the source position and the "where it IS now" diamond on the
      // ghost.
      const fillAlpha = dim ? 0.4 : 0.85;
      const strokeAlpha = dim ? 0.3 : 0.65;
      ctx.fillStyle = isSelected
        ? style.selectedRing
        : isHovered
          ? "#ffffff"
          : withAlpha(style.text, fillAlpha);
      ctx.fill();
      ctx.strokeStyle = isHovered
        ? style.selectedRing
        : `rgba(0, 0, 0, ${strokeAlpha})`;
      ctx.lineWidth = isHovered ? 1.5 : 1;
      ctx.stroke();
    }
  }

  ctx.restore();
}

// ---- headers --------------------------------------------------------------

function drawHeaders(
  ctx: CanvasRenderingContext2D,
  state: DrawState,
  style: DrawStyle,
): void {
  ctx.fillStyle = style.bg;
  ctx.fillRect(0, 0, HEADER_WIDTH, state.viewportHeight);

  // Right border separating headers from scrollable area.
  ctx.strokeStyle = style.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(HEADER_WIDTH - 0.5, 0);
  ctx.lineTo(HEADER_WIDTH - 0.5, state.viewportHeight);
  ctx.stroke();

  ctx.textBaseline = "middle";
  ctx.font = "11px system-ui, -apple-system, sans-serif";
  for (let i = 0; i < state.project.tracks.length; i++) {
    const t = state.project.tracks[i]!;
    const y = trackY(i);
    // Track row separator.
    ctx.strokeStyle = style.border;
    ctx.beginPath();
    ctx.moveTo(0, y + TRACK_HEIGHT - 0.5);
    ctx.lineTo(HEADER_WIDTH, y + TRACK_HEIGHT - 0.5);
    ctx.stroke();

    ctx.fillStyle = withAlpha(style.text, 0.7);
    const template =
      t.kind === "video"
        ? state.locale.videoTrackLabel
        : state.locale.audioTrackLabel;
    const label = formatLabel(template, { n: i + 1 });
    ctx.fillText(label, 12, y + TRACK_HEIGHT / 2);

    // Delete-track button — × icon at the right edge. Only painted
    // for empty tracks (hit-test agrees) so a busy row's UI doesn't
    // dangle a destructive button next to actual content.
    if (t.clips.length === 0) {
      const hovered = state.hoveredTrackIndex === i;
      const btnSize = 18;
      const btnLeft = HEADER_WIDTH - btnSize - 6;
      const btnTop = y + (TRACK_HEIGHT - btnSize) / 2;
      ctx.save();
      if (hovered) {
        ctx.fillStyle = withAlpha(style.text, 0.1);
        roundRect(ctx, btnLeft, btnTop, btnSize, btnSize, 5);
        ctx.fill();
      }
      ctx.strokeStyle = withAlpha(style.text, hovered ? 0.85 : 0.4);
      ctx.lineWidth = 1.4;
      const pad = 5;
      ctx.beginPath();
      ctx.moveTo(btnLeft + pad, btnTop + pad);
      ctx.lineTo(btnLeft + btnSize - pad, btnTop + btnSize - pad);
      ctx.moveTo(btnLeft + btnSize - pad, btnTop + pad);
      ctx.lineTo(btnLeft + pad, btnTop + btnSize - pad);
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ---- playhead -------------------------------------------------------------

function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  state: DrawState,
  style: DrawStyle,
): void {
  const baseX = contentLeftX(state.showHeader);
  const x = baseX + (state.timeMs / 1000) * state.pxPerSec - state.scrollLeft;
  if (x < baseX - 2 || x > state.viewportWidth + 2) return;

  // Vertical line through ruler + tracks.
  ctx.strokeStyle = style.playhead;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, state.viewportHeight);
  ctx.stroke();

  // Time bubble centered on the playhead at the top of the ruler.
  // Clamped to the content area's bounds so it doesn't get clipped
  // (or hidden behind the header column) when the playhead sits at
  // t=0 or scrolled to the very end. The triangle stays anchored to
  // the playhead line so the visual link survives the clamp.
  const label = fmtClockMs(state.timeMs);
  ctx.font = "10px system-ui, -apple-system, sans-serif";
  const padX = 6;
  const w = ctx.measureText(label).width + padX * 2;
  const h = 14;
  const contentRight = state.viewportWidth - SCROLLBAR_THICKNESS;
  const rawBx = x - w / 2;
  const bx = Math.max(baseX, Math.min(contentRight - w, rawBx));
  const by = 2;
  ctx.fillStyle = style.playhead;
  roundRect(ctx, bx, by, w, h, 4);
  ctx.fill();
  // Triangle hanging below the bubble — keeps the visual link to the
  // playhead line even when the bubble is clamped.
  ctx.beginPath();
  ctx.moveTo(x - 4, by + h);
  ctx.lineTo(x + 4, by + h);
  ctx.lineTo(x, by + h + 4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.fillText(label, bx + padX, by + h / 2);
}

// ---- snap guide -----------------------------------------------------------

function drawSnapGuide(
  ctx: CanvasRenderingContext2D,
  state: DrawState,
  style: DrawStyle,
): void {
  if (state.snapX == null) return;
  ctx.strokeStyle = style.info;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(state.snapX + 0.5, 0);
  ctx.lineTo(state.snapX + 0.5, state.viewportHeight);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ---- utilities ------------------------------------------------------------

// ---- scrollbars -----------------------------------------------------------

/**
 * Right-edge vertical scrollbar. Opacity is host-controlled (set by
 * Timeline based on time-since-interaction + hover). Thumb position
 * and length derive from scrollTop / contentHeight / visibleHeight.
 */
function drawScrollbarV(
  ctx: CanvasRenderingContext2D,
  state: DrawState,
  style: DrawStyle,
): void {
  if (state.scrollbarOpacityY <= 0.01) return;
  const visibleH = state.viewportHeight - RULER_HEIGHT - SCROLLBAR_THICKNESS;
  const contentH = contentHeight(state.project.tracks, state.isDragging);
  if (contentH <= visibleH) return;
  const trackX = state.viewportWidth - SCROLLBAR_THICKNESS + SCROLLBAR_INSET;
  const trackY0 = RULER_HEIGHT + SCROLLBAR_INSET;
  const trackLen = visibleH - SCROLLBAR_INSET * 2;
  const thumbLen = Math.max(
    SCROLLBAR_MIN_THUMB,
    trackLen * (visibleH / contentH),
  );
  const maxScroll = contentH - visibleH;
  const thumbY =
    trackY0 + (maxScroll > 0 ? (state.scrollTop / maxScroll) * (trackLen - thumbLen) : 0);
  paintScrollbar(
    ctx,
    style,
    trackX,
    trackY0,
    SCROLLBAR_THICKNESS - SCROLLBAR_INSET * 2,
    trackLen,
    thumbY - trackY0,
    thumbLen,
    state.scrollbarOpacityY,
    state.scrollbarActiveY,
    "v",
  );
}

function drawScrollbarH(
  ctx: CanvasRenderingContext2D,
  state: DrawState,
  style: DrawStyle,
): void {
  if (state.scrollbarOpacityX <= 0.01) return;
  const baseX = contentLeftX(state.showHeader);
  const visibleW = state.viewportWidth - baseX - SCROLLBAR_THICKNESS;
  const contentW = contentWidth(state.project, state.pxPerSec);
  if (contentW <= visibleW) return;
  const trackY0 = state.viewportHeight - SCROLLBAR_THICKNESS + SCROLLBAR_INSET;
  const trackX0 = baseX + SCROLLBAR_INSET;
  const trackLen = visibleW - SCROLLBAR_INSET * 2;
  const thumbLen = Math.max(
    SCROLLBAR_MIN_THUMB,
    trackLen * (visibleW / contentW),
  );
  const maxScroll = contentW - visibleW;
  const thumbX =
    trackX0 + (maxScroll > 0 ? (state.scrollLeft / maxScroll) * (trackLen - thumbLen) : 0);
  paintScrollbar(
    ctx,
    style,
    trackX0,
    trackY0,
    trackLen,
    SCROLLBAR_THICKNESS - SCROLLBAR_INSET * 2,
    thumbX - trackX0,
    thumbLen,
    state.scrollbarOpacityX,
    state.scrollbarActiveX,
    "h",
  );
}

/**
 * Common drawing for both scrollbars. The thumb fades with `opacity`;
 * `active` (dragging) emphasizes via thicker stroke. Gutter is a
 * subtle background — visible to suggest "you can grab here" but
 * never loud enough to fight clip content.
 */
function paintScrollbar(
  ctx: CanvasRenderingContext2D,
  style: DrawStyle,
  trackX: number,
  trackY0: number,
  trackW: number,
  trackH: number,
  thumbOffset: number,
  thumbLen: number,
  opacity: number,
  active: boolean,
  axis: "h" | "v",
): void {
  ctx.save();
  ctx.globalAlpha = opacity;
  // Gutter — barely visible track lane.
  ctx.fillStyle = withAlpha(style.text, 0.06);
  roundRect(ctx, trackX, trackY0, trackW, trackH, Math.min(trackW, trackH) / 2);
  ctx.fill();
  // Thumb — neutral by default, info-tinted when actively dragged.
  ctx.fillStyle = active
    ? withAlpha(style.info, 0.85)
    : withAlpha(style.text, 0.4);
  if (axis === "v") {
    roundRect(ctx, trackX, trackY0 + thumbOffset, trackW, thumbLen, trackW / 2);
  } else {
    roundRect(ctx, trackX + thumbOffset, trackY0, thumbLen, trackH, trackH / 2);
  }
  ctx.fill();
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** color-mix substitute that works directly on hex/rgba strings via
 * canvas — quick & dirty: parse-or-pass-through. For named css colors
 * we fall back to the original. Good enough for our palette. */
function mix(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return a;
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * (1 - t));
  const g = Math.round(ca[1] + (cb[1] - ca[1]) * (1 - t));
  const bl = Math.round(ca[2] + (cb[2] - ca[2]) * (1 - t));
  return `rgb(${r}, ${g}, ${bl})`;
}

function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  if (!c) return color;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

function parseColor(s: string): [number, number, number] | null {
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0]! + hex[0]!, 16),
        parseInt(hex[1]! + hex[1]!, 16),
        parseInt(hex[2]! + hex[2]!, 16),
      ];
    }
    if (hex.length === 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
  }
  const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

/**
 * Cluster per-property keyframes by clip-local time. Two keyframes
 * within `epsilonMs` are considered the same "moment" (a UX concept
 * — the user thinks of "this point in time" as a single keyframe
 * regardless of which props are pinned). Used for one-diamond-per-
 * moment rendering and for moment-aware hit-testing.
 */
export function groupKeyframesByTime(
  kfs: Keyframe[],
  epsilonMs: number,
): Array<{ time: number; kfs: Keyframe[] }> {
  const sorted = [...kfs].sort((a, b) => a.time - b.time);
  const out: Array<{ time: number; kfs: Keyframe[] }> = [];
  for (const k of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(k.time - last.time) < epsilonMs) {
      last.kfs.push(k);
    } else {
      out.push({ time: k.time, kfs: [k] });
    }
  }
  return out;
}
