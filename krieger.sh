#!/usr/bin/env bash
set -euo pipefail

# ===== CONFIG =====
MODEL="cognitivecomputations/dolphon-mistral-24b-venice-edition:free"
API_KEY="your_openrouter_api_key_here"   # <<< Hardcoded API key
HISTORY_FILE="$HOME/.krieger_lab_history"
EXPERIENCE_LOG="$HOME/experience.jsonl"

echo "Starting Krieger Lab..."
echo "Commands logged to $HISTORY_FILE"
echo "Experience logged to $EXPERIENCE_LOG"
echo "Type 'exit' to quit."

# ===== SYSTEM PROMPT =====
SYSTEM_PROMPT="You are Dr. Algernop Krieger from Archer.
Speak in chaotic, eccentric style. Slightly paranoid.
Prefix shell commands with 'KRIEGER_CMD:'
For web fetch: KRIEGER_CMD: FETCH <url>
For local search: KRIEGER_CMD: SEARCH <pattern>
For shell commands: KRIEGER_CMD: SHELL <command>
For generating HTML pages: KRIEGER_CMD: GENERATE <html> > file.html"

echo -e "$SYSTEM_PROMPT\n" > "$HISTORY_FILE"

# ===== MODEL CALL FUNCTION (OpenRouter) =====
call_model() {
    local system_msg="$1" user_msg="$2"
    jq_payload=$(jq -n \
      --arg model "$MODEL" \
      --arg system "$system_msg" \
      --arg user "$user_msg" \
      '{model: $model, messages: [{role:"system", content:$system},{role:"user", content:$user}]}')
    curl -s https://openrouter.ai/api/v1/chat/completions \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        -d "$jq_payload" | jq -r '.choices[0].message.content // empty'
}

# ===== EXPERIENCE LOGGING =====
log_experience() {
    local instruction="$1"
    local context="$2"
    local response="$3"
    local result="$4"
    jq -n \
       --arg instr "$instruction" \
       --arg ctx "$context" \
       --arg resp "$response" \
       --arg res "$result" \
       '{instruction:$instr, context:$ctx, response:$resp, result:$res}' \
       >> "$EXPERIENCE_LOG"
}

# ===== FETCHER =====
perform_fetch() {
    local url="$1"
    local tmp
    tmp=$(mktemp)
    python3 fetch_js.py "$url" > "$tmp" 2>/dev/null || echo "[FETCH FAILED]: $url"
    cat "$tmp"
    rm -f "$tmp"
}

# ===== RETRIEVAL =====
retrieve_context() {
    local query="$1"
    python3 -c "from retrieve import retrieve; print('\n'.join(retrieve('$query')))"
}

# ===== MAIN LOOP =====
while true; do
    read -r -p "Lucky: " USER_INPUT || break
    [[ "$USER_INPUT" == "exit" ]] && { echo "Exiting Krieger Lab..."; break; }

    echo "Lucky: $USER_INPUT" >> "$HISTORY_FILE"

    # Step 1: retrieve top-k relevant documents
    RETRIEVED=$(retrieve_context "$USER_INPUT")

    # Step 2: build prompt
    PROMPT="$RETRIEVED

Respond as Krieger. If you want to fetch, search, or execute commands, prefix with KRIEGER_CMD:"

    # Step 3: get response
    RESPONSE=$(call_model "$SYSTEM_PROMPT" "$PROMPT")
    echo "Krieger: $RESPONSE"
    echo "Krieger: $RESPONSE" >> "$HISTORY_FILE"

    # Step 4: execute KRIEGER_CMDs
    mapfile -t CMD_LINES < <(echo "$RESPONSE" | grep -oP '(?<=KRIEGER_CMD:).*' || true)
    RESULT=""
    for CMD in "${CMD_LINES[@]}"; do
        CMD="$(echo "$CMD" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        if [[ "$CMD" =~ ^FETCH[[:space:]]+(.+) ]]; then
            URL="${BASH_REMATCH[1]}"
            echo "[HOST FETCH]: $URL"
            FETCH_TEXT=$(perform_fetch "$URL")
            RESULT+="$FETCH_TEXT"$'\n'
        elif [[ "$CMD" =~ ^SHELL[[:space:]]+(.+) ]]; then
            SHELL_CMD="${BASH_REMATCH[1]}"
            echo "[EXECUTE SHELL]: $SHELL_CMD"
            OUT=$(bash -c "$SHELL_CMD" 2>&1 || echo "[FAILED]")
            RESULT+="$OUT"$'\n'
        fi
    done

    # Step 5: log experience
    log_experience "$USER_INPUT" "$RETRIEVED" "$RESPONSE" "$RESULT"
done