//go:build embedffmpeg

package main

import (
	"embed"
	"log"
	"os"
	"path/filepath"
)

//go:embed build/ffmpeg/ffmpeg build/ffmpeg/ffprobe
var embeddedTools embed.FS

func prepareFFmpeg() error {
	dir := filepath.Join(configDir, "bin")
	if configDir == "" {
		dir = filepath.Join(os.TempDir(), "gomoov-bin")
	}
	ffmpegData, err := embeddedTools.ReadFile("build/ffmpeg/ffmpeg")
	if err != nil {
		return err
	}
	ffprobeData, err := embeddedTools.ReadFile("build/ffmpeg/ffprobe")
	if err != nil {
		return err
	}
	ffmpegPath, err := writeTool(dir, "ffmpeg", ffmpegData)
	if err != nil {
		return err
	}
	ffprobePath, err := writeTool(dir, "ffprobe", ffprobeData)
	if err != nil {
		return err
	}
	ffmpegBin = ffmpegPath
	ffprobeBin = ffprobePath
	log.Printf("using embedded ffmpeg from %s", dir)
	return nil
}
