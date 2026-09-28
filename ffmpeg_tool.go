package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var transcodeSlots = make(chan struct{}, 2)
var hwEncoder string

func detectHWEncoder() {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, toolBin("ffmpeg"), "-hide_banner", "-encoders").CombinedOutput()
	if err != nil {
		return
	}
	text := string(out)
	if strings.Contains(text, "h264_nvenc") {
		if _, err := os.Stat("/dev/nvidia0"); err == nil {
			hwEncoder = "nvenc"
			log.Printf("hardware encoder h264_nvenc")
			return
		}
	}
	if strings.Contains(text, "h264_vaapi") {
		if _, err := os.Stat("/dev/dri/renderD128"); err == nil {
			hwEncoder = "vaapi"
			log.Printf("hardware encoder h264_vaapi")
		}
	}
}

func acquireTranscode(ctx context.Context) bool {
	select {
	case transcodeSlots <- struct{}{}:
		return true
	default:
	}
	log.Printf("transcode queue waiting")
	select {
	case transcodeSlots <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	}
}

func releaseTranscode() { <-transcodeSlots }

func videoEncodeArgs() []string {
	switch hwEncoder {
	case "nvenc":
		return []string{"-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-rc", "vbr", "-cq", "23", "-pix_fmt", "yuv420p"}
	case "vaapi":
		return []string{"-c:v", "h264_vaapi", "-qp", "23"}
	default:
		return []string{"-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "23", "-pix_fmt", "yuv420p", "-profile:v", "high"}
	}
}

var (
	ffmpegBin  = "ffmpeg"
	ffprobeBin = "ffprobe"
)

func toolBin(name string) string {
	if name == "ffprobe" {
		return ffprobeBin
	}
	return ffmpegBin
}

func writeTool(dir, name string, data []byte) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	dest := filepath.Join(dir, name)
	sum := sha256.Sum256(data)
	stamp := hex.EncodeToString(sum[:])
	if old, err := os.ReadFile(dest + ".sha"); err == nil && string(old) == stamp {
		if _, err := os.Stat(dest); err == nil {
			return dest, nil
		}
	}
	tmp := dest + ".tmp"
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, dest); err != nil {
		return "", err
	}
	if err := os.WriteFile(dest+".sha", []byte(stamp), 0o644); err != nil {
		return "", err
	}
	return dest, nil
}
