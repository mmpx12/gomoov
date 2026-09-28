// gomoov serves the local video library. The web page is embedded in the
// binary. Run it in the folder that holds the videos:
//
//	./gomoov
package main

import (
	"context"
	"crypto/sha1"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed index.html app.js styles.css
var web embed.FS

//go:embed brand/*.png
var brandLogos embed.FS

// version is increased on every change.
const version = "1.0.24"

// probeVer invalidates cached probes when the stored shape changes.
const probeVer = 2

var (
	root  string
	cache string

	videoExt = map[string]bool{
		".mkv": true, ".mp4": true, ".webm": true, ".m4v": true, ".mov": true, ".avi": true,
	}
	textSubs = map[string]bool{
		"subrip": true, "ass": true, "ssa": true, "webvtt": true, "mov_text": true, "text": true, "subviewer": true,
	}
	qualities = map[int]bool{0: true, 360: true, 480: true, 720: true, 1080: true}
	langNames = map[string]string{
		"fr": "French", "fre": "French", "fra": "French",
		"en": "English", "eng": "English",
		"de": "German", "deu": "German", "ger": "German",
		"es": "Spanish", "spa": "Spanish",
		"it": "Italian", "ita": "Italian",
		"pt": "Portuguese", "por": "Portuguese",
		"nl": "Dutch", "nld": "Dutch", "dut": "Dutch",
		"ja": "Japanese", "jpn": "Japanese",
		"zh": "Chinese", "chi": "Chinese", "zho": "Chinese",
		"ar": "Arabic", "ara": "Arabic",
		"ru": "Russian", "rus": "Russian",
		"pl": "Polish", "pol": "Polish",
		"tr": "Turkish", "tur": "Turkish",
		"sv": "Swedish", "swe": "Swedish",
		"no": "Norwegian", "nor": "Norwegian",
		"da": "Danish", "dan": "Danish",
		"fi": "Finnish", "fin": "Finnish",
		"ko": "Korean", "kor": "Korean",
		"ca": "Catalan", "cat": "Catalan",
	}

	libraryMu    sync.Mutex
	library      []videoInfo
	libraryStamp string
	memProbeMu   sync.Mutex
	memProbe     = map[string]memHit{}

	probeMu    sync.Mutex
	probeCache map[string]probeEntry

	thumbSlots = make(chan struct{}, 2)
	thumbMu    sync.Mutex
	thumbLocks = map[string]*sync.Mutex{}

	readrateOnce sync.Once
	readrate     bool

	originMu    sync.Mutex
	originCache = map[string]float64{}

	// includeDirs and excludeDirs are absolute directories under root.
	// An empty include list scans the whole library.
	includeDirs []string
	excludeDirs []string

	// videoPlayer hides accounts and private uploads. It is the default.
	// showPrivate includes those uploads while video player mode is on.
	videoPlayer = true
	showPrivate bool
)

type memHit struct {
	stamp string
	info  videoInfo
}

// multiFlag collects repeated flag values and comma-separated values.
type multiFlag []string

func (m *multiFlag) String() string {
	return strings.Join(*m, ",")
}

func (m *multiFlag) Set(value string) error {
	added := false
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		*m = append(*m, part)
		added = true
	}
	if !added {
		return errors.New("empty path")
	}
	return nil
}

func usage() {
	fmt.Fprintf(os.Stderr, `gomoov %s — local video library

Usage:
  gomoov [flags]

Run it in the folder that holds the videos. A plain launch is the simple
player: no sign-in, and private uploads stay hidden. -U turns on accounts.
Paths may be absolute or relative to that folder. A leading ~/ is your home
directory. -i may point at a folder outside the one you started in. Uploads
in ~/gomoov stay available either way.

Flags:
  -h, --help                 show this help and exit
  -H, --host ADDR            listen address (overrides HOST, default 0.0.0.0)
  -p, --port PORT            listen port (overrides PORT, default 8080)
  -V, --version              print version and exit
  -U, --user-mode            accounts, uploads, and private videos
      --show-private         in the simple player, also show private videos
  -m, --movie PATH           open this video in a browser
  -L, --library DIR          movie folder (default: the current directory)
  -i, --include DIR          only scan these directories
  -e, --exclude DIR          skip these directories

-i/--include and -e/--exclude can be repeated, or take a comma-separated list:
  gomoov --exclude /films/extras,/films/samples
  gomoov -e /films/extras -e /films/samples
  gomoov -i Series/A,Series/B -m Series/A/episode.mkv
`, version)
}

type videoInfo struct {
	Path        string  `json:"path"`
	Name        string  `json:"name"`
	Size        int64   `json:"size"`
	Mtime       float64 `json:"mtime"`
	Duration    float64 `json:"duration"`
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	HasCover    bool    `json:"hasCover,omitempty"`
	CoverIndex  int     `json:"coverIndex,omitempty"`
	VideoCodec  string  `json:"videoCodec"`
	AudioCodec  string  `json:"audioCodec"`
	AudioTracks []track `json:"audioTracks"`
	Subtitles   []sub   `json:"subtitles"`
	StreamTitle string  `json:"streamTitle"`
	DisplayPath string  `json:"displayPath"`
	AbsPath     string  `json:"absPath"`
	OwnerID     string  `json:"ownerId,omitempty"`
	OwnerName   string  `json:"ownerName,omitempty"`
	Private     bool    `json:"private,omitempty"`
	Mine        bool    `json:"mine,omitempty"`
	CanRemove   bool    `json:"canRemove,omitempty"`
}

type track struct {
	ID       int    `json:"id"`
	Codec    string `json:"codec"`
	Language string `json:"language"`
	Label    string `json:"label"`
}

type sub struct {
	ID       int    `json:"id"`
	Codec    string `json:"codec"`
	Text     bool   `json:"text"`
	Language string `json:"language"`
	Label    string `json:"label"`
}

type probeEntry struct {
	Stamp string     `json:"stamp"`
	Ver   int        `json:"ver"`
	Info  *videoInfo `json:"info"`
}

