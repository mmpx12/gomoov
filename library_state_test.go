package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPerUserProgressWatchLaterAndSeen(t *testing.T) {
	withAuth(t)
	clip := filepath.Join(root, "clip.mp4")
	if err := os.WriteFile(clip, []byte("not a real movie"), 0o644); err != nil {
		t.Fatal(err)
	}
	abs, err := filepath.Abs(clip)
	if err != nil {
		t.Fatal(err)
	}
	seed, err := json.Marshal(map[string]progressEntry{abs: {T: 5, Dur: 20, At: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "progress.json"), seed, 0o644); err != nil {
		t.Fatal(err)
	}

	admin := cookieOf(t, postJSON("/api/login", map[string]string{"username": "admin", "password": "admin"}, nil))
	created := postJSON("/api/users", map[string]any{"username": "ada", "password": "secret", "canUpload": true}, admin)
	if created.Code != http.StatusOK {
		t.Fatalf("create ada %d %s", created.Code, created.Body.String())
	}
	ada := cookieOf(t, postJSON("/api/login", map[string]string{"username": "ada", "password": "secret"}, nil))

	adminGot := sendJSON(http.MethodGet, "/api/progress", nil, admin)
	adaGot := sendJSON(http.MethodGet, "/api/progress", nil, ada)
	anon := sendJSON(http.MethodGet, "/api/progress", nil, nil)
	if adminGot.Code != http.StatusOK || adaGot.Code != http.StatusOK || anon.Code != http.StatusOK {
		t.Fatalf("get progress %d %d %d", adminGot.Code, adaGot.Code, anon.Code)
	}
	var adminProg, adaProg, anonProg map[string]progressEntry
	if err := json.Unmarshal(adminGot.Body.Bytes(), &adminProg); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(adaGot.Body.Bytes(), &adaProg); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(anon.Body.Bytes(), &anonProg); err != nil {
		t.Fatal(err)
	}
	if adminProg[abs].T != 5 || adaProg[abs].T != 5 || anonProg[abs].T != 5 {
		t.Fatalf("seed admin %v ada %v anon %v", adminProg[abs].T, adaProg[abs].T, anonProg[abs].T)
	}

	updated := sendJSON(http.MethodPut, "/api/progress", map[string]any{
		"path":  "clip.mp4",
		"entry": progressEntry{T: 12, Dur: 20, At: 2},
	}, admin)
	if updated.Code != http.StatusOK {
		t.Fatalf("update %d %s", updated.Code, updated.Body.String())
	}
	adminGot = sendJSON(http.MethodGet, "/api/progress", nil, admin)
	adaGot = sendJSON(http.MethodGet, "/api/progress", nil, ada)
	_ = json.Unmarshal(adminGot.Body.Bytes(), &adminProg)
	_ = json.Unmarshal(adaGot.Body.Bytes(), &adaProg)
	if adminProg[abs].T != 12 || adaProg[abs].T != 5 {
		t.Fatalf("split progress admin %v ada %v", adminProg[abs].T, adaProg[abs].T)
	}

	if sendJSON(http.MethodPut, "/api/watchlater", map[string]any{"paths": []string{abs}}, nil).Code != http.StatusUnauthorized {
		t.Fatal("anonymous watch later was accepted")
	}
	if saved := sendJSON(http.MethodPut, "/api/watchlater", map[string]any{"paths": []string{"clip.mp4"}}, admin); saved.Code != http.StatusOK {
		t.Fatalf("watch later %d %s", saved.Code, saved.Body.String())
	}
	adaLater := sendJSON(http.MethodGet, "/api/watchlater", nil, ada)
	adminLater := sendJSON(http.MethodGet, "/api/watchlater", nil, admin)
	if adaLater.Body.String() == adminLater.Body.String() || !strings.Contains(adminLater.Body.String(), abs) {
		t.Fatalf("watch later admin %s ada %s", adminLater.Body.String(), adaLater.Body.String())
	}

	if saved := sendJSON(http.MethodPut, "/api/seen", map[string]any{"at": 100}, admin); saved.Code != http.StatusOK {
		t.Fatalf("seen %d %s", saved.Code, saved.Body.String())
	}
	adaSeen := sendJSON(http.MethodGet, "/api/seen", nil, ada)
	if adaSeen.Body.String() != "{\"at\":0}\n" && adaSeen.Body.String() != "{\"at\":0}" {
		t.Fatalf("ada seen %s", adaSeen.Body.String())
	}
	adminSeen := sendJSON(http.MethodGet, "/api/seen", nil, admin)
	if !strings.Contains(adminSeen.Body.String(), "100") {
		t.Fatalf("admin seen %s", adminSeen.Body.String())
	}
}
