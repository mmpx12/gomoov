package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	sessionCookie = "gomoov_session"
	sessionDays   = 30
	minPassword   = 4
	pbkdf2Default = 210000
)

// pbkdf2Iter is the iteration count used when hashing a new password.
// Stored hashes keep the count they were created with.
var pbkdf2Iter = pbkdf2Default

var (
	configDir  string
	uploadRoot string

	authMu     sync.Mutex
	users      []userRecord
	sessions   map[string]sessionRecord
	visibility map[string]visRecord
)

type userRecord struct {
	ID                 string `json:"id"`
	Username           string `json:"username"`
	PassHash           string `json:"passHash"`
	PassSalt           string `json:"passSalt"`
	PassIter           int    `json:"passIter"`
	Admin              bool   `json:"admin"`
	CanUpload          bool   `json:"canUpload"`
	MustChangePassword bool   `json:"mustChangePassword"`
	ResetRequested     bool   `json:"resetRequested"`
	Banned             bool   `json:"banned"`
}

type sessionRecord struct {
	UserID  string    `json:"userId"`
	Expires time.Time `json:"expires"`
}

type visRecord struct {
	OwnerID string `json:"ownerId"`
	Private bool   `json:"private"`
}

type videoMeta struct {
	OwnerID string
	Private bool
}

func initAuthPaths() error {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return errors.New("cannot find the home directory")
	}
	configDir = filepath.Join(home, ".gomoov")
	uploadRoot = filepath.Join(home, "gomoov")
	return loadAuth()
}

func loadAuth() error {
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(uploadRoot, 0o700); err != nil {
		return err
	}
	authMu.Lock()
	defer authMu.Unlock()
	users = nil
	sessions = map[string]sessionRecord{}
	visibility = map[string]visRecord{}
	usersPath := filepath.Join(configDir, "users.json")
	if b, err := os.ReadFile(usersPath); err == nil {
		if err := json.Unmarshal(b, &users); err != nil {
			return fmt.Errorf("users.json: %w", err)
		}
		if len(users) == 0 {
			return errors.New("users.json has no accounts")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if b, err := os.ReadFile(filepath.Join(configDir, "sessions.json")); err == nil {
		_ = json.Unmarshal(b, &sessions)
	}
	if sessions == nil {
		sessions = map[string]sessionRecord{}
	}
	if b, err := os.ReadFile(filepath.Join(configDir, "visibility.json")); err == nil {
		_ = json.Unmarshal(b, &visibility)
	}
	if visibility == nil {
		visibility = map[string]visRecord{}
	}
	now := time.Now()
	for token, sess := range sessions {
		if sess.UserID == "" || !now.Before(sess.Expires) {
			delete(sessions, token)
		}
	}
	if len(users) == 0 {
		salt, hash, iter, err := hashPassword("admin")
		if err != nil {
			return err
		}
		id, err := newID()
		if err != nil {
			return err
		}
		users = []userRecord{{
			ID:        id,
			Username:  "admin",
			PassHash:  hash,
			PassSalt:  salt,
			PassIter:  iter,
			Admin:     true,
			CanUpload: true,
		}}
		if err := saveUsersLocked(); err != nil {
			return err
		}
		log.Printf("created default admin account admin / admin")
	}
	for _, u := range users {
		_ = os.MkdirAll(filepath.Join(uploadRoot, u.ID), 0o700)
	}
	return saveSessionsLocked()
}

func hashPassword(password string) (saltHex, hashHex string, iter int, err error) {
	salt := make([]byte, 16)
	if _, err = rand.Read(salt); err != nil {
		return "", "", 0, err
	}
	iter = pbkdf2Iter
	if iter < 1 {
		iter = pbkdf2Default
	}
	sum := pbkdf2Key([]byte(password), salt, iter, 32)
	return hex.EncodeToString(salt), hex.EncodeToString(sum), iter, nil
}

func verifyPassword(password, saltHex, hashHex string, iter int) bool {
	salt, err1 := hex.DecodeString(saltHex)
	want, err2 := hex.DecodeString(hashHex)
	if err1 != nil || err2 != nil || len(want) == 0 || iter < 1 {
		return false
	}
	got := pbkdf2Key([]byte(password), salt, iter, len(want))
	return subtle.ConstantTimeCompare(got, want) == 1
}

func pbkdf2Key(password, salt []byte, iter, keyLen int) []byte {
	hLen := sha256.Size
	numBlocks := (keyLen + hLen - 1) / hLen
	out := make([]byte, 0, numBlocks*hLen)
	for block := 1; block <= numBlocks; block++ {
		mac := hmac.New(sha256.New, password)
		_, _ = mac.Write(salt)
		_, _ = mac.Write([]byte{byte(block >> 24), byte(block >> 16), byte(block >> 8), byte(block)})
		u := mac.Sum(nil)
		t := append([]byte(nil), u...)
		for i := 1; i < iter; i++ {
			mac.Reset()
			_, _ = mac.Write(u)
			u = mac.Sum(nil)
			for j := range t {
				t[j] ^= u[j]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}

func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b[:])
	return s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:32], nil
}

func validUserID(id string) bool {
	if len(id) < 8 || len(id) > 80 {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-':
		default:
			return false
		}
	}
	return true
}

func validUsername(name string) bool {
	if name != strings.TrimSpace(name) || utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 32 {
		return false
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-', r == '.':
		default:
			return false
		}
	}
	return true
}

