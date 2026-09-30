package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type siteSettings struct {
	Theme     string   `json:"theme"`
	BasicOn   bool     `json:"basicAuth"`
	BasicUser string   `json:"basicUser"`
	BasicSalt string   `json:"basicSalt,omitempty"`
	BasicHash string   `json:"basicHash,omitempty"`
	BasicIter int      `json:"basicIter,omitempty"`
	IPMode    string   `json:"ipMode"`
	IPs       []string `json:"ips"`
}

var (
	settingsMu sync.Mutex
	settings   = siteSettings{Theme: "dark", IPMode: "off"}
)

func validTheme(theme string) bool {
	switch theme {
	case "dark", "white", "cyber-green", "fancy", "neon", "cyberpunk", "retro", "ocean", "sunset", "amber", "lavender", "rose", "steel":
		return true
	default:
		return false
	}
}

func loadSettings() error {
	if configDir == "" {
		return nil
	}
	settingsMu.Lock()
	defer settingsMu.Unlock()
	settings = siteSettings{Theme: "dark", IPMode: "off"}
	b, err := os.ReadFile(filepath.Join(configDir, "settings.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, &settings); err != nil {
		return err
	}
	if !validTheme(settings.Theme) {
		settings.Theme = "dark"
	}
	if settings.IPMode == "" {
		settings.IPMode = "off"
	}
	return nil
}

func currentSettings() siteSettings {
	settingsMu.Lock()
	defer settingsMu.Unlock()
	s := settings
	s.IPs = append([]string(nil), settings.IPs...)
	return s
}

func saveSettings(s siteSettings) error {
	if configDir == "" {
		return errors.New("no config directory")
	}
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(configDir, "settings.json")
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	settingsMu.Lock()
	settings = s
	settings.IPs = append([]string(nil), s.IPs...)
	settingsMu.Unlock()
	return nil
}

func normalizeIPs(raw []string) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	for _, item := range raw {
		for _, part := range strings.FieldsFunc(item, func(r rune) bool {
			return r == ',' || r == '\n' || r == '\r' || r == ' ' || r == '\t'
		}) {
			part = strings.TrimSpace(part)
			if part == "" || seen[part] {
				continue
			}
			if strings.Contains(part, "/") {
				if _, _, err := net.ParseCIDR(part); err != nil {
					return nil, errors.New(part + " is not an IP or CIDR range")
				}
			} else if net.ParseIP(part) == nil {
				return nil, errors.New(part + " is not an IP or CIDR range")
			}
			seen[part] = true
			out = append(out, part)
		}
	}
	return out, nil
}

func ipMatches(ip net.IP, rules []string) bool {
	if ip == nil {
		return false
	}
	for _, rule := range rules {
		rule = strings.TrimSpace(rule)
		if rule == "" {
			continue
		}
		if strings.Contains(rule, "/") {
			_, network, err := net.ParseCIDR(rule)
			if err == nil && network.Contains(ip) {
				return true
			}
			continue
		}
		if parsed := net.ParseIP(rule); parsed != nil && parsed.Equal(ip) {
			return true
		}
	}
	return false
}

func ipAllowed(addr string, s siteSettings) bool {
	ip := net.ParseIP(addr)
	if ip != nil && ip.IsLoopback() {
		return true
	}
	switch s.IPMode {
	case "", "off":
		return true
	case "allow":
		return ipMatches(ip, s.IPs)
	case "deny":
		return !ipMatches(ip, s.IPs)
	default:
		return true
	}
}

func gateRequest(w http.ResponseWriter, r *http.Request) bool {
	s := currentSettings()
	if !ipAllowed(clientIP(r), s) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return false
	}
	if !s.BasicOn {
		return true
	}
	user, pass, ok := r.BasicAuth()
	userOK := subtle.ConstantTimeCompare([]byte(user), []byte(s.BasicUser)) == 1
	passOK := ok && verifyPassword(pass, s.BasicSalt, s.BasicHash, s.BasicIter)
	if !ok || !userOK || !passOK {
		w.Header().Set("WWW-Authenticate", `Basic realm="gomoov", charset="UTF-8"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
}

func settingsPublic(s siteSettings, admin bool) map[string]any {
	out := map[string]any{"theme": s.Theme}
	if !admin {
		return out
	}
	ips := s.IPs
	if ips == nil {
		ips = []string{}
	}
	out["basicAuth"] = s.BasicOn
	out["basicUser"] = s.BasicUser
	out["basicSet"] = s.BasicHash != ""
	out["ipMode"] = s.IPMode
	out["ips"] = ips
	return out
}

func serveSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		u := currentUser(r)
		writeJSON(w, settingsPublic(currentSettings(), u != nil && u.Admin))
		return
	}
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	if requireAdmin(w, r) == nil {
		return
	}
	var body struct {
		Theme         *string   `json:"theme"`
		BasicAuth     *bool     `json:"basicAuth"`
		BasicUser     *string   `json:"basicUser"`
		BasicPassword *string   `json:"basicPassword"`
		IPMode        *string   `json:"ipMode"`
		IPs           *[]string `json:"ips"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	next := currentSettings()
	if body.Theme != nil {
		if !validTheme(*body.Theme) {
			writeAPIError(w, http.StatusBadRequest, "Unknown theme.")
			return
		}
		next.Theme = *body.Theme
	}
	if body.IPMode != nil {
		switch *body.IPMode {
		case "off", "allow", "deny":
			next.IPMode = *body.IPMode
		default:
			writeAPIError(w, http.StatusBadRequest, "IP rule must be off, allow, or deny.")
			return
		}
	}
	if body.IPs != nil {
		ips, err := normalizeIPs(*body.IPs)
		if err != nil {
			writeAPIError(w, http.StatusBadRequest, err.Error())
			return
		}
		next.IPs = ips
	}
	if body.BasicAuth != nil {
		next.BasicOn = *body.BasicAuth
	}
	if body.BasicUser != nil {
		next.BasicUser = strings.TrimSpace(*body.BasicUser)
	}
	if body.BasicPassword != nil && *body.BasicPassword != "" {
		salt, hash, iter, err := hashPassword(*body.BasicPassword)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "could not save settings")
			return
		}
		next.BasicSalt, next.BasicHash, next.BasicIter = salt, hash, iter
	}
	if next.BasicOn && (next.BasicUser == "" || next.BasicHash == "") {
		writeAPIError(w, http.StatusBadRequest, "Basic auth needs a username and password.")
		return
	}
	if !ipAllowed(clientIP(r), next) {
		writeAPIError(w, http.StatusBadRequest, "That IP rule would block this request. Loopback stays allowed.")
		return
	}
	if err := saveSettings(next); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "could not save settings")
		return
	}
	writeJSON(w, settingsPublic(next, true))
}

func serveMyTheme(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	u := currentUser(r)
	if u == nil {
		writeAPIError(w, http.StatusUnauthorized, "sign in required")
		return
	}
	var body struct {
		Theme string `json:"theme"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Theme != "" && !validTheme(body.Theme) {
		writeAPIError(w, http.StatusBadRequest, "Unknown theme.")
		return
	}
	authMu.Lock()
	found := false
	for i := range users {
		if users[i].ID != u.ID {
			continue
		}
		users[i].Theme = body.Theme
		u.Theme = body.Theme
		found = true
		break
	}
	var err error
	if found {
		err = saveUsersLocked()
	}
	authMu.Unlock()
	if !found {
		writeAPIError(w, http.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "could not save theme")
		return
	}
	writeJSON(w, mePayload(u))
}