func main() {
	var hostFlag, portFlag, movieFlag, libraryFlag string
	var versionFlag, userModeFlag bool
	var includes, excludes multiFlag

	flag.Usage = usage
	flag.StringVar(&hostFlag, "host", "", "listen address (overrides HOST)")
	flag.StringVar(&hostFlag, "H", "", "listen address (overrides HOST)")
	flag.StringVar(&portFlag, "port", "", "listen port (overrides PORT)")
	flag.StringVar(&portFlag, "p", "", "listen port (overrides PORT)")
	flag.BoolVar(&versionFlag, "version", false, "print version and exit")
	flag.BoolVar(&versionFlag, "V", false, "print version and exit")
	flag.BoolVar(&userModeFlag, "user-mode", false, "accounts, uploads, and private videos")
	flag.BoolVar(&userModeFlag, "U", false, "accounts, uploads, and private videos")
	flag.BoolVar(&showPrivate, "show-private", false, "in the simple player, include private videos")
	flag.StringVar(&movieFlag, "movie", "", "open this video in a browser")
	flag.StringVar(&movieFlag, "m", "", "open this video in a browser")
	flag.StringVar(&libraryFlag, "library", "", "movie folder (default: the current directory)")
	flag.StringVar(&libraryFlag, "L", "", "movie folder (default: the current directory)")
	flag.Var(&includes, "include", "only scan these directories")
	flag.Var(&includes, "i", "only scan these directories")
	flag.Var(&excludes, "exclude", "skip these directories")
	flag.Var(&excludes, "e", "skip these directories")
	flag.Parse()
	if flag.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "unexpected argument %q\n\n", flag.Arg(0))
		usage()
		os.Exit(2)
	}
	videoPlayer = !userModeFlag
	if versionFlag {
		fmt.Println("gomoov " + version)
		return
	}

	var err error
	if libraryFlag != "" {
		root = expandUser(libraryFlag)
	} else {
		root, err = os.Getwd()
		if err != nil {
			log.Fatal(err)
		}
	}
	root, err = filepath.Abs(root)
	if err != nil {
		log.Fatal(err)
	}
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		log.Fatalf("library %s is not a directory", root)
	}
	if err := prepareFilters(includes, excludes); err != nil {
		log.Fatal(err)
	}
	if err := initAuthPaths(); err != nil {
		log.Fatal(err)
	}
	if err := prepareFFmpeg(); err != nil {
		log.Fatal(err)
	}
	detectHWEncoder()
	if err := loadSettings(); err != nil {
		log.Fatal(err)
	}
	var movieRel string
	if movieFlag != "" {
		movieRel, err = resolveMovie(movieFlag)
		if err != nil {
			log.Fatal(err)
		}
	}
	cache = os.Getenv("MOOVIES_CACHE")
	if cache == "" {
		cache = filepath.Join(configDir, "cache")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	if portFlag != "" {
		port = portFlag
	}
	host := os.Getenv("HOST")
	if host == "" {
		host = "0.0.0.0"
	}
	if hostFlag != "" {
		host = hostFlag
	}
	ffmpegHasReadrate()

	mux := http.NewServeMux()
	mux.HandleFunc("/", handle)

	addr := net.JoinHostPort(host, port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("gomoov %s listening on %s:%s", version, host, port)
	if host == "0.0.0.0" || host == "::" {
		for _, ip := range localIPs() {
			log.Printf("  http://%s:%s", ip, port)
		}
		log.Printf("  http://127.0.0.1:%s", port)
	} else {
		log.Printf("  http://%s:%s", host, port)
	}
	if len(includeDirs) > 0 {
		log.Printf("including %s", strings.Join(includeDirs, ", "))
	}
	if len(excludeDirs) > 0 {
		log.Printf("excluding %s", strings.Join(excludeDirs, ", "))
	}
	if videoPlayer {
		if showPrivate {
			log.Printf("video player mode, including private videos")
		} else {
			log.Printf("video player mode, private videos hidden")
		}
	}

	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	if movieRel != "" {
		openMovie(host, port, movieRel)
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Printf("stopping")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

func expandUser(path string) string {
	if path != "~" && !strings.HasPrefix(path, "~/") && !strings.HasPrefix(path, `~\`) {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	if path == "~" {
		return home
	}
	return filepath.Join(home, path[2:])
}

func insideRoot(abs string) bool {
	return abs == root || strings.HasPrefix(abs, root+string(os.PathSeparator))
}

func hasPathPrefix(path, dir string) bool {
	return path == dir || strings.HasPrefix(path, dir+string(os.PathSeparator))
}

func resolveDir(raw string) (string, error) {
	full := expandUser(strings.TrimSpace(raw))
	if full == "" {
		return "", errors.New("empty path")
	}
	if !filepath.IsAbs(full) {
		full = filepath.Join(root, full)
	}
	abs, err := filepath.Abs(full)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("%s: %w", raw, err)
	}
	if !st.IsDir() {
		return "", fmt.Errorf("%s is not a directory", raw)
	}
	return abs, nil
}

func resolveDirList(raw []string) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	for _, item := range raw {
		abs, err := resolveDir(item)
		if err != nil {
			return nil, err
		}
		if seen[abs] {
			continue
		}
		seen[abs] = true
		out = append(out, abs)
	}
	return out, nil
}

func prepareFilters(includes, excludes []string) error {
	var err error
	includeDirs, err = resolveDirList(includes)
	if err != nil {
		return err
	}
	excludeDirs, err = resolveDirList(excludes)
	if err != nil {
		return err
	}
	for _, in := range includeDirs {
		for _, ex := range excludeDirs {
			if hasPathPrefix(in, ex) {
				return fmt.Errorf("include %s is inside excluded %s", in, ex)
			}
		}
	}
	return nil
}

func walkDir(abs string) bool {
	for _, ex := range excludeDirs {
		if hasPathPrefix(abs, ex) {
			return false
		}
	}
	if len(includeDirs) == 0 {
		return true
	}
	for _, in := range includeDirs {
		if hasPathPrefix(abs, in) || hasPathPrefix(in, abs) {
			return true
		}
	}
	return false
}

func fileIncluded(abs string) bool {
	for _, ex := range excludeDirs {
		if hasPathPrefix(abs, ex) {
			return false
		}
	}
	if len(includeDirs) == 0 {
		return true
	}
	for _, in := range includeDirs {
		if hasPathPrefix(abs, in) {
			return true
		}
	}
	return false
}

func resolveMovie(raw string) (string, error) {
	full := expandUser(strings.TrimSpace(raw))
	if full == "" {
		return "", errors.New("empty movie path")
	}
	if !filepath.IsAbs(full) {
		full = filepath.Join(root, full)
	}
	abs, err := filepath.Abs(full)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("%s: %w", raw, err)
	}
	if st.IsDir() || !videoExt[strings.ToLower(filepath.Ext(abs))] {
		return "", fmt.Errorf("%s is not a video", raw)
	}
	if !libraryFile(abs) {
		return "", fmt.Errorf("%s is outside the library", raw)
	}
	return relOf(abs), nil
}

func includeKey(dir string) string {
	sum := sha1.Sum([]byte(filepath.Clean(dir)))
	return fmt.Sprintf("%x", sum[:6])
}

func externalRel(abs string) (string, bool) {
	for _, dir := range includeDirs {
		if dir == root || insideRoot(dir) || !hasPathPrefix(abs, dir) {
			continue
		}
		rel, err := filepath.Rel(dir, abs)
		if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
			continue
		}
		return "inc/" + includeKey(dir) + "/" + filepath.ToSlash(rel), true
	}
	return "", false
}

func libraryFile(abs string) bool {
	if isUnderUpload(abs) {
		return true
	}
	if !fileIncluded(abs) {
		return false
	}
	if insideRoot(abs) {
		return true
	}
	for _, dir := range includeDirs {
		if hasPathPrefix(abs, dir) {
			return true
		}
	}
	return false
}

func openMovie(host, port, rel string) {
	pageHost := host
	if host == "" || host == "0.0.0.0" || host == "::" {
		pageHost = "127.0.0.1"
	}
	escaped := url.QueryEscape(rel)
	watch := "http://" + net.JoinHostPort(pageHost, port) + "/#/watch?v=" + escaped
	log.Printf("movie %s", watch)
	if host == "0.0.0.0" || host == "::" {
		for _, ip := range localIPs() {
			log.Printf("  http://%s/#/watch?v=%s", net.JoinHostPort(ip, port), escaped)
		}
	}
	go func() {
		deadline := time.Now().Add(2 * time.Second)
		dial := net.JoinHostPort(pageHost, port)
		for {
			conn, err := net.DialTimeout("tcp", dial, 200*time.Millisecond)
			if err == nil {
				_ = conn.Close()
				break
			}
			if time.Now().After(deadline) {
				log.Printf("could not open movie; server did not accept connections")
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		launchBrowser(watch)
	}()
}

func launchBrowser(rawURL string) {
	var names []string
	if browser := strings.TrimSpace(os.Getenv("BROWSER")); browser != "" {
		names = append(names, browser)
	}
	names = append(names, "xdg-open")
	for _, name := range names {
		bin, err := exec.LookPath(name)
		if err != nil {
			continue
		}
		cmd := exec.Command(bin, rawURL)
		cmd.Stdout = io.Discard
		cmd.Stderr = io.Discard
		log.Printf("opening %s", rawURL)
		if err := cmd.Start(); err != nil {
			log.Printf("could not open the browser with %s: %v", name, err)
			continue
		}
		go func() {
			if err := cmd.Wait(); err != nil {
				log.Printf("could not open the browser (%v); open %s", err, rawURL)
			}
		}()
		return
	}
	log.Printf("no browser launcher found; open %s", rawURL)
}

func handle(w http.ResponseWriter, r *http.Request) {
	if !gateRequest(w, r) {
		log.Printf("%s - %s %s blocked", clientIP(r), r.Method, r.URL.RequestURI())
		return
	}
	if strings.HasPrefix(r.URL.Path, "/brand/") && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		serveBrand(w, r.URL.Path)
		return
	}
	if u := currentUser(r); u != nil && u.MustChangePassword && !passwordChangeExempt(r) {
		log.Printf("%s - %s %s blocked until password change", clientIP(r), r.Method, r.URL.RequestURI())
		writeAPIError(w, http.StatusForbidden, "password_change_required")
		return
	}
	switch r.URL.Path {
	case "/api/login":
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		log.Printf("%s - %s %s", clientIP(r), r.Method, r.URL.RequestURI())
		serveLogin(w, r)
		return
	case "/api/logout":
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		log.Printf("%s - %s %s", clientIP(r), r.Method, r.URL.RequestURI())
		serveLogout(w, r)
		return
	case "/api/me":
		if r.Method != http.MethodGet {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		log.Printf("%s - %s %s", clientIP(r), r.Method, r.URL.RequestURI())
		serveMe(w, r)
		return
	case "/api/password":
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		log.Printf("%s - %s %s", clientIP(r), r.Method, r.URL.RequestURI())
		servePassword(w, r)
		return
	case "/api/settings":
		log.Printf("%s - %s %s", clientIP(r), r.Method, r.URL.RequestURI())
		serveSettings(w, r)
		return
	case "/api/theme":
		if r.Method != http.MethodPut && r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		log.Printf("%s - %s %s", clientIP(r), r.Method, r.URL.RequestURI())
		serveMyTheme(w, r)
		return
	case "/api/password-reset":
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		log.Printf("%s - %s %s", clientIP(r), r.Method, r.URL.RequestURI())
		serveResetRequest(w, r)
		return
	case "/api/users":
		log.Printf("%s - %s %s", clientIP(r), r.Method, r.URL.RequestURI())
		switch r.Method {
		case http.MethodGet:
			if id := strings.TrimSpace(r.URL.Query().Get("id")); id != "" {
				serveUserDetail(w, r, id)
			} else {
				serveUserList(w, r)
			}
		case http.MethodPost:
			serveUserCreate(w, r)
		case http.MethodPut, http.MethodPatch:
			serveUserUpdate(w, r)
		case http.MethodDelete:
			serveUserDelete(w, r)
		default:
			http.Error(w, "method", http.StatusMethodNotAllowed)
		}
		return
	case "/api/upload":
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		log.Printf("%s - %s %s", clientIP(r), r.Method, r.URL.RequestURI())
		serveUpload(w, r)
		return
	case "/api/video/visibility":
		if r.Method != http.MethodPost && r.Method != http.MethodPut {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		log.Printf("%s - %s %s", clientIP(r), r.Method, r.URL.RequestURI())
		serveVisibility(w, r)
		return
	case "/api/download":
		if r.Method != http.MethodGet {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		log.Printf("%s - %s %s", clientIP(r), r.Method, r.URL.RequestURI())
		serveDownload(w, r)
		return
	case "/api/video/transfer":
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		log.Printf("%s - %s %s", clientIP(r), r.Method, r.URL.RequestURI())
		serveTransfer(w, r)
		return
	}
	if r.URL.Path == "/api/progress" && (r.Method == http.MethodGet || r.Method == http.MethodPut || r.Method == http.MethodPost) {
		log.Printf("%s - %s %s", clientIP(r), r.Method, r.URL.RequestURI())
		serveProgress(w, r)
		return
	}
	if r.URL.Path == "/api/video" && r.Method == http.MethodDelete {
		log.Printf("%s - %s %s", clientIP(r), r.Method, r.URL.RequestURI())
		deleteVideo(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	log.Printf("%s - %s %s", clientIP(r), r.Method, r.URL.RequestURI())
	path := r.URL.Path
	q := r.URL.Query()
	switch path {
	case "/api/library":
		writeJSON(w, map[string]any{"videos": presentLibrary(currentUser(r))})
	case "/thumb":
		if _, ok := visiblePath(w, r, q.Get("path")); !ok {
			return
		}
		serveThumb(w, q.Get("path"))
	case "/stream":
		if _, ok := visiblePath(w, r, q.Get("path")); !ok {
			return
		}
		serveStream(w, r, q)
	case "/subs":
		if _, ok := visiblePath(w, r, q.Get("path")); !ok {
			return
		}
		serveSubs(w, q.Get("path"), q.Get("id"))
	case "/start":
		if _, ok := visiblePath(w, r, q.Get("path")); !ok {
			return
		}
		serveStart(w, q)
	case "/", "/index.html":
		serveStatic(w, "index.html", "text/html; charset=utf-8")
	case "/app.js":
		serveStatic(w, "app.js", "text/javascript; charset=utf-8")
	case "/styles.css":
		serveStatic(w, "styles.css", "text/css; charset=utf-8")
	default:
		http.NotFound(w, r)
	}
}

func invalidateLibrary() {
	libraryMu.Lock()
	library = nil
	libraryStamp = ""
	libraryMu.Unlock()
}

func deleteVideo(w http.ResponseWriter, r *http.Request) {
	path, err := safeVideo(r.URL.Query().Get("path"))
	if err != nil || !canSeePath(currentUser(r), path) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if !canRemove(currentUser(r), path) {
		writeAPIError(w, http.StatusForbidden, "you cannot remove this video")
		return
	}
	if err := os.Remove(path); err != nil {
		log.Printf("%s remove failed %s: %v", clientIP(r), relOf(path), err)
		http.Error(w, "could not remove", http.StatusInternalServerError)
		return
	}
	invalidateLibrary()
	abs, _ := filepath.Abs(path)
	forgetVideo(abs)
	_ = writeProgressEntry(abs, nil)
	who := "anonymous"
	if u := currentUser(r); u != nil && u.Username != "" {
		who = u.Username
	}
	appendAudit(who, "delete", abs)
	log.Printf("%s removed %s", clientIP(r), relOf(path))
	writeJSON(w, map[string]bool{"ok": true})
}

func appendAudit(who, action, path string) {
	if configDir == "" {
		return
	}
	line := fmt.Sprintf("%s\t%s\t%s\t%s\n", time.Now().Format(time.RFC3339), who, action, path)
	f, err := os.OpenFile(filepath.Join(configDir, "audit.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		log.Printf("audit: %v", err)
		return
	}
	_, _ = f.WriteString(line)
	_ = f.Close()
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func serveBrand(w http.ResponseWriter, path string) {
	name := strings.TrimPrefix(path, "/brand/")
	if name == "" || strings.Contains(name, "/") || !strings.HasSuffix(name, ".png") {
		http.NotFound(w, nil)
		return
	}
	data, err := brandLogos.ReadFile("brand/" + name)
	if err != nil {
		http.NotFound(w, nil)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(data)
}

func serveStatic(w http.ResponseWriter, name, contentType string) {
	data, err := web.ReadFile(name)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(data)
}

func writeJSON(w http.ResponseWriter, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, "json", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(body)
}

func serveThumb(w http.ResponseWriter, raw string) {
	path, err := safeVideo(raw)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	img := thumbFile(path)
	if img == nil {
		http.Error(w, "no thumbnail", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(img)
}

func serveSubs(w http.ResponseWriter, raw, idRaw string) {
	path, err := safeVideo(raw)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	id, err := strconv.Atoi(idRaw)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	data := subsVTT(path, id)
	if data == nil {
		http.Error(w, "no subtitles", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(data)
}

func serveStart(w http.ResponseWriter, q url.Values) {
	path, err := safeVideo(q.Get("path"))
	requested, ferr := strconv.ParseFloat(q.Get("t"), 64)
	if err != nil || ferr != nil || math.IsNaN(requested) || requested < 0 {
		writeJSON(w, map[string]float64{"start": 0})
		return
	}
	quality := parseQuality(q.Get("q"))
	burn := burnSubIndex(path, q.Get("s"))
	origin := playbackOrigin(path, requested, quality, burn)
	writeJSON(w, map[string]float64{"start": math.Round(origin*1000) / 1000})
}

func serveStream(w http.ResponseWriter, r *http.Request, q url.Values) {
	path, err := safeVideo(q.Get("path"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	start, err := strconv.ParseFloat(q.Get("t"), 64)
	if err != nil || math.IsNaN(start) || start < 0 {
		start = 0
	}
	quality := parseQuality(q.Get("q"))
	audio, _ := strconv.Atoi(q.Get("a"))
	if audio < 0 {
		audio = 0
	}
	info := libraryByPath()[relOf(path)]
	burn := burnSubIndex(path, q.Get("s"))
	if info == nil || !copiesVideo(info, quality, burn) {
		if !acquireTranscode(r.Context()) {
			http.Error(w, "transcode queue cancelled", http.StatusServiceUnavailable)
			return
		}
		defer releaseTranscode()
	}
	if info != nil && info.Duration > 0 && start > info.Duration-1 {
		start = math.Max(0, info.Duration-1.5)
	}
	qLabel := "orig"
	if quality != 0 {
		qLabel = strconv.Itoa(quality)
	}
	sLabel := "nil"
	if burn != nil {
		sLabel = strconv.Itoa(*burn)
	}
	log.Printf("%s stream %s t=%.1fs q=%s a=%d s=%s", clientIP(r), relOf(path), start, qLabel, audio, sLabel)

	args := streamArgs(path, start, quality, audio, burn)
	cmd := exec.CommandContext(r.Context(), args[0], args[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = 2 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, "stream", http.StatusInternalServerError)
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		http.Error(w, "stream", http.StatusInternalServerError)
		return
	}
	if err := cmd.Start(); err != nil {
		http.Error(w, "stream", http.StatusInternalServerError)
		return
	}
	errBuf := make(chan []byte, 1)
	go func() {
		b, _ := io.ReadAll(stderr)
		if len(b) > 2000 {
			b = b[len(b)-2000:]
		}
		errBuf <- b
	}()

	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Start", fmt.Sprintf("%.3f", start))
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 64*1024)
	for {
		n, rerr := stdout.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				break
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr != nil {
			break
		}
	}
	_ = stdout.Close()
	waitErr := cmd.Wait()
	msg := <-errBuf
	if waitErr != nil && r.Context().Err() == nil && len(msg) > 0 {
		log.Printf("ffmpeg: %s", strings.TrimSpace(string(msg)))
	}
}

func parseQuality(raw string) int {
	n, err := strconv.Atoi(raw)
	if err != nil || !qualities[n] {
		return 0
	}
	return n
}

func burnSubIndex(path, raw string) *int {
	if raw == "" {
		return nil
	}
	id, err := strconv.Atoi(raw)
	if err != nil {
		return nil
	}
	info := libraryByPath()[relOf(path)]
	if info == nil {
		return nil
	}
	for i := range info.Subtitles {
		if info.Subtitles[i].ID == id && !info.Subtitles[i].Text {
			v := info.Subtitles[i].ID
			return &v
		}
	}
	return nil
}

func safeVideo(raw string) (string, error) {
	rel := strings.TrimPrefix(strings.ReplaceAll(raw, "\\", "/"), "/")
	if rel == "" || strings.Contains(rel, "..") {
		return "", errors.New("bad path")
	}
	if strings.HasPrefix(rel, "user/") {
		return safeUploadPath(strings.TrimPrefix(rel, "user/"))
	}
	if strings.HasPrefix(rel, "inc/") {
		return safeExternalPath(strings.TrimPrefix(rel, "inc/"))
	}
	full := filepath.Join(root, filepath.FromSlash(rel))
	full, err := filepath.Abs(full)
	if err != nil {
		return "", err
	}
	if full != root && !strings.HasPrefix(full, root+string(os.PathSeparator)) {
		return "", errors.New("bad path")
	}
	st, err := os.Stat(full)
	if err != nil || st.IsDir() || !videoExt[strings.ToLower(filepath.Ext(full))] {
		return "", errors.New("not a video")
	}
	return full, nil
}

func relOf(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	if owner, ok := uploadOwner(abs); ok {
		up, err := filepath.Abs(uploadRoot)
		if err == nil {
			rel, err := filepath.Rel(up, abs)
			if err == nil && rel != "." && !strings.HasPrefix(rel, "..") {
				return "user/" + owner + "/" + filepath.ToSlash(strings.TrimPrefix(rel, owner+string(os.PathSeparator)))
			}
		}
	}
	if rel, ok := externalRel(abs); ok {
		return rel
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil {
		return filepath.ToSlash(abs)
	}
	return filepath.ToSlash(rel)
}

func listVideos() []string {
	seen := map[string]bool{}
	var found []string
	add := func(abs string) {
		if abs == "" || seen[abs] || isUnderUpload(abs) {
			return
		}
		seen[abs] = true
		found = append(found, abs)
	}
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if path != root && strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}
			abs, err := filepath.Abs(path)
			if err != nil || !walkDir(abs) {
				return filepath.SkipDir
			}
			if path != root && isUnderUpload(abs) {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(name, ".") || !videoExt[strings.ToLower(filepath.Ext(name))] {
			return nil
		}
		abs, err := filepath.Abs(path)
		if err != nil || !insideRoot(abs) || !fileIncluded(abs) {
			return nil
		}
		add(abs)
		return nil
	})
	for _, abs := range listOutsideIncludes() {
		if abs == "" || seen[abs] {
			continue
		}
		seen[abs] = true
		found = append(found, abs)
	}
	for _, abs := range listUploadVideos() {
		if abs == "" || seen[abs] {
			continue
		}
		seen[abs] = true
		found = append(found, abs)
	}
	sort.Strings(found)
	return found
}

func listOutsideIncludes() []string {
	var found []string
	for _, dir := range includeDirs {
		if dir == root || insideRoot(dir) {
			continue
		}
		_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			name := d.Name()
			if d.IsDir() {
				if path != dir && strings.HasPrefix(name, ".") {
					return filepath.SkipDir
				}
				abs, err := filepath.Abs(path)
				if err != nil || !walkDir(abs) {
					return filepath.SkipDir
				}
				if path != dir && isUnderUpload(abs) {
					return filepath.SkipDir
				}
				return nil
			}
			if strings.HasPrefix(name, ".") || !videoExt[strings.ToLower(filepath.Ext(name))] {
				return nil
			}
			abs, err := filepath.Abs(path)
			if err != nil || !libraryFile(abs) || isUnderUpload(abs) {
				return nil
			}
			found = append(found, abs)
			return nil
		})
	}
	return found
}

func safeExternalPath(rest string) (string, error) {
	if rest == "" || strings.Contains(rest, "..") {
		return "", errors.New("bad path")
	}
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", errors.New("bad path")
	}
	var dir string
	for _, inc := range includeDirs {
		if includeKey(inc) == parts[0] {
			dir = inc
			break
		}
	}
	if dir == "" {
		return "", errors.New("bad path")
	}
	full, err := filepath.Abs(filepath.Join(dir, filepath.FromSlash(parts[1])))
	if err != nil || !hasPathPrefix(full, dir) || !libraryFile(full) {
		return "", errors.New("bad path")
	}
	st, err := os.Stat(full)
	if err != nil || st.IsDir() || !videoExt[strings.ToLower(filepath.Ext(full))] {
		return "", errors.New("not a video")
	}
	return full, nil
}

func getLibrary() []videoInfo {
	files := listVideos()
	parts := make([]string, 0, len(files))
	for _, p := range files {
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s:%d:%d", relOf(p), st.Size(), st.ModTime().UnixNano()))
	}
	stamp := strings.Join(parts, "|")
	libraryMu.Lock()
	defer libraryMu.Unlock()
	if library != nil && stamp == libraryStamp {
		return library
	}
	var videos []videoInfo
	for _, p := range files {
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		stamp := fmt.Sprintf("%d:%d", st.Size(), st.ModTime().UnixNano())
		memProbeMu.Lock()
		hit, ok := memProbe[p]
		memProbeMu.Unlock()
		if ok && hit.stamp == stamp && hit.info.Duration > 0 {
			videos = append(videos, hit.info)
			continue
		}
		info := probe(p)
		if info != nil && info.Duration > 0 {
			videos = append(videos, *info)
			memProbeMu.Lock()
			memProbe[p] = memHit{stamp: stamp, info: *info}
			memProbeMu.Unlock()
		}
	}
	if videos == nil {
		videos = []videoInfo{}
	}
	library = videos
	libraryStamp = stamp
	return library
}

func libraryByPath() map[string]*videoInfo {
	list := getLibrary()
	out := make(map[string]*videoInfo, len(list))
	for i := range list {
		v := list[i]
		out[v.Path] = &v
	}
	return out
}

func loadProbeCache() map[string]probeEntry {
	probeMu.Lock()
	defer probeMu.Unlock()
	if probeCache != nil {
		return probeCache
	}
	probeCache = map[string]probeEntry{}
	b, err := os.ReadFile(filepath.Join(cache, "probes.json"))
	if err != nil {
		return probeCache
	}
	_ = json.Unmarshal(b, &probeCache)
	return probeCache
}

func saveProbeCache(c map[string]probeEntry) {
	b, err := json.Marshal(c)
	if err != nil {
		return
	}
	if err := os.MkdirAll(cache, 0o755); err != nil {
		return
	}
	target := filepath.Join(cache, "probes.json")
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, target)
}

func probe(path string) *videoInfo {
	rel := relOf(path)
	st, err := os.Stat(path)
	if err != nil {
		return nil
	}
	stamp := fmt.Sprintf("%d:%d", st.Size(), st.ModTime().UnixNano())
	c := loadProbeCache()
	probeMu.Lock()
	hit, ok := c[rel]
	probeMu.Unlock()
	if ok && hit.Stamp == stamp && hit.Ver == probeVer && hit.Info != nil && hit.Info.AudioTracks != nil {
		if hit.Info.DisplayPath == "" {
			hit.Info.DisplayPath = shortPath(path)
		}
		if hit.Info.AbsPath == "" {
			if abs, err := filepath.Abs(path); err == nil {
				hit.Info.AbsPath = abs
			}
		}
		return hit.Info
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, toolBin("ffprobe"), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path).Output()
	if err != nil {
		log.Printf("probe failed for %s: %v", rel, err)
		return nil
	}
	var doc struct {
		Streams []struct {
			CodecType   string `json:"codec_type"`
			CodecName   string `json:"codec_name"`
			Width       int    `json:"width"`
			Height      int    `json:"height"`
			Disposition struct {
				AttachedPic int `json:"attached_pic"`
			} `json:"disposition"`
			Tags map[string]string `json:"tags"`
		} `json:"streams"`
		Format struct {
			Duration string            `json:"duration"`
			Tags     map[string]string `json:"tags"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		log.Printf("probe failed for %s: %v", rel, err)
		return nil
	}
	var video *struct {
		CodecName string
		Width     int
		Height    int
		Tags      map[string]string
	}
	coverIndex := -1
	videoOrd := 0
	for _, s := range doc.Streams {
		if s.CodecType != "video" {
			continue
		}
		if s.Disposition.AttachedPic != 0 {
			if coverIndex < 0 {
				coverIndex = videoOrd
			}
			videoOrd++
			continue
		}
		if video == nil {
			video = &struct {
				CodecName string
				Width     int
				Height    int
				Tags      map[string]string
			}{s.CodecName, s.Width, s.Height, s.Tags}
		}
		videoOrd++
	}
	if video == nil {
		return nil
	}
	duration, _ := strconv.ParseFloat(doc.Format.Duration, 64)
	title := ""
	if video.Tags != nil {
		title = video.Tags["title"]
	}
	if title == "" && doc.Format.Tags != nil {
		title = doc.Format.Tags["title"]
	}
	if len(title) > 180 {
		title = title[:180]
	}
	var audios []track
	var subs []sub
	ai, si := 0, 0
	for _, s := range doc.Streams {
		switch s.CodecType {
		case "audio":
			label, code := trackLabel(s.Tags)
			audios = append(audios, track{ID: ai, Codec: s.CodecName, Language: code, Label: label})
			ai++
		case "subtitle":
			label, code := trackLabel(s.Tags)
			subs = append(subs, sub{ID: si, Codec: s.CodecName, Text: textSubs[s.CodecName], Language: code, Label: label})
			si++
		}
	}
	if audios == nil {
		audios = []track{}
	}
	if subs == nil {
		subs = []sub{}
	}
	firstAudio := ""
	if len(audios) > 0 {
		firstAudio = audios[0].Codec
	}
	info := &videoInfo{
		Path: rel, Name: filepath.Base(path), Size: st.Size(),
		Mtime: float64(st.ModTime().UnixNano()) / 1e9, Duration: duration,
		Width: video.Width, Height: video.Height, VideoCodec: video.CodecName,
		HasCover: coverIndex >= 0, CoverIndex: max(coverIndex, 0),
		AudioCodec: firstAudio, AudioTracks: audios, Subtitles: subs, StreamTitle: title,
		DisplayPath: shortPath(path),
		AbsPath:     absPath(path),
	}
	probeMu.Lock()
	if probeCache == nil {
		probeCache = map[string]probeEntry{}
	}
	probeCache[rel] = probeEntry{Stamp: stamp, Ver: probeVer, Info: info}
	saveProbeCache(probeCache)
	probeMu.Unlock()
	return info
}

func trackLabel(tags map[string]string) (string, string) {
	title, code := "", ""
	if tags != nil {
		title = strings.TrimSpace(tags["title"])
		code = strings.ToLower(strings.TrimSpace(tags["language"]))
	}
	if code == "und" || code == "unk" || code == "mul" {
		code = ""
	}
	lang := langNames[code]
	if lang == "" && code != "" {
		lang = strings.ToUpper(code)
	}
	label := title
	if title != "" && lang != "" && !strings.Contains(strings.ToLower(title), strings.ToLower(lang)) {
		label = lang + " · " + title
	} else if label == "" {
		label = lang
	}
	if label == "" {
		label = "Unknown"
	}
	if len(label) > 90 {
		label = label[:90]
	}
	return label, code
}

func thumbLock(key string) *sync.Mutex {
	thumbMu.Lock()
	defer thumbMu.Unlock()
	if thumbLocks[key] == nil {
		thumbLocks[key] = &sync.Mutex{}
	}
	return thumbLocks[key]
}

func ffmpegJPEG(input []string) []byte {
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin"}
	args = append(args, input...)
	args = append(args, "-frames:v", "1", "-vf", "scale=640:-2,format=yuvj420p", "-q:v", "4", "-f", "image2", "pipe:1")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	data, err := exec.CommandContext(ctx, toolBin("ffmpeg"), args...).Output()
	if err != nil || len(data) < 800 {
		return nil
	}
	return data
}

func thumbFile(path string) []byte {
	info := libraryByPath()[relOf(path)]
	duration := 30.0
	if info != nil && info.Duration > 0 {
		duration = info.Duration
	}
	st, err := os.Stat(path)
	if err != nil {
		return nil
	}
	key := fmt.Sprintf("%s:%d:%d:v3", relOf(path), st.Size(), st.ModTime().UnixNano())
	sum := sha1.Sum([]byte(key))
	dest := filepath.Join(cache, "thumbs", fmt.Sprintf("%x.jpg", sum))
	lock := thumbLock(dest)
	lock.Lock()
	defer lock.Unlock()
	if b, err := os.ReadFile(dest); err == nil && len(b) > 0 {
		return b
	}
	_ = os.MkdirAll(filepath.Dir(dest), 0o755)

	try := func(input []string) []byte {
		thumbSlots <- struct{}{}
		data := ffmpegJPEG(input)
		<-thumbSlots
		return data
	}
	if info != nil && info.HasCover {
		if data := try([]string{"-i", path, "-map", fmt.Sprintf("0:v:%d", info.CoverIndex)}); data != nil {
			_ = os.WriteFile(dest, data, 0o644)
			return data
		}
	}
	poster := 8.0
	if duration > 1 {
		poster = math.Min(8, math.Max(1, duration*0.1))
		if poster > duration-0.5 {
			poster = math.Max(0, duration*0.1)
		}
	}
	if data := try([]string{"-ss", fmt.Sprintf("%.3f", poster), "-i", path}); data != nil {
		_ = os.WriteFile(dest, data, 0o644)
		return data
	}

	samples := []float64{}
	for _, ratio := range []float64{0.12, 0.28, 0.45} {
		at := math.Min(math.Max(1, duration*ratio), math.Max(1, duration-1))
		samples = append(samples, at)
	}
	var best []byte
	thumbSlots <- struct{}{}
	for _, ss := range samples {
		data := ffmpegJPEG([]string{"-ss", fmt.Sprintf("%.3f", ss), "-i", path})
		if len(data) > len(best) {
			best = data
		}
	}
	<-thumbSlots
	if len(best) < 800 {
		log.Printf("thumb failed for %s", relOf(path))
		return nil
	}
	_ = os.WriteFile(dest, best, 0o644)
	return best
}

func ffmpegHasReadrate() bool {
	readrateOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, toolBin("ffmpeg"), "-hide_banner", "-h", "full").CombinedOutput()
		readrate = err == nil && strings.Contains(string(out), "-readrate")
	})
	return readrate
}

