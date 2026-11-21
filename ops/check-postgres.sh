#!/usr/bin/env bash
set -euo pipefail

APP="${APP_DIR:-/opt/apps/jeu-chimie}"
DB_CONTAINER="${DB_CONTAINER:-jeu-chimie-db}"
APP_CONTAINER="${APP_CONTAINER:-jeu-chimie}"
EOL_WARNING_DAYS=180

log() { echo "$(date '+%F %T') $*"; }

env_value() {
  grep -E "^$1=" "$APP/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r'
}

alert() {
  local key from
  key=$(env_value BREVO_API_KEY)
  from=$(env_value MAIL_FROM)
  [ -n "$key" ] && [ -n "$from" ] || return 0
  curl -s -o /dev/null --max-time 15 https://api.brevo.com/v3/smtp/email \
    -H "api-key: $key" -H "content-type: application/json" \
    -d "{\"sender\":{\"email\":\"$from\",\"name\":\"Jeu - chimie\"},\"to\":[{\"email\":\"$from\"}],\"subject\":\"PostgreSQL : $1\",\"textContent\":\"$2\"}" || true
}

running=$(docker exec "$DB_CONTAINER" postgres --version | grep -oE '[0-9]+\.[0-9]+' | head -1)
major=${running%%.*}
minor=${running##*.}

if ! versions=$(curl -s --fail --max-time 20 https://www.postgresql.org/versions.json); then
  log "Impossible de lire versions.json"
  exit 1
fi

read -r latest eol < <(printf '%s' "$versions" | docker exec -i "$APP_CONTAINER" node -e '
  let s = "";
  process.stdin.on("data", (d) => { s += d; }).on("end", () => {
    const v = JSON.parse(s).find((x) => String(x.major) === process.argv[1]);
    console.log(v ? `${v.latestMinor} ${v.eolDate}` : "0 0");
  });
' "$major")

if [ "$latest" = "0" ]; then
  log "Branche $major introuvable dans versions.json"
  exit 1
fi

if [ "$latest" -gt "$minor" ]; then
  log "Mise à jour disponible : $major.$latest (en service : $running)"
  alert "mise à jour $major.$latest disponible" "La version $major.$latest de PostgreSQL est sortie. La base tourne en $running. Lis l'annonce sur https://www.postgresql.org/support/security/ puis mets à jour l'image dans docker-compose.yml (postgres:$major.$latest-alpine)."
else
  log "PostgreSQL $running à jour"
fi

left=$(( ( $(date -d "$eol" +%s) - $(date +%s) ) / 86400 ))
if [ "$left" -lt "$EOL_WARNING_DAYS" ]; then
  log "Fin de maintenance de la branche $major dans $left jours ($eol)"
  alert "fin de maintenance de la branche $major" "La branche $major de PostgreSQL ne sera plus maintenue après le $eol (dans $left jours). Prévois le passage à une version majeure plus récente."
fi
