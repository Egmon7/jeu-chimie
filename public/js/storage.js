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
  const stored = read().prefs || {};
  const prefs = { ...defaultSettings(), ...stored };
  if (!stored.scoreChosen && Number(prefs.scoreLimit) === 0) prefs.scoreLimit = 10;
  return prefs;
}

export function savePrefs(prefs) {
  const data = read();
  data.prefs = prefs;
  write(data);
}

const PROFILE_ICONS = ["dot", "house", "star", "crown", "pen", "book", "flame", "gem"];

export function loadProfile() {
  const profile = read().profile || {};
  const icon = PROFILE_ICONS.includes(profile.icon) ? profile.icon : "dot";
  return {
    name: typeof profile.name === "string" ? profile.name : "",
    email: typeof profile.email === "string" ? profile.email : "",
    icon,
    photo: /^https:\/\/res\.cloudinary\.com\/ka4h4lpk\/image\/upload\/[A-Za-z0-9_./%-]{1,360}$/.test(profile.photo) ? profile.photo : "",
  };
}

export function saveProfile(profile) {
  const data = read();
  const previous = data.profile || {};
  const icon = PROFILE_ICONS.includes(profile.icon)
    ? profile.icon
    : PROFILE_ICONS.includes(previous.icon) ? previous.icon : "dot";
  const photo = /^https:\/\/res\.cloudinary\.com\/ka4h4lpk\/image\/upload\/[A-Za-z0-9_./%-]{1,360}$/.test(profile.photo)
    ? profile.photo
    : (/^https:\/\/res\.cloudinary\.com\/ka4h4lpk\/image\/upload\/[A-Za-z0-9_./%-]{1,360}$/.test(previous.photo) ? previous.photo : "");
  data.profile = {
    name: String(profile.name || "").trim(),
    email: String(profile.email || "").trim(),
    icon,
    photo,
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

export function replaceHistory(entries) {
  const data = read();
  data.history = Array.isArray(entries) ? entries.slice(0, 40) : [];
  write(data);
  return data.history;
}

export function playerId() {
  const key = "egmon-player-id";
  let id = localStorage.getItem(key) || sessionStorage.getItem(key);
  if (!id) id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}
