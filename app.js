"use strict";
// Vattenfall InCharge watcher PWA - talks to the API directly (CORS is open).
const API = "https://businessspecificapimanglobal.azure-api.net/emobility/";
const KEY = "12c7d772faa84b92a8f13a22d7bd8638";
const WATCH_KEY = "incharge.watch.v1";
const DEVICE_KEY = "incharge.device.v1";
const STATUS_TEXT = { AVAILABLE: "free", OCCUPIED: "busy", UNKNOWN: "unknown", ERROR: "error" };
const STATUS_CLS = { AVAILABLE: "free", OCCUPIED: "busy", UNKNOWN: "unknown", ERROR: "error" };

const $ = (id) => document.getElementById(id);

// ---------- API ----------
let device = JSON.parse(localStorage.getItem(DEVICE_KEY) || "null");

async function apiRaw(method, path, body, deviceId, xToken) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "Ocp-Apim-Subscription-Key": KEY,
      "Content-Type": "application/json",
      Accept: "application/vnd.emobilitymobile.v16+json",
      "User-Agent": "Android",
      ...(deviceId ? { "Device-Id": deviceId } : {}),
      ...(xToken ? { "X-Token": xToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return data;
}

async function ensureDevice() {
  if (device && device.deviceId && device.xToken) return device;
  const deviceId = crypto.randomUUID();
  const reg = { brand: "generic", userAgent: "Android", osVersion: "15", language: "en",
    locale: "en_US", versionName: "4.9.12", versionCode: 8, pushToken: null, countryCode: "NL" };
  const data = await apiRaw("PUT", "device", reg, deviceId, null);
  device = { deviceId, xToken: data.xToken };
  localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
  return device;
}

async function api(method, path, body) {
  const d = await ensureDevice();
  try {
    return await apiRaw(method, path, body, d.deviceId, d.xToken);
  } catch (e) {
    if (e.message !== "API 401" && e.message !== "API 403") throw e;
    localStorage.removeItem(DEVICE_KEY);
    device = null;
    const d2 = await ensureDevice();
    return apiRaw(method, path, body, d2.deviceId, d2.xToken);
  }
}

const search = (query, coords) =>
  api("POST", "api/charging-points/charging_point/search", {
    search: query,
    coordinates: coords,
    pagination: { pageSize: 40, pageNumber: 0 },
  });

const details = (uuids) => api("POST", "api/charging-points/charging_points", { uuids });

// ---------- watchlist ----------
let watch = JSON.parse(localStorage.getItem(WATCH_KEY) || "[]");
const saveWatch = () => localStorage.setItem(WATCH_KEY, JSON.stringify(watch));

// ---------- rendering ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function card(point, opts = {}) {
  const d = el("div", "card");
  const row = el("div", "row");
  const cls = STATUS_CLS[point.status] || "unknown";
  const badge = el("span", "badge " + cls);
  badge.append(el("span", "dot"), el("span", "", (STATUS_TEXT[point.status] || "?").toLowerCase()));
  row.append(badge);
  row.append(el("span", "name", opts.short ? (point.displayName || point.evseId) : (point.displayName || point.name || "?")));
  if (point.distanceKm != null) row.append(el("span", "dist", point.distanceKm.toFixed(1) + " km"));
  d.append(row);
  const meta = el("div", "meta");
  if (point.address) meta.append(el("span", "addr", point.address));
  if (point.evseId) meta.append(el("span", "evse", point.evseId));
  d.append(meta);
  if (point.updatedAt) d.append(el("div", "ts", "Updated " + point.updatedAt));
  if (opts.actions) d.append(opts.actions);
  return d;
}

function renderWatch() {
  const box = $("watch");
  box.textContent = "";
  if (!watch.length) {
    box.append(el("div", "note", "No chargers watched yet — tap Watch on a nearby charger below."));
    return;
  }
  for (const w of watch) {
    const actions = el("div", "actions");
    const btnFree = el("button", "mini" + (w.notifyWhenFree ? " on" : ""), "🔔 Free");
    btnFree.onclick = () => { w.notifyWhenFree = !w.notifyWhenFree; saveWatch(); renderWatch(); };
    const btnBusy = el("button", "mini" + (w.notifyWhenBusy ? " on" : ""), "🔔 Busy");
    btnBusy.onclick = () => { w.notifyWhenBusy = !w.notifyWhenBusy; saveWatch(); renderWatch(); };
    const rm = el("button", "mini rm", "Remove");
    rm.onclick = () => { watch = watch.filter((x) => x.uuid !== w.uuid); saveWatch(); renderWatch(); };
    actions.append(btnFree, btnBusy, rm);
    box.append(card({
      uuid: w.uuid, status: w.lastStatus || "UNKNOWN", displayName: w.name,
      evseId: w.evseId, address: "", updatedAt: w.updatedAt,
    }, { short: true, actions }));
  }
}