func copiesVideo(info *videoInfo, quality int, burn *int) bool {
	if info == nil || info.VideoCodec != "h264" {
		return false
	}
	if quality != 0 && info.Height != 0 && quality < info.Height-8 {
		return false
	}
	return burn == nil
}

func playbackOrigin(path string, requested float64, quality int, burn *int) float64 {
	if requested <= 0.05 {
		return 0
	}
	info := libraryByPath()[relOf(path)]
	if !copiesVideo(info, quality, burn) {
		return requested
	}
	st, err := os.Stat(path)
	if err != nil {
		return requested
	}
	key := fmt.Sprintf("%s:%d:%d:%.2f:%d:%v", relOf(path), st.Size(), st.ModTime().UnixNano(), requested, quality, burn)
	originMu.Lock()
	if v, ok := originCache[key]; ok {
		originMu.Unlock()
		return v
	}
	originMu.Unlock()
	origin := keyframeAt(path, requested)
	originMu.Lock()
	if len(originCache) > 256 {
		originCache = map[string]float64{}
	}
	originCache[key] = origin
	originMu.Unlock()
	return origin
}

func keyframeAt(path string, requested float64) float64 {
	for _, window := range []float64{30, 90} {
		begin := math.Max(0, requested-window)
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		out, err := exec.CommandContext(ctx, toolBin("ffprobe"), "-v", "error",
			"-select_streams", "v:0", "-skip_frame", "nokey",
			"-show_entries", "frame=pts_time", "-of", "csv=p=0",
			"-read_intervals", fmt.Sprintf("%.3f%%%.3f", begin, requested+0.05),
			path).Output()
		cancel()
		if err != nil {
			return requested
		}
		best := math.NaN()
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimRight(strings.TrimSpace(line), ",")
			pts, err := strconv.ParseFloat(line, 64)
			if err != nil {
				continue
			}
			if pts <= requested+0.04 && (math.IsNaN(best) || pts > best) {
				best = pts
			}
		}
		if !math.IsNaN(best) {
			return best
		}
	}
	return requested
}