func saveUsersLocked() error {
	return writeSecret(filepath.Join(configDir, "users.json"), users)
}

func saveSessionsLocked() error {
	return writeSecret(filepath.Join(configDir, "sessions.json"), sessions)
}

func saveVisibilityLocked() error {
	return writeSecret(filepath.Join(configDir, "visibility.json"), visibility)
}

func writeSecret(path string, payload any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func findUser(name string) (userRecord, bool) {
	authMu.Lock()
	defer authMu.Unlock()
	for _, u := range users {
		if strings.EqualFold(u.Username, strings.TrimSpace(name)) {
			return u, true
		}
	}
	return userRecord{}, false
}

func userByID(id string) (userRecord, bool) {
	authMu.Lock()
	defer authMu.Unlock()
	return userByIDLocked(id)
}

func userByIDLocked(id string) (userRecord, bool) {
	for _, u := range users {
		if u.ID == id {
			return u, true
		}
	}
	return userRecord{}, false
}

func usernameByID() map[string]string {
	authMu.Lock()
	defer authMu.Unlock()
	out := make(map[string]string, len(users))
	for _, u := range users {
		out[u.ID] = u.Username
	}
	return out
}

func resetCount() int {
	authMu.Lock()
	defer authMu.Unlock()
	n := 0
	for _, u := range users {
		if u.ResetRequested {
			n++
		}
	}
	return n
}

func currentUser(r *http.Request) *userRecord {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil || cookie.Value == "" {
		return nil
	}
	authMu.Lock()
	defer authMu.Unlock()
	sess, ok := sessions[cookie.Value]
	if !ok || !time.Now().Before(sess.Expires) {
		delete(sessions, cookie.Value)
		return nil
	}
	u, ok := userByIDLocked(sess.UserID)
	if !ok || u.Banned {
		delete(sessions, cookie.Value)
		_ = saveSessionsLocked()
		return nil
	}
	cp := u
	return &cp
}

func startSession(w http.ResponseWriter, userID string) error {
	tokenRaw := make([]byte, 32)
	if _, err := rand.Read(tokenRaw); err != nil {
		return err
	}
	token := hex.EncodeToString(tokenRaw)
	expires := time.Now().Add(sessionDays * 24 * time.Hour)
	authMu.Lock()
	sessions[token] = sessionRecord{UserID: userID, Expires: expires}
	err := saveSessionsLocked()
	authMu.Unlock()
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		MaxAge:   sessionDays * 24 * 3600,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	return nil
}

func clearSession(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookie); err == nil && cookie.Value != "" {
		authMu.Lock()
		delete(sessions, cookie.Value)
		_ = saveSessionsLocked()
		authMu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

func publicUser(u userRecord, adminView bool) map[string]any {
	out := map[string]any{
		"id":                 u.ID,
		"username":           u.Username,
		"admin":              u.Admin,
		"canUpload":          u.CanUpload,
		"mustChangePassword": u.MustChangePassword,
	}
	if adminView {
		out["resetRequested"] = u.ResetRequested
		out["banned"] = u.Banned
	}
	return out
}

func mePayload(u *userRecord) map[string]any {
	out := map[string]any{"user": nil, "videoPlayer": videoPlayer}
	if u == nil {
		return out
	}
	pub := publicUser(*u, false)
	if u.Admin {
		pub["resetCount"] = resetCount()
	}
	out["user"] = pub
	return out
}

func readJSON(w http.ResponseWriter, r *http.Request, dest any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(dest); err != nil {
		writeAPIError(w, http.StatusBadRequest, "bad json")
		return false
	}
	return true
}

func writeAPIError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func passwordChangeExempt(r *http.Request) bool {
	switch r.URL.Path {
	case "/api/login", "/api/logout", "/api/me", "/api/password", "/api/password-reset", "/", "/index.html", "/app.js", "/styles.css":
		return true
	}
	return false
}

func requireAdmin(w http.ResponseWriter, r *http.Request) *userRecord {
	u := currentUser(r)
	if u == nil {
		writeAPIError(w, http.StatusUnauthorized, "sign in required")
		return nil
	}
	if !u.Admin {
		writeAPIError(w, http.StatusForbidden, "admin only")
		return nil
	}
	return u
}

func serveLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	u, ok := findUser(body.Username)
	if !ok || !verifyPassword(body.Password, u.PassSalt, u.PassHash, u.PassIter) {
		writeAPIError(w, http.StatusUnauthorized, "Wrong username or password.")
		return
	}
	if u.Banned {
		writeAPIError(w, http.StatusForbidden, "This account is banned.")
		return
	}
	if err := startSession(w, u.ID); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "could not sign in")
		return
	}
	log.Printf("%s signed in %s", clientIP(r), u.Username)
	writeJSON(w, mePayload(&u))
}

