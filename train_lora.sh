#!/usr/bin/env bash
set -euo pipefail

BASE_MODEL="cognitivecomputations/dolphon-mistral-24b-venice-edition:free"
TRAIN_FILE="train.jsonl"
OUTPUT_DIR="lora_updates"

# Convert self_supervised.jsonl if not done
if [[ ! -f "$TRAIN_FILE" ]]; then
    jq -c '{input: .context, output: .response}' self_supervised.jsonl > train.jsonl
fi

echo "Starting LoRA fine-tuning on $BASE_MODEL"

python3 -m finetune_lora \
    --base_model "$BASE_MODEL" \
    --train_file "$TRAIN_FILE" \
    --output_dir "$OUTPUT_DIR" \
    --batch_size 1 \
    --epochs 1 \
    --learning_rate 1e-4 \
    --fp16