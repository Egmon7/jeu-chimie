import { defaultSettings } from "./engine.js";

const KEY = "egmon-dots-v1";

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

function write(data) {
  localStorage.setItem(KEY, JSON.stringify(data));
}

export function loadPrefs() {
  return { ...defaultSettings(), ...(read().prefs || {}) };
}

export function savePrefs(prefs) {
  const data = read();
  data.prefs = prefs;
  write(data);
}

export function loadProfile() {
  const profile = read().profile || {};
  return {
    name: typeof profile.name === "string" ? profile.name : "",
    email: typeof profile.email === "string" ? profile.email : "",
  };
}

export function saveProfile(profile) {
  const data = read();
  data.profile = {
    name: String(profile.name || "").trim(),
    email: String(profile.email || "").trim(),
  };
  write(data);
  return data.profile;
}

export function loadHistory() {
  return Array.isArray(read().history) ? read().history : [];
}

export function pushHistory(entry) {
  const data = read();
  const history = Array.isArray(data.history) ? data.history : [];
  data.history = [entry, ...history].slice(0, 40);
  write(data);
  return data.history;
}

export function clearHistory() {
  const data = read();
  data.history = [];
  write(data);
}

export function playerId() {
  const key = "egmon-player-id";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}
