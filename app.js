"use strict";

const STORAGE_KEY = "moovies.progress.v1";
const VOLUME_KEY = "moovies.volume";
const SORT_STORE = "moovies.sort";
const MINE_ONLY = "moovies.mineOnly";
const THEME_KEY = "moovies.theme";
const CONTINUE_COLLAPSE = "moovies.continueCollapsed";
const WATCH_LATER = "gomoov.watchlater";
const LATER_COLLAPSE = "gomoov.watchlaterCollapsed";
const RECENT_COLLAPSE = "gomoov.recentCollapsed";
const SEEN_LIBRARY = "gomoov.seenLibrary";
const WATCH_FILTER = "gomoov.watchFilter";
const FOLDER_COLLAPSE = "moovies.folderCollapsed";
const THEATER_KEY = "moovies.theater";
const RATE_KEY = "moovies.rate";
const PREF_KEY = "moovies.playsettings";
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const QUALITY_STEPS = [1080, 720, 480, 360];
const RESUME_AT = 8;
const DONE_WITHIN = 15;

const RELEASE = new Set([
  "1080p", "720p", "2160p", "480p", "web", "webdl", "webrip", "bluray",
  "hdlight", "hdrip", "hdtv", "h264", "h265", "x264", "x265", "hevc",
  "aac", "ac3", "eac3", "dts", "multi", "vff", "vf2", "vof", "french",
  "doc", "truefrench", "mhd", "10bit", "8bit", "hdr", "remux", "uhd",
  "proper", "repack", "extended", "nf"
]);

const statusEl = document.getElementById("status");
const viewHome = document.getElementById("view-home");
const viewWatch = document.getElementById("view-watch");
const libraryEl = document.getElementById("library");
const continueSection = document.getElementById("continue-section");
const continueRow = document.getElementById("continue-row");
const laterSection = document.getElementById("later-section");
const laterRow = document.getElementById("later-row");
const recentSection = document.getElementById("recent-section");
const recentRow = document.getElementById("recent-row");
const searchInput = document.getElementById("search");
const stage = document.getElementById("stage");
let video = document.getElementById("video");
const playBtn = document.getElementById("play");
const bigPlay = document.getElementById("big-play");
const skipBackBtn = document.getElementById("skip-back");
const skipForwardBtn = document.getElementById("skip-forward");
const muteBtn = document.getElementById("mute");
const volumeInput = document.getElementById("volume");
const menuBtn = document.getElementById("menu-btn");
const menuEl = document.getElementById("menu");
const subsEl = document.getElementById("subs");
const theaterBtn = document.getElementById("theater");
const fullscreenBtn = document.getElementById("fullscreen");
const timeLabel = document.getElementById("time-label");
const timeline = document.getElementById("timeline");
const timelinePlay = document.getElementById("timeline-play");
const timelineBuf = document.getElementById("timeline-buf");
const timelineTip = document.getElementById("timeline-tip");
const miniPlay = document.getElementById("mini-play");
const watchTitle = document.getElementById("watch-title");
const watchMeta = document.getElementById("watch-meta");
const codecHint = document.getElementById("codec-hint");
const startOverBtn = document.getElementById("start-over");
const upNextEl = document.getElementById("up-next");
const playerMessage = document.getElementById("player-message");
const playerMessageText = document.getElementById("player-message-text");
const playerRetry = document.getElementById("player-retry");

let catalog = [];
let me = null;
let sortKey = "newest";
let sortDesc = true;
let groupByFolder = false;
let mineOnly = false;
let videoPlayer = false;
let siteTheme = "dark";
let continueCollapsed = false;
let laterCollapsed = false;
let recentCollapsed = false;
let qualityGhost = null;
let seenLibrary = Number(localStorage.getItem(SEEN_LIBRARY)) || 0;
let seenNotedFor = "";
let watchLater = [];
let watchFilter = "all";
let infoSeries = "";
let upNextTimer = 0;
let upNextToken = 0;
let previewTimer = 0;
let previewToken = 0;
let current = null;
let streamStart = 0;
let playToken = 0;
let ignoreMedia = false;
let scrubbing = false;
let scrubRatio = 0;
let wasPlaying = false;
let hideTimer = 0;
let playBtnTimer = 0;
let seekLock = 0;
let refreshTimer = 0;
let refreshGen = 0;
let libraryAbort = null;
let saveTimer = 0;
let videoClickTimer = 0;
let playbackRate = 1;
let menuPage = "root";
let qualityChoice = 0;
let audioChoice = null;
let subChoice = null;
let subsCues = [];
let subsToken = 0;

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return h + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
  return m + ":" + String(sec).padStart(2, "0");
}

function formatSize(bytes) {
  if (!bytes) return "";
  const gb = bytes / 1e9;
  if (gb >= 1) return gb.toFixed(gb >= 10 ? 0 : 1) + " GB";
  return Math.max(1, Math.round(bytes / 1e6)) + " MB";
}

function qualityLabel(width, height) {
  const n = Math.max(width || 0, height || 0);
  if (n >= 3000) return "4K";
  if (n >= 1600) return "1080p";
  if (n >= 1200) return "720p";
  if (n) return height + "p";
  return "";
}

function hueOf(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

function initials(text) {
  const words = text.replace(/[·()]/g, " ").split(/\s+/).filter(Boolean);
  return (words[0] ? words[0][0] : "?") + (words[1] ? words[1][0] : "");
}

function cleanReleaseName(stem) {
  const tokens = stem.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim().split(" ");
  const kept = [];
  for (const token of tokens) {
    const key = token.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (RELEASE.has(key)) break;
    kept.push(token);
  }
  return kept.join(" ").trim().replace(/(?<!\()(\b(?:19|20)\d{2}\b)(?!\))/g, "($1)");
}

function editionOf(file) {
  const blob = (file.path + " " + file.name).toLowerCase();
  if (blob.includes("hdlight")) return "HDLight";
  if (blob.includes("bluray") || blob.includes("blu-ray")) return "BluRay";
  if (blob.includes(".web.") || blob.includes("/web") || blob.includes(" web")) return "WEB";
  return "";
}

function decorate(file) {
  const fromName = cleanReleaseName(file.name.replace(/\.[^.]+$/, ""));
  const fromStream = file.streamTitle ? cleanReleaseName(file.streamTitle) : "";
  let cleaned = fromName;
  if (fromStream && fromStream.length >= 3 && fromStream.length <= 80) {
    const nameHasEp = /S\d{1,2}E\d{1,2}/i.test(fromName);
    const streamHasEp = /S\d{1,2}E\d{1,2}/i.test(fromStream);
    if (!nameHasEp || streamHasEp) cleaned = fromStream;
  }
  const match = cleaned.match(/^(.*?)[\s.-]*S(\d{1,2})E(\d{1,2})(.*)$/i);
  const item = {
    ...file,
    series: "",
    season: 0,
    episode: 0,
    final: false,
    edition: editionOf(file),
    quality: qualityLabel(file.width, file.height),
    sizeLabel: formatSize(file.size)
  };
  if (match && match[1].trim()) {
    item.series = match[1].trim();
    item.season = Number(match[2]);
    item.episode = Number(match[3]);
    item.final = /\bfinal\b/i.test(match[4] || "");
    item.cardTitle = "Episode " + item.episode + (item.final ? " (Final)" : "");
    item.fullTitle = item.series + " · Episode " + item.episode;
  } else {
    item.cardTitle = cleaned || file.name;
    item.fullTitle = item.cardTitle;
  }
  item.sortTitle = (item.series || item.fullTitle).toLowerCase();
  return item;
}

let progress = {};

function progressKey(item) {
  return item && (item.absPath || item.path);
}

function entryFor(item) {
  const key = typeof item === "string" ? item : progressKey(item);
  return (key && progress[key]) || null;
}

function sendProgress(relPath, entry) {
  const keyItem = catalog.find((item) => item.path === relPath) || current;
  const key = keyItem && keyItem.path === relPath ? progressKey(keyItem) : relPath;
  if (entry) progress[key] = entry;
  else delete progress[key];
  const body = JSON.stringify({ path: relPath, entry: entry });
  if (document.visibilityState === "hidden" && navigator.sendBeacon) {
    navigator.sendBeacon("/api/progress", new Blob([body], { type: "application/json" }));
    return;
  }
  fetch("/api/progress", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body,
    keepalive: true
  }).catch(() => {});
}

async function loadServerProgress() {
  const response = await fetch("/api/progress");
  if (!response.ok) return;
  progress = (await response.json()) || {};
  let local = {};
  try {
    local = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    local = {};
  }
  const jobs = [];
  for (const item of catalog) {
    const old = local[item.path];
    if (old && item.absPath && !progress[item.absPath]) {
      progress[item.absPath] = old;
      jobs.push(fetch("/api/progress", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: item.path, entry: old })
      }));
    }
  }
  await Promise.all(jobs);
}

function localWatchLater() {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCH_LATER));
    return Array.isArray(saved) ? saved.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function loadWatchLater() {
  if (!(me && me.id)) {
    watchLater = localWatchLater();
    return;
  }
  const response = await fetch("/api/watchlater");
  if (!response.ok) {
    watchLater = [];
    return;
  }
  const data = await response.json();
  let paths = Array.isArray(data.paths) ? data.paths : [];
  if (!paths.length) {
    const local = localWatchLater();
    if (local.length) {
      const saved = await fetch("/api/watchlater", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: local })
      });
      if (saved.ok) {
        const body = await saved.json();
        paths = Array.isArray(body.paths) ? body.paths : local;
      }
    }
  }
  watchLater = paths;
}

async function loadSeen() {
  if (!(me && me.id)) {
    seenLibrary = Number(localStorage.getItem(SEEN_LIBRARY)) || 0;
    return;
  }
  const response = await fetch("/api/seen");
  if (!response.ok) return;
  const data = await response.json();
  let at = Number(data.at) || 0;
  if (!at) at = Number(localStorage.getItem(SEEN_LIBRARY)) || 0;
  seenLibrary = at;
}

async function loadAccountState() {
  await loadServerProgress();
  await loadWatchLater();
  await loadSeen();
  noteLibraryVisit();
}

function totalDuration() {
  if (current && current.duration > 0) return current.duration;
  if (Number.isFinite(video.duration)) return streamStart + video.duration;
  return 0;
}

function realTime() {
  const local = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  return streamStart + local;
}

function flushProgress() {
  if (!current || ignoreMedia) return;
  const dur = totalDuration();
  if (!dur) return;
  const t = realTime();
  const key = progressKey(current);
  if (t < 5) {
    if (progress[key]) sendProgress(current.path, null);
    return;
  }
  const done = t > 30 && dur - t < DONE_WITHIN;
  sendProgress(current.path, { t: done ? 0 : t, dur, at: Date.now(), done });
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    flushProgress();
  }, 1000);
}

function setStatus(text) {
  statusEl.hidden = !text;
  statusEl.textContent = text || "";
}

function thumbURL(videoFile) {
  return "/thumb?path=" + encodeURIComponent(videoFile.path) + "&v=" + encodeURIComponent(String(videoFile.mtime));
}

function streamURL(path, t) {
  let url = "/stream?path=" + encodeURIComponent(path) + "&t=" + encodeURIComponent(t.toFixed(3));
  url += "&q=" + encodeURIComponent(String(qualityChoice || 0));
  if (audioChoice) url += "&a=" + encodeURIComponent(String(audioChoice.id));
  if (subChoice && !subChoice.text) url += "&s=" + encodeURIComponent(String(subChoice.id));
  return url;
}

function metaLine(item) {
  return [item.quality, item.edition, item.sizeLabel].filter(Boolean).join(" · ");
}

function relativeAge(mtime) {
  const then = Number(mtime);
  if (!then) return "";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - then));
  if (seconds < 45) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  if (days < 30) return days + "d ago";
  const months = Math.floor(days / 30);
  if (months < 12) return months + "mo ago";
  return Math.max(1, Math.floor(days / 365)) + "y ago";
}

function progressRatio(item) {
  const saved = entryFor(item);
  if (!saved || saved.done || !saved.dur || saved.t < 5) return 0;
  return Math.max(0, Math.min(1, saved.t / saved.dur));
}

function cardHTML(item, mode) {
  const ratio = progressRatio(item);
  const saved = entryFor(item);
  const title = mode === "episode" ? item.cardTitle : item.fullTitle;
  let sub = metaLine(item);
  if (mode === "continue" && saved && !saved.done) {
    const left = Math.max(0, (saved.dur || item.duration) - saved.t);
    sub = formatTime(left) + " left";
  } else {
    const age = relativeAge(item.mtime);
    if (age) sub = [sub, age].filter(Boolean).join(" · ");
  }
  const hue = hueOf(item.fullTitle);
  const href = "#/watch?v=" + encodeURIComponent(item.path);
  return (
    '<article class="card">' +
      '<div class="card-media">' +
        '<a class="card-open" href="' + href + '" data-video="' + esc(item.path) + '">' +
          '<div class="thumb" style="--h:' + hue + ';background:linear-gradient(145deg,hsl(' + hue + ',55%,32%),hsl(' + ((hue + 36) % 360) + ',45%,14%))">' +
            '<div class="thumb-fallback">' + esc(initials(item.series || item.fullTitle).toUpperCase()) + "</div>" +
            '<img class="thumb-img" alt="" loading="lazy" draggable="false" src="' + esc(thumbURL(item)) + '">' +
            (item.private ? '<span class="privacy-badge">Private</span>' : "") +
            '<span class="badge">' + esc(formatTime(item.duration)) + "</span>" +
            (ratio ? '<div class="thumb-progress"><span style="width:' + (ratio * 100).toFixed(1) + '%"></span></div>' : "") +
          "</div>" +
        "</a>" +
      "</div>" +
      '<div class="card-head">' +
        '<a class="card-title" href="' + href + '" data-video="' + esc(item.path) + '">' + esc(title) + "</a>" +
        '<div class="card-action card-menu">' +
          '<button type="button" class="info-btn" data-info data-path="' + esc(item.path) + '" aria-label="Menu for ' + esc(title) + '">' +
            '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
          "</button>" +
        "</div>" +
      "</div>" +
      (sub ? '<div class="card-meta">' + esc(sub) + "</div>" : "") +
      cardActions(item, mode) +
    "</article>"
  );
}

