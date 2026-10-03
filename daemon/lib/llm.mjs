// Minimal OpenAI-compatible chat completions client.
// Deliberately does not import the memory MCP or spawn any MCP server: an
// unattended call must not be able to recursively schedule more work.

import { redact, tail } from "./core.mjs";

const MAX_TOKENS = 1200;

export async function chat(messages, { endpointUrl, apiKey, model, signal } = {}) {
  const base = (endpointUrl || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: MAX_TOKENS
      }),
      signal: controller.signal
    });

    const raw = await res.text();
    if (!res.ok) {
      // Include the body: 402/429/503 from OpenRouter are the useful diagnostics
      // and carry no credentials. redact() scrubs any that show up anyway.
      throw new Error(`HTTP ${res.status} from endpoint: ${tail(raw, 600)}`);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Endpoint returned non-JSON: ${tail(raw, 600)}`);
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error(
        `Empty completion. usage=${JSON.stringify(data?.usage ?? null)}`
      );
    }

    return {
      content: redact(content.trim()),
      usage: data.usage ?? null,
      model: data.model ?? model
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
