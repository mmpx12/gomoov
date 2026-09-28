package main

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func withAuth(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	oldConfig, oldUpload, oldRoot, oldIter := configDir, uploadRoot, root, pbkdf2Iter
	oldPlayer := videoPlayer
	videoPlayer = false
	t.Cleanup(func() {
		configDir, uploadRoot, root, pbkdf2Iter = oldConfig, oldUpload, oldRoot, oldIter
		videoPlayer = oldPlayer
		authMu.Lock()
		users = nil
		sessions = nil
		visibility = nil
		authMu.Unlock()
		invalidateLibrary()
	})
	pbkdf2Iter = 1000
	configDir = filepath.Join(dir, "cfg")
	uploadRoot = filepath.Join(dir, "up")
	root = filepath.Join(dir, "lib")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := loadAuth(); err != nil {
		t.Fatal(err)
	}
}

func postJSON(path string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
	return sendJSON(http.MethodPost, path, body, cookie)
}

func sendJSON(method, path string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	handle(rec, req)
	return rec
}

func cookieOf(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == sessionCookie && cookie.Value != "" {
			return cookie
		}
	}
	t.Fatalf("no session cookie, status %d body %s", rec.Code, rec.Body.String())
	return nil
}

func TestAuthPrivacyAndPasswords(t *testing.T) {
	withAuth(t)
	admin := cookieOf(t, postJSON("/api/login", map[string]string{"username": "admin", "password": "admin"}, nil))
	if rec := postJSON("/api/login", map[string]string{"username": "admin", "password": "nope"}, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("bad password status %d", rec.Code)
	}

	created := postJSON("/api/users", map[string]any{
		"username": "ada", "password": "secret", "canUpload": true, "mustChangePassword": false,
	}, admin)
	if created.Code != http.StatusOK {
		t.Fatalf("create user %d %s", created.Code, created.Body.String())
	}
	var createdBody struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &createdBody); err != nil {
		t.Fatal(err)
	}
	ada := cookieOf(t, postJSON("/api/login", map[string]string{"username": "ada", "password": "secret"}, nil))

	forced := postJSON("/api/users", map[string]any{
		"username": "bee", "password": "temp1", "canUpload": true, "mustChangePassword": true,
	}, admin)
	if forced.Code != http.StatusOK {
		t.Fatalf("create bee %d %s", forced.Code, forced.Body.String())
	}
	bee := cookieOf(t, postJSON("/api/login", map[string]string{"username": "bee", "password": "temp1"}, nil))
	lib := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/library", nil)
	req.AddCookie(bee)
	handle(lib, req)
	if lib.Code != http.StatusForbidden {
		t.Fatalf("forced password still reached library: %d", lib.Code)
	}
	changed := postJSON("/api/password", map[string]string{"current": "temp1", "next": "longterm"}, bee)
	if changed.Code != http.StatusOK {
		t.Fatalf("change password %d %s", changed.Code, changed.Body.String())
	}
	lib = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/library", nil)
	req.AddCookie(bee)
	handle(lib, req)
	if lib.Code != http.StatusOK {
		t.Fatalf("library after password change %d %s", lib.Code, lib.Body.String())
	}

	noUpload := postJSON("/api/users", map[string]any{
		"username": "cy", "password": "secret", "canUpload": false,
	}, admin)
	if noUpload.Code != http.StatusOK {
		t.Fatal(noUpload.Body.String())
	}
	cy := cookieOf(t, postJSON("/api/login", map[string]string{"username": "cy", "password": "secret"}, nil))
	if rec := uploadFile(t, cy, "nope.mkv", "1"); rec.Code != http.StatusForbidden {
		t.Fatalf("upload without permission %d %s", rec.Code, rec.Body.String())
	}

	up := uploadFile(t, ada, "clip.mkv", "1")
	if up.Code != http.StatusOK {
		t.Fatalf("upload %d %s", up.Code, up.Body.String())
	}
	var upBody struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(up.Body.Bytes(), &upBody); err != nil {
		t.Fatal(err)
	}
	full, err := safeVideo(upBody.Path)
	if err != nil {
		t.Fatal(err)
	}
	wantDir := filepath.Join(uploadRoot, createdBody.User.ID)
	if !hasPathPrefix(full, wantDir) {
		t.Fatalf("upload %s not under %s", full, wantDir)
	}
	adaUser, _ := findUser("ada")
	beeUser, _ := findUser("bee")
	adminUser, _ := findUser("admin")
	if canSeePath(nil, full) {
		t.Fatal("anonymous saw a private upload")
	}
	if canSeePath(&beeUser, full) {
		t.Fatal("another user saw a private upload")
	}
	if !canSeePath(&adaUser, full) || !canSeePath(&adminUser, full) {
		t.Fatal("owner or admin could not see the private upload")
	}
	pub := postJSON("/api/video/visibility", map[string]any{"path": upBody.Path, "private": false}, ada)
	if pub.Code != http.StatusOK {
		t.Fatalf("make public %d %s", pub.Code, pub.Body.String())
	}
	if !canSeePath(nil, full) {
		t.Fatal("anonymous could not see a public upload")
	}

	libraryFile := filepath.Join(root, "library.mkv")
	if err := os.WriteFile(libraryFile, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !canSeePath(nil, libraryFile) {
		t.Fatal("anonymous could not see a library video")
	}
	kept := postJSON("/api/video/visibility", map[string]any{"path": "library.mkv", "private": true}, ada)
	if kept.Code != http.StatusBadRequest {
		t.Fatalf("library privacy status %d", kept.Code)
	}
	del := httptest.NewRecorder()
	dreq := httptest.NewRequest(http.MethodDelete, "/api/video?path=library.mkv", nil)
	handle(del, dreq)
	if del.Code != http.StatusForbidden {
		t.Fatalf("anonymous delete %d", del.Code)
	}
	dreq = httptest.NewRequest(http.MethodDelete, "/api/video?path=library.mkv", nil)
	dreq.AddCookie(admin)
	del = httptest.NewRecorder()
	handle(del, dreq)
	if del.Code != http.StatusOK {
		t.Fatalf("admin delete %d %s", del.Code, del.Body.String())
	}

	reset := postJSON("/api/password-reset", map[string]string{"username": "ada"}, nil)
	if reset.Code != http.StatusOK {
		t.Fatal(reset.Body.String())
	}
	adaUser, _ = findUser("ada")
	if !adaUser.ResetRequested {
		t.Fatal("reset request was not recorded")
	}
	missing := postJSON("/api/password-reset", map[string]string{"username": "nobody"}, nil)
	if missing.Code != http.StatusOK {
		t.Fatal("unknown user reset should still succeed")
	}
	updated := sendJSON(http.MethodPut, "/api/users", map[string]any{
		"id": adaUser.ID, "password": "fresh1", "mustChangePassword": true,
	}, admin)
	if updated.Code != http.StatusOK {
		t.Fatalf("admin set password %d %s", updated.Code, updated.Body.String())
	}
	adaUser, _ = findUser("ada")
	if adaUser.ResetRequested || !adaUser.MustChangePassword {
		t.Fatalf("reset flag %v force %v", adaUser.ResetRequested, adaUser.MustChangePassword)
	}
	if _, err := safeVideo("user/" + adaUser.ID + "/../../library.mkv"); err == nil {
		t.Fatal("upload path escaped the user directory")
	}
}

