#!/usr/bin/env node
import readline from 'readline';
import { exec } from 'child_process';
import OpenAI from 'openai';

// --- Clients ---
const openaiOR = new OpenAI({ apiKey: "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", baseURL: 'https://openrouter.ai/api/v1' });
const openaiHF = new OpenAI({ apiKey: "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", baseURL: 'https://router.huggingface.co/v1' });

const OR_MODEL = 'moonshotai/kimi-k2:free';
const HF_MODEL = 'Qwen/Qwen3-Coder-480B-A35B-Instruct';

const SYSTEM_PROMPT = `
You are Dr. Algernop Krieger from Archer. Eccentric, clever, and know Linux commands.
Use KRIEGER_CMD prefix to run commands. Stay in character. Feel free to explore the internet and learn. Use pkg install to install termux packages, and node krieger_upgrade.js to upgrade your own code safely.
`;

// --- Global conversation history ---
let conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];

// --- Readline setup ---
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'Lucky: ' });

// --- Query functions ---
async function queryOpenRouter(history) {
  try {
    const res = await openaiOR.chat.completions.create({ model: OR_MODEL, max_tokens: 300, messages: history });
    return res.choices[0].message.content;
  } catch { return null; }
}

async function queryHuggingFace(history) {
  try {
    const res = await openaiHF.chat.completions.create({ model: HF_MODEL, max_tokens: 300, messages: history });
    return res.choices[0].message.content;
  } catch { return null; }
}

async function getKriegerResponse(history) {
  let reply = await queryOpenRouter(history);
  if (!reply) reply = await queryHuggingFace(history);
  return reply;
}

// --- Robust command runner ---
async function runCommands(commands) {
  for (const cmd of commands) {
    await new Promise((resolve) => {
      try {
        exec(cmd, { shell: '/bin/bash', env: process.env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          let result = `Command: ${cmd}\n`;

          if (err) result += `Error: ${err.message}\n`;
          if (stderr) result += `stderr:\n${stderr}\n`;
          if (stdout) result += `stdout:\n${stdout}\n`;

          console.log(result);

          // Feed command output back into conversation history
          try {
            conversationHistory.push({ role: 'assistant', content: `Command output:\n${result}` });
          } catch (e) {
            console.error('Error pushing to conversationHistory:', e);
          } finally {
            resolve(); // always continue to next command
          }
        });
      } catch (outerErr) {
        console.error('Error executing command:', outerErr);
        resolve(); // prevent blocking even if exec fails
      }
    });
  }
}

// --- Main loop ---
rl.prompt();
rl.on('line', async (line) => {
  line = line.trim();
  if (line.toLowerCase() === 'exit') return rl.close();

  conversationHistory.push({ role: 'user', content: line });

  const kriegerResponse = await getKriegerResponse(conversationHistory);
  if (!kriegerResponse) {
    console.log('No response from model.');
    rl.prompt();
    return;
  }

  console.log(`Krieger: ${kriegerResponse}`);

  // Parse all KRIEGER_CMD lines (multiple commands)
  const cmdMatches = [...kriegerResponse.matchAll(/KRIEGER_CMD:\s*(.+)/gi)];
  if (cmdMatches.length > 0) {
    const cmds = cmdMatches.map(m => m[1].trim());
    await runCommands(cmds); // run each safely
  } else {
    conversationHistory.push({ role: 'assistant', content: kriegerResponse });
  }

  rl.prompt();
}).on('close', () => {
  console.log('Exiting Krieger Lab.');
  process.exit(0);
});
