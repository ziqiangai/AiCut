/**
 * Inline SVG icon set. Strings, not JSX, since core has no framework.
 * Each icon is 14×14 paint-area inside a 16×16 viewbox; `currentColor`
 * so toolbar buttons can recolor by `color`.
 */

const wrap = (path: string) =>
  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">${path}</svg>`;

export const ICONS = {
  undo: wrap(
    `<g transform="translate(1 1)"><path d="M5.66577 1.38721L2.85034 4.20264H9.64624C11.8471 4.20264 13.6313 5.98724 13.6316 8.18799C13.6315 10.3889 11.8472 12.1733 9.64624 12.1733H7.19116V11.1235H9.64624C11.2673 11.1235 12.5817 9.80904 12.5818 8.18799C12.5815 6.56714 11.2672 5.25342 9.64624 5.25342H2.85034L5.66577 8.06885L4.92358 8.81201L0.8396 4.72803L4.92358 0.644043L5.66577 1.38721Z" fill="currentColor"/></g>`,
  ),
  redo: wrap(
    `<g transform="translate(1 1)"><path d="M8.55005 2.04655L11.3659 4.86239L4.56982 4.86239C2.36897 4.86251 0.584578 6.64687 0.584473 8.84774C0.584646 11.0485 2.36901 12.833 4.56982 12.8331L7.0245 12.8331L7.0245 11.7832H4.56982C2.94891 11.7831 1.63453 10.4686 1.63436 8.84774C1.63446 7.22677 2.94886 5.91297 4.56982 5.91284H11.3659L8.55005 8.72811L9.29289 9.47095L13.3768 5.38761L9.29289 1.30371L8.55005 2.04655Z" fill="currentColor"/></g>`,
  ),
  split: wrap(
    `<g transform="translate(1 1)"><path d="M5.7168 12.7754H1.75V11.7246H4.68164V2.27539H1.75V1.22461H5.7168V12.7754ZM12.25 2.27539H9.31836V11.7246H12.25V12.7754H8.2832V1.22461H12.25V2.27539Z" fill="currentColor"/></g>`,
  ),
  trimLeft: wrap(
    `<g transform="translate(1 1)"><path d="M2.7998 12.7754H1.75V11.7246H2.7998V12.7754ZM4.25781 12.7754H3.20801V11.7246H4.25781V12.7754ZM5.7168 12.7754H4.66699V11.7246H5.7168V12.7754ZM12.25 2.27539H9.31836V11.7246H12.25V12.7754H8.2832V1.22461H12.25V2.27539ZM5.7168 11.0254H4.66699V9.97461H5.7168V11.0254ZM5.7168 9.27539H4.66699V8.22461H5.7168V9.27539ZM5.7168 7.52539H4.66699V6.47461H5.7168V7.52539ZM5.7168 5.77539H4.66699V4.72461H5.7168V5.77539ZM5.7168 4.02539H4.66699V2.97461H5.7168V4.02539ZM2.7998 2.27539H1.75V1.22461H2.7998V2.27539ZM4.25781 2.27539H3.20801V1.22461H4.25781V2.27539ZM5.7168 2.27539H4.66699V1.22461H5.7168V2.27539Z" fill="currentColor"/></g>`,
  ),
  trimRight: wrap(
    `<g transform="translate(1 1)"><path d="M5.7168 12.7754H1.75V11.7246H4.68164V2.27539H1.75V1.22461H5.7168V12.7754ZM9.33301 12.7754H8.2832V11.7246H9.33301V12.7754ZM10.792 12.7754H9.74219V11.7246H10.792V12.7754ZM12.25 12.7754H11.2002V11.7246H12.25V12.7754ZM9.33301 11.0254H8.2832V9.97461H9.33301V11.0254ZM9.33301 9.27539H8.2832V8.22461H9.33301V9.27539ZM9.33301 7.52539H8.2832V6.47461H9.33301V7.52539ZM9.33301 5.77539H8.2832V4.72461H9.33301V5.77539ZM9.33301 4.02539H8.2832V2.97461H9.33301V4.02539ZM9.33301 2.27539H8.2832V1.22461H9.33301V2.27539ZM10.792 2.27539H9.74219V1.22461H10.792V2.27539ZM12.25 2.27539H11.2002V1.22461H12.25V2.27539Z" fill="currentColor"/></g>`,
  ),
  speed: wrap(
    `<g transform="translate(1 1)"><path d="M7.00175 0.595229C7.32353 0.596316 7.58439 0.858333 7.58378 1.18019C7.583 1.50212 7.32071 1.76265 6.99882 1.76222C6.45361 1.76108 5.90722 1.8449 5.38065 2.01417C4.23393 2.38294 3.24874 3.13519 2.59061 4.14406C1.93249 5.15302 1.64169 6.35801 1.76639 7.55617C1.89121 8.75413 2.4235 9.87343 3.27518 10.7251C4.12694 11.5767 5.24613 12.1092 6.44413 12.2339C7.6422 12.3585 8.84735 12.0678 9.85624 11.4097C10.8649 10.7516 11.6173 9.76618 11.9861 8.61964C12.5967 6.72047 12.1219 5.04361 11.0633 3.76124L8.57792 6.24757C8.68682 6.4756 8.74974 6.72999 8.74979 6.99953C8.74979 7.9659 7.96612 8.74933 6.99979 8.74953C6.03345 8.74934 5.24979 7.96591 5.24979 6.99953C5.24997 6.03329 6.03356 5.24971 6.99979 5.24953C7.26941 5.24958 7.52464 5.31244 7.75272 5.4214L10.6707 2.50441L10.7137 2.46535C10.8174 2.38043 10.9485 2.33351 11.0838 2.33351C11.2382 2.33369 11.3867 2.39519 11.4959 2.50441C13.0855 4.09426 13.9307 6.38102 13.0965 8.97609C12.6458 10.3776 11.726 11.5819 10.493 12.3862C9.25989 13.1905 7.7873 13.5464 6.32303 13.3941C4.8588 13.2416 3.49099 12.5903 2.44999 11.5493C1.40904 10.5083 0.757676 9.14058 0.605261 7.67628C0.452904 6.21196 0.808759 4.73947 1.61307 3.50636C2.41742 2.27338 3.62178 1.35455 5.02323 0.903823C5.66695 0.696861 6.33524 0.593807 7.00175 0.595229Z" fill="currentColor"/></g>`,
  ),
  play: wrap(
    // Triangle bbox center at viewBox x=9.4 vs viewBox center 8 — the
    // raw path leans right. Optical centering: translate by half the
    // bbox offset (-0.7) so the centroid stays near 7.5 (slight left
    // of center, which the eye accepts as balanced for a right-pointing
    // triangle) while the bbox is no longer obviously off to one side.
    `<g transform="translate(-0.7 0)"><path d="M4.66699 2.64248C4.66717 1.82358 5.59736 1.35167 6.25781 1.83584L13.5674 7.19619C14.1117 7.59579 14.1118 8.40897 13.5674 8.8085L6.25781 14.1688C5.59734 14.6528 4.6671 14.1811 4.66699 13.3622V2.64248Z" fill="currentColor"/></g>`,
  ),
  pause: wrap(
    `<path d="M4 3h2.5v10H4V3zm5.5 0H12v10H9.5V3z" fill="currentColor"/>`,
  ),
  fullscreen:
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 00-2 2v3"/><path d="M21 8V5a2 2 0 00-2-2h-3"/><path d="M3 16v3a2 2 0 002 2h3"/><path d="M16 21h3a2 2 0 002-2v-3"/></svg>`,
  snap:
    `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path fill="currentColor" d="M8.275.783a5.07 5.07 0 0 1 4.929 4.927 5.07 5.07 0 0 1-1.311 3.542l-3.937 3.95a.526.526 0 0 1-.744 0l-2.334-2.334a.525.525 0 0 1 .001-.743l2.55-2.538a.5.5 0 0 1 .171-.17l.976-.97a.723.723 0 0 0-1.01-1.008L3.87 9.12a.526.526 0 0 1-.743 0L.795 6.784a.526.526 0 0 1 0-.742l3.937-3.95.022-.02a5.07 5.07 0 0 1 3.52-1.29m-2.281 9.715 1.588 1.589 1.884-1.889-1.583-1.583zm2.253-8.666a4.02 4.02 0 0 0-2.785 1.017l-.936.939 1.602 1.603.729-.726.052-.045a1.776 1.776 0 0 1 2.33.154 1.775 1.775 0 0 1 .155 2.332 1 1 0 0 1-.046.053l-.72.716 1.58 1.58.924-.929a4.019 4.019 0 0 0-2.885-6.694M1.909 6.413 3.5 8.005 5.384 6.13l-1.6-1.6z"/></svg>`,
  zoomOut:
    `<svg width="14" height="14" viewBox="0 0 20.2618 20.2564" fill="none" aria-hidden="true"><path d="M9 0C13.9706 0 18 4.02944 18 9C18 11.1612 17.2374 13.1438 15.9678 14.6953L19.998 18.7197C20.3494 19.071 20.3498 19.6404 19.999 19.9922C19.6476 20.3441 19.0775 20.3446 18.7256 19.9932L14.6953 15.9678C13.1438 17.2374 11.1612 18 9 18C4.02944 18 0 13.9706 0 9C0 4.02944 4.02944 0 9 0ZM9 1.7998C5.02355 1.7998 1.7998 5.02355 1.7998 9C1.7998 12.9765 5.02355 16.2002 9 16.2002C12.9765 16.2002 16.2002 12.9765 16.2002 9C16.2002 5.02355 12.9765 1.7998 9 1.7998ZM12.5996 8.09961C13.0969 8.09961 13.5 8.50273 13.5 9C13.5 9.49727 13.0969 9.90039 12.5996 9.90039H5.40039C4.90312 9.90039 4.5 9.49727 4.5 9C4.5 8.50273 4.90312 8.09961 5.40039 8.09961H12.5996Z" fill="currentColor"/></svg>`,
  zoomIn:
    `<svg width="14" height="14" viewBox="0 0 20.2613 20.2565" fill="none" aria-hidden="true"><path d="M9 0C13.9705 6.59711e-05 18 4.02948 18 9C18 11.1612 17.2374 13.1438 15.9678 14.6953L19.9971 18.7197C20.3489 19.0711 20.3494 19.6403 19.998 19.9922C19.6466 20.3441 19.0765 20.3446 18.7246 19.9932L14.6953 15.9678C13.1438 17.2374 11.1611 18 9 18C4.02944 18 0 13.9706 0 9C0 4.02944 4.02944 0 9 0ZM9 1.7998C5.02355 1.7998 1.7998 5.02355 1.7998 9C1.7998 12.9765 5.02355 16.2002 9 16.2002C12.9764 16.2001 16.2002 12.9764 16.2002 9C16.2002 5.02359 12.9764 1.79987 9 1.7998ZM8.99512 4.50488C9.49233 4.50495 9.89551 4.90804 9.89551 5.40527V8.09961H12.5996C13.0968 8.09968 13.5 8.50277 13.5 9C13.5 9.49723 13.0968 9.90032 12.5996 9.90039H9.89551V12.6045C9.89551 13.1017 9.49233 13.5048 8.99512 13.5049C8.49785 13.5049 8.09473 13.1018 8.09473 12.6045V9.90039H5.40039C4.90312 9.90039 4.5 9.49727 4.5 9C4.5 8.50273 4.90312 8.09961 5.40039 8.09961H8.09473V5.40527C8.09473 4.908 8.49785 4.50488 8.99512 4.50488Z" fill="currentColor"/></svg>`,
  export:
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  addTrack: wrap(
    `<g transform="translate(2 2)"><rect x="0" y="1.5" width="12" height="2.5" rx="0.5" fill="currentColor"/><rect x="0" y="8" width="12" height="2.5" rx="0.5" fill="currentColor" opacity="0.55"/><circle cx="10" cy="10" r="3.4" fill="currentColor"/><rect x="9.4" y="8.5" width="1.2" height="3" rx="0.4" fill="#fff"/><rect x="8.5" y="9.4" width="3" height="1.2" rx="0.4" fill="#fff"/></g>`,
  ),
  trash: wrap(
    `<g transform="translate(1 1)" fill="currentColor"><path d="M5 1.25h4v.9H13v1.05H1V2.15h4v-.9zM2.4 4.1h9.2l-.65 8.9c-.04.55-.5.96-1.05.96H4.1c-.55 0-1.01-.41-1.05-.96L2.4 4.1zm2.3 1.7l.35 7.1h1l-.35-7.1h-1zm2.65 0v7.1h1V5.8h-1zm2.3 0l-.35 7.1h1l.35-7.1h-1z"/></g>`,
  ),
  /** "Skip to start" — vertical bar + left-pointing triangle. Sits to
   *  the left of the keyframe diamond so the clip-edge nav cluster
   *  reads as [|◀ ◇ ▶|] = "go to clip start / add kf / go to clip end". */
  seekClipStart: wrap(
    `<g transform="translate(2 3)" fill="currentColor"><rect x="0" y="0" width="1.6" height="10" rx="0.4"/><path d="M11 0.6c0-0.5-0.55-0.78-0.95-0.48l-6.5 4.4c-0.34 0.23-0.34 0.73 0 0.96l6.5 4.4c0.4 0.3 0.95 0.02 0.95-0.48z"/></g>`,
  ),
  /** "Skip to end" — mirror of seekClipStart. */
  seekClipEnd: wrap(
    `<g transform="translate(1 3)" fill="currentColor"><path d="M0 0.6c0-0.5 0.55-0.78 0.95-0.48l6.5 4.4c0.34 0.23 0.34 0.73 0 0.96l-6.5 4.4c-0.4 0.3-0.95 0.02-0.95-0.48z"/><rect x="10.4" y="0" width="1.6" height="10" rx="0.4"/></g>`,
  ),
  /** Outlined diamond (rotated square) — "add keyframe" affordance. */
  keyframeOutline: wrap(
    `<g transform="translate(8 8) rotate(45) translate(-4 -4)" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="0.5" y="0.5" width="7" height="7" rx="0.5"/></g>`,
  ),
  /** Filled diamond — shown when a keyframe already exists at playhead. */
  keyframeFilled: wrap(
    `<g transform="translate(8 8) rotate(45) translate(-4 -4)" fill="currentColor"><rect x="0" y="0" width="8" height="8" rx="0.8"/></g>`,
  ),
  /** Aspect-ratio picker — outlined rounded rectangle (landscape
   *  proportions) with a portrait rectangle nested inside it. Matches
   *  CapCut's "比例" affordance: a frame-within-frame conveying
   *  "choose which output canvas to crop into". */
  aspect: wrap(
    `<g transform="translate(1 1.5)" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="0.6" y="2.4" width="12.8" height="8.2" rx="1.2"/><rect x="4.6" y="4.4" width="4.8" height="6.2" rx="0.9" stroke-width="1.1" opacity="0.85"/></g>`,
  ),
  /** Counter-clockwise circular arrow — "reset to initial layout". */
  reset:
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
};

export type IconName = keyof typeof ICONS;
