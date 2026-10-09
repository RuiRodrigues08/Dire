#!/usr/bin/env bash
# Arranca o Ollama (se ainda não estiver a correr) e o backend (porta 8000).
set -euo pipefail
cd "$(dirname "$0")/../backend"

# Só se aplica quando é este script a arrancar o Ollama; com o serviço systemd, ver README 3.1.
export OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0
if ! curl -sf http://127.0.0.1:11434/api/tags >/dev/null; then
  echo "A arrancar o Ollama…"
  (ollama serve >/tmp/ollama.log 2>&1 &)
  for _ in $(seq 1 30); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 1; done
fi

# Interface: compilar se ainda não existir (depois de mudar o frontend: cd frontend && npm run build).
if [ ! -f ../frontend/dist/index.html ]; then
  echo "A compilar a interface…"
  (cd ../frontend && npm install --silent && npm run build) || { echo "Falhou a compilação do frontend"; exit 1; }
fi

[ -f .env ] || { echo "Falta backend/.env (copiar de .env.example)"; exit 1; }
[ -f profiles.json ] || { echo "Falta backend/profiles.json (ver README)"; exit 1; }
[ -d .venv ] && source .venv/bin/activate
exec python -m app.main
