#!/usr/bin/env bash
# Baja el binario de Piper (TTS) + la voz es_AR-daniela a ./data/piper (gitignored).
# El código lo espera en las rutas por default de src/tts.ts (PIPER_BIN / PIPER_VOICE).
#   ./scripts/get-piper.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)/data/piper"
mkdir -p "$DIR"
cd "$DIR"

PIPER_URL="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz"
VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_AR/daniela/high"
VOICE="es_AR-daniela-high"

if [ ! -x "$DIR/piper/piper" ]; then
  echo "→ bajando binario piper…"
  curl -fsSL -o piper.tar.gz "$PIPER_URL"
  tar xzf piper.tar.gz
  rm -f piper.tar.gz
fi

if [ ! -f "$DIR/$VOICE.onnx" ]; then
  echo "→ bajando voz $VOICE (~109MB)…"
  curl -fsSL -o "$VOICE.onnx" "$VOICE_BASE/$VOICE.onnx"
  curl -fsSL -o "$VOICE.onnx.json" "$VOICE_BASE/$VOICE.onnx.json"
fi

echo "✅ Piper listo en $DIR"
echo "   binario: $DIR/piper/piper"
echo "   voz:     $DIR/$VOICE.onnx"