function cardActions(item, mode) {
  let button = "";
  if (mode === "continue") {
    button = '<div class="card-action"><button type="button" class="continue-remove" data-continue-remove data-path="' + esc(item.path) + '">Remove from list</button></div>';
  } else if (mode === "watchlater") {
    button = '<div class="card-action"><button type="button" class="continue-remove" data-watch-later data-path="' + esc(watchKey(item)) + '">Remove from Watch later</button></div>';
  } else {
    button = '<div class="card-action"><button type="button" class="continue-remove" data-watch-later data-path="' + esc(watchKey(item)) + '">' +
      (inWatchLater(item) ? "In Watch later" : "Watch later") +
    "</button></div>";
  }
  return '<div class="card-actions">' + button + "</div>";
}

function watchLaterItems() {
  const byKey = new Map(catalog.map((item) => [watchKey(item), item]));
  const later = [];
  for (const key of watchLaterIDs()) {
    const item = byKey.get(key);
    if (item) later.push(item);
  }
  return later;
}

function renderWatchLater() {
  const later = watchLaterItems();
  laterSection.classList.toggle("collapsed", laterCollapsed);
  document.getElementById("later-toggle").setAttribute("aria-expanded", laterCollapsed ? "false" : "true");
  const empty = document.getElementById("later-empty");
  laterRow.hidden = later.length === 0;
  if (empty) empty.hidden = later.length !== 0;
  laterRow.innerHTML = later.map((item) => cardHTML(item, "watchlater")).join("");
}

function watchLaterIDs() {
  if (me && me.id) return watchLater.slice();
  return localWatchLater();
}

function watchKey(item) {
  return item.absPath || item.path;
}

function inWatchLater(item) {
  const key = watchKey(item);
  return watchLaterIDs().some((saved) => saved === key || saved === item.path);
}

function saveWatchLater(list) {
  watchLater = list;
  if (me && me.id) {
    fetch("/api/watchlater", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: list })
    }).catch(() => {});
    return;
  }
  localStorage.setItem(WATCH_LATER, JSON.stringify(list));
}

function toggleWatchLater(key) {
  const had = watchLaterIDs().includes(key);
  const list = watchLaterIDs().filter((item) => item !== key);
  if (!had) list.push(key);
  saveWatchLater(list);
  const seriesView = document.getElementById("series-view");
  if (seriesView && !seriesView.hidden && seriesView.dataset.name) {
    showSeries(seriesView.dataset.name);
    return;
  }
  renderHome();
}

function noteLibraryVisit() {
  const who = me && me.id ? me.id : "anon";
  if (seenNotedFor === who) return;
  seenNotedFor = who;
  const now = Date.now() / 1000;
  if (me && me.id) {
    fetch("/api/seen", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ at: now })
    }).catch(() => {});
    return;
  }
  localStorage.setItem(SEEN_LIBRARY, String(now));
}

function isWatched(item) {
  const saved = entryFor(item);
  return !!(saved && saved.done);
}

function passesWatchFilter(item) {
  if (watchFilter === "watched") return isWatched(item);
  if (watchFilter === "unwatched") return !isWatched(item);
  return true;
}

function seriesEpisodes(name) {
  return catalog.filter((item) => item.series === name)
    .sort((a, b) => a.season - b.season || a.episode - b.episode || a.fullTitle.localeCompare(b.fullTitle));
}

function nextToPlay(episodes) {
  const resume = episodes.find((item) => {
    const saved = entryFor(item);
    return saved && !saved.done && saved.t >= RESUME_AT;
  });
  if (resume) return resume;
  return episodes.find((item) => !isWatched(item)) || episodes[0] || null;
}

function nextEpisode(item) {
  if (!item || !item.series) return null;
  const episodes = seriesEpisodes(item.series);
  const index = episodes.findIndex((other) => other.path === item.path);
  if (index < 0 || index + 1 >= episodes.length) return null;
  return episodes[index + 1];
}

function seriesUnit(name) {
  const episodes = seriesEpisodes(name);
  const latest = episodes.reduce((best, item) => ((item.mtime || 0) > (best || 0) ? item.mtime : best), 0);
  const play = nextToPlay(episodes);
  return {
    kind: "series",
    name,
    episodes,
    play,
    mtime: latest,
    duration: episodes.reduce((sum, item) => sum + (item.duration || 0), 0),
    size: episodes.reduce((sum, item) => sum + (item.size || 0), 0),
    path: (play && play.path) || (episodes[0] && episodes[0].path) || name
  };
}

function groupLibrary(items) {
  const units = [];
  const seen = new Set();
  for (const item of items) {
    if (!item.series) {
      units.push({
        kind: "movie",
        name: item.fullTitle,
        item,
        mtime: item.mtime || 0,
        duration: item.duration || 0,
        size: item.size || 0,
        path: item.displayPath || item.path
      });
      continue;
    }
    if (seen.has(item.series)) continue;
    seen.add(item.series);
    units.push(seriesUnit(item.series));
  }
  return units;
}

function compareUnits(a, b) {
  let diff = 0;
  if (sortKey === "newest") diff = (a.mtime || 0) - (b.mtime || 0);
  else if (sortKey === "longest") diff = (a.duration || 0) - (b.duration || 0);
  else if (sortKey === "size") diff = (a.size || 0) - (b.size || 0);
  else if (sortKey === "path") diff = String(a.path).localeCompare(String(b.path), undefined, { numeric: true });
  else diff = String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
  if (diff === 0) diff = String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
  return sortDesc ? -diff : diff;
}

function seriesCardHTML(unit) {
  const play = unit.play || unit.episodes[0];
  const left = unit.episodes.filter((item) => !isWatched(item)).length;
  const hue = hueOf(unit.name);
  const href = "#/series?s=" + encodeURIComponent(unit.name);
  let sub = unit.episodes.length === 1 ? "1 episode" : unit.episodes.length + " episodes";
  if (left && left < unit.episodes.length) sub += " · " + left + " left";
  const ratio = play ? progressRatio(play) : 0;
  const continueLabel = play && entryFor(play) && !isWatched(play) && entryFor(play).t >= RESUME_AT
    ? "Continue · Episode " + play.episode
    : (left ? "Play · Episode " + (play ? play.episode : 1) : "Play again");
  return (
    '<article class="card">' +
      '<div class="card-media">' +
        '<a class="card-open" href="' + href + '" data-series="' + esc(unit.name) + '">' +
          '<div class="thumb" style="--h:' + hue + ';background:linear-gradient(145deg,hsl(' + hue + ',55%,32%),hsl(' + ((hue + 36) % 360) + ',45%,14%))">' +
            '<div class="thumb-fallback">' + esc(initials(unit.name).toUpperCase()) + "</div>" +
            (play ? '<img class="thumb-img" alt="" loading="lazy" draggable="false" src="' + esc(thumbURL(play)) + '">' : "") +
            '<span class="badge">' + esc(String(unit.episodes.length)) + "</span>" +
            (ratio ? '<div class="thumb-progress"><span style="width:' + (ratio * 100).toFixed(1) + '%"></span></div>' : "") +
          "</div>" +
        "</a>" +
      "</div>" +
      '<div class="card-head">' +
        '<a class="card-title" href="' + href + '" data-series="' + esc(unit.name) + '">' + esc(unit.name) + "</a>" +
        '<div class="card-action card-menu">' +
          '<button type="button" class="info-btn" data-info data-series="' + esc(unit.name) + '" data-path="' + esc(play ? play.path : "") + '" aria-label="Menu for ' + esc(unit.name) + '">' +
            '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
          "</button>" +
        "</div>" +
      "</div>" +
      '<div class="card-meta">' + esc(sub) + "</div>" +
      (play
        ? '<div class="card-actions"><div class="card-action"><a class="continue-remove" href="#/watch?v=' + encodeURIComponent(play.path) + '" data-video="' + esc(play.path) + '">' + esc(continueLabel) + "</a></div></div>"
        : "") +
    "</article>"
  );
}

function nextHTML(item) {
  const hue = hueOf(item.fullTitle);
  return (
    '<a class="next" href="#/watch?v=' + encodeURIComponent(item.path) + '" data-video="' + esc(item.path) + '">' +
      '<div class="next-thumb" style="background:linear-gradient(145deg,hsl(' + hue + ',55%,32%),hsl(' + ((hue + 36) % 360) + ',45%,14%))">' +
        '<div class="next-fallback">' + esc(initials(item.series || item.fullTitle).toUpperCase()) + "</div>" +
        '<img alt="" loading="lazy" draggable="false" src="' + esc(thumbURL(item)) + '">' +
        '<span class="badge">' + esc(formatTime(item.duration)) + "</span>" +
      "</div>" +
      "<div>" +
        '<div class="next-title">' + esc(item.fullTitle) + "</div>" +
        '<div class="next-meta">' + esc(metaLine(item)) + "</div>" +
      "</div>" +
    "</a>"
  );
}

function filtered() {
  let items = catalog;
  if (mineOnly && me) items = items.filter((item) => item.mine);
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return items;
  const words = q.split(/\s+/);
  return items.filter((item) => {
    const hay = (item.fullTitle + " " + item.series + " " + item.name).toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

const SORT_DIRS = {
  name: ["A to Z", "Z to A"],
  newest: ["Oldest first", "Latest first"],
  longest: ["Shortest first", "Longest first"],
  size: ["Smallest first", "Largest first"],
  path: ["A to Z", "Z to A"]
};

function syncMineControl() {
  const wrap = document.getElementById("mine-only-wrap");
  const box = document.getElementById("mine-only");
  const menu = document.getElementById("account-mine");
  if (wrap) wrap.hidden = videoPlayer || !me;
  if (box) box.checked = mineOnly;
  if (menu) {
    menu.hidden = videoPlayer || !me;
    menu.textContent = mineOnly ? "Show all videos" : "My videos";
    menu.setAttribute("aria-pressed", mineOnly ? "true" : "false");
  }
}

function loadSort() {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_STORE)) || {};
    if (saved.v === 2 && SORT_DIRS[saved.key]) {
      sortKey = saved.key;
      sortDesc = !!saved.desc;
      groupByFolder = !!saved.group;
    }
  } catch {
    sortKey = "newest";
    sortDesc = true;
  }
}

function saveSort() {
  localStorage.setItem(SORT_STORE, JSON.stringify({ v: 2, key: sortKey, desc: sortDesc, group: groupByFolder }));
}

function syncSortControls() {
  const select = document.getElementById("sort-key");
  const button = document.getElementById("sort-dir");
  if (!select || !button) return;
  select.value = sortKey;
  const labels = SORT_DIRS[sortKey];
  button.textContent = labels[sortDesc ? 1 : 0];
  const group = document.getElementById("sort-group");
  const box = document.getElementById("group-folders");
  if (group && box) {
    group.hidden = sortKey !== "path";
    box.checked = groupByFolder;
  }
}

function folderLabel(item) {
  const full = item.displayPath || item.path;
  const slash = full.lastIndexOf("/");
  if (slash <= 0) return "Library";
  return full.slice(0, slash);
}

