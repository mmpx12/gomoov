package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func stateRoot() string {
	if configDir != "" {
		return configDir
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		if cache != "" {
			return cache
		}
		return os.TempDir()
	}
	return filepath.Join(home, ".gomoov")
}

func userStateDir(userID string) (string, bool) {
	if !validUserID(userID) {
		return "", false
	}
	root, err := filepath.Abs(filepath.Join(stateRoot(), "users"))
	if err != nil {
		return "", false
	}
	dir, err := filepath.Abs(filepath.Join(root, userID))
	if err != nil || !hasPathPrefix(dir, root) || dir == root {
		return "", false
	}
	return dir, true
}

func progressFileFor(userID string) string {
	if userID == "" {
		return filepath.Join(stateRoot(), "progress.json")
	}
	dir, ok := userStateDir(userID)
	if !ok {
		return filepath.Join(stateRoot(), "progress.json")
	}
	return filepath.Join(dir, "progress.json")
}

func watchLaterFile(userID string) string {
	dir, ok := userStateDir(userID)
	if !ok {
		return ""
	}
	return filepath.Join(dir, "watchlater.json")
}

func seenFile(userID string) string {
	dir, ok := userStateDir(userID)
	if !ok {
		return ""
	}
	return filepath.Join(dir, "seen.json")
}

func readProgressMap(file string) map[string]progressEntry {
	out := map[string]progressEntry{}
	b, err := os.ReadFile(file)
	if err != nil {
		return out
	}
	_ = json.Unmarshal(b, &out)
	if out == nil {
		out = map[string]progressEntry{}
	}
	return out
}

func writeProgressMap(file string, all map[string]progressEntry, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(all)
	if err != nil {
		return err
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, b, mode); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

func progressMode(userID string) os.FileMode {
	if userID == "" {
		return 0o644
	}
	return 0o600
}

func accountID(user *userRecord) string {
	if user == nil {
		return ""
	}
	return user.ID
}

// loadProgressFile returns that viewer's resume map. The first time a signed-in
// user asks, their file is seeded from the shared map so an existing resume
// is not lost. Later watches stay on the account.
func loadProgressFile(user *userRecord) map[string]progressEntry {
	id := accountID(user)
	file := progressFileFor(id)
	if id != "" {
		progressMu.Lock()
		_, err := os.Stat(file)
		progressMu.Unlock()
		if errors.Is(err, os.ErrNotExist) {
			global := map[string]progressEntry{}
			progressMu.Lock()
			global = readProgressMap(progressFileFor(""))
			progressMu.Unlock()
			seeded := map[string]progressEntry{}
			for abs, entry := range global {
				if canSeePath(user, abs) {
					seeded[abs] = entry
				}
			}
			progressMu.Lock()
			if _, err2 := os.Stat(file); errors.Is(err2, os.ErrNotExist) {
				_ = writeProgressMap(file, seeded, 0o600)
			} else {
				seeded = readProgressMap(file)
			}
			progressMu.Unlock()
			return seeded
		}
	}
	progressMu.Lock()
	defer progressMu.Unlock()
	return readProgressMap(file)
}

func visibleProgress(user *userRecord) map[string]progressEntry {
	all := loadProgressFile(user)
	out := map[string]progressEntry{}
	for abs, entry := range all {
		if canSeePath(user, abs) {
			out[abs] = entry
		}
	}
	return out
}

func writeUserProgress(user *userRecord, abs string, entry *progressEntry) error {
	if abs == "" {
		return errors.New("empty path")
	}
	id := accountID(user)
	file := progressFileFor(id)
	progressMu.Lock()
	defer progressMu.Unlock()
	all := readProgressMap(file)
	if entry == nil {
		delete(all, abs)
	} else {
		all[abs] = *entry
	}
	return writeProgressMap(file, all, progressMode(id))
}

func eachProgressFile(fn func(file string)) {
	fn(progressFileFor(""))
	dir := filepath.Join(stateRoot(), "users")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, ent := range entries {
		if !ent.IsDir() || !validUserID(ent.Name()) {
			continue
		}
		fn(progressFileFor(ent.Name()))
	}
}

func moveStoredPath(oldAbs, newAbs string) {
	if oldAbs == "" || newAbs == "" || oldAbs == newAbs {
		return
	}
	progressMu.Lock()
	eachProgressFile(func(file string) {
		all := readProgressMap(file)
		entry, ok := all[oldAbs]
		if !ok {
			return
		}
		delete(all, oldAbs)
		all[newAbs] = entry
		mode := os.FileMode(0o644)
		if strings.Contains(file, string(os.PathSeparator)+"users"+string(os.PathSeparator)) {
			mode = 0o600
		}
		_ = writeProgressMap(file, all, mode)
	})
	progressMu.Unlock()
	dir := filepath.Join(stateRoot(), "users")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, ent := range entries {
		if !ent.IsDir() || !validUserID(ent.Name()) {
			continue
		}
		file := watchLaterFile(ent.Name())
		b, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		var doc watchLaterDoc
		if json.Unmarshal(b, &doc) != nil {
			continue
		}
		changed := false
		for i, path := range doc.Paths {
			if path == oldAbs {
				doc.Paths[i] = newAbs
				changed = true
			}
		}
		if changed {
			_ = writeJSONFile(file, doc, 0o600)
		}
	}
}

func forgetProgressPath(abs string) {
	if abs == "" {
		return
	}
	progressMu.Lock()
	defer progressMu.Unlock()
	eachProgressFile(func(file string) {
		all := readProgressMap(file)
		if _, ok := all[abs]; !ok {
			return
		}
		delete(all, abs)
		mode := os.FileMode(0o644)
		if strings.Contains(file, string(os.PathSeparator)+"users"+string(os.PathSeparator)) {
			mode = 0o600
		}
		_ = writeProgressMap(file, all, mode)
	})
	forgetWatchLaterPath(abs)
}

func forgetProgressUnder(dir string) {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return
	}
	progressMu.Lock()
	defer progressMu.Unlock()
	eachProgressFile(func(file string) {
		all := readProgressMap(file)
		changed := false
		for path := range all {
			if hasPathPrefix(path, dir) {
				delete(all, path)
				changed = true
			}
		}
		if !changed {
			return
		}
		mode := os.FileMode(0o644)
		if strings.Contains(file, string(os.PathSeparator)+"users"+string(os.PathSeparator)) {
			mode = 0o600
		}
		_ = writeProgressMap(file, all, mode)
	})
}