func serveLogout(w http.ResponseWriter, r *http.Request) {
	clearSession(w, r)
	writeJSON(w, map[string]bool{"ok": true})
}

func serveMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, mePayload(currentUser(r)))
}

func servePassword(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	if u == nil {
		writeAPIError(w, http.StatusUnauthorized, "sign in required")
		return
	}
	var body struct {
		Current string `json:"current"`
		Next    string `json:"next"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if utf8.RuneCountInString(body.Next) < minPassword {
		writeAPIError(w, http.StatusBadRequest, "Password must be at least 4 characters.")
		return
	}
	if !verifyPassword(body.Current, u.PassSalt, u.PassHash, u.PassIter) {
		writeAPIError(w, http.StatusUnauthorized, "Current password is wrong.")
		return
	}
	salt, hash, iter, err := hashPassword(body.Next)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "could not save password")
		return
	}
	authMu.Lock()
	defer authMu.Unlock()
	for i := range users {
		if users[i].ID != u.ID {
			continue
		}
		users[i].PassSalt = salt
		users[i].PassHash = hash
		users[i].PassIter = iter
		users[i].MustChangePassword = false
		u.MustChangePassword = false
		break
	}
	if err := saveUsersLocked(); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "could not save password")
		return
	}
	writeJSON(w, mePayload(u))
}

func serveResetRequest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	name := strings.TrimSpace(body.Username)
	authMu.Lock()
	changed := false
	for i := range users {
		if strings.EqualFold(users[i].Username, name) {
			if !users[i].ResetRequested {
				users[i].ResetRequested = true
				changed = true
			}
			log.Printf("password reset requested for %s", users[i].Username)
			break
		}
	}
	if changed {
		if err := saveUsersLocked(); err != nil {
			authMu.Unlock()
			writeAPIError(w, http.StatusInternalServerError, "could not save the request")
			return
		}
	}
	authMu.Unlock()
	writeJSON(w, map[string]any{"ok": true, "message": "If that account exists, the admin was notified."})
}

func serveUserList(w http.ResponseWriter, r *http.Request) {
	if requireAdmin(w, r) == nil {
		return
	}
	authMu.Lock()
	list := make([]map[string]any, 0, len(users))
	for _, u := range users {
		list = append(list, publicUser(u, true))
	}
	authMu.Unlock()
	writeJSON(w, map[string]any{"users": list})
}

func serveUserCreate(w http.ResponseWriter, r *http.Request) {
	if requireAdmin(w, r) == nil {
		return
	}
	var body struct {
		Username           string `json:"username"`
		Password           string `json:"password"`
		CanUpload          bool   `json:"canUpload"`
		MustChangePassword bool   `json:"mustChangePassword"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	body.Username = strings.TrimSpace(body.Username)
	if !validUsername(body.Username) {
		writeAPIError(w, http.StatusBadRequest, "Username must be 1–32 letters, numbers, dots, dashes, or underscores.")
		return
	}
	if utf8.RuneCountInString(body.Password) < minPassword {
		writeAPIError(w, http.StatusBadRequest, "Password must be at least 4 characters.")
		return
	}
	if _, ok := findUser(body.Username); ok {
		writeAPIError(w, http.StatusConflict, "That username is already used.")
		return
	}
	salt, hash, iter, err := hashPassword(body.Password)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "could not add user")
		return
	}
	id, err := newID()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "could not add user")
		return
	}
	rec := userRecord{
		ID:                 id,
		Username:           body.Username,
		PassHash:           hash,
		PassSalt:           salt,
		PassIter:           iter,
		CanUpload:          body.CanUpload,
		MustChangePassword: body.MustChangePassword,
	}
	if err := os.MkdirAll(filepath.Join(uploadRoot, id), 0o700); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "could not add user")
		return
	}
	authMu.Lock()
	users = append(users, rec)
	err = saveUsersLocked()
	authMu.Unlock()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "could not add user")
		return
	}
	log.Printf("%s added user %s upload=%v forceChange=%v", clientIP(r), rec.Username, rec.CanUpload, rec.MustChangePassword)
	writeJSON(w, map[string]any{"user": publicUser(rec, true)})
}

