# Memo

Asistente de WhatsApp — un "segundo cerebro" que vive pineado en el self-chat ("Mensajes
contigo mismo") del usuario: sabe los pendientes, a quién responder, sugiere respuestas (sin
responder por vos) y permite conversar al final del día sobre lo que pasó.

Plan y arquitectura completos: **`<doc interno>`**.
(`nombre-interno` es el nombre interno del proyecto; el producto se llama **Memo**.)

## Estado: Fase 0 — validar la ingesta

Objetivo: confirmar que podemos linkear el WhatsApp propio como *companion device*, ingerir
todo (DMs, **grupos** y self-chat) a SQLite, y postear en el self-chat. Esto de-riskea el
punto crítico (factibilidad + riesgo de ban) antes de construir nada más.

### Requisitos

- **Node 22** (ya en host-backend).
- **pnpm** — en host-backend está en `~/.local/node/bin` (no en PATH). Prependé:
  `export PATH="/home/usuario/.hermes/node/bin:$PATH"`
- **wacli** — ya instalado en `~/.local/bin/wacli` (v0.11.1, `steipete/wacli`).

### Runbook

```bash
cd ~/memo
export PATH="/home/usuario/.hermes/node/bin:$PATH"   # pnpm
pnpm install                                      # instala deps (better-sqlite3, tsx)
cp .env.example .env                              # ajustá si querés

# 1) Parear (interactivo, escaneás un QR). Correr en una terminal REAL:
pnpm pair
#    WhatsApp del celu → Ajustes → Dispositivos vinculados → Vincular un dispositivo → escaneá.

# 2) Ingerir en vivo (Ctrl-C corta). Vas a ver DMs, grupos y self-chat caer a la DB:
pnpm ingest

# 3) (otra terminal) Smoke test: postear en tu propio self-chat:
pnpm send-self "hola desde Memo"
```

> ⚠️ El pairing linkea Memo a **tu número personal** de WhatsApp. Es la apuesta del producto:
> el riesgo de ban recae sobre ese número. El diseño (lee mucho, escribe solo al self-chat,
> nunca a terceros) es el patrón de menor riesgo, pero no es cero. Para Fase 0 conviene usar
> un número de prueba si tenés uno.

### Verificar lo ingerido

```bash
sqlite3 data/memo.db "SELECT chat_kind, count(*) FROM messages GROUP BY chat_kind;"
sqlite3 data/memo.db "SELECT ts, chat_kind, push_name, substr(text,1,60) FROM messages ORDER BY ts DESC LIMIT 20;"
```

## Estructura

```
src/
  wacli/
    wacli-webhook-types.ts   # tipos del payload de wacli + helpers de JID (portado de Proyecto-interno)
    wacli-webhook-server.ts  # server HTTP loopback HMAC que recibe de `wacli sync` (portado)
    wacli-client.ts          # cliente del binario wacli: send/auth (portado)
  ingest.ts                  # normaliza mensaje → MemoMessage (CONSERVA grupos + self)
  store.ts                   # SQLite (better-sqlite3, WAL): tabla `messages`
  index.ts                   # runner Fase 0: auth → webhook → sync → log + store
  pair.ts                    # `wacli auth` interactivo (QR)
  send-self.ts               # smoke test: postear al self-chat
```

## Diferencias con el canal WhatsApp de Proyecto-interno

- **Conserva grupos** (Proyecto-interno v1 descarta `@g.us`) — la coordinación en grupos es caso de uso central.
- **Conserva self-chat, mensajes propios y reacciones** — Fase 0 quiere ver todo; se marcan con flags.
- **Mono-tenant** y sin dependencias de `@proyecto-interno/*` (agent/store/telegram). Multi-tenant llega en Fase 3.
