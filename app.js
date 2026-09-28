"use strict";

const STORAGE_KEY = "moovies.progress.v1";
const VOLUME_KEY = "moovies.volume";
const SORT_STORE = "moovies.sort";
const CONTINUE_COLLAPSE = "moovies.continueCollapsed";
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
const searchInput = document.getElementById("search");
const stage = document.getElementById("stage");
const video = document.getElementById("video");
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
let sortKey = "name";
let sortDesc = false;
let groupByFolder = false;
let continueCollapsed = false;
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
            '<span class="badge">' + esc(formatTime(item.duration)) + "</span>" +
            (ratio ? '<div class="thumb-progress"><span style="width:' + (ratio * 100).toFixed(1) + '%"></span></div>' : "") +
          "</div>" +
        "</a>" +
      "</div>" +
      '<div class="card-head">' +
        '<a class="card-title" href="' + href + '" data-video="' + esc(item.path) + '">' + esc(title) + "</a>" +
        '<button type="button" class="info-btn" data-info data-path="' + esc(item.path) + '" aria-label="Info for ' + esc(title) + '">i</button>' +
      "</div>" +
      (sub ? '<div class="card-meta">' + esc(sub) + "</div>" : "") +
      (mode === "continue" ? '<button type="button" class="continue-remove" data-continue-remove data-path="' + esc(item.path) + '">Remove from list</button>' : "") +
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
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return catalog;
  const words = q.split(/\s+/);
  return catalog.filter((item) => {
    const hay = (item.fullTitle + " " + item.series + " " + item.name).toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

const SORT_DIRS = {
  name: ["A to Z", "Z to A"],
  newest: ["Oldest first", "Newest first"],
  longest: ["Shortest first", "Longest first"],
  size: ["Smallest first", "Largest first"],
  path: ["A to Z", "Z to A"]
};

function loadSort() {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_STORE)) || {};
    if (SORT_DIRS[saved.key]) sortKey = saved.key;
    sortDesc = !!saved.desc;
    groupByFolder = !!saved.group;
  } catch {
    sortKey = "name";
    sortDesc = false;
  }
}

