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
	if err := prepareFilters([]string{filepath.Dir(dir)}, nil); err == nil {
		t.Fatal("include outside the library was accepted")
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
