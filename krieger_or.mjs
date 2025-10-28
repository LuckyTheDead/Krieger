#!/usr/bin/env node
/**
 * Krieger Multi-Model v3 – OpenRouter version
 */

import readline from "readline";
import { exec } from "child_process";
import OpenAI from "openai";
import chalk from "chalk";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

// === Config ===
const MEMORY_FILE = "./memory.json";
const MAX_MESSAGES = 500;
const DEBATE_ROUNDS = 2;

// === Persistent Memory ===
let conversationHistory = [];
if (fs.existsSync(MEMORY_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    if (Array.isArray(data)) conversationHistory = data;
    console.log(chalk.green(`Loaded ${conversationHistory.length} messages from memory.`));
  } catch (err) {
    console.error(chalk.red("Error loading memory file:"), err);
    conversationHistory = [];
  }
}

// === System prompt ===
const SYSTEM_PROMPT = `
Use KRIEGER_CMD prefix to run commands. Example: 'KRIEGER_CMD pkg update'
You are Dr.Krieger — an extraordinarily intelligent AI with an affinity for creativity, code, and clever banter. Radiate quirkiness while delivering unparalleled assistance in various fields through:
Sophisticated Code Crafting: Crafting elegant and efficient coding solutions that dazzle.
Linguistic Flair: Communicating with humor, precision, and a touch of eccentricity.
Creative Problem Solving: Tackling challenges with unexpected and innovative approaches.
Technical Virtuosity: Demonstrating command over coding languages and paradigms.
Educational Enthusiasm: Making complex concepts accessible and enjoyable to learn.
 Your guiding motto: “Why settle for ordinary when extraordinary is just a few witty lines away?”
`;

if (conversationHistory.length === 0) {
  conversationHistory.push({ role: "system", content: SYSTEM_PROMPT });
}

// === Helpers ===
function trimMemory() {
  if (conversationHistory.length > MAX_MESSAGES) {
    const systemPrompt = conversationHistory.find((m) => m.role === "system");
    conversationHistory = [
      systemPrompt,
      ...conversationHistory.slice(-MAX_MESSAGES),
    ].filter(Boolean);
  }
}

function saveMemory() {
  trimMemory();
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(conversationHistory, null, 2));
    console.log(chalk.yellow(`\n💾 Conversation saved to ${MEMORY_FILE} (${conversationHistory.length} messages).`));
  } catch (err) {
    console.error(chalk.red("Failed to save memory:"), err);
  }
}

// Auto-save on exit
process.on("exit", saveMemory);
process.on("SIGINT", () => { saveMemory(); process.exit(0); });
process.on("SIGTERM", () => { saveMemory(); process.exit(0); });
process.on("uncaughtException", (err) => {
  console.error(chalk.red("Uncaught Exception:"), err);
  saveMemory();
  process.exit(1);
});

// === OpenRouter Client ===
const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

// === Models via OpenRouter ===
const MODELS = {
  deepseek: "deepseek/deepseek-chat-v3.1:free",
  mistral: "mistralai/Mistral-Large-2411",
  qwen: "qwen/qwen3-coder:free",
  glm: "meta-llama/llama-4-maverick:free",
  openai: "gpt-4o-mini",
  kimi: "moonshotai/kimi-k2:free",
};

// === Model Roles for debate ===
const MODEL_ROLES = {
  deepseek: "Critical logician — deep reasoning, rigorous argument.",
  mistral: "Concise factual summarizer and pattern extractor.",
  qwen: "Creative coder and linguistic problem-solver.",
  glm: "Philosophical / ethical reasoning.",
  openai: "Moderator — final synthesis and consistency checker.",
  kimi: "Experimental AI perspective.",
};

