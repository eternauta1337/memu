# Bench v2: prompts ÚNICOS por request (sin prefix-cache de vLLM) — el caso real de N usuarios
# DISTINTOS preguntando a la vez. Tamaños: ~6k tok (agente típico) y ~30k tok (estrés). Además
# muestrea vllm:gpu_cache_usage_perc durante la corrida.
import json, os, time, threading, urllib.request, statistics

# Config por entorno (o .env del repo). METRICS es opcional: el endpoint /metrics del server de
# inferencia, para muestrear el uso de KV cache mientras corre el bench.
BASE = os.environ.get("LLM_BASE_URL", "http://127.0.0.1:4000/v1")
METRICS = os.environ.get("LLM_METRICS_URL")
MODEL = os.environ.get("LLM_MODEL", "")
KEY = os.environ.get("LLM_API_KEY")
if not KEY or not MODEL:
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    with open(env_path) as f:
        for line in f:
            for var, cur in (("LLM_API_KEY", KEY), ("LLM_MODEL", MODEL)):
                if line.startswith(f"{var}=") and not cur:
                    val = line.strip().split("=", 1)[1]
                    KEY = val if var == "LLM_API_KEY" else KEY
                    MODEL = val if var == "LLM_MODEL" else MODEL

SYSTEM = "Sos Memu, asistente dentro del WhatsApp de la persona. Rioplatense, concreto.\n" + "\n".join(
    f"- Hecho {i}: dato de ejemplo {i}." for i in range(30))

def fake_chat(salt, lines):
    return "\n".join(
        f"[2026-07-{(i % 28) + 1:02d}] Persona{(i * salt) % 9}: mensaje {salt}-{i} sobre la obra de la casa, "
        f"el presupuesto {salt * 100 + i} y la entrega del jueves; también del asado del grupo {salt}." for i in range(lines))

SEQ = [0]
def payload(tok_target):
    SEQ[0] += 1
    salt = SEQ[0]
    lines = int(tok_target / 30)  # ~30 tok por línea
    msgs = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": f"(consulta {salt}) ¿Qué quedó del presupuesto de la obra?"},
        {"role": "assistant", "content": "Busco en tus chats."},
        {"role": "user", "content": "Contexto:\n" + fake_chat(salt, lines) + "\nRespondé breve."},
    ]
    return {"model": MODEL, "messages": msgs, "max_tokens": 350, "temperature": 0.3, "stream": True,
            "stream_options": {"include_usage": True}}

def kv_usage():
    if not METRICS:
        return None
    try:
        with urllib.request.urlopen(METRICS, timeout=5) as r:
            for line in r.read().decode().splitlines():
                if line.startswith("vllm:gpu_cache_usage_perc{"):
                    return float(line.rsplit(" ", 1)[1])
    except Exception:
        return None

def one_request(tok_target, out):
    body = json.dumps(payload(tok_target)).encode()
    req = urllib.request.Request(f"{BASE}/chat/completions", data=body,
        headers={"content-type": "application/json", "authorization": f"Bearer {KEY}"})
    t0 = time.monotonic(); ttft = None; usage = None
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            for raw in r:
                line = raw.decode("utf-8", "ignore").strip()
                if not line.startswith("data: ") or line == "data: [DONE]": continue
                try: chunk = json.loads(line[6:])
                except Exception: continue
                if ttft is None and chunk.get("choices") and (chunk["choices"][0].get("delta") or {}).get("content"):
                    ttft = time.monotonic() - t0
                if chunk.get("usage"): usage = chunk["usage"]
        total = time.monotonic() - t0
        ct = (usage or {}).get("completion_tokens") or 0
        pt = (usage or {}).get("prompt_tokens") or 0
        gen = total - (ttft or 0)
        out.append({"ttft": ttft, "total": total, "ctok": ct, "ptok": pt,
                    "tps": ct / gen if ct and gen > 0 else None})
    except Exception as e:
        out.append({"error": str(e)[:120]})

def run(tok_target, conc):
    out = []; peak = [0.0]; stop = threading.Event()
    def poll():
        while not stop.is_set():
            v = kv_usage()
            if v is not None: peak[0] = max(peak[0], v)
            time.sleep(0.5)
    poller = threading.Thread(target=poll); poller.start()
    t0 = time.monotonic()
    threads = [threading.Thread(target=one_request, args=(tok_target, out)) for _ in range(conc)]
    for t in threads: t.start()
    for t in threads: t.join()
    wall = time.monotonic() - t0
    stop.set(); poller.join()
    ok = [o for o in out if "error" not in o and o.get("tps")]
    errs = [o for o in out if "error" in o]
    if errs: print(f"  ~{tok_target // 1000}k x{conc}: {len(errs)} ERRORES: {errs[0]['error']}")
    if not ok: return
    med = lambda k: statistics.median(o[k] for o in ok)
    mx = lambda k: max(o[k] for o in ok)
    agg = sum(o["ctok"] for o in ok) / wall
    print(f"  ~{med('ptok') / 1000:4.1f}k tok x{conc:2d} | TTFT med {med('ttft'):5.2f}s max {mx('ttft'):5.2f}s | "
          f"total med {med('total'):5.1f}s | {med('tps'):5.1f} tok/s por req | agregado {agg:6.1f} tok/s | "
          f"KV peak {peak[0] * 100:4.1f}% | wall {wall:5.1f}s")

print("caso típico (~6k tok, prompts únicos):")
for conc in (1, 2, 5, 10): run(6000, conc)
print("estrés (~30k tok, prompts únicos):")
for conc in (1, 2, 5): run(30000, conc)