function collapsedFolders() {
  try {
    const saved = JSON.parse(localStorage.getItem(FOLDER_COLLAPSE));
    return new Set(Array.isArray(saved) ? saved : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedFolders(names) {
  localStorage.setItem(FOLDER_COLLAPSE, JSON.stringify([...names]));
}

function folderNode(path) {
  return { path: path, items: [], children: new Map() };
}

function folderTree(items) {
  const paths = items.map(folderLabel);
  const split = paths.map((path) => path.split("/"));
  let common = 0;
  if (split.length) {
    while (split[0][common] !== undefined && split.every((parts) => parts[common] === split[0][common])) common += 1;
  }
  const root = folderNode("");
  items.forEach((item) => {
    const parts = folderLabel(item).split("/");
    let node = root;
    for (let i = Math.max(common - 1, 0); i < parts.length; i += 1) {
      const path = parts.slice(0, i + 1).join("/");
      if (!node.children.has(path)) node.children.set(path, folderNode(path));
      node = node.children.get(path);
    }
    node.items.push(item);
  });
  return root;
}

function renderFolderNode(node) {
  const collapsed = collapsedFolders().has(node.path);
  const children = [...node.children.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  if (sortDesc) children.reverse();
  const files = node.items.slice().sort(compareItems);
  const grid = files.length ? '<div class="grid">' + files.map((item) => cardHTML(item, "plain")).join("") + "</div>" : "";
  return '<section class="shelf' + (collapsed ? " collapsed" : "") + '">' +
    '<button type="button" class="shelf-toggle" data-folder="' + esc(node.path) + '" aria-expanded="' + (collapsed ? "false" : "true") + '">' +
      '<span class="shelf-chevron" aria-hidden="true"></span>' +
      "<h2>" + esc(node.path) + "</h2>" +
    "</button>" +
    '<div class="folder-body">' + grid + children.map(renderFolderNode).join("") + "</div>" +
    "</section>";
}

function compareItems(a, b) {
  let diff = 0;
  if (sortKey === "newest") diff = (a.mtime || 0) - (b.mtime || 0);
  else if (sortKey === "longest") diff = (a.duration || 0) - (b.duration || 0);
  else if (sortKey === "size") diff = (a.size || 0) - (b.size || 0);
  else if (sortKey === "path") diff = (a.displayPath || a.path).localeCompare(b.displayPath || b.path, undefined, { numeric: true });
  else diff = a.fullTitle.localeCompare(b.fullTitle, undefined, { numeric: true });
  if (diff === 0) diff = a.fullTitle.localeCompare(b.fullTitle, undefined, { numeric: true });
  return sortDesc ? -diff : diff;
}

function showLibraryBrowser() {
  const browser = document.getElementById("library-browser");
  const series = document.getElementById("series-view");
  if (browser) browser.hidden = false;
  if (series) series.hidden = true;
}

function renderHome() {
  showLibraryBrowser();
  const q = searchInput.value.trim();
  const items = filtered().filter((item) => {
    if (watchFilter === "all") return true;
    if (!item.series) return passesWatchFilter(item);
    const episodes = seriesEpisodes(item.series);
    const allDone = episodes.length > 0 && episodes.every(isWatched);
    return watchFilter === "watched" ? allDone : !allDone;
  }).slice().sort(compareItems);
  const continuing = !q
    ? catalog
      .filter((item) => {
        const saved = progress[progressKey(item)];
        return saved && !saved.done && saved.t >= RESUME_AT;
      })
      .sort((a, b) => (progress[progressKey(b)].at || 0) - (progress[progressKey(a)].at || 0))
    : [];

  const recent = !q && seenLibrary
    ? catalog.filter((item) => (item.mtime || 0) > seenLibrary + 1).sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 24)
    : [];

  renderWatchLater();

  continueSection.hidden = continuing.length === 0;
  continueSection.classList.toggle("collapsed", continueCollapsed);
  document.getElementById("continue-toggle").setAttribute("aria-expanded", continueCollapsed ? "false" : "true");
  continueRow.innerHTML = continuing.map((item) => cardHTML(item, "continue")).join("");

  recentSection.hidden = recent.length === 0;
  recentSection.classList.toggle("collapsed", recentCollapsed);
  document.getElementById("recent-toggle").setAttribute("aria-expanded", recentCollapsed ? "false" : "true");
  recentRow.innerHTML = recent.map((item) => cardHTML(item, "plain")).join("");

  if (!items.length) {
    const empty = q ? "No videos match “" + esc(q) + "”." : (watchFilter !== "all" ? "Nothing matches this filter." : (mineOnly && me ? "No videos of yours yet." : "No videos in this folder."));
    libraryEl.innerHTML = '<p class="empty">' + empty + "</p>";
    return;
  }

  if (sortKey === "path" && groupByFolder) {
    const tree = folderTree(items);
    const top = [...tree.children.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    if (sortDesc) top.reverse();
    libraryEl.innerHTML = top.map(renderFolderNode).join("");
    return;
  }

  const units = groupLibrary(items).sort(compareUnits);
  const heading = q ? "Results" : "Library";
  libraryEl.innerHTML = '<section class="shelf"><h2>' + heading + '</h2><div class="grid">' +
    units.map((unit) => unit.kind === "series" ? seriesCardHTML(unit) : cardHTML(unit.item, "plain")).join("") +
    "</div></section>";
}

function showSeries(name) {
  const episodes = seriesEpisodes(name);
  if (!episodes.length) {
    showHome();
    setStatus("That series is not in the library.");
    return;
  }
  flushProgress();
  closeMenu();
  closeAccountMenu();
  closeInfoMenu();
  stopVideo();
  current = null;
  viewWatch.hidden = true;
  viewLogin.hidden = true;
  viewAdmin.hidden = true;
  viewSettings.hidden = true;
  viewHome.hidden = false;
  document.getElementById("library-browser").hidden = true;
  const view = document.getElementById("series-view");
  view.hidden = false;
  view.dataset.name = name;
  document.title = name + " · gomoov";
  document.getElementById("series-title").textContent = name;
  const left = episodes.filter((item) => !isWatched(item)).length;
  document.getElementById("series-meta").textContent = episodes.length + (episodes.length === 1 ? " episode" : " episodes") + (left ? " · " + left + " left" : " · finished");
  const play = nextToPlay(episodes);
  const button = document.getElementById("series-continue");
  button.hidden = !play;
  if (play) {
    const resumed = entryFor(play) && !isWatched(play) && entryFor(play).t >= RESUME_AT;
    button.textContent = (resumed ? "Continue" : (left ? "Play" : "Play again")) + " · Episode " + play.episode;
    button.dataset.path = play.path;
  }
  const seasons = new Map();
  for (const item of episodes) {
    const key = item.season || 1;
    if (!seasons.has(key)) seasons.set(key, []);
    seasons.get(key).push(item);
  }
  let html = "";
  for (const [season, eps] of seasons) {
    html += '<section class="shelf"><h2>Season ' + esc(String(season)) + '</h2><div class="grid">' +
      eps.map((item) => cardHTML(item, "episode")).join("") + "</div></section>";
  }
  document.getElementById("series-episodes").innerHTML = html;
  window.scrollTo(0, 0);
}

function upNextList(item) {
  const rest = catalog.filter((other) => other.path !== item.path);
  if (!item.series) {
    return rest.sort((a, b) => a.fullTitle.localeCompare(b.fullTitle));
  }
  const eps = catalog.filter((other) => other.series === item.series)
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  const index = eps.findIndex((other) => other.path === item.path);
  const others = rest.filter((other) => other.series !== item.series)
    .sort((a, b) => a.fullTitle.localeCompare(b.fullTitle));
  return eps.slice(index + 1).concat(eps.slice(0, index), others);
}

function showHome() {
  flushProgress();
  closeMenu();
  closeAccountMenu();
  subsToken += 1;
  subsCues = [];
  subsEl.innerHTML = "";
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  stopVideo();
  current = null;
  viewWatch.hidden = true;
  viewLogin.hidden = true;
  viewAdmin.hidden = true;
  viewSettings.hidden = true;
  viewHome.hidden = false;
  document.title = "gomoov";
  renderHome();
}

function cancelUpNext() {
  upNextToken += 1;
  window.clearInterval(upNextTimer);
  upNextTimer = 0;
  const gate = document.getElementById("up-next-gate");
  if (gate) gate.hidden = true;
}

function armUpNext(item) {
  cancelUpNext();
  const next = nextEpisode(item);
  if (!next) return;
  const gate = document.getElementById("up-next-gate");
  document.getElementById("up-next-title").textContent = next.fullTitle;
  const count = document.getElementById("up-next-count");
  let left = 8;
  count.textContent = "Playing in " + left + "s";
  gate.hidden = false;
  gate.dataset.path = next.path;
  const token = ++upNextToken;
  upNextTimer = window.setInterval(() => {
    if (token !== upNextToken) return;
    left -= 1;
    if (left <= 0) {
      const path = gate.dataset.path;
      cancelUpNext();
      if (!path) return;
      location.hash = "/watch?v=" + encodeURIComponent(path);
      route();
      return;
    }
    count.textContent = "Playing in " + left + "s";
  }, 1000);
}

function hidePreview() {
  previewToken += 1;
  window.clearTimeout(previewTimer);
  const preview = document.getElementById("timeline-preview");
  if (preview) preview.hidden = true;
}

function schedulePreview(ratio) {
  if (!current) return;
  if (isMobile() && !scrubbing) return;
  const dur = totalDuration();
  if (!dur) return;
  const preview = document.getElementById("timeline-preview");
  const left = Math.min(92, Math.max(8, ratio * 100));
  preview.style.left = left + "%";
  timelineTip.style.left = left + "%";
  timelineTip.hidden = false;
  timelineTip.textContent = formatTime(ratio * dur);
  window.clearTimeout(previewTimer);
  const at = ratio * dur;
  previewTimer = window.setTimeout(() => {
    const token = ++previewToken;
    const img = document.getElementById("timeline-preview-img");
    const url = "/frame?path=" + encodeURIComponent(current.path) + "&t=" + at.toFixed(2);
    const show = () => {
      if (token === previewToken) preview.hidden = false;
    };
    img.onload = show;
    img.onerror = () => {
      if (token === previewToken) preview.hidden = true;
    };
    if (img.getAttribute("src") === url && img.complete && img.naturalWidth) {
      show();
      return;
    }
    img.src = url;
  }, 140);
}

function stopVideo() {
  playToken += 1;
  cancelUpNext();
  hidePreview();
  ignoreMedia = true;
  video.pause();
  video.removeAttribute("src");
  video.load();
  ignoreMedia = false;
}

function syncTransport() {
  const paused = video.paused;
  stage.classList.toggle("paused", paused);
  stage.classList.toggle("muted", video.muted || video.volume === 0);
  playBtn.setAttribute("aria-label", paused ? "Play" : "Pause");
  bigPlay.setAttribute("aria-label", paused ? "Play" : "Pause");
  muteBtn.setAttribute("aria-label", stage.classList.contains("muted") ? "Unmute" : "Mute");
  const full = !!document.fullscreenElement;
  fullscreenBtn.querySelector(".icon-expand").hidden = full;
  fullscreenBtn.querySelector(".icon-shrink").hidden = !full;
  fullscreenBtn.setAttribute("aria-label", full ? "Exit full screen" : "Full screen");
}

function paintTimeline(ratio) {
  const dur = totalDuration();
  const shown = scrubbing ? scrubRatio : (dur ? realTime() / dur : 0);
  const played = Math.max(0, Math.min(1, shown));
  timelinePlay.style.width = (played * 100) + "%";
  miniPlay.style.width = (played * 100) + "%";
  let buffered = 0;
  if (dur && video.buffered && video.buffered.length) {
    buffered = (streamStart + video.buffered.end(video.buffered.length - 1)) / dur;
  }
  timelineBuf.style.width = (Math.max(0, Math.min(1, buffered)) * 100) + "%";
  timeLabel.textContent = formatTime(scrubbing ? scrubRatio * dur : realTime()) + " / " + formatTime(dur);
  if (ratio !== undefined) return played;
  return played;
}

function needsEncode() {
  if (!current) return false;
  if (current.videoCodec && current.videoCodec !== "h264") return true;
  if (qualityChoice && current.height && qualityChoice < current.height - 8) return true;
  if (subChoice && !subChoice.text) return true;
  return false;
}

function setBuffering(on, text) {
  stage.classList.toggle("buffering", on);
  const label = document.getElementById("buffer-label");
  if (!label) return;
  if (!on) {
    label.hidden = true;
    return;
  }
  label.hidden = false;
  label.textContent = text || (needsEncode() ? "Waiting for the encoder…" : "Waiting…");
}

function showKeyframeGap(asked, start) {
  const note = document.getElementById("keyframe-note");
  if (!note) return;
  const gap = asked - start;
  if (gap > 0.8) {
    const rounded = Math.max(1, Math.round(gap));
    note.hidden = false;
    note.textContent = "This copy starts about " + rounded + " second" + (rounded === 1 ? "" : "s") + " early, at the previous keyframe.";
  } else {
    note.hidden = true;
    note.textContent = "";
  }
}

function dropQualityGhost() {
  const ghost = qualityGhost;
  qualityGhost = null;
  if (!ghost) return;
  ghost.pause();
  ghost.removeAttribute("src");
  ghost.load();
  ghost.remove();
}

function showPlayerError(text) {
  setBuffering(false);
  playerMessageText.textContent = text;
  playerMessage.hidden = false;
}

function hidePlayerError() {
  playerMessage.hidden = true;
}

function canLocalSeek(localTarget) {
  const ranges = video.buffered;
  if (!ranges) return false;
  for (let i = 0; i < ranges.length; i += 1) {
    if (localTarget >= ranges.start(i) + 0.15 && localTarget <= ranges.end(i) - 0.35) return true;
  }
  return false;
}

async function originFor(t) {
  if (!current || t < 0.2) return t;
  const params = new URLSearchParams();
  params.set("path", current.path);
  params.set("t", t.toFixed(3));
  params.set("q", String(qualityChoice || 0));
  if (subChoice && !subChoice.text) params.set("s", String(subChoice.id));
  try {
    const response = await fetch("/start?" + params.toString());
    if (!response.ok) return t;
    const data = await response.json();
    const start = Number(data.start);
    if (Number.isFinite(start) && start >= 0 && start <= t + 0.05 && t - start < 90) return start;
  } catch {
    /* keep the requested time */
  }
  return t;
}

async function restartAt(seconds, resume) {
  if (!current) return;
  dropQualityGhost();
  const dur = totalDuration();
  const t = Math.max(0, Math.min(seconds, dur > 1 ? dur - 0.4 : seconds));
  const token = ++playToken;
  ignoreMedia = true;
  hidePlayerError();
  setBuffering(true);
  // A copied video starts on the previous keyframe. Subtitles follow that
  // real time, not the time that was asked for, or they drift from the voice.
  const start = await originFor(t);
  if (token !== playToken) return;
  streamStart = start;
  showKeyframeGap(t, start);
  video.src = streamURL(current.path, t);
  video.addEventListener("loadeddata", () => {
    if (token !== playToken) return;
    ignoreMedia = false;
    video.playbackRate = playbackRate;
    paintTimeline();
    paintSubs();
  }, { once: true });
  if (resume) {
    const pending = video.play();
    if (pending) pending.catch(() => setBuffering(false));
  }
}

function seekTo(seconds, resume) {
  const local = seconds - streamStart;
  if (local >= 0 && canLocalSeek(local)) {
    video.currentTime = local;
    if (resume) video.play().catch(() => {});
    flushProgress();
    paintTimeline();
    return;
  }
  restartAt(seconds, resume);
}

function openVideo(item, startAt) {
  cancelUpNext();
  hidePreview();
  flushProgress();
  current = item;
  viewHome.hidden = true;
  viewWatch.hidden = false;
  document.title = item.fullTitle + " · gomoov";
  watchTitle.textContent = item.fullTitle;
  const bits = [formatTime(item.duration), item.quality, item.edition, item.sizeLabel, item.private ? "Private" : ""].filter(Boolean);
  watchMeta.textContent = bits.join(" · ");
  if (item.videoCodec && item.videoCodec !== "h264") {
    codecHint.hidden = false;
    codecHint.textContent = "This file is " + item.videoCodec.toUpperCase() + ", so it is converted while you watch. Seeking can take a moment.";
  } else {
    codecHint.hidden = true;
    codecHint.textContent = "";
  }
  upNextEl.innerHTML = upNextList(item).map(nextHTML).join("") || '<p class="empty">Nothing else in the library.</p>';
  window.scrollTo(0, 0);

  qualityChoice = pickQuality(item);
  audioChoice = pickAudio(item);
  subChoice = pickSub(item);
  const saved = entryFor(item);
  const start = startAt != null ? startAt : (saved && !saved.done && saved.t >= RESUME_AT ? saved.t : 0);
  startOverBtn.hidden = start < RESUME_AT;
  startOverBtn.textContent = start >= RESUME_AT
    ? "Start from beginning · resumed at " + formatTime(start)
    : "Start from beginning";
  restartAt(start, true);
  loadTextSubs();
  showChrome();
}

function parseRoute() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const q = hash.indexOf("?");
  const pathname = q === -1 ? hash : hash.slice(0, q);
  const params = new URLSearchParams(q === -1 ? "" : hash.slice(q + 1));
  return { pathname, video: params.get("v"), user: params.get("u"), t: params.get("t"), series: params.get("s") };
}

function routeTime(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function route() {
  if (me && me.mustChangePassword) {
    showPasswordGate(true);
    return;
  }
  const { pathname, video: path, user: userID, t, series } = parseRoute();
  if (videoPlayer && (pathname === "/login" || pathname === "/users" || pathname === "/admin" || pathname === "/settings")) {
    location.hash = "/";
    return;
  }
  if (pathname === "/login") {
    if (me) {
      location.hash = "/";
      return;
    }
    showLogin();
    return;
  }
  if (pathname === "/admin" || pathname === "/users") {
    if (!me || !me.admin) {
      location.hash = "/";
      return;
    }
    const tab = userID ? "users" : (new URLSearchParams((location.hash.split("?")[1] || "")).get("tab") || "users");
    showAdmin(tab);
    if (userID) showUser(userID);
    return;
  }
  if (pathname === "/settings") {
    if (!me) {
      location.hash = "/login";
      return;
    }
    const tab = new URLSearchParams((location.hash.split("?")[1] || "")).get("tab") || "password";
    showSettings(tab);
    return;
  }
  if (pathname === "/series" && series) {
    showSeries(series);
    return;
  }
  if (pathname === "/watch" && path) {
    const item = catalog.find((entry) => entry.path === path);
    if (!item) {
      showHome();
      setStatus("That video is not in the library.");
      return;
    }
    const startAt = routeTime(t);
    if (current && current.path === path && video.getAttribute("src")) {
      if (startAt != null) seekTo(startAt, true);
      return;
    }
    setStatus("");
    openVideo(item, startAt);
    return;
  }
  showHome();
}

function pointX(event) {
  if (event.touches && event.touches.length) return event.touches[0].clientX;
  if (event.changedTouches && event.changedTouches.length) return event.changedTouches[0].clientX;
  return event.clientX;
}

function ratioOn(el, event) {
  const rect = el.getBoundingClientRect();
  if (!rect.width) return 0;
  return Math.min(1, Math.max(0, (pointX(event) - rect.left) / rect.width));
}

function ratioFromEvent(event) {
  return ratioOn(timeline, event);
}

function togglePlay() {
  if (!current) return;
  cancelUpNext();
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function toggleMute() {
  video.muted = !video.muted;
  if (!video.muted && video.volume === 0) {
    video.volume = 0.6;
    volumeInput.value = "0.6";
  }
  syncTransport();
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen().catch(() => {});
  showChrome();
}

function isMobile() {
  return window.matchMedia("(max-width: 1100px)").matches;
}

function showPlayButton() {
  if (!isMobile()) return;
  stage.classList.add("show-play");
  window.clearTimeout(playBtnTimer);
  playBtnTimer = window.setTimeout(() => stage.classList.remove("show-play"), 3000);
}

function hidePlayButton() {
  window.clearTimeout(playBtnTimer);
  stage.classList.remove("show-play");
}

function showChrome() {
  window.clearTimeout(hideTimer);
  stage.classList.add("active");
  if (scrubbing || stage.classList.contains("menu-open")) return;
  if (isMobile()) {
    hideTimer = window.setTimeout(hideChrome, 5000);
    return;
  }
  if (!video.paused) hideTimer = window.setTimeout(hideChrome, 2500);
}

function hideChrome() {
  if (scrubbing || stage.classList.contains("menu-open") || stage.classList.contains("keys-open")) return;
  stage.classList.remove("active");
}

function toggleKeys(force) {
  const panel = document.getElementById("keys-panel");
  const open = force == null ? panel.hidden : !!force;
  panel.hidden = !open;
  stage.classList.toggle("keys-open", open);
  if (open) showChrome();
}

async function copyTimeLink() {
  if (!current) return;
  const t = Math.max(0, Math.floor(realTime()));
  const url = location.origin + location.pathname + location.search + "#/watch?v=" + encodeURIComponent(current.path) + "&t=" + t;
  try {
    await navigator.clipboard.writeText(url);
    setStatus("Link copied.");
  } catch {
    setStatus(url);
  }
  window.setTimeout(() => {
    if (statusEl.textContent === "Link copied." || statusEl.textContent === url) setStatus("");
  }, 2500);
}

function toggleTheater() {
  const on = !viewWatch.classList.contains("theater");
  viewWatch.classList.toggle("theater", on);
  localStorage.setItem(THEATER_KEY, on ? "1" : "0");
  theaterBtn.setAttribute("aria-pressed", on ? "true" : "false");
  showChrome();
}

function applyTheater() {
  const on = localStorage.getItem(THEATER_KEY) === "1";
  viewWatch.classList.toggle("theater", on);
  theaterBtn.setAttribute("aria-pressed", on ? "true" : "false");
}

function closeMenu() {
  menuEl.hidden = true;
  menuBtn.setAttribute("aria-expanded", "false");
  stage.classList.remove("menu-open");
}

function toggleMenu() {
  const open = menuEl.hidden;
  if (open) {
    menuPage = "root";
    renderMenu();
  }
  menuEl.hidden = !open;
  menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  stage.classList.toggle("menu-open", open);
  if (open) showChrome();
}

function setRate(rate) {
  playbackRate = rate;
  video.playbackRate = rate;
  localStorage.setItem(RATE_KEY, String(rate));
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs(patch) {
  localStorage.setItem(PREF_KEY, JSON.stringify(Object.assign(loadPrefs(), patch)));
}

function qualityOptions(item) {
  const height = item && item.height ? item.height : 0;
  const options = [{ id: 0, label: height ? "Original (" + height + "p)" : "Original" }];
  for (const step of QUALITY_STEPS) {
    if (!height || step < height - 16) options.push({ id: step, label: step + "p" });
  }
  return options;
}

function pickQuality(item) {
  const saved = Number(loadPrefs().quality) || 0;
  return qualityOptions(item).some((option) => option.id === saved) ? saved : 0;
}

function pickAudio(item) {
  const tracks = item.audioTracks || [];
  if (!tracks.length) return null;
  const lang = loadPrefs().audioLang || "";
  if (lang) {
    const match = tracks.find((track) => track.language === lang);
    if (match) return match;
  }
  return tracks[0];
}

function pickSub(item) {
  const tracks = item.subtitles || [];
  const prefs = loadPrefs();
  if (prefs.subMode !== "on" || !tracks.length) return null;
  if (prefs.subLang) {
    const match = tracks.find((track) => track.language === prefs.subLang);
    if (match) return match;
  }
  return tracks[0];
}

function qualityText() {
  if (!qualityChoice) {
    const height = current && current.height;
    return height ? "Original (" + height + "p)" : "Original";
  }
  return qualityChoice + "p";
}

function rateText(rate) {
  return rate === 1 ? "Normal" : rate + "×";
}

function applyPlaybackChange() {
  if (!current) return;
  const resume = !video.paused;
  const at = realTime();
  restartAt(at, resume);
}

async function selectQuality(value) {
  const next = Number(value) || 0;
  if (next === qualityChoice) return;
  const at = current ? realTime() : 0;
  const resume = !!(current && !video.paused);
  qualityChoice = next;
  savePrefs({ quality: next });
  if (!current || !video.getAttribute("src")) return;
  dropQualityGhost();
  const token = ++playToken;
  setBuffering(true, "Switching to " + qualityText() + "…");
  const start = await originFor(at);
  if (token !== playToken || !current) return;
  const ghost = document.createElement("video");
  ghost.playsInline = true;
  ghost.preload = "auto";
  ghost.muted = true;
  ghost.className = "quality-ghost";
  qualityGhost = ghost;
  video.insertAdjacentElement("afterend", ghost);
  ghost.addEventListener("error", () => {
    if (token !== playToken || qualityGhost !== ghost) return;
    dropQualityGhost();
    setBuffering(false);
    setStatus("That quality could not be started.");
  }, { once: true });
  ghost.addEventListener("loadeddata", () => {
    if (token !== playToken || !current || qualityGhost !== ghost) {
      if (qualityGhost === ghost) dropQualityGhost();
      return;
    }
    qualityGhost = null;
    streamStart = start;
    ghost.muted = video.muted;
    ghost.volume = video.volume;
    ghost.playbackRate = playbackRate;
    const old = video;
    ghost.id = "video";
    ghost.classList.remove("quality-ghost");
    old.removeAttribute("id");
    old.replaceWith(ghost);
    video = ghost;
    attachVideo(video);
    old.pause();
    old.removeAttribute("src");
    old.load();
    ignoreMedia = false;
    showKeyframeGap(at, start);
    paintTimeline();
    paintSubs();
    if (resume) {
      const pending = video.play();
      if (pending) pending.catch(() => setBuffering(false));
    } else {
      setBuffering(false);
    }
  }, { once: true });
  ghost.src = streamURL(current.path, at);
}

function selectAudio(id) {
  const tracks = (current && current.audioTracks) || [];
  const track = tracks.find((item) => item.id === id);
  if (!track || (audioChoice && audioChoice.id === track.id)) return;
  audioChoice = track;
  savePrefs({ audioLang: track.language || "" });
  applyPlaybackChange();
}

function selectSub(id) {
  const tracks = (current && current.subtitles) || [];
  const track = id === null ? null : tracks.find((item) => item.id === id) || null;
  const wasBurned = !!(subChoice && !subChoice.text);
  if ((subChoice && subChoice.id) === (track && track.id)) return;
  subChoice = track;
  savePrefs({
    subMode: track ? "on" : "off",
    subLang: track ? (track.language || "") : ""
  });
  const burns = !!(track && !track.text);
  if (wasBurned || burns) applyPlaybackChange();
  loadTextSubs();
}

function parseVtt(text) {
  const cues = [];
  const lines = text.replace(/\r/g, "").split("\n");
  const stamp = /(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/;
  const toSec = (h, m, s, ms) => (Number(h) || 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(stamp);
    if (!match) {
      i += 1;
      continue;
    }
    const start = toSec(match[1], match[2], match[3], match[4]);
    const end = toSec(match[5], match[6], match[7], match[8]);
    i += 1;
    const body = [];
    while (i < lines.length && lines[i].trim() !== "") {
      body.push(lines[i]);
      i += 1;
    }
    const html = body.join("\n")
      .replace(/\{\\[^}]*\}/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
    if (html.trim()) cues.push({ start, end, html });
  }
  return cues;
}

function paintSubs() {
  if (!subChoice || !subChoice.text || !subsCues.length) {
    if (subsEl.innerHTML) subsEl.innerHTML = "";
    return;
  }
  const t = realTime();
  let html = "";
  for (const cue of subsCues) {
    if (t >= cue.start && t < cue.end) html += (html ? "<br>" : "") + cue.html;
  }
  if (subsEl.innerHTML !== html) subsEl.innerHTML = html;
}

async function loadTextSubs() {
  const token = ++subsToken;
  subsCues = [];
  subsEl.innerHTML = "";
  if (!current || !subChoice || !subChoice.text) return;
  try {
    const response = await fetch("/subs?path=" + encodeURIComponent(current.path) + "&id=" + encodeURIComponent(String(subChoice.id)));
    if (!response.ok || token !== subsToken) return;
    const text = await response.text();
    if (token !== subsToken) return;
    subsCues = parseVtt(text);
    paintSubs();
  } catch {
    /* the picture keeps playing without captions */
  }
}

function menuOption(kind, value, label, checked) {
  return '<button type="button" class="menu-option" data-pick="' + kind + '" data-value="' + esc(value) + '" aria-checked="' + (checked ? "true" : "false") + '">' + esc(label) + "</button>";
}

function renderMenu() {
  if (!menuEl) return;
  if (menuPage === "root") {
    const language = audioChoice ? audioChoice.label : "Default";
    const subtitles = subChoice ? subChoice.label : "Off";
    menuEl.innerHTML = [
      '<button type="button" class="menu-row" data-menu="speed"><span>Playback speed</span><span class="menu-value">' + esc(rateText(playbackRate)) + " ›</span></button>",
      '<button type="button" class="menu-row" data-menu="quality"><span>Quality</span><span class="menu-value">' + esc(qualityText()) + " ›</span></button>",
      '<button type="button" class="menu-row" data-menu="language"><span>Language</span><span class="menu-value">' + esc(language) + " ›</span></button>",
      '<button type="button" class="menu-row" data-menu="subtitles"><span>Subtitles</span><span class="menu-value">' + esc(subtitles) + " ›</span></button>",
      '<button type="button" class="menu-row" data-menu="info"><span>Info</span><span class="menu-value">›</span></button>'
    ].join("");
    return;
  }
  const titles = { speed: "Playback speed", quality: "Quality", language: "Language", subtitles: "Subtitles" };
  const parts = ['<button type="button" class="menu-back" data-menu="root">‹ ' + esc(titles[menuPage] || "Settings") + "</button>"];
  if (menuPage === "speed") {
    for (const rate of SPEEDS) parts.push(menuOption("speed", rate, rateText(rate), rate === playbackRate));
  } else if (menuPage === "quality") {
    for (const option of qualityOptions(current)) {
      parts.push(menuOption("quality", option.id, option.label, option.id === qualityChoice));
    }
  } else if (menuPage === "language") {
    const tracks = (current && current.audioTracks) || [];
    if (!tracks.length) parts.push('<p class="menu-note">This video has one audio track.</p>');
    for (const track of tracks) {
      parts.push(menuOption("language", track.id, track.label, !!(audioChoice && audioChoice.id === track.id)));
    }
  } else if (menuPage === "subtitles") {
    parts.push(menuOption("subtitles", "off", "Off", !subChoice));
    const tracks = (current && current.subtitles) || [];
    if (!tracks.length) parts.push('<p class="menu-note">No subtitles in this file.</p>');
    for (const track of tracks) {
      const label = track.text ? track.label : track.label + " (picture)";
      parts.push(menuOption("subtitles", track.id, label, !!(subChoice && subChoice.id === track.id)));
    }
    if (tracks.some((track) => !track.text)) {
      parts.push('<p class="menu-note">Picture subtitles are drawn into the video, so playback restarts.</p>');
    }
  }
  menuEl.innerHTML = parts.join("");
}

function armRefreshWatch() {
  window.clearTimeout(refreshTimer);
  const gen = ++refreshGen;
  refreshTimer = window.setTimeout(() => {
    if (gen !== refreshGen) return;
    document.getElementById("refresh-wait").hidden = false;
  }, 8000);
}

function refreshSettled() {
  refreshGen += 1;
  window.clearTimeout(refreshTimer);
  const button = document.getElementById("refresh");
  if (button) button.disabled = false;
  document.getElementById("refresh-wait").hidden = true;
}

function stopRefresh() {
  if (libraryAbort) libraryAbort.abort();
  libraryAbort = null;
  refreshSettled();
}

async function refreshLibrary() {
  if (libraryAbort) libraryAbort.abort();
  const controller = new AbortController();
  libraryAbort = controller;
  const button = document.getElementById("refresh");
  if (button) button.disabled = true;
  armRefreshWatch();
  try {
    const response = await fetch("/api/library", { signal: controller.signal });
    if (!response.ok) throw new Error("bad status");
    const data = await response.json();
    if (controller.signal.aborted) return;
    catalog = applyCatalog(data.videos || []);
    await loadServerProgress();
    if (!viewHome.hidden) renderHome();
    setStatus("");
  } catch (err) {
    if (err.name === "AbortError") return;
    setStatus("Could not refresh the library.");
  } finally {
    if (libraryAbort === controller) libraryAbort = null;
    refreshSettled();
  }
}

function nudge(seconds) {
  showChrome();
  seekTo(realTime() + seconds, !video.paused);
}

document.getElementById("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
});

const searchToggle = document.getElementById("search-toggle");
const topbar = document.querySelector(".topbar");
searchToggle.addEventListener("click", () => {
  topbar.classList.add("search-open");
  searchInput.focus();
});
searchInput.addEventListener("blur", () => {
  if (!searchInput.value.trim()) topbar.classList.remove("search-open");
});

searchInput.addEventListener("input", () => {
  const seriesView = document.getElementById("series-view");
  if (seriesView && !seriesView.hidden) {
    location.hash = "/";
    showHome();
    return;
  }
  if (!viewHome.hidden) renderHome();
});

loadSort();
syncSortControls();
document.getElementById("sort-key").addEventListener("change", (event) => {
  sortKey = event.target.value;
  sortDesc = sortKey === "newest" || sortKey === "longest" || sortKey === "size";
  saveSort();
  syncSortControls();
  renderHome();
});
document.getElementById("sort-dir").addEventListener("click", () => {
  sortDesc = !sortDesc;
  saveSort();
  syncSortControls();
  renderHome();
});
document.getElementById("group-folders").addEventListener("change", (event) => {
  groupByFolder = event.target.checked;
  saveSort();
  renderHome();
});
watchFilter = localStorage.getItem(WATCH_FILTER) || "all";
if (!["all", "unwatched", "watched"].includes(watchFilter)) watchFilter = "all";
document.getElementById("watch-filter").value = watchFilter;
document.getElementById("watch-filter").addEventListener("change", (event) => {
  watchFilter = event.target.value;
  localStorage.setItem(WATCH_FILTER, watchFilter);
  renderHome();
});
mineOnly = localStorage.getItem(MINE_ONLY) === "1";
document.getElementById("mine-only").addEventListener("change", (event) => {
  mineOnly = event.target.checked;
  localStorage.setItem(MINE_ONLY, mineOnly ? "1" : "0");
  syncMineControl();
  renderHome();
});
continueCollapsed = localStorage.getItem(CONTINUE_COLLAPSE) === "1";
laterCollapsed = localStorage.getItem(LATER_COLLAPSE) === "1";
recentCollapsed = localStorage.getItem(RECENT_COLLAPSE) === "1";
document.getElementById("continue-toggle").addEventListener("click", () => {
  continueCollapsed = !continueCollapsed;
  localStorage.setItem(CONTINUE_COLLAPSE, continueCollapsed ? "1" : "0");
  continueSection.classList.toggle("collapsed", continueCollapsed);
  document.getElementById("continue-toggle").setAttribute("aria-expanded", continueCollapsed ? "false" : "true");
});
document.getElementById("later-toggle").addEventListener("click", () => {
  laterCollapsed = !laterCollapsed;
  localStorage.setItem(LATER_COLLAPSE, laterCollapsed ? "1" : "0");
  laterSection.classList.toggle("collapsed", laterCollapsed);
  document.getElementById("later-toggle").setAttribute("aria-expanded", laterCollapsed ? "false" : "true");
});
document.getElementById("recent-toggle").addEventListener("click", () => {
  recentCollapsed = !recentCollapsed;
  localStorage.setItem(RECENT_COLLAPSE, recentCollapsed ? "1" : "0");
  recentSection.classList.toggle("collapsed", recentCollapsed);
  document.getElementById("recent-toggle").setAttribute("aria-expanded", recentCollapsed ? "false" : "true");
});

let infoTarget = "";

function closeInfoMenu() {
  const menu = document.getElementById("info-menu");
  menu.hidden = true;
  document.querySelectorAll(".info-btn[aria-expanded='true']").forEach((btn) => btn.setAttribute("aria-expanded", "false"));
}

function filePathLabel(item) {
  return item.displayPath || item.path;
}

function setWatched(item, done) {
  if (!item) return;
  if (done) sendProgress(item.path, { t: 0, dur: item.duration || 0, at: Date.now(), done: true });
  else sendProgress(item.path, null);
}

function markInfoWatched() {
  const done = document.getElementById("info-watched").textContent.indexOf("unwatched") === -1;
  if (infoSeries) {
    seriesEpisodes(infoSeries).forEach((item) => setWatched(item, done));
  } else {
    setWatched(catalog.find((entry) => entry.path === infoTarget) || current, done);
  }
  closeInfoMenu();
  const seriesView = document.getElementById("series-view");
  if (seriesView && !seriesView.hidden && seriesView.dataset.name) showSeries(seriesView.dataset.name);
  else if (!viewHome.hidden) renderHome();
}

function openInfoFor(item, anchor) {
  if (!item) return;
  infoSeries = anchor && anchor.dataset.series || "";
  infoTarget = item.path;
  document.getElementById("info-quality").textContent = [item.quality, item.edition, item.sizeLabel].filter(Boolean).join(" · ") || "Unknown";
  const languages = (item.audioTracks || []).map((track) => track.label);
  document.getElementById("info-language").textContent = languages.join(", ") || "Unknown";
  document.getElementById("info-duration").textContent = formatTime(item.duration);
  document.getElementById("info-path").textContent = filePathLabel(item);
  const visibility = item.ownerId
    ? (item.private ? "Private" : "Public") + (item.ownerName ? " · " + item.ownerName : "")
    : "Public";
  document.getElementById("info-visibility").textContent = visibility;
  const privacyBtn = document.getElementById("info-privacy");
  const canPrivacy = !!(item.ownerId && me && (item.mine || me.admin));
  privacyBtn.hidden = !canPrivacy;
  privacyBtn.textContent = item.private ? "Make public" : "Make private";
  document.getElementById("info-remove").hidden = infoSeries || !item.canRemove;
  const watchedBtn = document.getElementById("info-watched");
  if (infoSeries) {
    const episodes = seriesEpisodes(infoSeries);
    const allDone = episodes.length > 0 && episodes.every(isWatched);
    watchedBtn.hidden = false;
    watchedBtn.textContent = allDone ? "Mark unwatched" : "Mark watched";
    document.getElementById("info-duration").textContent = episodes.length + (episodes.length === 1 ? " episode" : " episodes");
    document.getElementById("info-path").textContent = infoSeries;
    document.getElementById("info-privacy").hidden = true;
  } else {
    watchedBtn.hidden = false;
    watchedBtn.textContent = isWatched(item) ? "Mark unwatched" : "Mark watched";
  }
  document.querySelectorAll(".info-btn[aria-expanded='true']").forEach((btn) => btn.setAttribute("aria-expanded", "false"));
  if (anchor && anchor.classList && anchor.classList.contains("info-btn")) anchor.setAttribute("aria-expanded", "true");
  const menu = document.getElementById("info-menu");
  menu.hidden = false;
  const rect = (anchor || menuBtn).getBoundingClientRect();
  menu.style.left = "0px";
  menu.style.top = "0px";
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + 6;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  menu.style.left = Math.max(8, left) + "px";
  menu.style.top = Math.max(8, top) + "px";
}

function openRemoveConfirm() {
  const item = catalog.find((entry) => entry.path === infoTarget);
  if (!item) return;
  closeInfoMenu();
  document.getElementById("confirm-name").textContent = item.fullTitle;
  document.getElementById("confirm-path").textContent = filePathLabel(item);
  document.getElementById("confirm-error").hidden = true;
  document.getElementById("confirm").hidden = false;
}

function closeRemoveConfirm() {
  document.getElementById("confirm").hidden = true;
}

async function removeCurrentFile() {
  const path = infoTarget;
  const errorEl = document.getElementById("confirm-error");
  errorEl.hidden = true;
  try {
    const response = await fetch("/api/video?path=" + encodeURIComponent(path), { method: "DELETE" });
    if (!response.ok) throw new Error("could not remove");
  } catch {
    errorEl.textContent = "The file could not be removed.";
    errorEl.hidden = false;
    return;
  }
  sendProgress(path, null);
  closeRemoveConfirm();
  if (current && current.path === path) location.hash = "/";
  await reloadLibrary();
}

async function reloadLibrary() {
  const response = await fetch("/api/library");
  if (!response.ok) throw new Error("bad status");
  const data = await response.json();
  catalog = applyCatalog(data.videos || []);
  if (!viewHome.hidden) renderHome();
  else if (current) upNextEl.innerHTML = upNextList(current).map(nextHTML).join("") || '<p class="empty">Nothing else in the library.</p>';
}

function applyCatalog(videos) {
  const items = videos.map(decorate);
  const titles = items.map((item) => item.fullTitle);
  const dupes = new Set(titles.filter((title, index) => titles.indexOf(title) !== index));
  for (const item of items) {
    if (dupes.has(item.fullTitle) && item.edition) {
      item.fullTitle = item.fullTitle + " · " + item.edition;
      if (!item.series) item.cardTitle = item.fullTitle;
    }
  }
  return items;
}

document.getElementById("info-remove").addEventListener("click", openRemoveConfirm);
document.getElementById("info-watched").addEventListener("click", markInfoWatched);
document.getElementById("series-back").addEventListener("click", () => {
  location.hash = "/";
  showHome();
});
document.getElementById("series-continue").addEventListener("click", () => {
  const path = document.getElementById("series-continue").dataset.path;
  if (!path) return;
  location.hash = "/watch?v=" + encodeURIComponent(path);
  route();
});
document.getElementById("confirm-no").addEventListener("click", closeRemoveConfirm);
document.getElementById("confirm-yes").addEventListener("click", removeCurrentFile);
document.getElementById("confirm").addEventListener("click", (event) => {
  if (event.target.id === "confirm") closeRemoveConfirm();
});

document.body.addEventListener("click", (event) => {
  const folderBtn = event.target.closest("[data-folder]");
  if (folderBtn) {
    event.preventDefault();
    const name = folderBtn.getAttribute("data-folder");
    const names = collapsedFolders();
    const collapsed = !names.has(name);
    if (collapsed) names.add(name);
    else names.delete(name);
    saveCollapsedFolders(names);
    const section = folderBtn.closest(".shelf");
    if (section) section.classList.toggle("collapsed", collapsed);
    folderBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    return;
  }
  const drop = event.target.closest("[data-continue-remove]");
  if (drop) {
    event.preventDefault();
    event.stopPropagation();
    sendProgress(drop.dataset.path, null);
    renderHome();
    return;
  }
  const actionPad = event.target.closest(".card-action");
  if (actionPad && !event.target.closest("button")) {
    const button = actionPad.querySelector("button");
    if (button) button.click();
    return;
  }
  const laterBtn = event.target.closest("[data-watch-later]");
  if (laterBtn) {
    event.preventDefault();
    event.stopPropagation();
    toggleWatchLater(laterBtn.dataset.path);
    return;
  }
  const info = event.target.closest("[data-info]");
  if (info) {
    event.preventDefault();
    event.stopPropagation();
    openInfoFor(catalog.find((entry) => entry.path === info.dataset.path), info);
    return;
  }
  if (!event.target.closest("#info-menu")) closeInfoMenu();
  const seriesLink = event.target.closest("a[data-series]");
  if (seriesLink) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    location.hash = "/series?s=" + encodeURIComponent(seriesLink.dataset.series);
    route();
    return;
  }
  const link = event.target.closest("a[data-video]");
  if (!link) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const path = link.getAttribute("data-video");
  const next = "/watch?v=" + encodeURIComponent(path);
  if ((location.hash.replace(/^#/, "") || "/") === next && current && current.path === path) return;
  location.hash = next;
  route();
});

document.body.addEventListener("error", (event) => {
  const img = event.target;
  if (img && img.tagName === "IMG") img.hidden = true;
}, true);

playBtn.addEventListener("click", togglePlay);
document.getElementById("refresh").addEventListener("click", () => {
  refreshLibrary();
});
document.getElementById("refresh-stop").addEventListener("click", stopRefresh);
document.getElementById("refresh-wait-more").addEventListener("click", () => {
  document.getElementById("refresh-wait").hidden = true;
  armRefreshWatch();
});
document.getElementById("refresh-wait").addEventListener("click", (event) => {
  if (event.target.id === "refresh-wait") stopRefresh();
});
bigPlay.addEventListener("click", (event) => {
  event.stopPropagation();
  const starting = video.paused;
  togglePlay();
  if (!isMobile()) return;
  if (starting) hidePlayButton();
  else showPlayButton();
  showChrome();
});
skipBackBtn.addEventListener("click", () => nudge(-10));
skipForwardBtn.addEventListener("click", () => nudge(10));
muteBtn.addEventListener("click", toggleMute);
menuBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleMenu();
});
theaterBtn.addEventListener("click", toggleTheater);
fullscreenBtn.addEventListener("click", toggleFullscreen);
document.getElementById("copy-link").addEventListener("click", (event) => {
  event.stopPropagation();
  copyTimeLink();
});
document.getElementById("keys-btn").addEventListener("click", (event) => {
  event.stopPropagation();
  toggleKeys();
});
document.addEventListener("fullscreenchange", syncTransport);
playerRetry.addEventListener("click", () => {
  if (current) restartAt(realTime() || streamStart, true);
});
startOverBtn.addEventListener("click", () => {
  if (!current) return;
  sendProgress(current.path, null);
  startOverBtn.hidden = true;
  restartAt(0, true);
});

volumeInput.addEventListener("input", () => {
  video.muted = false;
  video.volume = Number(volumeInput.value);
  localStorage.setItem(VOLUME_KEY, String(video.volume));
  syncTransport();
});

function commitSeek(ratio, resume) {
  const now = performance.now();
  if (now - seekLock < 400) return;
  seekLock = now;
  const dur = totalDuration();
  if (!dur) return;
  seekTo(Math.min(1, Math.max(0, ratio)) * dur, resume);
}

function bindSeekBar(el) {
  const begin = (event) => {
    if (!current) return;
    if (event.pointerType === undefined && performance.now() - seekLock < 50) return;
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
    scrubbing = true;
    wasPlaying = !video.paused;
    el.classList.add("scrubbing");
    stage.classList.add("scrubbing");
    if (event.pointerId != null && el.setPointerCapture) {
      try { el.setPointerCapture(event.pointerId); } catch (err) { /* Firefox fullscreen */ }
    }
    scrubRatio = ratioOn(el, event);
    paintTimeline();
    if (el === timeline) schedulePreview(scrubRatio);
    showChrome();
  };
  const move = (event) => {
    if (!scrubbing) {
      if (!isMobile() && el === timeline) schedulePreview(ratioOn(el, event));
      return;
    }
    if (event.cancelable) event.preventDefault();
    scrubRatio = ratioOn(el, event);
    paintTimeline();
    if (el === timeline) schedulePreview(scrubRatio);
  };
  const end = (event) => {
    if (!scrubbing) return;
    event.stopPropagation();
    const ratio = ratioOn(el, event);
    scrubbing = false;
    el.classList.remove("scrubbing");
    stage.classList.remove("scrubbing");
    timelineTip.hidden = true;
    hidePreview();
    commitSeek(ratio, wasPlaying);
    showChrome();
  };
  el.addEventListener("pointerdown", begin);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("touchstart", begin, { passive: false });
  el.addEventListener("touchmove", move, { passive: false });
  el.addEventListener("touchend", end, { passive: false });
  el.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    commitSeek(ratioOn(el, event), !video.paused);
    showChrome();
  });
}

bindSeekBar(timeline);
bindSeekBar(document.getElementById("mini-progress"));
timeline.addEventListener("pointerleave", () => {
  if (!scrubbing) {
    timelineTip.hidden = true;
    hidePreview();
  }
});
document.getElementById("up-next-cancel").addEventListener("click", (event) => {
  event.stopPropagation();
  cancelUpNext();
});
document.getElementById("up-next-now").addEventListener("click", (event) => {
  event.stopPropagation();
  const path = document.getElementById("up-next-gate").dataset.path;
  cancelUpNext();
  if (!path) return;
  location.hash = "/watch?v=" + encodeURIComponent(path);
  route();
});

stage.addEventListener("mousemove", () => {
  if (!isMobile()) showChrome();
});
stage.addEventListener("mouseleave", () => {
  if (isMobile() || scrubbing) return;
  hideChrome();
});

stage.addEventListener("dblclick", (event) => {
  if (event.target.closest(".controls")) return;
  window.clearTimeout(videoClickTimer);
  videoClickTimer = 0;
  toggleFullscreen();
});

function attachVideo(el) {
  if (el.dataset.mediaBound === "1") return;
  el.dataset.mediaBound = "1";
  el.addEventListener("play", () => {
    syncTransport();
    if (isMobile()) hidePlayButton();
    showChrome();
  });
  el.addEventListener("pause", () => {
    syncTransport();
    flushProgress();
    if (isMobile()) showPlayButton();
    showChrome();
  });
  el.addEventListener("playing", () => {
    setBuffering(false);
    syncTransport();
  });
  el.addEventListener("waiting", () => setBuffering(true));
  el.addEventListener("timeupdate", () => {
    if (ignoreMedia || scrubbing || el !== video) return;
    paintTimeline();
    paintSubs();
    scheduleSave();
  });
  el.addEventListener("ended", () => {
    if (ignoreMedia || !current || el !== video) return;
    sendProgress(current.path, { t: 0, dur: totalDuration(), at: Date.now(), done: true });
    syncTransport();
    setBuffering(false);
    armUpNext(current);
  });
  el.addEventListener("click", () => {
    if (isMobile() || el !== video) return;
    window.clearTimeout(videoClickTimer);
    videoClickTimer = window.setTimeout(() => {
      videoClickTimer = 0;
      togglePlay();
    }, 220);
  });
  el.addEventListener("error", () => {
    if (el !== video || !video.getAttribute("src")) return;
    const code = video.error && video.error.code;
    if (code === 1) return;
    ignoreMedia = false;
    showPlayerError("This video could not be played. The file may still be unreadable, or playback was interrupted.");
  });
}

attachVideo(video);

const seekHint = document.getElementById("seek-hint");
let seekHintTimer = 0;
let lastTapAt = 0;

function showSeekHint(direction) {
  seekHint.hidden = false;
  seekHint.className = "seek-hint " + direction;
  seekHint.textContent = direction === "back" ? "−10s" : "+10s";
  window.clearTimeout(seekHintTimer);
  seekHintTimer = window.setTimeout(() => { seekHint.hidden = true; }, 600);
}

stage.addEventListener("pointerup", (event) => {
  if (!isMobile()) return;
  if (event.target.closest("button, input, .menu, .timeline, .keys-panel")) return;
  const now = performance.now();
  const rect = stage.getBoundingClientRect();
  const ratio = rect.width ? (event.clientX - rect.left) / rect.width : 0.5;
  if (now - lastTapAt < 280) {
    lastTapAt = 0;
    if (ratio < 0.4) {
      nudge(-10);
      showSeekHint("back");
    } else if (ratio > 0.6) {
      nudge(10);
      showSeekHint("fwd");
    } else {
      showChrome();
    }
    return;
  }
  lastTapAt = now;
  window.setTimeout(() => {
    if (lastTapAt !== now) return;
    lastTapAt = 0;
    if (stage.classList.contains("active") && !video.paused) hideChrome();
    else {
      showPlayButton();
      showChrome();
    }
  }, 280);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushProgress();
});
window.addEventListener("pagehide", flushProgress);

document.addEventListener("keydown", (event) => {
  const typing = event.target.closest("input, textarea");
  if (event.key === "/" && !typing) {
    event.preventDefault();
    if (!viewWatch.hidden) location.hash = "/";
    searchInput.focus();
    searchInput.select();
    return;
  }
  if (typing || viewWatch.hidden || !current) return;
  if (event.key === "Escape" && upNextTimer) {
    event.preventDefault();
    cancelUpNext();
    return;
  }
  if (event.key === "?") {
    event.preventDefault();
    toggleKeys();
    return;
  }
  if (event.key === " " || event.key === "k" || event.key === "K") {
    event.preventDefault();
    showChrome();
    togglePlay();
  } else if (event.key === "ArrowLeft" || event.key === "j" || event.key === "J") {
    event.preventDefault();
    nudge(event.key === "ArrowLeft" ? -5 : -10);
  } else if (event.key === "ArrowRight" || event.key === "l" || event.key === "L") {
    event.preventDefault();
    nudge(event.key === "ArrowRight" ? 5 : 10);
  } else if (event.key === "f" || event.key === "F") {
    event.preventDefault();
    toggleFullscreen();
  } else if (event.key === "t" || event.key === "T") {
    event.preventDefault();
    toggleTheater();
  } else if (event.key === "m" || event.key === "M") {
    event.preventDefault();
    toggleMute();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    video.muted = false;
    video.volume = Math.min(1, video.volume + 0.05);
    volumeInput.value = String(video.volume);
    localStorage.setItem(VOLUME_KEY, String(video.volume));
    syncTransport();
    showChrome();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    video.volume = Math.max(0, video.volume - 0.05);
    volumeInput.value = String(video.volume);
    localStorage.setItem(VOLUME_KEY, String(video.volume));
    syncTransport();
    showChrome();
  } else if (/^[0-9]$/.test(event.key)) {
    event.preventDefault();
    seekTo(totalDuration() * (Number(event.key) / 10), !video.paused);
  } else if (event.key === "Escape") {
    if (!document.getElementById("keys-panel").hidden) {
      toggleKeys(false);
      return;
    }
    if (!document.getElementById("password-gate").hidden) {
      if (!(me && me.mustChangePassword)) closePasswordGate();
      return;
    }
    if (!document.getElementById("upload-modal").hidden) {
      closeUpload();
      return;
    }
    if (!document.getElementById("account-menu").hidden) {
      closeAccountMenu();
      return;
    }
    if (!document.getElementById("refresh-wait").hidden) {
      stopRefresh();
      return;
    }
    if (!document.getElementById("user-confirm").hidden) {
      closeUserConfirm();
      return;
    }
    if (!document.getElementById("confirm").hidden) {
      closeRemoveConfirm();
      return;
    }
    if (!document.getElementById("info-menu").hidden) {
      closeInfoMenu();
      return;
    }
    if (!menuEl.hidden) {
      if (menuPage !== "root") {
        menuPage = "root";
        renderMenu();
      } else {
        closeMenu();
      }
      return;
    }
    if (!document.fullscreenElement) location.hash = "/";
  }
});

document.addEventListener("click", (event) => {
  if (menuEl.hidden) return;
  if (event.target.closest("#menu") || event.target.closest("#menu-btn")) return;
  closeMenu();
});

menuEl.addEventListener("click", (event) => {
  // Rebuilding the menu detaches the clicked row. Stop the click here so
  // the outside-click handler does not treat that as leaving the menu.
  event.stopPropagation();
  const pick = event.target.closest("[data-pick]");
  if (pick) {
    const kind = pick.dataset.pick;
    const value = pick.dataset.value;
    if (kind === "speed") setRate(Number(value));
    else if (kind === "quality") selectQuality(value);
    else if (kind === "language") selectAudio(Number(value));
    else if (kind === "subtitles") selectSub(value === "off" ? null : Number(value));
    renderMenu();
    return;
  }
  const nav = event.target.closest("[data-menu]");
  if (!nav) return;
  if (nav.dataset.menu === "info") {
    openInfoFor(current, menuBtn);
    closeMenu();
    return;
  }
  menuPage = nav.dataset.menu;
  renderMenu();
});

const storedRate = Number(localStorage.getItem(RATE_KEY));
setRate(SPEEDS.includes(storedRate) ? storedRate : 1);
applyTheater();

window.addEventListener("hashchange", route);

const storedVolume = localStorage.getItem(VOLUME_KEY);
if (storedVolume !== null && !Number.isNaN(Number(storedVolume))) {
  video.volume = Number(storedVolume);
  volumeInput.value = storedVolume;
}

const viewLogin = document.getElementById("view-login");
const viewAdmin = document.getElementById("view-admin");
const viewSettings = document.getElementById("view-settings");

function closeAccountMenu() {
  document.getElementById("account-menu").hidden = true;
  document.getElementById("account-btn").setAttribute("aria-expanded", "false");
}

function renderAccount() {
  const button = document.getElementById("account-btn");
  const upload = document.getElementById("account-upload");
  const users = document.getElementById("account-users");
  const password = document.getElementById("account-password");
  const logout = document.getElementById("account-logout");
  if (!me) {
    button.textContent = "Sign in";
    upload.hidden = true;
    users.hidden = true;
    password.hidden = true;
    logout.hidden = true;
    syncMineControl();
    return;
  }
  button.textContent = me.username;
  upload.hidden = !me.canUpload;
  users.hidden = !me.admin;
  users.textContent = me.admin && me.resetCount ? "Admin (" + me.resetCount + ")" : "Admin";
  password.hidden = false;
  logout.hidden = false;
  syncMineControl();
}

async function loadMe() {
  const response = await fetch("/api/me");
  if (!response.ok) {
    me = null;
    renderAccount();
    return;
  }
  const data = await response.json();
  videoPlayer = !!data.videoPlayer;
  me = data.user || null;
  const account = document.querySelector(".account");
  if (account) account.hidden = videoPlayer;
  renderAccount();
}

async function loadCatalog() {
  setStatus("Loading library…");
  const response = await fetch("/api/library");
  if (!response.ok) throw new Error("bad status");
  const data = await response.json();
  catalog = applyCatalog(data.videos || []);
  await loadAccountState();
  setStatus("");
}

function showLogin() {
  closeAccountMenu();
  closeMenu();
  viewHome.hidden = true;
  viewWatch.hidden = true;
  viewAdmin.hidden = true;
  viewSettings.hidden = true;
  viewLogin.hidden = false;
  document.title = "Sign in · gomoov";
}

function showAdmin(tab) {
  closeAccountMenu();
  closeMenu();
  viewHome.hidden = true;
  viewWatch.hidden = true;
  viewLogin.hidden = true;
  viewAdmin.hidden = false;
  viewSettings.hidden = true;
  document.querySelectorAll("[data-admin-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.adminPanel !== tab;
  });
  document.querySelectorAll("[data-admin-tab]").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.adminTab === tab ? "true" : "false");
  });
  document.title = "Admin · gomoov";
  if (tab === "users") {
    document.getElementById("user-add").hidden = false;
    document.getElementById("user-list").hidden = false;
    document.getElementById("user-detail").hidden = true;
    renderUserList();
  } else if (tab === "videos") {
    renderAdminVideos();
  } else if (tab === "access" || tab === "theme") {
    loadAdminSettings();
  }
}