func serveUserUpdate(w http.ResponseWriter, r *http.Request) {
	if requireAdmin(w, r) == nil {
		return
	}
	var body struct {
		ID                 string  `json:"id"`
		Password           *string `json:"password"`
		CanUpload          *bool   `json:"canUpload"`
		MustChangePassword *bool   `json:"mustChangePassword"`
		Banned             *bool   `json:"banned"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.ID) == "" {
		writeAPIError(w, http.StatusBadRequest, "missing user")
		return
	}
	var salt, hash string
	var iter int
	if body.Password != nil {
		if utf8.RuneCountInString(*body.Password) < minPassword {
			writeAPIError(w, http.StatusBadRequest, "Password must be at least 4 characters.")
			return
		}
		var err error
		salt, hash, iter, err = hashPassword(*body.Password)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "could not save user")
			return
		}
	}
	authMu.Lock()
	defer authMu.Unlock()
	for i := range users {
		if users[i].ID != body.ID {
			continue
		}
		if body.Password != nil {
			users[i].PassSalt = salt
			users[i].PassHash = hash
			users[i].PassIter = iter
			users[i].ResetRequested = false
		}
		if body.CanUpload != nil && !users[i].Admin {
			users[i].CanUpload = *body.CanUpload
		}
		if body.MustChangePassword != nil {
			users[i].MustChangePassword = *body.MustChangePassword
		}
		if body.Banned != nil {
			if users[i].Admin {
				writeAPIError(w, http.StatusBadRequest, "The admin account cannot be banned.")
				return
			}
			users[i].Banned = *body.Banned
			if users[i].Banned {
				dropSessionsLocked(users[i].ID)
			}
		}
		if err := saveUsersLocked(); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "could not save user")
			return
		}
		if users[i].Banned {
			_ = saveSessionsLocked()
		}
		log.Printf("%s updated user %s banned=%v", clientIP(r), users[i].Username, users[i].Banned)
		writeJSON(w, map[string]any{"user": publicUser(users[i], true)})
		return
	}
	writeAPIError(w, http.StatusNotFound, "user not found")
}

func serveUserDetail(w http.ResponseWriter, r *http.Request, id string) {
	if requireAdmin(w, r) == nil {
		return
	}
	u, ok := userByID(id)
	if !ok {
		writeAPIError(w, http.StatusNotFound, "user not found")
		return
	}
	writeJSON(w, map[string]any{
		"user":   publicUser(u, true),
		"videos": videosOf(u.ID),
	})
}

func videosOf(owner string) []videoInfo {
	all := presentLibrary(&userRecord{Admin: true})
	out := make([]videoInfo, 0)
	for _, v := range all {
		if v.OwnerID == owner {
			out = append(out, v)
		}
	}
	return out
}

func serveUserDelete(w http.ResponseWriter, r *http.Request) {
	admin := requireAdmin(w, r)
	if admin == nil {
		return
	}
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	u, ok := userByID(id)
	if !ok {
		writeAPIError(w, http.StatusNotFound, "user not found")
		return
	}
	if u.Admin || u.ID == admin.ID {
		writeAPIError(w, http.StatusBadRequest, "The admin account cannot be deleted.")
		return
	}
	authMu.Lock()
	kept := users[:0]
	for _, item := range users {
		if item.ID != u.ID {
			kept = append(kept, item)
		}
	}
	users = kept
	dropSessionsLocked(u.ID)
	err := saveUsersLocked()
	if err == nil {
		err = saveSessionsLocked()
	}
	authMu.Unlock()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "could not delete user")
		return
	}
	removeUserFiles(u.ID)
	invalidateLibrary()
	log.Printf("%s deleted user %s", clientIP(r), u.Username)
	writeJSON(w, map[string]bool{"ok": true})
}

func dropSessionsLocked(userID string) {
	for token, sess := range sessions {
		if sess.UserID == userID {
			delete(sessions, token)
		}
	}
}

func removeUserFiles(id string) {
	if !validUserID(id) || uploadRoot == "" {
		return
	}
	dir, err := filepath.Abs(filepath.Join(uploadRoot, id))
	if err != nil {
		return
	}
	up, err := filepath.Abs(uploadRoot)
	if err != nil || !hasPathPrefix(dir, up) || dir == up {
		return
	}
	_ = os.RemoveAll(dir)
	authMu.Lock()
	for path := range visibility {
		if hasPathPrefix(path, dir) {
			delete(visibility, path)
		}
	}
	_ = saveVisibilityLocked()
	authMu.Unlock()
	forgetProgressUnder(dir)
}

func serveUpload(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	if u == nil {
		writeAPIError(w, http.StatusUnauthorized, "sign in required")
		return
	}
	if !u.CanUpload {
		writeAPIError(w, http.StatusForbidden, "upload is not enabled for this account")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<30)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeAPIError(w, http.StatusBadRequest, "could not read the upload")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "choose a video file")
		return
	}
	defer file.Close()
	name, err := safeUploadName(header.Filename)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, err.Error())
		return
	}
	dir := filepath.Join(uploadRoot, u.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "could not store the video")
		return
	}
	dest, err := exclusiveVideoPath(dir, name)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "could not store the video")
		return
	}
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "could not store the video")
		return
	}
	written, copyErr := io.Copy(out, file)
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil || written == 0 {
		_ = os.Remove(dest)
		writeAPIError(w, http.StatusBadRequest, "could not store the video")
		return
	}
	abs, _ := filepath.Abs(dest)
	private := r.FormValue("private") == "1" || strings.EqualFold(r.FormValue("private"), "true")
	authMu.Lock()
	visibility[abs] = visRecord{OwnerID: u.ID, Private: private}
	err = saveVisibilityLocked()
	authMu.Unlock()
	if err != nil {
		_ = os.Remove(dest)
		writeAPIError(w, http.StatusInternalServerError, "could not store the video")
		return
	}
	invalidateLibrary()
	log.Printf("%s uploaded %s private=%v", clientIP(r), relOf(abs), private)
	writeJSON(w, map[string]any{"ok": true, "path": relOf(abs), "private": private})
}

func safeUploadName(name string) (string, error) {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.TrimSpace(name)
	if name == "" || name == "." || strings.HasPrefix(name, ".") || strings.Contains(name, "..") {
		return "", errors.New("choose a video file")
	}
	ext := strings.ToLower(filepath.Ext(name))
	if !videoExt[ext] {
		return "", errors.New("upload a video file (mkv, mp4, webm, m4v, mov, or avi)")
	}
	cleaned := strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"|?*`, r) {
			return '_'
		}
		return r
	}, name)
	if len(cleaned) > 180 {
		stem := strings.TrimSuffix(cleaned, ext)
		if len(stem) > 180-len(ext) {
			stem = stem[:180-len(ext)]
		}
		cleaned = stem + ext
	}
	return cleaned, nil
}