function renderNearby(points) {
  const box = $("nearby");
  box.textContent = "";
  for (const p of points) {
    const watched = watch.some((w) => w.uuid === p.uuid);
    const btn = el("button", "watch" + (watched ? " watched" : ""), watched ? "✓ Watching" : "+ Watch charger");
    btn.disabled = watched;
    btn.onclick = () => {
      watch.push({ uuid: p.uuid, evseId: p.evseId, name: p.displayName || p.name,
        lastStatus: p.status, updatedAt: null, notifyWhenFree: true, notifyWhenBusy: true });
      saveWatch(); renderWatch(); renderNearby(points);
    };
    box.append(card(p, { actions: btn }));
  }
}

// ---------- polling & notifications ----------
function syncNotifBtn() {
  const btn = $("notifbtn");
  if (!("Notification" in window)) { btn.textContent = "🔕 Unsupported"; btn.disabled = true; return; }
  if (Notification.permission === "granted") { btn.textContent = "🔔 Alerts On"; btn.className = "mini on"; }
  else if (Notification.permission === "denied") { btn.textContent = "🔕 Blocked"; }
}

async function requestNotifications() {
  if (!("Notification" in window)) { $("state").textContent = "Notifications unsupported"; return; }
  await Notification.requestPermission();
  syncNotifBtn();
}

async function poll() {
  if (!watch.length) return;
  let points;
  try {
    points = await details(watch.map((w) => w.uuid));
  } catch (e) {
    $("state").textContent = "Poll error";
    return;
  }
  for (const p of points) {
    const w = watch.find((x) => x.uuid === p.uuid);
    if (!w) continue;
    if (w.lastStatus && w.lastStatus !== p.status) {
      const wantFree = p.status === "AVAILABLE" && w.notifyWhenFree;
      const wantBusy = p.status === "OCCUPIED" && w.notifyWhenBusy;
      if (wantFree || wantBusy) {
        try {
          new Notification("Charger " + (w.name || w.evseId), {
            body: "Now " + STATUS_TEXT[p.status] + " — " + (p.displayName || w.evseId),
            tag: w.uuid, renotify: true,
          });
        } catch (e) { /* ignore */ }
      }
    }
    w.lastStatus = p.status;
    w.updatedAt = p.statusUpdateTimestamp || w.updatedAt;
    w.name = p.displayName || p.name || w.name;
  }
  saveWatch();
  renderWatch();
  const stale = points.filter((p) => p.statusUpdateTimestamp && Date.now() - new Date(p.statusUpdateTimestamp).getTime() > 3 * 3600e3).length;
  $("state").textContent =
    "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
    (stale ? " · " + stale + " stale" : "");
}

let pollTimer = null;
function startPolling() {
  const secs = parseInt($("interval").value, 10);
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, secs * 1000);
  $("state").textContent = "Every " + secs + "s";
}

// ---------- locate & search ----------
function haversine(lat1, lon1, lat2, lon2) {
  const r = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

async function loadNearby(lat, lon) {
  $("state").textContent = "Searching…";
  try {
    const pts = await search("", { latitude: lat, longitude: lon });
    const withDist = pts
      .filter((p) => p.location && p.location.coordinates)
      .map((p) => ({
        ...p,
        distanceKm: haversine(lat, lon, p.location.coordinates.latitude, p.location.coordinates.longitude),
        address: [p.location.address, p.location.city].filter(Boolean).join(", "),
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm);
    renderNearby(withDist);
    $("state").textContent = withDist.length + " nearby";
  } catch (e) {
    $("state").textContent = "Search failed";
  }
}

function useMyLocation() {
  if (!navigator.geolocation) { $("state").textContent = "No GPS — enter manually"; return; }
  $("state").textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(
    (pos) => loadNearby(pos.coords.latitude, pos.coords.longitude),
    () => { $("state").textContent = "Location blocked"; },
    { enableHighAccuracy: true, timeout: 10000 });
}

function manualGo() {
  const lat = parseFloat($("lat").value), lon = parseFloat($("lon").value);
  if (isNaN(lat) || isNaN(lon)) { $("state").textContent = "Invalid coordinates"; return; }
  loadNearby(lat, lon);
}

// ---------- boot ----------
document.addEventListener("DOMContentLoaded", () => {
  $("locate").onclick = useMyLocation;
  $("go").onclick = manualGo;
  $("notifbtn").onclick = requestNotifications;
  $("interval").onchange = startPolling;
  $("refresh").onclick = poll;
  syncNotifBtn();
  startPolling();
  renderWatch();
  poll();
});