async function showUsers() {
  showAdmin("users");
}

async function showUser(id) {
  closeAccountMenu();
  closeMenu();
  viewHome.hidden = true;
  viewWatch.hidden = true;
  viewLogin.hidden = true;
  viewAdmin.hidden = false;
  viewSettings.hidden = true;
  document.querySelectorAll("[data-admin-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.adminPanel !== "users";
  });
  document.getElementById("user-add").hidden = true;
  document.getElementById("user-list").hidden = true;
  const detail = document.getElementById("user-detail");
  detail.hidden = false;
  detail.dataset.user = id;
  closeUserConfirm();
  document.getElementById("user-detail-error").hidden = true;
  document.title = "User · gomoov";
  const response = await fetch("/api/users?id=" + encodeURIComponent(id));
  if (!response.ok) {
    document.getElementById("user-detail-name").textContent = "User";
    document.getElementById("user-detail-error").textContent = await apiError(response);
    document.getElementById("user-detail-error").hidden = false;
    document.getElementById("user-videos").innerHTML = "";
    return;
  }
  const data = await response.json();
  const user = data.user;
  document.getElementById("user-detail-name").textContent = user.username;
  const bits = [];
  if (user.admin) bits.push("Admin");
  if (user.banned) bits.push("Banned");
  if (user.resetRequested) bits.push("Password reset requested");
  if (user.mustChangePassword) bits.push("Must change password");
  document.getElementById("user-detail-status").textContent = bits.join(" · ") || "Active";
  const upload = document.getElementById("user-detail-upload");
  upload.checked = !!user.canUpload;
  upload.disabled = !!user.admin;
  const ban = document.getElementById("user-ban");
  const del = document.getElementById("user-delete");
  ban.hidden = !!user.admin;
  del.hidden = !!user.admin;
  ban.textContent = user.banned ? "Unban" : "Ban";
  const videos = data.videos || [];
  document.getElementById("user-videos").innerHTML = videos.length
    ? videos.map((item) => {
        const decorated = decorate(item);
        return '<a class="user-video" href="#/watch?v=' + encodeURIComponent(item.path) + '" data-video="' + esc(item.path) + '">' +
          esc(decorated.fullTitle) + (item.private ? " · Private" : " · Public") + "</a>";
      }).join("")
    : '<p class="empty">No uploads yet.</p>';
}