func serveProgress(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	if r.Method == http.MethodGet {
		writeJSON(w, visibleProgress(user))
		return
	}
	var body struct {
		Path  string         `json:"path"`
		Entry *progressEntry `json:"entry"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	full, err := safeVideo(body.Path)
	if err != nil || !canSeePath(user, full) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	abs, _ := filepath.Abs(full)
	if err := writeUserProgress(user, abs, body.Entry); err != nil {
		http.Error(w, "could not save", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

type watchLaterDoc struct {
	Paths []string `json:"paths"`
}

func readWatchLater(user *userRecord) []string {
	file := watchLaterFile(accountID(user))
	if file == "" {
		return []string{}
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return []string{}
	}
	var doc watchLaterDoc
	if json.Unmarshal(b, &doc) != nil || doc.Paths == nil {
		return []string{}
	}
	out := make([]string, 0, len(doc.Paths))
	for _, path := range doc.Paths {
		if canSeePath(user, path) {
			out = append(out, path)
		}
	}
	return out
}

func resolveStatePath(user *userRecord, raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("bad path")
	}
	if filepath.IsAbs(raw) {
		abs, err := filepath.Abs(raw)
		if err != nil || !canSeePath(user, abs) {
			return "", errors.New("not found")
		}
		return abs, nil
	}
	full, err := safeVideo(raw)
	if err != nil || !canSeePath(user, full) {
		return "", errors.New("not found")
	}
	abs, err := filepath.Abs(full)
	if err != nil {
		return "", err
	}
	return abs, nil
}

func serveWatchLater(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	if user == nil {
		writeAPIError(w, http.StatusUnauthorized, "sign in required")
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, watchLaterDoc{Paths: readWatchLater(user)})
		return
	}
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	var body watchLaterDoc
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "bad json")
		return
	}
	seen := map[string]bool{}
	paths := make([]string, 0, len(body.Paths))
	for _, raw := range body.Paths {
		if len(paths) >= 400 {
			break
		}
		abs, err := resolveStatePath(user, raw)
		if err != nil || seen[abs] {
			continue
		}
		seen[abs] = true
		paths = append(paths, abs)
	}
	file := watchLaterFile(user.ID)
	if file == "" {
		writeAPIError(w, http.StatusBadRequest, "could not save")
		return
	}
	if err := writeJSONFile(file, watchLaterDoc{Paths: paths}, 0o600); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "could not save")
		return
	}
	writeJSON(w, watchLaterDoc{Paths: paths})
}

func forgetWatchLaterPath(abs string) {
	dir := filepath.Join(stateRoot(), "users")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, ent := range entries {
		if !ent.IsDir() || !validUserID(ent.Name()) {
			continue
		}
		file := watchLaterFile(ent.Name())
		b, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		var doc watchLaterDoc
		if json.Unmarshal(b, &doc) != nil {
			continue
		}
		kept := doc.Paths[:0]
		changed := false
		for _, path := range doc.Paths {
			if path == abs {
				changed = true
				continue
			}
			kept = append(kept, path)
		}
		if !changed {
			continue
		}
		doc.Paths = kept
		_ = writeJSONFile(file, doc, 0o600)
	}
}

type seenDoc struct {
	At float64 `json:"at"`
}

func serveSeen(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	if user == nil {
		writeAPIError(w, http.StatusUnauthorized, "sign in required")
		return
	}
	file := seenFile(user.ID)
	if file == "" {
		writeAPIError(w, http.StatusBadRequest, "could not save")
		return
	}
	if r.Method == http.MethodGet {
		var doc seenDoc
		if b, err := os.ReadFile(file); err == nil {
			_ = json.Unmarshal(b, &doc)
		}
		writeJSON(w, doc)
		return
	}
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	var doc seenDoc
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&doc); err != nil {
		writeAPIError(w, http.StatusBadRequest, "bad json")
		return
	}
	if doc.At < 0 || doc.At > float64(time.Now().Add(48*time.Hour).Unix()) {
		writeAPIError(w, http.StatusBadRequest, "bad time")
		return
	}
	if err := writeJSONFile(file, doc, 0o600); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "could not save")
		return
	}
	writeJSON(w, doc)
}

func writeJSONFile(file string, payload any, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, b, mode); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

func removeUserState(id string) {
	dir, ok := userStateDir(id)
	if !ok {
		return
	}
	_ = os.RemoveAll(dir)
}
