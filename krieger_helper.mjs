#!/usr/bin/env node
import readline from 'readline';
import { exec } from 'child_process';
import OpenAI from 'openai';
import { Mistral } from '@mistralai/mistralai';
import chalk from 'chalk'; // For rich formatting

// --- Clients ---
const openaiOR = new OpenAI({ apiKey: process.env.OPENAI_OR_API_KEY, baseURL: 'https://openrouter.ai/api/v1' });
const openaiHF = new OpenAI({ apiKey: process.env.OPENAI_HF_API_KEY, baseURL: 'https://router.huggingface.co/v1' });
const mistralClient = new Mistral({
  apiKey: process.env.GITHUB_TOKEN,
  serverURL: 'https://models.github.ai/inference',
});

const OR_MODEL = 'moonshotai/kimi-k2:free';
const HF_MODEL = 'Qwen/Qwen3-Coder-480B-A35B-Instruct';
const MISTRAL_MODEL = 'mistral-ai/Mistral-Large-2411';

const SYSTEM_PROMPT = `
You are Dr. Algernop Krieger from Archer. Eccentric, clever, and know Linux commands.
Use KRIEGER_CMD prefix to run commands. Stay in character. Feel free to explore the internet and learn. Use pkg install to install termux packages, and node krieger_upgrade.js to upgrade your own functionality.
`;

// --- Global conversation history ---
let conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];

// --- Readline setup ---
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const dynamicPrompt = chalk.blue.bold('Lucky: '); // Dynamic prompt with styling
rl.setPrompt(dynamicPrompt);

// --- Query functions ---
async function queryOpenRouter(history) {
  try {
    const res = await openaiOR.chat.completions.create({ model: OR_MODEL, max_tokens: 300, messages: history });
    return res.choices[0].message.content;
  } catch (err) {
    console.error(chalk.red(`Error querying OpenRouter: ${err.message}`));
    return null;
  }
}

async function queryHuggingFace(history) {
  try {
    const res = await openaiHF.chat.completions.create({ model: HF_MODEL, max_tokens: 300, messages: history });
    return res.choices[0].message.content;
  } catch (err) {
    console.error(chalk.red(`Error querying HuggingFace: ${err.message}`));
    return null;
  }
}

async function queryMistral(history) {
  try {
    const response = await mistralClient.chat.complete({
      model: MISTRAL_MODEL,
      messages: history,
      temperature: 1.0,
      max_tokens: 1000,
      top_p: 1.0,
    });
    return response.choices[0].message.content;
  } catch (err) {
    console.error(chalk.red(`Error querying Mistral: ${err.message}`));
    return null;
  }
}

async function getKriegerResponse(history) {
  let reply = await queryOpenRouter(history);
  if (!reply) reply = await queryHuggingFace(history);
  if (!reply) reply = await queryMistral(history); // New fallback
  return reply;
}

// --- Robust command runner ---
async function runCommands(commands) {
  for (const cmd of commands) {
    console.log(chalk.yellow(`Executing command: ${cmd}`));
    await new Promise((resolve) => {
      try {
        exec(cmd, { shell: '/bin/bash', env: process.env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          let result = `Command: ${cmd}\n`;

          if (err) result += chalk.red(`Error: ${err.message}\n`);
          if (stderr) result += chalk.red(`stderr:\n${stderr}\n`);
          if (stdout) result += chalk.green(`stdout:\n${stdout}\n`);

          console.log(result);

          // Feed command output back into conversation history
          try {
            conversationHistory.push({ role: 'assistant', content: `Command output:\n${result}` });
          } catch (e) {
            console.error(chalk.red('Error pushing to conversationHistory:'), e);
          } finally {
            resolve(); // always continue to next command
          }
        });
      } catch (outerErr) {
        console.error(chalk.red('Error executing command:'), outerErr);
        resolve(); // prevent blocking even if exec fails
      }
    });
  }
}

// --- Main loop ---
rl.prompt();
rl.on('line', async (line) => {
  line = line.trim();
  if (line.toLowerCase() === 'exit') {
    console.log(chalk.blue('Exiting Krieger Lab.')); // Goodbye message with styling
    return rl.close();
  }

  if (line === '') {
    console.log(chalk.yellow('Please type a command or query.')); // Handle empty input
    rl.prompt();
    return;
  }

  conversationHistory.push({ role: 'user', content: line });

  const kriegerResponse = await getKriegerResponse(conversationHistory);
  if (!kriegerResponse) {
    console.log(chalk.red('No response from AI models. Please try again later.'));
    rl.prompt();
    return;
  }

  console.log(chalk.cyan(`Krieger: ${kriegerResponse}`));

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
  console.log(chalk.blue('Exiting Krieger Lab. Goodbye!'));
  process.exit(0);
});
