# Memu

Asistente de WhatsApp — un "segundo cerebro" que vive pineado en el self-chat ("Mensajes
contigo mismo") del usuario: sabe los pendientes, a quién responder, sugiere respuestas (sin
responder por vos) y permite conversar al final del día sobre lo que pasó.

## Cómo funciona

Memu se linkea al WhatsApp del usuario como **companion device** (vía [`wacli`](https://wacli.sh),
que envuelve whatsmeow). Desde ahí ingiere DMs, grupos y self-chat a SQLite, los indexa con
embeddings y responde en el self-chat.

Hay dos canales:

- **Companion por usuario** — lee los chats de esa persona y escribe *solo* en su self-chat.
  Nunca responde a terceros.
- **Bot central** — un número dedicado por donde la gente hace onboarding, paga y consulta.
  Es el único que habla con desconocidos.

El backend es un orquestador multi-tenant: un proceso, un runtime aislado por usuario
(`data/users/<id>/`, con su propia DB y su propio store de wacli), y un pool que decide qué
usuarios tienen `follow` activo.

### Dependencias de inferencia

Memu no trae modelos: consume cuatro servicios por HTTP, todos configurables por env.

| Pieza | Qué espera | Env |
|---|---|---|
| LLM | endpoint OpenAI-compatible (`/chat/completions`) con tool calling | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` |
| Embeddings | [TEI](https://github.com/huggingface/text-embeddings-inference), endpoint nativo `/embed`, 768-dim | `EMBED_URL` |
| STT | OpenAI-compatible `/v1/audio/transcriptions` (ej. faster-whisper) | `STT_URL`, `STT_MODEL` |
| TTS | [Inworld](https://inworld.ai) (API paga) | `INWORLD_API_KEY`, `INWORLD_VOICE_DEFAULT` |

Pueden vivir en la misma máquina o en otra alcanzable por red privada; los tres primeros
suelen querer GPU.

## Requisitos

- **Node 22** y **pnpm**
- **wacli** ≥ 0.11 en el `PATH` (o `WACLI_BIN` apuntándolo)
- Los servicios de inferencia de arriba

## Puesta en marcha

```bash
pnpm install
cp .env.example .env      # completá LLM_*, EMBED_URL, STT_URL, INWORLD_*

# Alta del primer usuario: lo registra y lo parea por código
pnpm add-user --phone +59899XXXXXXX

# Orquestador (ingesta + bot central + loop de respuesta). Ctrl-C corta.
pnpm ingest
```

Para parear por QR en vez de código: `pnpm pair`.

> ⚠️ El pairing linkea Memu al **número personal** del usuario, así que el riesgo de ban
> recae sobre ese número. El diseño (lee mucho, escribe solo al self-chat, nunca a terceros)
> es el patrón de menor riesgo, pero no es cero.

### Verificar

```bash
pnpm ask "¿qué tengo pendiente?"    # pregunta puntual por CLI, sin WhatsApp
sqlite3 data/users/1/memu.db "SELECT chat_kind, count(*) FROM messages GROUP BY chat_kind;"
```

## Scripts

| Comando | Qué hace |
|---|---|
| `pnpm ingest` | orquestador multi-tenant (el proceso principal) |
| `pnpm control-plane` | HTTP con bearer token para que la web provisione y paree usuarios |
| `pnpm add-user` / `pnpm delete-user` | alta y baja (la baja borra datos y deja constancia) |
| `pnpm pair` | pairing interactivo por QR |
| `pnpm ask "…"` | consultar el cerebro desde la terminal |
| `pnpm rem` | corrida de detección de compromisos (tareas propuestas, nunca auto-insertadas) |
| `pnpm digest` | resumen del día |
| `pnpm import-history` | vuelca el histórico de `wacli.db` a la DB de Memu |
| `pnpm embed` | indexa embeddings pendientes |

## Estructura

```
src/
  index.ts          # orquestador: webhook compartido, runtimes, pool de follows, watchdogs
  user-runtime.ts   # todo lo de UN usuario: ingesta, answer loop, sweeps
  central-bot.ts    # bot del número central: onboarding, suscripción, ruteo por remitente
  control-plane.ts  # HTTP de aprovisionamiento/pairing (lo llama la web, server-side)
  registry.ts       # registro central de usuarios (estado, suscripción, bajas)
  store.ts          # SQLite por usuario (better-sqlite3 + sqlite-vec, WAL)
  agent.ts tools.ts # cerebro: loop de agente con herramientas
  retrieval.ts      # recuperación híbrida (FTS + vectores) sobre los mensajes
  tasks.ts rem.ts   # tareas y detección nocturna de compromisos
  llm.ts embeddings.ts stt.ts tts.ts   # clientes de los servicios de inferencia
  wacli/            # cliente del binario wacli + webhook server
```

## Privacidad

Los datos de cada usuario están **físicamente aislados** en `data/users/<id>/`: es imposible
filtrar entre usuarios por un query mal escrito. El proceso corre con `UMask=0077` y todo lo
que crea nace 600/700. Por default el journal **no** loguea contenido de mensajes, solo
metadata (`MEMU_LOG_CONTENT=1` lo prende, solo para debug). Los chats archivados no se
ingieren ni se indexan.
