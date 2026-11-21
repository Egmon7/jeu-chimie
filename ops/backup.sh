#!/usr/bin/env bash
set -euo pipefail

DIR="${BACKUP_DIR:-/opt/backups}"
APP="${APP_DIR:-/opt/apps/jeu-chimie}"
DB_CONTAINER="${DB_CONTAINER:-jeu-chimie-db}"
MIN_BYTES=20000
KEEP_DAILY=7
KEEP_WEEKLY=4
KEEP_MONTHLY=6

day=$(date +%F)
mkdir -p "$DIR/quotidien" "$DIR/hebdo" "$DIR/mensuel" "$DIR/echecs"
chmod 700 "$DIR/quotidien" "$DIR/hebdo" "$DIR/mensuel" "$DIR/echecs"

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
    -d "{\"sender\":{\"email\":\"$from\",\"name\":\"Jeu - chimie\"},\"to\":[{\"email\":\"$from\"}],\"subject\":\"Sauvegarde de la base en échec\",\"textContent\":\"La sauvegarde du $day a échoué : $1. Le fichier est gardé dans $DIR/echecs.\"}" || true
}

fail() {
  local reason=$1
  [ -f "$tmp" ] && mv "$tmp" "$DIR/echecs/jeu_chimie_${day}_$(date +%H%M).dump"
  log "ÉCHEC : $reason"
  alert "$reason"
  exit 1
}

keep_newest() {
  local folder=$1 count=$2
  find "$folder" -maxdepth 1 -type f -name '*.dump' -printf '%T@ %p\n' \
    | sort -rn | tail -n +"$((count + 1))" | cut -d' ' -f2- | xargs -r rm -f
}

tmp="$DIR/.en-cours.dump"
umask 077
if ! docker exec "$DB_CONTAINER" pg_dump -U jeu -Fc jeu_chimie > "$tmp"; then
  fail "pg_dump a échoué"
fi
size=$(stat -c %s "$tmp")
[ "$size" -ge "$MIN_BYTES" ] || fail "fichier trop petit ($size octets)"
docker exec -i "$DB_CONTAINER" pg_restore -l < "$tmp" > /dev/null 2>&1 || fail "fichier illisible par pg_restore"

daily="$DIR/quotidien/jeu_chimie_$day.dump"
mv "$tmp" "$daily"
[ "$(date +%u)" = "7" ] && cp "$daily" "$DIR/hebdo/jeu_chimie_$day.dump"
[ "$(date +%d)" = "01" ] && cp "$daily" "$DIR/mensuel/jeu_chimie_$day.dump"

keep_newest "$DIR/quotidien" "$KEEP_DAILY"
keep_newest "$DIR/hebdo" "$KEEP_WEEKLY"
keep_newest "$DIR/mensuel" "$KEEP_MONTHLY"
keep_newest "$DIR/echecs" 5

log "OK : $daily ($size octets)"
