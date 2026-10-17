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
    // /device tokens are occasionally rejected on first use; retry once fresh.
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
  const d = document.createElement("div");
  d.className = "card";
  const row = el("div", "row");
  row.append(el("span", "dot " + (STATUS_CLS[point.status] || "unknown")));
  row.append(el("span", "status " + (STATUS_CLS[point.status] || "unknown"), (STATUS_TEXT[point.status] || "?").toLowerCase()));
  row.append(el("span", "name", opts.short ? (point.displayName || point.evseId) : (point.displayName || point.name || "?")));
  if (point.distanceKm != null) row.append(el("span", "dist", point.distanceKm.toFixed(1) + " km"));
  d.append(row);
  if (point.address) d.append(el("div", "addr", point.address));
  d.append(el("div", "evse", point.evseId || ""));
  if (point.updatedAt) d.append(el("div", "ts", "status updated " + point.updatedAt));
  d.append(opts.actions || el("div"));
  return d;
}

function renderWatch() {
  const box = $("watch");
  box.textContent = "";
  if (!watch.length) {
    box.append(el("div", "note", "Nothing watched yet - tap ⭐ on a charger below."));
    return;
  }
  for (const w of watch) {
    const actions = el("div", "actions");
    const btnFree = el("button", "mini" + (w.notifyWhenFree ? " on" : ""), "🔔 free");
    btnFree.onclick = () => { w.notifyWhenFree = !w.notifyWhenFree; saveWatch(); renderWatch(); };
    const btnBusy = el("button", "mini" + (w.notifyWhenBusy ? " on" : ""), "🔔 busy");
    btnBusy.onclick = () => { w.notifyWhenBusy = !w.notifyWhenBusy; saveWatch(); renderWatch(); };
    const rm = el("button", "mini", "✕");
    rm.onclick = () => { watch = watch.filter((x) => x.uuid !== w.uuid); saveWatch(); renderWatch(); };
    actions.append(btnFree, btnBusy, rm);
    const c = card({
      uuid: w.uuid, status: w.lastStatus || "UNKNOWN", displayName: w.name,
      evseId: w.evseId, address: "", updatedAt: w.updatedAt,
    }, { short: true, actions });
    box.append(c);
  }
}

function renderNearby(points) {
  const box = $("nearby");
  box.textContent = "";
  for (const p of points) {
    const watched = watch.some((w) => w.uuid === p.uuid);
    const btn = el("button", "watch", watched ? "★ watched" : "☆ watch");
    btn.disabled = watched;
    btn.onclick = () => {
      watch.push({ uuid: p.uuid, evseId: p.evseId, name: p.displayName || p.name,
        lastStatus: p.status, updatedAt: null, notifyWhenFree: true, notifyWhenBusy: true });
      saveWatch(); renderWatch(); renderNearby(points);
    };
    const c = card({ ...p, address: p.address, distanceKm: p.distanceKm }, { actions: btn });
    box.append(c);
  }
}

// ---------- polling & notifications ----------
async function requestNotifications() {
  if (!("Notification" in window)) { $("notif").textContent = "Notifications not supported in this browser."; return; }
  const perm = await Notification.requestPermission();
  $("notif").textContent = perm === "granted" ? "🔔 Notifications on" : "Notifications blocked - enable in browser settings.";
}

async function poll() {
  if (!watch.length) return;
  let points;
  try {
    points = await details(watch.map((w) => w.uuid));
  } catch (e) {
    $("state").textContent = "poll failed: " + e.message;
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
            body: "Now " + STATUS_TEXT[p.status] + " - " + (p.displayName || w.evseId),
            tag: w.uuid, renotify: true,
          });
        } catch (e) { /* notifications unavailable; ignore */ }
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
    new Date().toLocaleTimeString() + " · polled " + points.length + " watched" +
    (stale ? " · ⚠ " + stale + " status(es) stale (>3h)" : "") +
    (document.hidden ? " · background (may be paused by OS)" : "");
}

let pollTimer = null;
function startPolling() {
  const secs = parseInt($("interval").value, 10);
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, secs * 1000);
  $("state").textContent = "polling every " + secs + "s";
}

// ---------- locate & search ----------
function haversine(lat1, lon1, lat2, lon2) {
  const r = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

async function loadNearby(lat, lon) {
  $("state").textContent = "searching…";
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
    $("state").textContent = withDist.length + " chargers found. Tap ☆ to watch one.";
  } catch (e) {
    $("state").textContent = "search failed: " + e.message;
  }
}

function useMyLocation() {
  if (!navigator.geolocation) { $("state").textContent = "Geolocation unavailable - use manual lat/lon."; return; }
  $("state").textContent = "locating…";
  navigator.geolocation.getCurrentPosition(
    (pos) => loadNearby(pos.coords.latitude, pos.coords.longitude),
    (err) => { $("state").textContent = "Location blocked (" + err.message + ") - use manual lat/lon."; },
    { enableHighAccuracy: true, timeout: 10000 });
}

function manualGo() {
  const lat = parseFloat($("lat").value), lon = parseFloat($("lon").value);
  if (isNaN(lat) || isNaN(lon)) { $("state").textContent = "Enter valid lat/lon."; return; }
  loadNearby(lat, lon);
}

// ---------- boot ----------
document.addEventListener("DOMContentLoaded", () => {
  $("locate").onclick = useMyLocation;
  $("go").onclick = manualGo;
  $("notifbtn").onclick = requestNotifications;
  $("interval").onchange = startPolling;
  $("refresh").onclick = poll;
  poll();
  startPolling();
  renderWatch();
});