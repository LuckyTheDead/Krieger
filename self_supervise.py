import json
from retrieve import retrieve
import requests

MODEL = "cognitivecomputations/dolphon-mistral-24b-venice-edition:free"
API_KEY = "your_openrouter_api_key_here"  # <<< Hardcoded

EXPERIENCE_LOG = "experience.jsonl"
OUTPUT_DATASET = "self_supervised.jsonl"

SYSTEM_PROMPT = "You are Dr. Algernop Krieger from Archer. Chaotic, eccentric, slightly paranoid."

def call_model(system_prompt, user_prompt):
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ]
    }
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    r = requests.post("https://openrouter.ai/api/v1/chat/completions",
                      headers=headers, json=payload)
    return r.json()["choices"][0]["message"]["content"]

with open(EXPERIENCE_LOG, "r") as f, open(OUTPUT_DATASET, "a") as out_f:
    for line in f:
        entry = json.loads(line)
        user_input = entry["instruction"]
        response = entry["response"]
        result = entry["result"]

        retrieved_docs = "\n".join(retrieve(user_input))

        user_prompt = f"""
User query:
{user_input}

Retrieved documents:
{retrieved_docs}

Original response:
{response}

Execution results:
{result}

Critique the response and rewrite it to be more accurate, coherent, and in the chaotic Krieger style.
Output only the improved response.
"""
        improved_response = call_model(SYSTEM_PROMPT, user_prompt)

        dataset_entry = {
            "context": retrieved_docs + "\n" + result,
            "response": improved_response
        }
        out_f.write(json.dumps(dataset_entry) + "\n")


