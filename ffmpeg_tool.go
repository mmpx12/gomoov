package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
)

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
		if st, err := os.Stat(dest); err == nil && st.Mode()&0o111 != 0 {
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
