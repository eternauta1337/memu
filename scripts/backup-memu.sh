#!/usr/bin/env bash
# Backup cifrado de data/ con restic. Uso: backup-memu.sh [local|offsite]
#
#   local   → repo en otro disco de la misma máquina (MEMU_BACKUP_REPO_LOCAL). Pensado para un
#             timer diario. Escribe data/backup-stamp.
#   offsite → repo remoto (MEMU_BACKUP_REPO_OFFSITE, ej. `sftp:host:ruta`). Pensado para un
#             timer horario OPORTUNISTA, para destinos que no siempre están online (una laptop):
#             si ya hubo un backup en las últimas 20 h no hace nada, y si el host no responde
#             sale en silencio y reintenta. Escribe data/backup-stamp-offsite cuando logra uno.
#
# index.ts vigila ambos stamps y alerta por WhatsApp: local >26 h = el backup está roto;
# offsite >4 días = el destino remoto no aparece hace demasiado.
#
# El cifrado es del lado del origen (el destino solo ve blobs). Los sqlite (memu.db, registry,
# wacli.db, session.db) NO se copian en caliente: se sacan con `sqlite3 .backup` (consistente
# aun con el servicio escribiendo) a un stage que replica las rutas relativas. En el snapshot:
#   data/…   → todo menos *.db*, LOCK, HEARTBEAT (media incluida)
#   stage/…  → los .db consistentes, mismas rutas relativas que en data/
# RESTORE: restic restore <snap> --target /tmp/r && copiar /tmp/r/…/stage/X.db sobre data/X.db.
#
# La clave vive en ~/.config/memu/restic-pass (600), override con RESTIC_PASSWORD_FILE.
# ⚠️ Guardala TAMBIÉN fuera de la máquina (gestor de contraseñas): si se muere el disco, sin
# esa clave los backups no sirven de nada.
#
# Retención corta a propósito (7 diarios + 4 semanales ≈ 30 días): la privacy policy promete
# borrado — un usuario borrado desaparece también de los backups en ≤ ~35 días.

set -euo pipefail

MODE="${1:-local}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$REPO_ROOT/data"
STAGE="$HOME/.cache/memu-backup-stage-$MODE"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-$HOME/.config/memu/restic-pass}"

# Destinos (por entorno — no hay defaults razonables, dependen de la instalación):
#   MEMU_BACKUP_REPO_LOCAL    ruta del repo restic en disco       ej. /mnt/backups/memu-restic
#   MEMU_BACKUP_REPO_OFFSITE  repo remoto                         ej. sftp:mihost:backups/memu
#   MEMU_BACKUP_OFFSITE_HOST  host ssh a probar antes del offsite ej. mihost  (opcional)

log() { echo "[backup:$MODE] $*"; }

case "$MODE" in
  local)
    REPO="${MEMU_BACKUP_REPO_LOCAL:?falta MEMU_BACKUP_REPO_LOCAL (ruta del repo restic)}"
    STAMP="$DATA/backup-stamp"
    ;;
  offsite)
    REPO="${MEMU_BACKUP_REPO_OFFSITE:?falta MEMU_BACKUP_REPO_OFFSITE (repo remoto de restic)}"
    STAMP="$DATA/backup-stamp-offsite"
    # ¿Ya hubo un backup offsite en las últimas 20 h? → nada que hacer hasta mañana.
    if [ -f "$STAMP" ] && [ "$(( $(date +%s) - $(stat -c %Y "$STAMP") ))" -lt $((20 * 3600)) ]; then
      exit 0
    fi
    # ¿El destino está online? Si no, salir en silencio — se reintenta en la próxima corrida.
    if [ -n "${MEMU_BACKUP_OFFSITE_HOST:-}" ] &&
       ! ssh -o BatchMode=yes -o ConnectTimeout=6 "$MEMU_BACKUP_OFFSITE_HOST" true 2>/dev/null; then
      log "$MEMU_BACKUP_OFFSITE_HOST no responde — reintento en la próxima corrida"
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
