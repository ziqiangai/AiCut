package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// resolveSourceURL maps a frontend source URL to something ffmpeg can
// open. HTTP(s)/file:// pass through; an absolute-looking "/foo.mov"
// is treated as a Vite-style public path and resolved under
// AICUT_ASSETS_DIR when set. Without the env var we pass through
// unchanged and let ffmpeg report the missing file.
//
// Matches the TS backend's resolveSourceUrl exactly so the two
// backends behave identically on the same project JSON.
var protocolPrefix = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+\-.]*://`)

func resolveSourceURL(url string) string {
	if protocolPrefix.MatchString(url) {
		return url
	}
	if dir := os.Getenv("AICUT_ASSETS_DIR"); dir != "" && strings.HasPrefix(url, "/") {
		return filepath.Join(dir, url)
	}
	return url
}

// ProgressEvent matches the SSE wire format the demo consumes. Stays
// in lockstep with backends/ts/src/render.ts ProgressEvent.
type ProgressEvent struct {
	Phase      string  `json:"phase"`               // "encode" | "concat"
	Overall    float64 `json:"overall"`             // 0..1
	ClipIndex  *int    `json:"clipIndex,omitempty"` // encode phase only
	TotalClips int     `json:"totalClips,omitempty"`
}

// renderProject re-encodes each clip then concat-demuxes them into a
// single mp4 at outputPath. onProgress (optional) is called for each
// progress sample we receive from ffmpeg — the server is responsible
// for throttling before writing to SSE.
func renderProject(ctx context.Context, req ExportRequest, outputPath string, onProgress func(ProgressEvent)) error {
	bin := resolveFfmpeg()

	work, err := os.MkdirTemp("", "aicut-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)

	track, ok := findVideoTrack(req.Project)
	if !ok || len(track.Clips) == 0 {
		return errors.New("project has no video clips to export")
	}

	sourcesByID := make(map[string]MediaSource, len(req.Project.Sources))
	for _, s := range req.Project.Sources {
		sourcesByID[s.ID] = s
	}

	// Total project duration in ms — denominator for the overall
	// progress fraction across clips.
	var totalMs int64
	for _, c := range track.Clips {
		totalMs += c.Out - c.In
	}
	totalClips := len(track.Clips)
	var accumDoneMs int64

	segments := make([]string, 0, len(track.Clips))
	for i, clip := range track.Clips {
		src, ok := sourcesByID[clip.SourceID]
		if !ok {
			return fmt.Errorf("missing source %s", clip.SourceID)
		}
		segPath := filepath.Join(work, fmt.Sprintf("seg-%d.mp4", i))
		durMs := clip.Out - clip.In
		args := []string{
			"-y",
			"-ss", msToSec(clip.In),
			"-i", resolveSourceURL(src.URL),
			"-t", msToSec(durMs),
			"-c:v", "libx264",
			"-preset", "veryfast",
			"-c:a", "aac",
			"-movflags", "+faststart",
		}
		hasKeyframes := len(clip.Keyframes) > 0
		hasOutputDims := req.Output != nil && req.Output.Width > 0 && req.Output.Height > 0
		if hasKeyframes && !hasOutputDims {
			// Match the TS backend's warn so silent kf skips don't go
			// unnoticed — operator gets a clear "your animation went
			// nowhere because you didn't pass output dims" hint.
			log.Printf(
				"[render] clip %s has %d keyframe(s) but no output width/height — pass output: { width, height } in the request to apply keyframe animation.",
				clip.ID, len(clip.Keyframes),
			)
		}
		if hasKeyframes && hasOutputDims {
			// Animated path — filter_complex mirrors the frontend PiP
			// semantics (fixed black bg, animated content inside). See
			// buildKeyframeFilterComplex for the math.
			fps := 30
			if req.Output.FPS > 0 {
				fps = req.Output.FPS
			}
			durSec := float64(durMs) / 1000.0
			fc := buildKeyframeFilterComplex(clip, req.Output.Width, req.Output.Height, fps, durSec)
			args = append(args,
				"-filter_complex", fc,
				"-map", "[out]",
				"-map", "0:a?",
			)
		} else if req.Output != nil && req.Output.Width > 0 && req.Output.Height > 0 {
			w := strconv.Itoa(req.Output.Width)
			h := strconv.Itoa(req.Output.Height)
			args = append(args, "-vf",
				fmt.Sprintf("scale=%s:%s:force_original_aspect_ratio=decrease,pad=%s:%s:(ow-iw)/2:(oh-ih)/2", w, h, w, h),
			)
		}
		if req.Output != nil && req.Output.FPS > 0 {
			args = append(args, "-r", strconv.Itoa(req.Output.FPS))
		}
		args = append(args, "-nostats", "-progress", "pipe:1", segPath)

		localI := i
		onLine := func(line string) {
			us, ok := parseOutTimeUs(line)
			if !ok {
				return
			}
			clipMs := int64(us / 1000)
			if clipMs > durMs {
				clipMs = durMs
			}
			var overall float64
			if totalMs > 0 {
				overall = float64(accumDoneMs+clipMs) / float64(totalMs)
				overall = math.Min(overall, 0.99)
			}
			if onProgress != nil {
				onProgress(ProgressEvent{
					Phase:      "encode",
					Overall:    overall,
					ClipIndex:  &localI,
					TotalClips: totalClips,
				})
			}
		}
		if err := runFfmpeg(ctx, bin, args, onLine); err != nil {
			return fmt.Errorf("ffmpeg segment %d failed: %w", i, err)
		}
		accumDoneMs += durMs
		segments = append(segments, segPath)
	}

	if onProgress != nil {
		onProgress(ProgressEvent{Phase: "concat", Overall: 0.99, TotalClips: totalClips})
	}

	listPath := filepath.Join(work, "concat.txt")
	var lb strings.Builder
	for _, p := range segments {
		// concat-demuxer escapes single quotes by closing + escaping +
		// reopening the quoted string.
		escaped := strings.ReplaceAll(p, "'", `'\''`)
		lb.WriteString("file '")
		lb.WriteString(escaped)
		lb.WriteString("'\n")
	}
	if err := os.WriteFile(listPath, []byte(lb.String()), 0o644); err != nil {
		return err
	}

	tmpOut := filepath.Join(work, "output.mp4")
	concatArgs := []string{
		"-y",
		"-f", "concat",
		"-safe", "0",
		"-i", listPath,
		"-c", "copy",
		"-movflags", "+faststart",
		tmpOut,
	}
	if err := runFfmpeg(ctx, bin, concatArgs, nil); err != nil {
		return fmt.Errorf("ffmpeg concat failed: %w", err)
	}
	// rename works in-FS; fall back to copy for cross-FS (tmpdir vs
	// outputs dir on different mounts).
	if err := os.Rename(tmpOut, outputPath); err != nil {
		if err := copyFile(tmpOut, outputPath); err != nil {
			return err
		}
		_ = os.Remove(tmpOut)
	}
	if onProgress != nil {
		onProgress(ProgressEvent{Phase: "concat", Overall: 1, TotalClips: totalClips})
	}
	return nil
}

// buildKeyframeFilterComplex compiles a -filter_complex graph that
// applies pan / scale keyframe animation to a single clip. Mirrors
// the TS backend's buildKeyframeFilterComplex; both pipe a fitted
// source through an animated scale into a fixed black background
// at an animated overlay position. eval=frame is required to
// re-evaluate the expressions per output frame (default is `init`).
func buildKeyframeFilterComplex(clip Clip, width, height, fps int, durSec float64) string {
	scaleExpr := compileKeyframeExpression(clip.Keyframes, "scale", floatOr(clip.Scale, 1))
	panXExpr := compileKeyframeExpression(clip.Keyframes, "panX", floatOr(clip.PanX, 0))
	panYExpr := compileKeyframeExpression(clip.Keyframes, "panY", floatOr(clip.PanY, 0))
	wExpr := fmt.Sprintf("trunc(iw*(%s)/2)*2", scaleExpr)
	hExpr := fmt.Sprintf("trunc(ih*(%s)/2)*2", scaleExpr)
	parts := []string{
		fmt.Sprintf("[0:v]scale=%d:%d:force_original_aspect_ratio=decrease,setsar=1[fitted]", width, height),
		fmt.Sprintf("[fitted]scale=w='%s':h='%s':eval=frame[zoomed]", wExpr, hExpr),
		fmt.Sprintf("color=c=black:s=%dx%d:r=%d:d=%s,format=yuv420p[bg]", width, height, fps, strconv.FormatFloat(durSec, 'f', 3, 64)),
		fmt.Sprintf("[bg][zoomed]overlay=x='(W-w)/2+(%s)':y='(H-h)/2+(%s)':eval=frame:format=auto[out]", panXExpr, panYExpr),
	}
	return strings.Join(parts, ";")
}

func findVideoTrack(p Project) (Track, bool) {
	for _, t := range p.Tracks {
		if t.Kind == "video" {
			return t, true
		}
	}
	return Track{}, false
}

func msToSec(ms int64) string {
	return strconv.FormatFloat(float64(ms)/1000.0, 'f', -1, 64)
}

// parseOutTimeUs extracts microseconds from an ffmpeg -progress line
// `out_time_us=12345678`. We avoid `out_time_ms` because the field's
// unit has varied between ms and us across ffmpeg releases.
func parseOutTimeUs(line string) (int64, bool) {
	const prefix = "out_time_us="
	if !strings.HasPrefix(line, prefix) {
		return 0, false
	}
	v, err := strconv.ParseInt(strings.TrimSpace(line[len(prefix):]), 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}
