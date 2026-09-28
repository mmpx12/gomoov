package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSRTToVTT(t *testing.T) {
	raw := []byte("1\r\n00:00:01,000 --> 00:00:04,000\r\nHello\r\nthere\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\nNext\r\n")
	out := string(srtToVTT(raw))
	if !strings.HasPrefix(out, "WEBVTT\n") {
		t.Fatalf("header %q", out)
	}
	if !strings.Contains(out, "00:00:01.000 --> 00:00:04.000\nHello\nthere\n") {
		t.Fatalf("cue %q", out)
	}
	if strings.Contains(out, "1\n00:00") {
		t.Fatalf("cue index kept %q", out)
	}
}

func TestSidecarDiscovery(t *testing.T) {
	dir := t.TempDir()
	video := filepath.Join(dir, "Lantern Street S01E01.mkv")
	if err := os.WriteFile(video, []byte("v"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Lantern Street S01E01.srt"), []byte("1\n00:00:01,000 --> 00:00:02,000\nHi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Lantern Street S01E01.fr.vtt"), []byte("WEBVTT\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "other.srt"), []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret.srt")
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "Lantern Street S01E01.en.srt")); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	matches := matchingSidecars(video, entries)
	if len(matches) != 2 {
		t.Fatalf("matches %d %+v", len(matches), matches)
	}
	subs := subsFromMatches(matches)
	if len(subs) != 2 || subs[0].ID != sidecarIDBase || !subs[0].Text {
		t.Fatalf("subs %+v", subs)
	}
	var french, plain *sub
	for i := range subs {
		if subs[i].Language == "fr" {
			french = &subs[i]
		}
		if subs[i].Language == "" {
			plain = &subs[i]
		}
	}
	if french == nil || !strings.Contains(french.Label, "French") || plain == nil {
		t.Fatalf("subs %+v", subs)
	}
	oldCache := cache
	cache = t.TempDir()
	t.Cleanup(func() { cache = oldCache })
	vtt := string(sidecarVTT(video, plain.ID))
	if !strings.Contains(vtt, "WEBVTT") || !strings.Contains(vtt, "Hi") {
		t.Fatalf("vtt %q", vtt)
	}
}
