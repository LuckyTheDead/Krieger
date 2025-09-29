#!/usr/bin/env bash
set -euo pipefail

echo "=== Krieger Lab Initial Setup ==="

# ===== CONFIG =====
CORPUS_DIR="web_corpus"
META_FILE="meta.json"
INDEX_FILE="index.faiss"
SELF_SUP_FILE="self_supervised.jsonl"
EXPERIENCE_LOG="experience.jsonl"

mkdir -p "$CORPUS_DIR"

# ===== STEP 1: Sample Web Pages =====
echo "Creating sample web pages..."
cat > "$CORPUS_DIR/page1.txt" <<'EOF'
Quantum flux capacitor experiments show anomalous energy spikes.
EOF

cat > "$CORPUS_DIR/page2.txt" <<'EOF'
Python script logs for sensor 7 indicate consistent 1024 readings.
EOF

cat > "$CORPUS_DIR/page3.txt" <<'EOF'
Chemical X reacts violently with water, producing vivid reactions.
EOF

# ===== STEP 2: Meta file =====
echo "Creating meta.json..."
jq -n '[{"file":"page1.txt"},{"file":"page2.txt"},{"file":"page3.txt"}]' > "$META_FILE"

# ===== STEP 3: Generate FAISS index =====
echo "Creating FAISS index..."
python3 - <<'PYTHON'
import faiss, json, numpy as np
from sentence_transformers import SentenceTransformer
import os

CORPUS_DIR = "web_corpus"
META_FILE = "meta.json"
INDEX_FILE = "index.faiss"

model = SentenceTransformer('all-MiniLM-L6-v2')
meta = json.load(open(META_FILE))

embeddings = []
for entry in meta:
    path = os.path.join(CORPUS_DIR, entry["file"])
    with open(path, 'r', encoding='utf-8') as f:
        text = f.read()
    emb = model.encode([text])[0]
    embeddings.append(emb)

emb_matrix = np.array(embeddings).astype("float32")
index = faiss.IndexFlatL2(emb_matrix.shape[1])
index.add(emb_matrix)
faiss.write_index(index, INDEX_FILE)
print("FAISS index created.")
PYTHON

# ===== STEP 4: Sample experience.jsonl =====
echo "Creating sample experience.jsonl..."
cat > "$EXPERIENCE_LOG" <<'EOF'
{"instruction":"Check quantum capacitor status","context":"Quantum flux capacitor experiments show anomalous energy spikes.","response":"Flux capacitor at 42% chaotic efficiency!","result":"Status OK"}
{"instruction":"Read sensor 7 logs","context":"Python script logs for sensor 7 indicate consistent 1024 readings.","response":"Sensor 7 screams in binary! Reading: 1024 units of paranoia.","result":"Readings recorded"}
{"instruction":"Test Chemical X reaction","context":"Chemical X reacts violently with water, producing vivid reactions.","response":"Chemical X throws a tantrum when touched by water! Chaos ensues.","result":"Reaction observed"}
EOF

# ===== STEP 5: Sample self_supervised.jsonl =====
echo "Creating sample self_supervised.jsonl..."
cat > "$SELF_SUP_FILE" <<'EOF'
{"context":"Quantum flux capacitor experiments show anomalous energy spikes.\nStatus OK","response":"Ah yes! Flux capacitors behaving like caffeinated squirrels! Efficiency? Perfectly chaotic at 42%! More experiments imminent!"}
{"context":"Python script logs for sensor 7 indicate consistent 1024 readings.\nReadings recorded","response":"Sensor 7 screaming in binary! 1024 units of pure, unadulterated paranoia. Adjusting parameters... violently!"}
{"context":"Chemical X reacts violently with water, producing vivid reactions.\nReaction observed","response":"Chemical X just threw a tantrum! Water dared to touch it, chaos ensues! Reaction observed, as expected, by yours truly, Krieger!"}
EOF

echo "=== Krieger Lab setup complete! ==="
echo "Web corpus, FAISS index, meta.json, experience.jsonl, and self_supervised.jsonl created."