function saveSort() {
  localStorage.setItem(SORT_STORE, JSON.stringify({ key: sortKey, desc: sortDesc, group: groupByFolder }));
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

function renderHome() {
  const q = searchInput.value.trim();
  const items = filtered().slice().sort(compareItems);
  const continuing = !q
    ? catalog
      .filter((item) => {
        const saved = progress[progressKey(item)];
        return saved && !saved.done && saved.t >= RESUME_AT;
      })
      .sort((a, b) => (progress[progressKey(b)].at || 0) - (progress[progressKey(a)].at || 0))
    : [];

  continueSection.hidden = continuing.length === 0;
  continueSection.classList.toggle("collapsed", continueCollapsed);
  document.getElementById("continue-toggle").setAttribute("aria-expanded", continueCollapsed ? "false" : "true");
  continueRow.innerHTML = continuing.map((item) => cardHTML(item, "continue")).join("");

  if (!items.length) {
    libraryEl.innerHTML = '<p class="empty">' + (q ? "No videos match “" + esc(q) + "”." : "No videos in this folder.") + "</p>";
    return;
  }

  if (sortKey === "path" && groupByFolder) {
    const tree = folderTree(items);
    const top = [...tree.children.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    if (sortDesc) top.reverse();
    libraryEl.innerHTML = top.map(renderFolderNode).join("");
    return;
  }

  if (q || sortKey !== "name" || sortDesc) {
    const heading = q ? "Results" : "Library";
    libraryEl.innerHTML = '<section class="shelf"><h2>' + heading + '</h2><div class="grid">' +
      items.map((item) => cardHTML(item, "plain")).join("") + "</div></section>";
    return;
  }

  const series = new Map();
  const movies = [];
  for (const item of items) {
    if (item.series) {
      if (!series.has(item.series)) series.set(item.series, []);
      series.get(item.series).push(item);
    } else {
      movies.push(item);
    }
  }
  const html = [];
  for (const [name, eps] of [...series.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    eps.sort((a, b) => a.season - b.season || a.episode - b.episode);
    html.push('<section class="shelf"><h2>' + esc(name) + '</h2><div class="grid">' +
      eps.map((item) => cardHTML(item, "episode")).join("") + "</div></section>");
  }
  if (movies.length) {
    movies.sort((a, b) => a.fullTitle.localeCompare(b.fullTitle));
    html.push('<section class="shelf"><h2>Movies</h2><div class="grid">' +
      movies.map((item) => cardHTML(item, "plain")).join("") + "</div></section>");
  }
  libraryEl.innerHTML = html.join("");
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
  subsToken += 1;
  subsCues = [];
  subsEl.innerHTML = "";
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  stopVideo();
  current = null;
  viewWatch.hidden = true;
  viewHome.hidden = false;
  document.title = "Moovies";
  renderHome();
}

function stopVideo() {
  playToken += 1;
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

function setBuffering(on) {
  stage.classList.toggle("buffering", on);
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

function openVideo(item) {
  flushProgress();
  current = item;
  viewHome.hidden = true;
  viewWatch.hidden = false;
  document.title = item.fullTitle + " · Moovies";
  watchTitle.textContent = item.fullTitle;
  const bits = [formatTime(item.duration), item.quality, item.edition, item.sizeLabel].filter(Boolean);
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
  const start = saved && !saved.done && saved.t >= RESUME_AT ? saved.t : 0;
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
  return { pathname, video: params.get("v") };
}

function route() {
  const { pathname, video: path } = parseRoute();
  if (pathname === "/watch" && path) {
    const item = catalog.find((entry) => entry.path === path);
    if (!item) {
      showHome();
      setStatus("That video is not in the library.");
      return;
    }
    if (current && current.path === path && video.getAttribute("src")) return;
    setStatus("");
    openVideo(item);
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
  if (scrubbing || stage.classList.contains("menu-open")) return;
  stage.classList.remove("active");
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

function selectQuality(value) {
  const next = Number(value) || 0;
  if (next === qualityChoice) return;
  qualityChoice = next;
  savePrefs({ quality: next });
  applyPlaybackChange();
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
continueCollapsed = localStorage.getItem(CONTINUE_COLLAPSE) === "1";
document.getElementById("continue-toggle").addEventListener("click", () => {
  continueCollapsed = !continueCollapsed;
  localStorage.setItem(CONTINUE_COLLAPSE, continueCollapsed ? "1" : "0");
  continueSection.classList.toggle("collapsed", continueCollapsed);
  document.getElementById("continue-toggle").setAttribute("aria-expanded", continueCollapsed ? "false" : "true");
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

function openInfoFor(item, anchor) {
  if (!item) return;
  infoTarget = item.path;
  document.getElementById("info-quality").textContent = [item.quality, item.edition, item.sizeLabel].filter(Boolean).join(" · ") || "Unknown";
  const languages = (item.audioTracks || []).map((track) => track.label);
  document.getElementById("info-language").textContent = languages.join(", ") || "Unknown";
  document.getElementById("info-duration").textContent = formatTime(item.duration);
  document.getElementById("info-path").textContent = filePathLabel(item);
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
  const info = event.target.closest("[data-info]");
  if (info) {
    event.preventDefault();
    event.stopPropagation();
    openInfoFor(catalog.find((entry) => entry.path === info.dataset.path), info);
    return;
  }
  if (!event.target.closest("#info-menu")) closeInfoMenu();
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
    showChrome();
  };
  const move = (event) => {
    if (!scrubbing) {
      if (!isMobile()) {
        const ratio = ratioOn(el, event);
        timelineTip.hidden = false;
        timelineTip.style.left = (ratio * 100) + "%";
        timelineTip.textContent = formatTime(ratio * totalDuration());
      }
      return;
    }
    if (event.cancelable) event.preventDefault();
    scrubRatio = ratioOn(el, event);
    paintTimeline();
  };
  const end = (event) => {
    if (!scrubbing) return;
    event.stopPropagation();
    const ratio = ratioOn(el, event);
    scrubbing = false;
    el.classList.remove("scrubbing");
    stage.classList.remove("scrubbing");
    timelineTip.hidden = true;
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

video.addEventListener("play", () => {
  syncTransport();
  if (isMobile()) hidePlayButton();
  showChrome();
});
video.addEventListener("pause", () => {
  syncTransport();
  flushProgress();
  if (isMobile()) showPlayButton();
  showChrome();
});
video.addEventListener("playing", () => {
  setBuffering(false);
  syncTransport();
});
video.addEventListener("waiting", () => setBuffering(true));
video.addEventListener("timeupdate", () => {
  if (ignoreMedia || scrubbing) return;
  paintTimeline();
  paintSubs();
  scheduleSave();
});
video.addEventListener("ended", () => {
  if (ignoreMedia || !current) return;
  sendProgress(current.path, { t: 0, dur: totalDuration(), at: Date.now(), done: true });
  syncTransport();
  setBuffering(false);
});
video.addEventListener("click", () => {
  if (isMobile()) return;
  window.clearTimeout(videoClickTimer);
  videoClickTimer = window.setTimeout(() => {
    videoClickTimer = 0;
    togglePlay();
  }, 220);
});

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
  if (event.target.closest("button, input, .menu, .timeline")) return;
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

video.addEventListener("error", () => {
  if (!video.getAttribute("src")) return;
  const code = video.error && video.error.code;
  if (code === 1) return;
  ignoreMedia = false;
  showPlayerError("This video could not be played. The file may still be unreadable, or playback was interrupted.");
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
    if (!document.getElementById("refresh-wait").hidden) {
      stopRefresh();
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

async function init() {
  if (location.protocol === "file:") {
    setStatus("Open this page through the player. In the video folder, run ./gomoov and open the address it prints.");
    return;
  }
  setStatus("Loading library…");
  try {
    const response = await fetch("/api/library");
    if (!response.ok) throw new Error("bad status");
    const data = await response.json();
    catalog = applyCatalog(data.videos || []);
    await loadServerProgress();
    setStatus("");
    route();
  } catch {
    setStatus("Could not load the library. In the video folder, run ./gomoov and open the address it prints.");
  }
}

init();