function showPasswordGate(forced) {
  const gate = document.getElementById("password-gate");
  document.getElementById("password-note").hidden = !forced;
  document.getElementById("password-cancel").hidden = !!forced;
  document.getElementById("password-title").textContent = forced ? "Choose a new password" : "Change password";
  document.getElementById("password-error").hidden = true;
  gate.hidden = false;
}

function closePasswordGate() {
  document.getElementById("password-gate").hidden = true;
  document.getElementById("password-form").reset();
}

function closeUpload() {
  document.getElementById("upload-modal").hidden = true;
  document.getElementById("upload-error").hidden = true;
}

async function apiError(response) {
  try {
    const data = await response.json();
    if (data.error === "password_change_required") {
      if (me) me.mustChangePassword = true;
      showPasswordGate(true);
      return "Choose a new password before continuing.";
    }
    return data.error || "Request failed.";
  } catch {
    return "Request failed.";
  }
}

document.getElementById("account-btn").addEventListener("click", (event) => {
  event.stopPropagation();
  if (!me) {
    location.hash = "/login";
    route();
    return;
  }
  const menu = document.getElementById("account-menu");
  if (!menu.hidden) {
    closeAccountMenu();
    return;
  }
  menu.hidden = false;
  document.getElementById("account-btn").setAttribute("aria-expanded", "true");
  const rect = document.getElementById("account-btn").getBoundingClientRect();
  menu.style.left = "0px";
  menu.style.top = "0px";
  const width = menu.offsetWidth;
  menu.style.left = Math.max(8, rect.right - width) + "px";
  menu.style.top = (rect.bottom + 6) + "px";
});

