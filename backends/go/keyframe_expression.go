package main

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// compileKeyframeExpression returns an ffmpeg filter expression in `t`
// (output-stream seconds) that evaluates to the property's value at
// time t. Mirrors backends/ts/src/keyframe-expression.ts line for
// line — same math, same boundary semantics:
//
//   - No keyframes for the prop → return the fallback as a literal.
//   - Single keyframe        → its value, constant.
//   - N keyframes            → sum of per-segment terms, each masked
//     by `gte(t, A) * lt(t, B)` so the half-open window [A, B) covers
//     exactly one segment per t.
//   - Before-first / after-last → held at the boundary kf's value.
//
// Easing follows the LEAVING keyframe (a→b is shaped by a.easing),
// matching the frontend convention.
func compileKeyframeExpression(keyframes []Keyframe, prop string, fallback float64) string {
	if len(keyframes) == 0 {
		return formatNumber(fallback)
	}
	propKfs := make([]Keyframe, 0, len(keyframes))
	for _, k := range keyframes {
		if k.Prop == prop {
			propKfs = append(propKfs, k)
		}
	}
	if len(propKfs) == 0 {
		return formatNumber(fallback)
	}
	sort.SliceStable(propKfs, func(i, j int) bool { return propKfs[i].Time < propKfs[j].Time })
	if len(propKfs) == 1 {
		return formatNumber(propKfs[0].Value)
	}

	first := propKfs[0]
	last := propKfs[len(propKfs)-1]

	parts := make([]string, 0, len(propKfs)+1)

	// Before first kf — held at first.value.
	parts = append(parts, fmt.Sprintf("lt(t,%s)*%s", formatTime(first.Time), formatNumber(first.Value)))

	// Segments.
	for i := 0; i < len(propKfs)-1; i++ {
		a := propKfs[i]
		b := propKfs[i+1]
		if b.Time <= a.Time {
			continue // zero / negative duration — skip to avoid div-by-zero
		}
		aSec := formatTime(a.Time)
		bSec := formatTime(b.Time)
		dur := float64(b.Time-a.Time) / 1000.0
		rawT := fmt.Sprintf("(t-%s)/%s", aSec, formatNumber(dur))
		easedT := easingExpression(rawT, a.Easing)
		delta := b.Value - a.Value
		var lerpedExpr string
		if delta == 0 {
			lerpedExpr = formatNumber(a.Value)
		} else {
			lerpedExpr = fmt.Sprintf("(%s+(%s)*(%s))", formatNumber(a.Value), easedT, formatNumber(delta))
		}
		parts = append(parts, fmt.Sprintf("gte(t,%s)*lt(t,%s)*%s", aSec, bSec, lerpedExpr))
	}

	// After last kf — held at last.value.
	parts = append(parts, fmt.Sprintf("gte(t,%s)*%s", formatTime(last.Time), formatNumber(last.Value)))

	return strings.Join(parts, "+")
}

// easingExpression wraps a normalized `rawT∈[0,1]` ffmpeg expression
// in the easing curve from the frontend. Endpoints stay exact (0→0,
// 1→1) so kf positions don't drift. Unknown easing values fall back
// to linear — defensive parse of project JSON authored elsewhere.
func easingExpression(rawT string, easing string) string {
	switch easing {
	case "easeIn":
		return fmt.Sprintf("pow(%s,3)", rawT)
	case "easeOut":
		return fmt.Sprintf("(1-pow(1-(%s),3))", rawT)
	case "easeInOut":
		return fmt.Sprintf("if(lt(%s,0.5),4*pow(%s,3),1-pow(-2*(%s)+2,3)/2)", rawT, rawT, rawT)
	default:
		// "linear" or anything we don't recognise.
		return rawT
	}
}

// formatNumber returns the ffmpeg-friendly decimal form of n. Integers
// stay integer-printed, fractions are truncated to 6 sig digits and
// stripped of trailing zeros / the stranded dot. Avoids scientific
// notation, which ffmpeg's parser doesn't understand.
func formatNumber(n float64) string {
	if n == float64(int64(n)) {
		return strconv.FormatInt(int64(n), 10)
	}
	s := strconv.FormatFloat(n, 'f', 6, 64)
	// Trim trailing zeros, then a possibly-stranded dot.
	s = strings.TrimRight(s, "0")
	s = strings.TrimRight(s, ".")
	return s
}

// formatTime converts clip-local ms to ffmpeg expression seconds.
func formatTime(ms int64) string {
	return formatNumber(float64(ms) / 1000.0)
}

// floatOr returns *p if non-nil, else fallback. Helper for the
// pointer-typed PanX / PanY / Scale fields on Clip.
func floatOr(p *float64, fallback float64) float64 {
	if p == nil {
		return fallback
	}
	return *p
}
