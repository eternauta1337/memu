#!/usr/bin/env bash
# Backup cifrado de data/ con restic. Uso: backup-memu.sh [local|offsite]
#
#   local   → repo en /mnt/backups (segundo disco de host-backend). memu-backup.timer, diario 03:30
#             America/Montevideo (= 06:30 UTC, UY no tiene DST). Escribe data/backup-stamp.
#   offsite → repo en el host-offsite (laptop) vía SFTP/Tailscale. Como el host-offsite se duerme/se va, el
#             timer (memu-backup-offsite.timer) intenta CADA HORA: si ya hubo un backup en
#             las últimas 20 h no hace nada, si el host-offsite no responde sale en silencio (se
#             reintenta en 1 h). Escribe data/backup-stamp-offsite cuando logra uno.
#
# index.ts vigila ambos stamps y alerta por WhatsApp: local >26 h = el backup está roto;
# offsite >4 días = el host-offsite no aparece en el tailnet — prendelo un rato.
#
# El cifrado es del lado de host-backend (el destino solo ve blobs). Los sqlite (memu.db, registry,
# wacli.db, session.db) NO se copian en caliente: se sacan con `sqlite3 .backup` (consistente
# aun con el servicio escribiendo) a un stage que replica las rutas relativas. En el snapshot:
#   data/…   → todo menos *.db*, LOCK, HEARTBEAT (media incluida)
#   stage/…  → los .db consistentes, mismas rutas relativas que en data/
# RESTORE: restic restore <snap> --target /tmp/r && copiar /tmp/r/…/stage/X.db sobre data/X.db.
#
# La clave vive en ~/.config/memu/restic-pass (600). ⚠️ Guardala TAMBIÉN fuera de host-backend
# (1Password): si se muere el disco, sin esa clave los backups no sirven de nada.
#
# Retención corta a propósito (7 diarios + 4 semanales ≈ 30 días): la privacy policy promete
# borrado — un usuario borrado desaparece también de los backups en ≤ ~35 días.

set -euo pipefail

MODE="${1:-local}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$REPO_ROOT/data"
STAGE="$HOME/.cache/memu-backup-stage-$MODE"
export RESTIC_PASSWORD_FILE="$HOME/.config/memu/restic-pass"

log() { echo "[backup:$MODE] $*"; }

case "$MODE" in
  local)
    REPO="/mnt/backups/backups/memu-restic"
    STAMP="$DATA/backup-stamp"
    ;;
  offsite)
    REPO="sftp:host-offsite:backups/memu-restic"
    STAMP="$DATA/backup-stamp-offsite"
    # ¿Ya hubo un backup al host-offsite en las últimas 20 h? → nada que hacer hasta mañana.
    if [ -f "$STAMP" ] && [ "$(( $(date +%s) - $(stat -c %Y "$STAMP") ))" -lt $((20 * 3600)) ]; then
      exit 0
    fi
    # ¿El host-offsite está despierto en el tailnet? Si no, salir en silencio — se reintenta en 1 h.
    if ! ssh -o BatchMode=yes -o ConnectTimeout=6 host-offsite true 2>/dev/null; then
      log "host-offsite no responde — reintento en la próxima corrida"
      exit 0
    fi
    ;;
  *)
    echo "uso: $0 [local|offsite]" >&2
    exit 2
    ;;
esac

# Primer uso contra un destino nuevo: crear el repo (idempotente).
if ! restic -r "$REPO" cat config >/dev/null 2>&1; then
  log "repo nuevo → restic init"
  restic -r "$REPO" init --quiet
fi

# --- 1. Stage consistente de los sqlite ------------------------------------------------------
rm -rf "$STAGE"
mkdir -p "$STAGE"
while IFS= read -r -d '' db; do
  rel="${db#"$DATA"/}"
  mkdir -p "$STAGE/$(dirname "$rel")"
  sqlite3 -cmd ".timeout 30000" "$db" ".backup '$STAGE/$rel'"
done < <(find "$DATA" -type f -name '*.db' -print0)
log "stage sqlite listo: $(find "$STAGE" -type f | wc -l) DBs"

# --- 2. Snapshot + retención -----------------------------------------------------------------
# Los sqlite vivos de data/ se excluyen POR RUTA EXACTA (un patrón `*.db` pisaría también los
# del stage, que son justamente los que queremos adentro).
EXCL="$(mktemp)"
trap 'rm -f "$EXCL"; rm -rf "$STAGE"' EXIT
find "$DATA" -type f \( -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' \
  -o -name LOCK -o -name HEARTBEAT \) > "$EXCL"
echo "$DATA/backup-stamp*" >> "$EXCL"

restic -r "$REPO" backup "$DATA" "$STAGE" \
  --exclude-file "$EXCL" --exclude 'tts-*.ogg' \
  --tag memu --quiet
restic -r "$REPO" forget --keep-daily 7 --keep-weekly 4 --prune --quiet
log "OK → $REPO"

# --- 3. Stamp de éxito (lo vigila index.ts) --------------------------------------------------
date -u +%Y-%m-%dT%H:%M:%SZ > "$STAMP"
log "listo ✅"