document.getElementById("account-mine").addEventListener("click", () => {
  closeAccountMenu();
  mineOnly = !mineOnly;
  localStorage.setItem(MINE_ONLY, mineOnly ? "1" : "0");
  syncMineControl();
  const here = location.hash.replace(/^#/, "") || "/";
  if (here !== "/") location.hash = "/";
  showHome();
});

document.getElementById("account-upload").addEventListener("click", () => {
  closeAccountMenu();
  document.getElementById("upload-form").reset();
  document.getElementById("upload-error").hidden = true;
  document.getElementById("upload-modal").hidden = false;
});

document.getElementById("account-users").addEventListener("click", () => {
  closeAccountMenu();
  location.hash = "/admin";
  route();
});

document.getElementById("account-password").addEventListener("click", () => {
  closeAccountMenu();
  location.hash = "/settings";
  route();
});

document.getElementById("account-logout").addEventListener("click", async () => {
  closeAccountMenu();
  await fetch("/api/logout", { method: "POST" });
  me = null;
  renderAccount();
  try {
    await loadCatalog();
  } catch {
    catalog = [];
  }
  location.hash = "/";
  showHome();
});

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.getElementById("login-error");
  error.hidden = true;
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: document.getElementById("login-user").value,
      password: document.getElementById("login-pass").value
    })
  });
  if (!response.ok) {
    error.textContent = await apiError(response);
    error.hidden = false;
    return;
  }
  const data = await response.json();
  me = data.user || null;
  renderAccount();
  document.getElementById("login-form").reset();
  if (me && me.mustChangePassword) {
    showPasswordGate(true);
    return;
  }
  try {
    await loadCatalog();
  } catch {
    setStatus("Could not load the library.");
  }
  location.hash = "/";
  showHome();
});

