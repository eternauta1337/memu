# Memu

A WhatsApp assistant — a "second brain" pinned to your own self-chat ("Message yourself"): it
knows what's pending, who's waiting on a reply, drafts responses (without ever answering for
you), and lets you talk through your day at the end of it.

## How it works

Memu links to the user's WhatsApp as a **companion device** (via [`wacli`](https://wacli.sh),
a wrapper around whatsmeow). From there it ingests DMs, groups and the self-chat into SQLite,
indexes everything with embeddings, and replies in the self-chat.

There are two channels:

- **Per-user companion** — reads that person's chats and writes *only* to their self-chat.
  It never replies to third parties.
- **Central bot** — a dedicated number where people onboard, subscribe and ask questions.
  It's the only one that talks to strangers.

The backend is a multi-tenant orchestrator: one process, one isolated runtime per user
(`data/users/<id>/`, each with its own database and its own wacli store), and a pool that
decides which users currently have an active `follow`.

### Inference dependencies

Memu ships no models: it consumes four services over HTTP, all configurable via env.

| Piece | What it expects | Env |
|---|---|---|
| LLM | OpenAI-compatible endpoint (`/chat/completions`) with tool calling | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` |
| Embeddings | [TEI](https://github.com/huggingface/text-embeddings-inference), native `/embed` endpoint, 768-dim | `EMBED_URL` |
| STT | OpenAI-compatible `/v1/audio/transcriptions` (e.g. faster-whisper) | `STT_URL`, `STT_MODEL` |
| TTS | [Inworld](https://inworld.ai) (paid API) | `INWORLD_API_KEY`, `INWORLD_VOICE_DEFAULT` |

They can live on the same machine or on another one reachable over a private network; the
first three usually want a GPU.

## Requirements

- **Node 22** and **pnpm**
- **wacli** ≥ 0.11 on your `PATH` (or `WACLI_BIN` pointing at it)
- The inference services above

## Getting started

```bash
pnpm install
cp .env.example .env      # fill in LLM_*, EMBED_URL, STT_URL, INWORLD_*

# Register the first user and pair them by code
pnpm add-user --phone +59899XXXXXXX

# Orchestrator (ingestion + central bot + answer loop). Ctrl-C to stop.
pnpm ingest
```

To pair with a QR code instead: `pnpm pair`.

> ⚠️ Pairing links Memu to the user's **personal** WhatsApp number, so the ban risk lands on
> that number. The design (reads a lot, writes only to the self-chat, never to third parties)
> is the lowest-risk pattern available, but it isn't zero.

### Verifying

```bash
pnpm ask "what's pending?"          # one-off question from the CLI, no WhatsApp involved
sqlite3 data/users/1/memu.db "SELECT chat_kind, count(*) FROM messages GROUP BY chat_kind;"
```

## Scripts

| Command | What it does |
|---|---|
| `pnpm ingest` | multi-tenant orchestrator (the main process) |
| `pnpm control-plane` | bearer-token HTTP API so the web frontend can provision and pair users |
| `pnpm add-user` / `pnpm delete-user` | sign-up and removal (removal wipes data and records it) |
| `pnpm pair` | interactive QR pairing |
| `pnpm ask "…"` | query the brain from the terminal |
| `pnpm rem` | commitment-detection run (proposes tasks, never inserts them automatically) |
| `pnpm digest` | end-of-day summary |
| `pnpm import-history` | dumps `wacli.db` history into Memu's database |
| `pnpm embed` | indexes pending embeddings |

## Layout

```
src/
  index.ts          # orchestrator: shared webhook, runtimes, follow pool, watchdogs
  user-runtime.ts   # everything for ONE user: ingestion, answer loop, sweeps
  central-bot.ts    # central-number bot: onboarding, subscription, routing by sender
  control-plane.ts  # provisioning/pairing HTTP API (called server-side by the web frontend)
  registry.ts       # central user registry (status, subscription, removals)
  store.ts          # per-user SQLite (better-sqlite3 + sqlite-vec, WAL)
  agent.ts tools.ts # the brain: agent loop with tools
  retrieval.ts      # hybrid retrieval (FTS + vectors) over messages
  tasks.ts rem.ts   # tasks and nightly commitment detection
  llm.ts embeddings.ts stt.ts tts.ts   # clients for the inference services
  wacli/            # wacli binary client + webhook server
```

> Note: the source comments are written in Spanish, as is the assistant's own voice.

## Privacy

Each user's data is **physically isolated** under `data/users/<id>/`: leaking data across
users through a badly written query is impossible. The process runs with `UMask=0077` and
everything it creates is born 600/700. By default the journal logs **no** message content,
only metadata (`MEMU_LOG_CONTENT=1` turns it on, for debugging only). Archived chats are
neither ingested nor indexed.