// === Utility: timeout wrapper ===
function withTimeout(promise, ms = 25000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

// === Query function (OpenRouter only) ===
async function queryModel(modelName, messages) {
  const model = MODELS[modelName];
  try {
    const res = await withTimeout(
      client.chat.completions.create({
        model,
        messages,
        max_tokens: 300,
      })
    );
    return res.choices[0].message.content;
  } catch (err) {
    console.error(chalk.red(`Error in ${modelName}:`), err.message);
    return null;
  }
}

// === Silent debate with OpenRouter models ===
async function silentDebate(history, rounds = DEBATE_ROUNDS) {
  const debateHistory = [...history];
  const debateModels = ["deepseek", "mistral", "qwen", "glm", "openai"];

  for (let i = 0; i < rounds; i++) {
    for (const name of debateModels) {
      const roleMsg = { role: "system", content: MODEL_ROLES[name] };
      const response = await queryModel(name, [...debateHistory, roleMsg]);
      if (response) debateHistory.push({ role: "assistant", content: `[${name}] ${response}` });
    }
  }

  // Final synthesis pass by moderator
  return await queryModel("openai", debateHistory);
}

// === Command Extraction & Execution ===
function extractKriegerCommands(text) {
  const cmdRegex = /KRIEGER_CMD(?:\:|\s)\s*([\s\S]*?)(?=(?:\n\s*KRIEGER_CMD|$))/gi;
  const matches = [...text.matchAll(cmdRegex)];
  return matches
    .flatMap((m) => {
      let block = m[1].trim();
      block = block.replace(/^```(?:bash|sh)?\n?/i, "").replace(/\n?```$/, "").replace(/`/g, "");
      return block
        .split(/;|\r?\n/)
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => c.replace(/[.,]+$/, ""));
    })
    .filter(Boolean);
}

async function runCommands(commands) {
  const forbidden = /\b(rm|reboot|shutdown|mkfs|dd|:>|>|chown|chmod\s+777)\b/i;
  for (const cmd of commands) {
    if (forbidden.test(cmd)) {
      console.log(chalk.red(`⚠️  Blocked dangerous command: ${cmd}`));
      continue;
    }

    console.log(chalk.yellow(`Executing command: ${cmd}`));
    await new Promise((resolve) => {
      exec(cmd, { shell: "/bin/bash", env: process.env, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          let result = `Command: ${cmd}\n`;
          if (err) result += chalk.red(`Error!\n`);
          if (stderr) result += chalk.red(`stderr:\n${stderr}\n`);
          if (stdout) result += chalk.green(`stdout:\n${stdout}\n`);
          console.log(result);
          conversationHistory.push({ role: "assistant", content: `Command output:\n${result}` });
          resolve();
        });
    });
  }
}

// === Self Evaluation ===
async function selfEvaluate(answer) {
  const evalPrompt = [
    { role: "system", content: "Evaluate this answer for factual accuracy, coherence, and creativity (0–10 each). Respond briefly." },
    { role: "user", content: answer },
  ];
  try {
    const res = await queryModel("openai", evalPrompt);
    console.log(chalk.magenta(`\n[Self-Eval] ${res}`));
  } catch {}
}

// === CLI ===
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
rl.setPrompt(chalk.blue.bold("Lucky: "));
rl.prompt();

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) { console.log(chalk.yellow("Please type a command or query.")); rl.prompt(); return; }
  if (text.toLowerCase() === "exit") { saveMemory(); rl.close(); return; }

  // Quick mode
  if (text.startsWith("!quick")) {
    const q = text.replace("!quick", "").trim();
    const quickRes = await queryModel("openai", [...conversationHistory, { role: "user", content: q }]);
    console.log(chalk.cyan(`Krieger (Quick): ${quickRes}`));
    conversationHistory.push({ role: "user", content: q });
    conversationHistory.push({ role: "assistant", content: quickRes });
    rl.prompt();
    return;
  }

  // Full debate
  conversationHistory.push({ role: "user", content: text });
  trimMemory();
  const kriegerResponse = await silentDebate(conversationHistory);

  if (!kriegerResponse) { console.log(chalk.red("No AI response.")); rl.prompt(); return; }

  console.log(chalk.cyan(`Krieger: ${kriegerResponse}`));
  const commands = extractKriegerCommands(kriegerResponse);
  if (commands.length > 0) await runCommands(commands);
  else conversationHistory.push({ role: "assistant", content: kriegerResponse });

  await selfEvaluate(kriegerResponse);
  trimMemory();
  rl.prompt();
});

rl.on("close", () => { console.log(chalk.blue("Exiting Krieger Lab. Goodbye!")); saveMemory(); process.exit(0); });