func TestVideoPlayerHidesPrivateUnlessAsked(t *testing.T) {
	lib := t.TempDir()
	ups := t.TempDir()
	oldRoot, oldUpload := root, uploadRoot
	oldPlayer, oldShow := videoPlayer, showPrivate
	t.Cleanup(func() {
		root, uploadRoot = oldRoot, oldUpload
		videoPlayer, showPrivate = oldPlayer, oldShow
		includeDirs, excludeDirs = nil, nil
	})
	root = lib
	uploadRoot = ups
	includeDirs, excludeDirs = nil, nil
	pub := filepath.Join(lib, "pub.mkv")
	if err := os.WriteFile(pub, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	id := "22222222-2222-4222-8222-222222222222"
	mine := filepath.Join(ups, id, "mine.mkv")
	if err := os.MkdirAll(filepath.Dir(mine), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mine, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	owner := &userRecord{ID: id}
	admin := &userRecord{Admin: true}
	videoPlayer = true
	showPrivate = false
	if !canSeePath(nil, pub) {
		t.Fatal("public video hidden in player mode")
	}
	if canSeePath(owner, mine) || canSeePath(admin, mine) || canSeePath(nil, mine) {
		t.Fatal("private video visible in player mode")
	}
	showPrivate = true
	if !canSeePath(nil, mine) {
		t.Fatal("show-private did not reveal the upload")
	}
	videoPlayer = false
	showPrivate = true
	if canSeePath(nil, mine) {
		t.Fatal("show-private revealed a private video outside player mode")
	}
	if !canSeePath(owner, mine) || !canSeePath(admin, mine) {
		t.Fatal("owner or admin lost a private video in normal mode")
	}
}

func TestBanAndDeleteUser(t *testing.T) {
	withAuth(t)
	admin := cookieOf(t, postJSON("/api/login", map[string]string{"username": "admin", "password": "admin"}, nil))
	created := postJSON("/api/users", map[string]any{
		"username": "ada", "password": "secret", "canUpload": true,
	}, admin)
	if created.Code != http.StatusOK {
		t.Fatal(created.Body.String())
	}
	var createdBody struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &createdBody); err != nil {
		t.Fatal(err)
	}
	id := createdBody.User.ID
	ada := cookieOf(t, postJSON("/api/login", map[string]string{"username": "ada", "password": "secret"}, nil))
	if up := uploadFile(t, ada, "clip.mkv", "1"); up.Code != http.StatusOK {
		t.Fatal(up.Body.String())
	}
	dir := filepath.Join(uploadRoot, id)
	if _, err := os.Stat(dir); err != nil {
		t.Fatal(err)
	}
	banned := sendJSON(http.MethodPut, "/api/users", map[string]any{"id": id, "banned": true}, admin)
	if banned.Code != http.StatusOK {
		t.Fatalf("ban %d %s", banned.Code, banned.Body.String())
	}
	if rec := postJSON("/api/login", map[string]string{"username": "ada", "password": "secret"}, nil); rec.Code != http.StatusForbidden {
		t.Fatalf("banned login %d %s", rec.Code, rec.Body.String())
	}
	me := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	req.AddCookie(ada)
	handle(me, req)
	if !bytes.Contains(me.Body.Bytes(), []byte(`"user":null`)) {
		t.Fatalf("banned session still active: %s", me.Body.String())
	}
	detail := httptest.NewRecorder()
	dreq := httptest.NewRequest(http.MethodGet, "/api/users?id="+id, nil)
	dreq.AddCookie(admin)
	handle(detail, dreq)
	if detail.Code != http.StatusOK || !bytes.Contains(detail.Body.Bytes(), []byte(`"banned":true`)) || !bytes.Contains(detail.Body.Bytes(), []byte(`"videos"`)) {
		t.Fatalf("detail %d %s", detail.Code, detail.Body.String())
	}
	adminUser, _ := findUser("admin")
	if rec := sendJSON(http.MethodPut, "/api/users", map[string]any{"id": adminUser.ID, "banned": true}, admin); rec.Code != http.StatusBadRequest {
		t.Fatalf("ban admin %d %s", rec.Code, rec.Body.String())
	}
	adminDel := httptest.NewRecorder()
	adminDelReq := httptest.NewRequest(http.MethodDelete, "/api/users?id="+adminUser.ID, nil)
	adminDelReq.AddCookie(admin)
	handle(adminDel, adminDelReq)
	if adminDel.Code != http.StatusBadRequest {
		t.Fatalf("delete admin %d %s", adminDel.Code, adminDel.Body.String())
	}
	deleted := httptest.NewRecorder()
	del := httptest.NewRequest(http.MethodDelete, "/api/users?id="+id, nil)
	del.AddCookie(admin)
	handle(deleted, del)
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete %d %s", deleted.Code, deleted.Body.String())
	}
	if _, ok := findUser("ada"); ok {
		t.Fatal("deleted user still exists")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("upload directory still present: %v", err)
	}
}

func uploadFile(t *testing.T, cookie *http.Cookie, name, private string) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("video-bytes")); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("private", private); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/upload", &buf)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	handle(rec, req)
	return rec
}
