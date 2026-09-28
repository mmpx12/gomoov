package main

import (
	"bytes"
	"crypto/sha1"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

const sidecarIDBase = 1000

type sidecarMatch struct {
	name string
	lang string
	abs  string
}

func matchingSidecars(video string, entries []os.DirEntry) []sidecarMatch {
	dir := filepath.Dir(video)
	base := filepath.Base(video)
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	if stem == "" || entries == nil {
		return nil
	}
	stemLower := strings.ToLower(stem)
	var matches []sidecarMatch
	for _, ent := range entries {
		if ent.IsDir() {
			continue
		}
		name := ent.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		subExt := strings.ToLower(filepath.Ext(name))
		if subExt != ".srt" && subExt != ".vtt" {
			continue
		}
		body := strings.ToLower(strings.TrimSuffix(name, filepath.Ext(name)))
		lang := ""
		switch {
		case body == stemLower:
		case strings.HasPrefix(body, stemLower+"."):
			lang = body[len(stemLower)+1:]
			if !validSubLang(lang) {
				continue
			}
		default:
			continue
		}
		full := filepath.Join(dir, name)
		if !sameDirFile(dir, full) {
			continue
		}
		matches = append(matches, sidecarMatch{name: name, lang: lang, abs: full})
	}
	sort.Slice(matches, func(i, j int) bool { return matches[i].name < matches[j].name })
	return matches
}

func validSubLang(lang string) bool {
	if len(lang) < 2 || len(lang) > 3 {
		return false
	}
	for _, r := range lang {
		if r < 'a' || r > 'z' {
			return false
		}
	}
	return true
}

func sameDirFile(dir, path string) bool {
	abs, err := filepath.Abs(path)
	if err != nil || !hasPathPrefix(abs, dir) {
		return false
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return false
	}
	dirResolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		dirResolved = dir
	}
	return hasPathPrefix(resolved, dirResolved)
}

func sidecarLabel(lang, name string) (string, string) {
	code := strings.ToLower(lang)
	if code == "" {
		return "Subtitles · " + name, ""
	}
	label, norm := trackLabel(map[string]string{"language": code})
	if label == "" || label == "Unknown" {
		label = strings.ToUpper(code)
	}
	return label + " · file", norm
}

func sidecarSubs(path string) []sub {
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		return nil
	}
	return subsFromMatches(matchingSidecars(path, entries))
}

func subsFromMatches(matches []sidecarMatch) []sub {
	if len(matches) == 0 {
		return nil
	}
	out := make([]sub, 0, len(matches))
	for i, match := range matches {
		label, code := sidecarLabel(match.lang, match.name)
		ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(match.name)), ".")
		out = append(out, sub{
			ID:       sidecarIDBase + i,
			Codec:    ext,
			Text:     true,
			Language: code,
			Label:    label,
		})
	}
	return out
}

func withSidecars(path string, info videoInfo, entries []os.DirEntry) videoInfo {
	extra := subsFromMatches(matchingSidecars(path, entries))
	if len(extra) == 0 {
		return info
	}
	merged := make([]sub, 0, len(info.Subtitles)+len(extra))
	merged = append(merged, info.Subtitles...)
	merged = append(merged, extra...)
	info.Subtitles = merged
	return info
}

func dirEntries(cache map[string][]os.DirEntry, dir string) []os.DirEntry {
	if entries, ok := cache[dir]; ok {
		return entries
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		entries = nil
	}
	cache[dir] = entries
	return entries
}

func sidecarStamp(path string, entries []os.DirEntry) string {
	matches := matchingSidecars(path, entries)
	if len(matches) == 0 {
		return ""
	}
	var b strings.Builder
	for _, match := range matches {
		st, err := os.Stat(match.abs)
		if err != nil {
			continue
		}
		fmt.Fprintf(&b, "|sub:%s:%d:%d", match.name, st.Size(), st.ModTime().UnixNano())
	}
	return b.String()
}

func srtToVTT(raw []byte) []byte {
	raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})
	if !utf8.Valid(raw) {
		raw = []byte(strings.ToValidUTF8(string(raw), ""))
	}
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	var b strings.Builder
	b.WriteString("WEBVTT\n\n")
	for _, block := range strings.Split(text, "\n\n") {
		lines := strings.Split(strings.TrimSpace(block), "\n")
		if len(lines) == 0 || lines[0] == "" {
			continue
		}
		start := 0
		if !strings.Contains(lines[0], "-->") {
			if len(lines) < 2 || !strings.Contains(lines[1], "-->") {
				continue
			}
			start = 1
		}
		b.WriteString(strings.ReplaceAll(lines[start], ",", "."))
		b.WriteByte('\n')
		for _, line := range lines[start+1:] {
			b.WriteString(line)
			b.WriteByte('\n')
		}
		b.WriteByte('\n')
	}
	return []byte(b.String())
}

func sidecarVTT(path string, id int) []byte {
	matches := matchingSidecars(path, dirEntries(map[string][]os.DirEntry{}, filepath.Dir(path)))
	index := id - sidecarIDBase
	if index < 0 || index >= len(matches) {
		return nil
	}
	match := matches[index]
	st, err := os.Stat(match.abs)
	if err != nil {
		return nil
	}
	key := fmt.Sprintf("side:%s:%d:%d", match.abs, st.Size(), st.ModTime().UnixNano())
	sum := sha1.Sum([]byte(key))
	dest := filepath.Join(cache, "subs", fmt.Sprintf("%x.vtt", sum))
	if b, err := os.ReadFile(dest); err == nil && len(b) > 0 {
		return b
	}
	raw, err := os.ReadFile(match.abs)
	if err != nil || len(raw) == 0 || len(raw) > 8<<20 {
		return nil
	}
	var data []byte
	if strings.EqualFold(filepath.Ext(match.name), ".srt") {
		data = srtToVTT(raw)
	} else {
		raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})
		if !bytes.HasPrefix(bytes.TrimSpace(raw), []byte("WEBVTT")) {
			data = append([]byte("WEBVTT\n\n"), raw...)
		} else {
			data = raw
		}
	}
	if len(data) == 0 {
		return nil
	}
	_ = os.MkdirAll(filepath.Dir(dest), 0o755)
	_ = os.WriteFile(dest, data, 0o644)
	return data
}
