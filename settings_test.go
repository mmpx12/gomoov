package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestAccessRulesAndTheme(t *testing.T) {
	withAuth(t)
	oldDir := configDir
	configDir = filepath.Join(t.TempDir(), "cfg")
	t.Cleanup(func() {
		configDir = oldDir
		settings = siteSettings{Theme: "dark", IPMode: "off"}
	})
	if err := loadSettings(); err != nil {
		t.Fatal(err)
	}
	admin := cookieOf(t, postJSON("/api/login", map[string]string{"username": "admin", "password": "admin"}, nil))

	blocked := sendJSON(http.MethodPut, "/api/settings", map[string]any{
		"ipMode": "allow",
		"ips":    []string{"10.0.0.9"},
	}, admin)
	blocked.Result().Request = httptest.NewRequest(http.MethodPut, "/api/settings", nil)
	if blocked.Code == http.StatusOK {
		t.Fatal("allow list that excludes the caller was saved")
	}

	saved := sendJSON(http.MethodPut, "/api/settings", map[string]any{
		"theme":         "cyber-green",
		"basicAuth":     true,
		"basicUser":     "gate",
		"basicPassword": "secret",
		"ipMode":        "deny",
		"ips":           []string{"10.1.1.1", "10.2.0.0/16"},
	}, admin)
	if saved.Code != http.StatusOK {
		t.Fatalf("save settings %d %s", saved.Code, saved.Body.String())
	}

	open := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	req.RemoteAddr = "192.0.2.1:1234"
	handle(open, req)
	if open.Code != http.StatusUnauthorized {
		t.Fatalf("basic auth status %d", open.Code)
	}

	ok := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	req.RemoteAddr = "192.0.2.1:1234"
	req.SetBasicAuth("gate", "secret")
	handle(ok, req)
	if ok.Code != http.StatusOK {
		t.Fatalf("basic auth passed %d %s", ok.Code, ok.Body.String())
	}

	denied := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.1.1.1:9"
	req.SetBasicAuth("gate", "secret")
	handle(denied, req)
	if denied.Code != http.StatusForbidden {
		t.Fatalf("denied ip %d", denied.Code)
	}

	ranged := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.2.1.8:9"
	req.SetBasicAuth("gate", "secret")
	handle(ranged, req)
	if ranged.Code != http.StatusForbidden {
		t.Fatalf("denied cidr %d", ranged.Code)
	}

	local := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	req.RemoteAddr = "127.0.0.1:9"
	req.SetBasicAuth("gate", "secret")
	handle(local, req)
	if local.Code != http.StatusOK {
		t.Fatalf("loopback %d %s", local.Code, local.Body.String())
	}
}