document.getElementById("forgot-btn").addEventListener("click", async () => {
  const username = document.getElementById("login-user").value.trim();
  const note = document.getElementById("forgot-note");
  if (!username) {
    note.textContent = "Type your username first, then ask for a reset.";
    note.hidden = false;
    return;
  }
  const response = await fetch("/api/password-reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });
  const data = await response.json().catch(() => ({}));
  note.textContent = data.message || "If that account exists, the admin was notified.";
  note.hidden = false;
});

document.getElementById("password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.getElementById("password-error");
  error.hidden = true;
  const next = document.getElementById("password-new").value;
  if (next !== document.getElementById("password-confirm").value) {
    error.textContent = "The new passwords do not match.";
    error.hidden = false;
    return;
  }
  const response = await fetch("/api/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      current: document.getElementById("password-current").value,
      next
    })
  });
  if (!response.ok) {
    error.textContent = await apiError(response);
    error.hidden = false;
    return;
  }
  const data = await response.json();
  me = data.user || me;
  if (me) me.mustChangePassword = false;
  renderAccount();
  closePasswordGate();
  try {
    await loadCatalog();
  } catch {
    setStatus("Could not load the library.");
  }
  if (viewLogin && !viewLogin.hidden) viewLogin.hidden = true;
  if ((location.hash.replace(/^#/, "") || "/") === "/login") location.hash = "/";
  route();
});

document.getElementById("password-cancel").addEventListener("click", closePasswordGate);
document.getElementById("password-gate").addEventListener("click", (event) => {
  if (event.target.id === "password-gate" && !(me && me.mustChangePassword)) closePasswordGate();
});
document.getElementById("upload-cancel").addEventListener("click", closeUpload);
document.getElementById("upload-modal").addEventListener("click", (event) => {
  if (event.target.id === "upload-modal") closeUpload();
});

document.getElementById("upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.getElementById("upload-error");
  const submit = document.getElementById("upload-submit");
  error.hidden = true;
  const file = document.getElementById("upload-file").files[0];
  if (!file) return;
  const body = new FormData();
  body.append("file", file);
  body.append("private", document.getElementById("upload-private").checked ? "1" : "0");
  submit.disabled = true;
  submit.textContent = "Uploading…";
  try {
    const response = await fetch("/api/upload", { method: "POST", body });
    if (!response.ok) {
      error.textContent = await apiError(response);
      error.hidden = false;
      return;
    }
    closeUpload();
    await loadCatalog();
    if (!viewHome.hidden) renderHome();
  } catch {
    error.textContent = "Could not upload the video.";
    error.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = "Upload";
  }
});

document.getElementById("info-privacy").addEventListener("click", async () => {
  const item = catalog.find((entry) => entry.path === infoTarget) || current;
  if (!item) return;
  const response = await fetch("/api/video/visibility", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: item.path, private: !item.private })
  });
  if (!response.ok) return;
  closeInfoMenu();
  await loadCatalog();
  const updated = catalog.find((entry) => entry.path === item.path);
  if (updated && current && current.path === item.path) {
    current.private = updated.private;
    current.ownerName = updated.ownerName;
    const bits = [formatTime(current.duration), current.quality, current.edition, current.sizeLabel, current.private ? "Private" : ""].filter(Boolean);
    watchMeta.textContent = bits.join(" · ");
  }
  if (!viewHome.hidden) renderHome();
});

document.getElementById("user-add").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.getElementById("user-add-error");
  error.hidden = true;
  const response = await fetch("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: document.getElementById("new-username").value.trim(),
      password: document.getElementById("new-password").value,
      canUpload: document.getElementById("new-upload").checked,
      mustChangePassword: document.getElementById("new-force").checked
    })
  });
  if (!response.ok) {
    error.textContent = await apiError(response);
    error.hidden = false;
    return;
  }
  document.getElementById("user-add").reset();
  document.getElementById("new-force").checked = true;
  await loadMe();
  await renderUserList();
});

