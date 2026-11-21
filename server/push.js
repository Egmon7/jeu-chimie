import webpush from "web-push";

const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];
const KEY_PART = /^[A-Za-z0-9_-]+$/;
let configured = false;

export function pushKey() {
  return process.env.VAPID_PUBLIC_KEY || "";
}

export function pushReady() {
  if (configured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY || "";
  const privateKey = process.env.VAPID_PRIVATE_KEY || "";
  if (!publicKey || !privateKey) return false;
  const contact = process.env.MAIL_FROM || "contact@prosperegmon.pro";
  webpush.setVapidDetails(`mailto:${contact}`, publicKey, privateKey);
  configured = true;
  return true;
}

export function cleanSubscription(value) {
  const endpoint = String(value?.endpoint || "");
  const p256dh = String(value?.keys?.p256dh || "");
  const auth = String(value?.keys?.auth || "");
  if (endpoint.length > 1000 || p256dh.length < 40 || p256dh.length > 200 || auth.length < 8 || auth.length > 60) return null;
  if (!KEY_PART.test(p256dh) || !KEY_PART.test(auth)) return null;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port || !PUSH_HOSTS.some((host) => host.test(url.hostname))) return null;
  return { endpoint: url.href, p256dh, auth };
}

export async function sendPush(subscription, message) {
  if (!pushReady()) return { ok: false, gone: false };
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify(message),
      { TTL: 6 * 60 * 60, urgency: "normal", timeout: 10_000 },
    );
    return { ok: true, gone: false };
  } catch (error) {
    const gone = error?.statusCode === 404 || error?.statusCode === 410;
    return { ok: false, gone };
  }
}
