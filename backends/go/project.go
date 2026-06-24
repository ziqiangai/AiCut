package main

// Project mirrors the @aicut/core Project JSON shape. Keep this in
// sync with packages/core/src/types.ts.

type MediaSource struct {
	ID       string `json:"id"`
	URL      string `json:"url"`
	Kind     string `json:"kind"`
	Duration int64  `json:"duration,omitempty"`
	Name     string `json:"name,omitempty"`
}

type Clip struct {
	ID       string `json:"id"`
	SourceID string `json:"sourceId"`
	In       int64  `json:"in"`
	Out      int64  `json:"out"`
	Start    int64  `json:"start"`
	// Static base values for the content transform, used when a prop
	// has no keyframes. Pointers so we can tell "0 by default" apart
	// from "explicitly 0 in the project JSON". Matches the optional
	// `panX?` / `panY?` / `scale?` fields on the frontend Clip type.
	PanX  *float64 `json:"panX,omitempty"`
	PanY  *float64 `json:"panY,omitempty"`
	Scale *float64 `json:"scale,omitempty"`
	// Per-property keyframes (current model). Each keyframe targets
	// one of panX / panY / scale at one clip-local time, with an
	// optional outgoing easing curve. Backend compiles these to
	// ffmpeg `t`-expressions in render.go.
	Keyframes []Keyframe `json:"keyframes,omitempty"`
}

type Keyframe struct {
	ID   string `json:"id"`
	Prop string `json:"prop"` // "panX" | "panY" | "scale"
	Time int64  `json:"time"`
	// Single per-property value (CSS px for pan, multiplier for scale).
	Value float64 `json:"value"`
	// Outgoing easing curve. Omitted = linear (back-compat with
	// pre-easing projects).
	Easing string `json:"easing,omitempty"` // "linear" | "easeIn" | "easeOut" | "easeInOut"
}

type Track struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Clips []Clip `json:"clips"`
}

type Project struct {
	Version int           `json:"version"`
	Sources []MediaSource `json:"sources"`
	Tracks  []Track       `json:"tracks"`
}

type OutputOptions struct {
	Width  int `json:"width,omitempty"`
	Height int `json:"height,omitempty"`
	FPS    int `json:"fps,omitempty"`
}

type ExportRequest struct {
	Project Project        `json:"project"`
	Output  *OutputOptions `json:"output,omitempty"`
}