async function renderUserList() {
  const host = document.getElementById("user-list");
  const response = await fetch("/api/users");
  if (!response.ok) {
    host.innerHTML = '<p class="empty">Users are visible to the admin only.</p>';
    return;
  }
  const data = await response.json();
  host.innerHTML = (data.users || []).map((user) => (
    '<article class="user-row">' +
      '<button type="button" class="user-open" data-user-open="' + esc(user.id) + '">' +
        "<span>" + esc(user.username) + "</span>" +
        (user.admin ? '<span class="pill">Admin</span>' : "") +
        (user.banned ? '<span class="pill warn">Banned</span>' : "") +
        (user.resetRequested ? '<span class="pill warn">Password reset requested</span>' : "") +
        (user.mustChangePassword ? '<span class="pill">Must change password</span>' : "") +
      "</button>" +
    "</article>"
  )).join("") || '<p class="empty">No users yet.</p>';
}

document.getElementById("user-list").addEventListener("click", (event) => {
  const open = event.target.closest("[data-user-open]");
  if (!open) return;
  location.hash = "/users?u=" + encodeURIComponent(open.dataset.userOpen);
});

document.getElementById("user-back").addEventListener("click", () => {
  location.hash = "/users";
});

document.getElementById("user-detail-upload").addEventListener("change", async (event) => {
  const id = document.getElementById("user-detail").dataset.user;
  const box = event.target;
  const response = await fetch("/api/users", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, canUpload: box.checked })
  });
  if (!response.ok) box.checked = !box.checked;
});

document.getElementById("user-detail-pass").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const error = document.getElementById("user-detail-error");
  error.hidden = true;
  const response = await fetch("/api/users", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: document.getElementById("user-detail").dataset.user,
      password: form.password.value,
      mustChangePassword: form.force.checked
    })
  });
  if (!response.ok) {
    error.textContent = await apiError(response);
    error.hidden = false;
    return;
  }
  form.reset();
  await showUser(document.getElementById("user-detail").dataset.user);
});

let userConfirmAction = "";

function openUserConfirm(action) {
  const name = document.getElementById("user-detail-name").textContent;
  const title = document.getElementById("user-confirm-title");
  const text = document.getElementById("user-confirm-text");
  const yes = document.getElementById("user-confirm-yes");
  userConfirmAction = action;
  document.getElementById("user-confirm-error").hidden = true;
  if (action === "ban") {
    title.textContent = "Ban this account?";
    text.textContent = name + " will be signed out and will not be able to sign in.";
    yes.textContent = "Ban";
  } else if (action === "unban") {
    title.textContent = "Unban this account?";
    text.textContent = name + " will be able to sign in again.";
    yes.textContent = "Unban";
  } else {
    title.textContent = "Delete this account?";
    text.textContent = name + " and the videos they uploaded will be removed.";
    yes.textContent = "Delete";
  }
  document.getElementById("user-confirm").hidden = false;
}

function closeUserConfirm() {
  document.getElementById("user-confirm").hidden = true;
  userConfirmAction = "";
}

document.getElementById("user-ban").addEventListener("click", () => {
  openUserConfirm(document.getElementById("user-ban").textContent === "Ban" ? "ban" : "unban");
});

document.getElementById("user-delete").addEventListener("click", () => {
  openUserConfirm("delete");
});

document.getElementById("user-confirm-no").addEventListener("click", closeUserConfirm);
document.getElementById("user-confirm").addEventListener("click", (event) => {
  if (event.target.id === "user-confirm") closeUserConfirm();
});

document.getElementById("user-confirm-yes").addEventListener("click", async () => {
  const error = document.getElementById("user-confirm-error");
  const detailError = document.getElementById("user-detail-error");
  error.hidden = true;
  const id = document.getElementById("user-detail").dataset.user;
  const action = userConfirmAction;
  const response = action === "delete"
    ? await fetch("/api/users?id=" + encodeURIComponent(id), { method: "DELETE" })
    : await fetch("/api/users", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, banned: action === "ban" })
      });
  if (!response.ok) {
    error.textContent = await apiError(response);
    error.hidden = false;
    return;
  }
  closeUserConfirm();
  detailError.hidden = true;
  if (action === "delete") {
    location.hash = "/users";
    return;
  }
  await showUser(id);
});

document.body.addEventListener("click", (event) => {
  if (!event.target.closest("#account-menu") && !event.target.closest("#account-btn")) closeAccountMenu();
});

const THEMES = ["dark", "white", "cyber-green", "fancy", "neon", "cyberpunk", "retro", "ocean", "sunset"];

function knownTheme(name) {
  return THEMES.includes(name);
}

function effectiveTheme() {
  const local = localStorage.getItem(THEME_KEY);
  if (knownTheme(local)) return local;
  if (me && knownTheme(me.theme)) return me.theme;
  return knownTheme(siteTheme) ? siteTheme : "dark";
}

function applyTheme() {
  document.documentElement.dataset.theme = effectiveTheme();
  const pick = document.getElementById("user-theme");
  if (!pick) return;
  const local = localStorage.getItem(THEME_KEY);
  pick.value = knownTheme(local) ? local : (me && knownTheme(me.theme) ? me.theme : "");
}

function showSettings(tab) {
  closeAccountMenu();
  closeMenu();
  viewHome.hidden = true;
  viewWatch.hidden = true;
  viewLogin.hidden = true;
  viewAdmin.hidden = true;
  viewSettings.hidden = false;
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== tab;
  });
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.settingsTab === tab ? "true" : "false");
  });
  document.title = "Settings · gomoov";
  applyTheme();
  if (tab === "videos") renderSettingsVideos();
}

async function loadSiteTheme() {
  const response = await fetch("/api/settings");
  if (!response.ok) return;
  const data = await response.json();
  if (knownTheme(data.theme)) siteTheme = data.theme;
  applyTheme();
}

async function chooseTheme(theme) {
  if (theme) localStorage.setItem(THEME_KEY, theme);
  else localStorage.removeItem(THEME_KEY);
  applyTheme();
  if (!me) return;
  const response = await fetch("/api/theme", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme })
  });
  if (response.ok) {
    const data = await response.json();
    if (data.user) me = data.user;
  }
  applyTheme();
}

function ownerLabel(item) {
  if (item.ownerName) return item.ownerName;
  if (item.ownerId) return item.ownerId;
  return "Library";
}

function renderAdminVideos() {
  const host = document.getElementById("admin-video-list");
  if (!catalog.length) {
    host.innerHTML = '<p class="empty">No videos.</p>';
    return;
  }
  host.innerHTML = catalog.map((item) => (
    '<article class="admin-video">' +
      '<a href="#/watch?v=' + encodeURIComponent(item.path) + '" data-video="' + esc(item.path) + '">' + esc(item.fullTitle) + "</a>" +
      '<span class="admin-owner">' + esc(ownerLabel(item)) + "</span>" +
      "<span>" + (item.private ? "Private" : "Public") + "</span>" +
      (item.canRemove ? '<button type="button" class="text-btn" data-admin-remove="' + esc(item.path) + '">Remove</button>' : "<span></span>") +
    "</article>"
  )).join("");
}

function renderSettingsVideos() {
  renderWatchLater();
  const host = document.getElementById("settings-video-list");
  const mine = catalog.filter((item) => item.mine);
  if (!mine.length) {
    host.innerHTML = '<p class="empty">You have not uploaded any videos.</p>';
    return;
  }
  host.innerHTML = mine.map((item) => (
    '<article class="mine-video">' +
      '<a href="#/watch?v=' + encodeURIComponent(item.path) + '" data-video="' + esc(item.path) + '">' + esc(item.fullTitle) + "</a>" +
      "<span>" + (item.private ? "Private" : "Public") + "</span>" +
      '<div class="video-actions">' +
        '<a class="text-btn" href="/api/download?path=' + encodeURIComponent(item.path) + '">Download</a>' +
        '<form class="hand-form" data-transfer="' + esc(item.path) + '">' +
          '<input name="to" placeholder="Username" autocomplete="off" aria-label="Hand ' + esc(item.fullTitle) + ' to" required>' +
          '<button type="submit" class="text-btn">Hand over</button>' +
        "</form>" +
        '<button type="button" class="text-btn" data-settings-remove="' + esc(item.path) + '">Remove</button>' +
      "</div>" +
    "</article>"
  )).join("");
}

async function loadAdminSettings() {
  const response = await fetch("/api/settings");
  if (!response.ok) return;
  const data = await response.json();
  if (knownTheme(data.theme)) {
    siteTheme = data.theme;
    document.getElementById("admin-theme").value = data.theme;
  }
  document.getElementById("basic-on").checked = !!data.basicAuth;
  document.getElementById("basic-user").value = data.basicUser || "";
  document.getElementById("basic-pass").value = "";
  document.getElementById("ip-mode").value = data.ipMode || "off";
  document.getElementById("ip-list").value = (data.ips || []).join("\n");
  applyTheme();
}

document.querySelector("#view-admin .admin-nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-admin-tab]");
  if (!button) return;
  const tab = button.dataset.adminTab;
  if ((location.hash.split("?")[0] || "#/admin") !== "#/admin") location.hash = "/admin?tab=" + encodeURIComponent(tab);
  else location.hash = "/admin?tab=" + encodeURIComponent(tab);
});

document.getElementById("admin-theme-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.getElementById("theme-error");
  error.hidden = true;
  const response = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme: document.getElementById("admin-theme").value })
  });
  if (!response.ok) {
    error.textContent = await apiError(response);
    error.hidden = false;
    return;
  }
  const chosen = document.getElementById("admin-theme").value;
  await loadAdminSettings();
  if (document.getElementById("admin-theme").value !== chosen) {
    error.textContent = "Could not save the theme.";
    error.hidden = false;
    return;
  }
  const saved = document.getElementById("theme-saved");
  saved.textContent = "Saved. People who have not chosen a theme will see " + chosen + ".";
  saved.hidden = false;
  if (!localStorage.getItem(THEME_KEY) && !(me && knownTheme(me.theme))) applyTheme();
});

document.getElementById("admin-access-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.getElementById("access-error");
  error.hidden = true;
  const response = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      basicAuth: document.getElementById("basic-on").checked,
      basicUser: document.getElementById("basic-user").value.trim(),
      basicPassword: document.getElementById("basic-pass").value,
      ipMode: document.getElementById("ip-mode").value,
      ips: document.getElementById("ip-list").value.split(/[\s,]+/).filter(Boolean)
    })
  });
  if (!response.ok) {
    error.textContent = await apiError(response);
    error.hidden = false;
    return;
  }
  await loadAdminSettings();
});

document.querySelector("#view-settings .admin-nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-settings-tab]");
  if (!button) return;
  location.hash = "/settings?tab=" + encodeURIComponent(button.dataset.settingsTab);
});

document.getElementById("settings-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.getElementById("settings-password-error");
  error.hidden = true;
  const next = document.getElementById("settings-new").value;
  if (next !== document.getElementById("settings-confirm").value) {
    error.textContent = "The new passwords do not match.";
    error.hidden = false;
    return;
  }
  const response = await fetch("/api/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      current: document.getElementById("settings-current").value,
      next
    })
  });
  if (!response.ok) {
    error.textContent = await apiError(response);
    error.hidden = false;
    return;
  }
  const data = await response.json();
  me = data.user || me;
  if (me) me.mustChangePassword = false;
  document.getElementById("settings-password-form").reset();
  error.hidden = true;
  document.getElementById("settings-password-error").hidden = true;
  const note = document.getElementById("settings-password-error");
  note.textContent = "Password saved.";
  note.hidden = false;
  note.style.color = "var(--muted)";
});

document.getElementById("settings-theme-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.getElementById("settings-theme-error");
  error.hidden = true;
  await chooseTheme(document.getElementById("user-theme").value);
  error.textContent = "Saved.";
  error.hidden = false;
  error.style.color = "var(--muted)";
});

document.getElementById("settings-video-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-settings-remove]");
  if (!button) return;
  const response = await fetch("/api/video?path=" + encodeURIComponent(button.dataset.settingsRemove), { method: "DELETE" });
  if (!response.ok) return;
  await loadCatalog();
  renderSettingsVideos();
});

document.getElementById("settings-video-list").addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-transfer]");
  if (!form) return;
  event.preventDefault();
  const to = form.to.value.trim();
  const response = await fetch("/api/video/transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: form.dataset.transfer, to })
  });
  if (!response.ok) {
    setStatus(await apiError(response));
    return;
  }
  setStatus("Handed over to " + to + ".");
  await loadCatalog();
  renderSettingsVideos();
});

document.getElementById("admin-video-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-admin-remove]");
  if (!button) return;
  const response = await fetch("/api/video?path=" + encodeURIComponent(button.dataset.adminRemove), { method: "DELETE" });
  if (!response.ok) return;
  await loadCatalog();
  renderAdminVideos();
});

async function init() {
  if (location.protocol === "file:") {
    setStatus("Open this page through the player. In the video folder, run ./gomoov and open the address it prints.");
    return;
  }
  try {
    await loadSiteTheme();
    applyTheme();
    await loadMe();
    applyTheme();
    if (me && me.mustChangePassword) {
      showPasswordGate(true);
      return;
    }
    await loadCatalog();
    route();
  } catch {
    setStatus("Could not load the library. In the video folder, run ./gomoov and open the address it prints.");
  }
}

init();