func exclusiveVideoPath(dir, name string) (string, error) {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for n := 0; n < 1000; n++ {
		candidate := name
		if n > 0 {
			candidate = stem + " (" + itoa(n+1) + ")" + ext
		}
		full := filepath.Join(dir, candidate)
		_, err := os.Stat(full)
		if errors.Is(err, os.ErrNotExist) {
			return full, nil
		}
		if err != nil {
			return "", err
		}
	}
	return "", errors.New("could not choose a file name")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [16]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func serveVisibility(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	if u == nil {
		writeAPIError(w, http.StatusUnauthorized, "sign in required")
		return
	}
	var body struct {
		Path    string `json:"path"`
		Private bool   `json:"private"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	full, err := safeVideo(body.Path)
	if err != nil || !canSeePath(u, full) {
		writeAPIError(w, http.StatusNotFound, "not found")
		return
	}
	abs, _ := filepath.Abs(full)
	owner, ok := uploadOwner(abs)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "library videos stay public")
		return
	}
	if !u.Admin && u.ID != owner {
		writeAPIError(w, http.StatusForbidden, "you cannot change this video")
		return
	}
	authMu.Lock()
	visibility[abs] = visRecord{OwnerID: owner, Private: body.Private}
	err = saveVisibilityLocked()
	authMu.Unlock()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "could not save")
		return
	}
	writeJSON(w, map[string]any{"ok": true, "private": body.Private})
}

func forgetVideo(abs string) {
	abs, err := filepath.Abs(abs)
	if err != nil {
		return
	}
	authMu.Lock()
	delete(visibility, abs)
	_ = saveVisibilityLocked()
	authMu.Unlock()
}

func isUnderUpload(abs string) bool {
	_, ok := uploadOwner(abs)
	return ok
}

func uploadOwner(abs string) (string, bool) {
	if uploadRoot == "" {
		return "", false
	}
	up, err := filepath.Abs(uploadRoot)
	if err != nil || !hasPathPrefix(abs, up) || abs == up {
		return "", false
	}
	rel, err := filepath.Rel(up, abs)
	if err != nil {
		return "", false
	}
	id := rel
	if i := strings.IndexAny(rel, `/\`); i >= 0 {
		id = rel[:i]
	}
	if !validUserID(id) {
		return "", false
	}
	return id, true
}

func metaFor(abs string) videoMeta {
	abs, err := filepath.Abs(abs)
	if err != nil {
		return videoMeta{}
	}
	owner, ok := uploadOwner(abs)
	if !ok {
		return videoMeta{}
	}
	authMu.Lock()
	rec, found := visibility[abs]
	authMu.Unlock()
	private := true
	if found {
		private = rec.Private
		if rec.OwnerID != "" {
			owner = rec.OwnerID
		}
	}
	return videoMeta{OwnerID: owner, Private: private}
}

func canSeeMeta(user *userRecord, meta videoMeta) bool {
	if !meta.Private {
		return true
	}
	if videoPlayer {
		return showPrivate
	}
	if user == nil {
		return false
	}
	return user.Admin || user.ID == meta.OwnerID
}

func canSeePath(user *userRecord, abs string) bool {
	abs, err := filepath.Abs(abs)
	if err != nil {
		return false
	}
	st, err := os.Stat(abs)
	if err != nil || st.IsDir() || !videoExt[strings.ToLower(filepath.Ext(abs))] {
		return false
	}
	if isUnderUpload(abs) {
		return canSeeMeta(user, metaFor(abs))
	}
	return libraryFile(abs)
}

func canRemove(user *userRecord, abs string) bool {
	if user == nil {
		return false
	}
	if user.Admin {
		return true
	}
	meta := metaFor(abs)
	return meta.OwnerID != "" && meta.OwnerID == user.ID
}

func visiblePath(w http.ResponseWriter, r *http.Request, raw string) (string, bool) {
	path, err := safeVideo(raw)
	if err != nil || !canSeePath(currentUser(r), path) {
		http.Error(w, "not found", http.StatusNotFound)
		return "", false
	}
	return path, true
}

func presentLibrary(user *userRecord) []videoInfo {
	all := getLibrary()
	names := usernameByID()
	out := make([]videoInfo, 0, len(all))
	for _, v := range all {
		abs := v.AbsPath
		if abs == "" {
			if full, err := safeVideo(v.Path); err == nil {
				abs = full
				v.AbsPath = full
			}
		}
		meta := metaFor(abs)
		if isUnderUpload(abs) {
			if !canSeeMeta(user, meta) {
				continue
			}
			v.OwnerID = meta.OwnerID
			v.OwnerName = names[meta.OwnerID]
			v.Private = meta.Private
		}
		v.Mine = user != nil && v.OwnerID != "" && user.ID == v.OwnerID
		v.CanRemove = canRemove(user, abs)
		out = append(out, v)
	}
	return out
}

func listUploadVideos() []string {
	if uploadRoot == "" {
		return nil
	}
	up, err := filepath.Abs(uploadRoot)
	if err != nil {
		return nil
	}
	entries, err := os.ReadDir(up)
	if err != nil {
		return nil
	}
	var found []string
	for _, ent := range entries {
		if !ent.IsDir() || !validUserID(ent.Name()) {
			continue
		}
		dir := filepath.Join(up, ent.Name())
		_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if err != nil || path == dir {
				return nil
			}
			name := d.Name()
			if d.IsDir() {
				if strings.HasPrefix(name, ".") {
					return filepath.SkipDir
				}
				return nil
			}
			if strings.HasPrefix(name, ".") || !videoExt[strings.ToLower(filepath.Ext(name))] {
				return nil
			}
			abs, err := filepath.Abs(path)
			if err != nil || !hasPathPrefix(abs, dir) {
				return nil
			}
			found = append(found, abs)
			return nil
		})
	}
	return found
}

func safeUploadPath(rest string) (string, error) {
	if uploadRoot == "" || rest == "" || strings.Contains(rest, "..") {
		return "", errors.New("bad path")
	}
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 || !validUserID(parts[0]) || parts[1] == "" {
		return "", errors.New("bad path")
	}
	up, err := filepath.Abs(uploadRoot)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(up, parts[0])
	full, err := filepath.Abs(filepath.Join(dir, filepath.FromSlash(parts[1])))
	if err != nil || !hasPathPrefix(full, dir) {
		return "", errors.New("bad path")
	}
	st, err := os.Stat(full)
	if err != nil || st.IsDir() || !videoExt[strings.ToLower(filepath.Ext(full))] {
		return "", errors.New("not a video")
	}
	return full, nil
}
