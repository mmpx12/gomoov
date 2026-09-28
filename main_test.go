package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestMultiFlagCommaAndRepeat(t *testing.T) {
	var got multiFlag
	if err := got.Set("/a,/b"); err != nil {
		t.Fatal(err)
	}
	if err := got.Set("/c"); err != nil {
		t.Fatal(err)
	}
	if err := got.Set("/d,"); err != nil {
		t.Fatal(err)
	}
	want := multiFlag{"/a", "/b", "/c", "/d"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", []string(got))
	}
	if err := got.Set(" , "); err == nil {
		t.Fatal("empty path was accepted")
	}
}

func TestIncludeExcludeAndMovie(t *testing.T) {
	dir := t.TempDir()
	root = dir
	t.Cleanup(func() {
		includeDirs = nil
		excludeDirs = nil
	})
	for _, rel := range []string{
		"a/one.mkv",
		"a/nested/two.mkv",
		"b/three.mkv",
		"c/skip/four.mkv",
		"c/keep/five.mkv",
		"top.mkv",
		".secret/hidden.mkv",
	} {
		full := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if err := prepareFilters(nil, nil); err != nil {
		t.Fatal(err)
	}
	assertRels(t, listVideos(), []string{
		"a/nested/two.mkv",
		"a/one.mkv",
		"b/three.mkv",
		"c/keep/five.mkv",
		"c/skip/four.mkv",
		"top.mkv",
	})

	if err := prepareFilters([]string{"a", "c"}, []string{"c/skip"}); err != nil {
		t.Fatal(err)
	}
	assertRels(t, listVideos(), []string{
		"a/nested/two.mkv",
		"a/one.mkv",
		"c/keep/five.mkv",
	})

	if err := prepareFilters([]string{"a/nested"}, nil); err != nil {
		t.Fatal(err)
	}
	assertRels(t, listVideos(), []string{"a/nested/two.mkv"})
	rel, err := resolveMovie("a/nested/two.mkv")
	if err != nil {
		t.Fatal(err)
	}
	if rel != "a/nested/two.mkv" {
		t.Fatalf("movie rel %q", rel)
	}
	absMovie := filepath.Join(dir, "a", "nested", "two.mkv")
	rel, err = resolveMovie(absMovie)
	if err != nil || rel != "a/nested/two.mkv" {
		t.Fatalf("abs movie %q %v", rel, err)
	}
	if _, err := resolveMovie("b/three.mkv"); err == nil {
		t.Fatal("movie outside include was accepted")
	}

	if err := prepareFilters([]string{"a/nested"}, []string{"a"}); err == nil {
		t.Fatal("include inside exclude was accepted")
	}
	other := t.TempDir()
	if err := prepareFilters([]string{other}, nil); err != nil {
		t.Fatal(err)
	}
	if len(listVideos()) != 0 {
		t.Fatalf("empty outside include listed %v", listVideos())
	}
	if err := prepareFilters([]string{"top.mkv"}, nil); err == nil {
		t.Fatal("include of a file was accepted")
	}

	if err := prepareFilters(nil, []string{"b", "c/skip"}); err != nil {
		t.Fatal(err)
	}
	assertRels(t, listVideos(), []string{
		"a/nested/two.mkv",
		"a/one.mkv",
		"c/keep/five.mkv",
		"top.mkv",
	})
}

func TestExternalIncludeAndUploads(t *testing.T) {
	lib := t.TempDir()
	other := t.TempDir()
	ups := t.TempDir()
	oldRoot, oldUpload := root, uploadRoot
	t.Cleanup(func() {
		root, uploadRoot = oldRoot, oldUpload
		includeDirs, excludeDirs = nil, nil
		authMu.Lock()
		visibility = nil
		authMu.Unlock()
	})
	root = lib
	uploadRoot = ups
	for _, rel := range []string{
		filepath.Join(lib, "local.mkv"),
		filepath.Join(other, "nested", "out.mkv"),
		filepath.Join(other, "skip", "hidden.mkv"),
	} {
		if err := os.MkdirAll(filepath.Dir(rel), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(rel, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	id := "11111111-1111-4111-8111-111111111111"
	mine := filepath.Join(ups, id, "mine.mkv")
	if err := os.MkdirAll(filepath.Dir(mine), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mine, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	loose := filepath.Join(ups, "loose.mkv")
	if err := os.WriteFile(loose, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := prepareFilters([]string{other}, []string{filepath.Join(other, "skip")}); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, path := range listVideos() {
		got[filepath.Base(path)] = path
	}
	if _, ok := got["local.mkv"]; ok {
		t.Fatal("launch folder was scanned even though it was not included")
	}
	if _, ok := got["hidden.mkv"]; ok {
		t.Fatal("excluded file was scanned")
	}
	out := got["out.mkv"]
	minePath := got["mine.mkv"]
	if out == "" || minePath == "" {
		t.Fatalf("missing included or upload video: %v", got)
	}
	if back, err := safeVideo(relOf(out)); err != nil || back != out {
		t.Fatalf("include path %q -> %q %v", relOf(out), back, err)
	}
	if back, err := safeVideo(relOf(minePath)); err != nil || back != minePath {
		t.Fatalf("upload path %q -> %q %v", relOf(minePath), back, err)
	}
	if !canSeePath(nil, out) {
		t.Fatal("anonymous could not open an included video")
	}
	if canSeePath(nil, minePath) {
		t.Fatal("anonymous saw a private upload")
	}
	owner := userRecord{ID: id}
	if !canSeePath(&owner, minePath) {
		t.Fatal("owner could not open their upload")
	}
	if _, err := resolveMovie(out); err != nil {
		t.Fatal(err)
	}

	if err := prepareFilters([]string{ups}, nil); err != nil {
		t.Fatal(err)
	}
	got = map[string]string{}
	for _, path := range listVideos() {
		got[filepath.Base(path)] = path
	}
	if got["loose.mkv"] == "" || got["mine.mkv"] == "" {
		t.Fatalf("~/gomoov was not accessible: %v", got)
	}
	if _, ok := got["local.mkv"]; ok || got["out.mkv"] != "" {
		t.Fatal("unrelated folders were included")
	}
	if back, err := safeVideo(relOf(got["loose.mkv"])); err != nil || back != got["loose.mkv"] {
		t.Fatalf("gomoov file %q -> %q %v", relOf(got["loose.mkv"]), back, err)
	}
	if !canSeePath(nil, got["loose.mkv"]) {
		t.Fatal("anonymous could not open a public file in ~/gomoov")
	}
}

func assertRels(t *testing.T, paths, want []string) {
	t.Helper()
	got := make([]string, len(paths))
	for i, path := range paths {
		got[i] = relOf(path)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}