func streamArgs(path string, start float64, quality, audio int, burn *int) []string {
	info := libraryByPath()[relOf(path)]
	videoCodec := ""
	height := 0
	var tracks []track
	if info != nil {
		videoCodec = info.VideoCodec
		height = info.Height
		tracks = info.AudioTracks
	}
	audioCodec := ""
	if len(tracks) > 0 {
		if audio >= len(tracks) {
			audio = len(tracks) - 1
		}
		if audio < 0 {
			audio = 0
		}
		audioCodec = tracks[audio].Codec
	} else if info != nil {
		audio = 0
		audioCodec = info.AudioCodec
	}
	scale := quality != 0 && height != 0 && quality < height-8
	tricky := scale || burn != nil
	transcode := videoCodec != "h264" || tricky
	// Burned-in subtitles and a scale stay on libx264. Hardware is encode-only.
	useHW := transcode && !tricky && hwEncoder != ""
	args := []string{toolBin("ffmpeg"), "-hide_banner", "-loglevel", "error", "-nostdin"}
	if useHW && hwEncoder == "vaapi" {
		args = append(args, "-vaapi_device", "/dev/dri/renderD128")
	}
	args = append(args, "-ss", fmt.Sprintf("%.3f", start))
	if ffmpegHasReadrate() {
		args = append(args, "-readrate", "1.5")
	}
	args = append(args, "-i", path)
	switch {
	case burn != nil && scale:
		args = append(args, "-filter_complex", fmt.Sprintf("[0:v:0]scale=-2:%d[vs];[vs][0:s:%d]overlay[v]", quality, *burn), "-map", "[v]")
	case burn != nil:
		args = append(args, "-filter_complex", fmt.Sprintf("[0:v:0][0:s:%d]overlay[v]", *burn), "-map", "[v]")
	case scale:
		args = append(args, "-map", "0:v:0", "-vf", fmt.Sprintf("scale=-2:%d", quality))
	default:
		args = append(args, "-map", "0:v:0")
		if useHW && hwEncoder == "vaapi" {
			args = append(args, "-vf", "format=nv12,hwupload")
		}
	}
	if transcode {
		if useHW {
			args = append(args, videoEncodeArgs()...)
		} else {
			args = append(args, "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "23", "-pix_fmt", "yuv420p", "-profile:v", "high")
		}
	} else {
		args = append(args, "-c:v", "copy")
	}
	if audioCodec != "" {
		args = append(args, "-map", fmt.Sprintf("0:a:%d", audio))
		if audioCodec == "aac" || audioCodec == "mp3" {
			args = append(args, "-c:a", "copy")
		} else {
			args = append(args, "-c:a", "aac", "-ac", "2", "-b:a", "160k")
		}
	} else {
		args = append(args, "-an")
	}
	args = append(args, "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "500000", "-reset_timestamps", "1", "-f", "mp4", "pipe:1")
	return args
}

func subsVTT(path string, id int) []byte {
	info := libraryByPath()[relOf(path)]
	if info == nil {
		return nil
	}
	ok := false
	for _, s := range info.Subtitles {
		if s.ID == id && s.Text {
			ok = true
			break
		}
	}
	if !ok {
		return nil
	}
	st, err := os.Stat(path)
	if err != nil {
		return nil
	}
	key := fmt.Sprintf("%s:%d:%d:s%d", relOf(path), st.Size(), st.ModTime().UnixNano(), id)
	sum := sha1.Sum([]byte(key))
	dest := filepath.Join(cache, "subs", fmt.Sprintf("%x.vtt", sum))
	if b, err := os.ReadFile(dest); err == nil && len(b) > 0 {
		return b
	}
	_ = os.MkdirAll(filepath.Dir(dest), 0o755)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	data, err := exec.CommandContext(ctx, toolBin("ffmpeg"), "-hide_banner", "-loglevel", "error", "-nostdin",
		"-i", path, "-map", fmt.Sprintf("0:s:%d", id), "-f", "webvtt", "pipe:1").Output()
	if err != nil {
		log.Printf("subs failed for %s #%d: %v", relOf(path), id, err)
		return nil
	}
	if !strings.HasPrefix(string(data), "WEBVTT") {
		data = append([]byte("WEBVTT\n\n"), data...)
	}
	_ = os.WriteFile(dest, data, 0o644)
	return data
}

func absPath(path string) string {
	full, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return full
}

type progressEntry struct {
	T    float64 `json:"t"`
	Dur  float64 `json:"dur"`
	At   int64   `json:"at"`
	Done bool    `json:"done"`
}

var progressMu sync.Mutex

func progressFile() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(cache, "progress.json")
	}
	return filepath.Join(home, ".gomoov", "progress.json")
}

