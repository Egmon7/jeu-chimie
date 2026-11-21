const SITE = "https://jeu-chimie.prosperegmon.pro";

export function mailReady() {
  return Boolean(process.env.BREVO_API_KEY && process.env.MAIL_FROM);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

export async function sendResetCode(to, code) {
  if (!mailReady()) return false;
  const shown = `${code.slice(0, 3)} ${code.slice(3)}`;
  const text = [
    "Bonjour,",
    "",
    "Voici ton code pour choisir un nouveau mot de passe sur Jeu - chimie :",
    "",
    shown,
    "",
    "Il est valable 15 minutes et ne sert qu’une fois.",
    "",
    "Si tu n’as rien demandé, ignore ce message : ton mot de passe ne change pas.",
    "",
    "— Jeu - chimie",
    SITE,
  ].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.5">`
    + `<p>Bonjour,</p>`
    + `<p>Voici ton code pour choisir un nouveau mot de passe sur Jeu - chimie :</p>`
    + `<p style="font-size:28px;font-weight:bold;letter-spacing:4px">${escapeHtml(shown)}</p>`
    + `<p>Il est valable 15 minutes et ne sert qu’une fois.</p>`
    + `<p>Si tu n’as rien demandé, ignore ce message : ton mot de passe ne change pas.</p>`
    + `<p>— Jeu - chimie<br><a href="${SITE}">jeu-chimie.prosperegmon.pro</a></p>`
    + `</div>`;
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: { email: process.env.MAIL_FROM, name: process.env.MAIL_FROM_NAME || "Jeu - chimie" },
      to: [{ email: to }],
      subject: "Ton code pour changer de mot de passe",
      textContent: text,
      htmlContent: html,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Brevo ${response.status}`);
  return true;
}