func readProgress() map[string]progressEntry {
	progressMu.Lock()
	defer progressMu.Unlock()
	out := map[string]progressEntry{}
	b, err := os.ReadFile(progressFile())
	if err != nil {
		return out
	}
	_ = json.Unmarshal(b, &out)
	return out
}

func writeProgressEntry(abs string, entry *progressEntry) error {
	if abs == "" {
		return errors.New("empty path")
	}
	progressMu.Lock()
	defer progressMu.Unlock()
	file := progressFile()
	all := map[string]progressEntry{}
	if b, err := os.ReadFile(file); err == nil {
		_ = json.Unmarshal(b, &all)
	}
	if entry == nil {
		delete(all, abs)
	} else {
		all[abs] = *entry
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	b, err := json.Marshal(all)
	if err != nil {
		return err
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

func forgetProgressUnder(dir string) {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return
	}
	progressMu.Lock()
	defer progressMu.Unlock()
	file := progressFile()
	all := map[string]progressEntry{}
	b, err := os.ReadFile(file)
	if err != nil {
		return
	}
	if json.Unmarshal(b, &all) != nil {
		return
	}
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
	out, err := json.Marshal(all)
	if err != nil {
		return
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, file)
}

func serveProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		user := currentUser(r)
		all := readProgress()
		visible := map[string]progressEntry{}
		for abs, entry := range all {
			if canSeePath(user, abs) {
				visible[abs] = entry
			}
		}
		writeJSON(w, visible)
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
	if err != nil || !canSeePath(currentUser(r), full) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	abs, _ := filepath.Abs(full)
	if err := writeProgressEntry(abs, body.Entry); err != nil {
		http.Error(w, "could not save", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func shortPath(path string) string {
	full, err := filepath.Abs(path)
	if err != nil {
		full = path
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return full
	}
	rel, err := filepath.Rel(home, full)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return full
	}
	if rel == "." {
		return "~"
	}
	return "~/" + filepath.ToSlash(rel)
}

func dockerBridge(ip string) bool {
	parts := strings.Split(ip, ".")
	if len(parts) != 4 {
		return false
	}
	a, e1 := strconv.Atoi(parts[0])
	b, e2 := strconv.Atoi(parts[1])
	if e1 != nil || e2 != nil {
		return false
	}
	return a == 172 && b >= 16 && b <= 31
}

func localIPs() []string {
	var found []string
	add := func(ip string) {
		parsed := net.ParseIP(ip)
		if parsed == nil || parsed.To4() == nil || strings.HasPrefix(ip, "127.") || dockerBridge(ip) {
			return
		}
		for _, have := range found {
			if have == ip {
				return
			}
		}
		found = append(found, ip)
	}
	conn, err := net.Dial("udp", "192.0.2.1:1")
	if err == nil {
		if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok {
			add(addr.IP.String())
		}
		_ = conn.Close()
	}
	if host, err := os.Hostname(); err == nil {
		if ips, err := net.LookupHost(host); err == nil {
			for _, ip := range ips {
				add(ip)
			}
		}
	}
	return found
}
