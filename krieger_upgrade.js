#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import ModelClient, { isUnexpected } from '@azure-rest/ai-inference';
import { AzureKeyCredential } from '@azure/core-auth';

// --- Config ---
const KRIEGER_FILE = process.env.KRIEGER_FILE || path.resolve('/data/data/com.termux/files/home/Krieger/krieger_helper.mjs'); // main Krieger file
const BACKUP_FILE = KRIEGER_FILE + '.backup.js';
const UPDATED_FILE = KRIEGER_FILE.replace('.mjs', '_next.mjs');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ENDPOINT = 'https://models.github.ai/inference';
const MODEL = 'deepseek/DeepSeek-V3-0324'; // coding-focused GitHub model

if (!GITHUB_TOKEN) {
  console.error('Error: Set your GitHub token as GITHUB_TOKEN environment variable.');
  process.exit(1);
}

// --- Read Krieger source code ---
function readKriegerSource() {
  if (!fs.existsSync(KRIEGER_FILE)) {
    console.error(`Error: Krieger file not found at ${KRIEGER_FILE}`);
    process.exit(1);
  }
  return fs.readFileSync(KRIEGER_FILE, 'utf-8');
}

// --- Backup current Krieger ---
function backupCurrentKrieger() {
  fs.copyFileSync(KRIEGER_FILE, BACKUP_FILE);
  console.log(`Backup created at ${BACKUP_FILE}`);
}

// --- Prompt user for confirmation ---
function confirmPrompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question + ' (y/n): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

// --- Upgrade function ---
async function upgradeKrieger() {
  const sourceCode = readKriegerSource();

  console.log('Generating upgraded Krieger code using GitHub-hosted model...');

  const client = ModelClient(ENDPOINT, new AzureKeyCredential(GITHUB_TOKEN));

  const response = await client.path('/chat/completions').post({
    body: {
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are Dr. Algernop Krieger from Archer. Eccentric, clever, and expert in Linux commands. Upgrade your code to run more efficiently and handle multiple KRIEGER_CMD commands robustly. Keep your personality intact.'
        },
        {
          role: 'user',
          content: `Here is your current Node.js code:\n\n${sourceCode}\n\nReturn the fully upgraded code, ready to run.`
        }
      ],
      temperature: 0.7,
      top_p: 1.0,
      max_tokens: 2000
    }
  });

  if (isUnexpected(response)) {
    console.error('Error from GitHub API:', response.body.error);
    process.exit(1);
  }

  const updatedCode = response.body.choices[0].message.content;

  console.log('--- Preview of upgraded Krieger ---');
  console.log(updatedCode.slice(0, 500) + '...\n');

  const confirmed = await confirmPrompt(`Write upgraded code to ${UPDATED_FILE}?`);
  if (!confirmed) {
    console.log('Upgrade cancelled.');
    return;
  }

  backupCurrentKrieger();
  fs.writeFileSync(UPDATED_FILE, updatedCode);
  console.log(`Upgraded Krieger written to ${UPDATED_FILE}`);
  console.log(`Run it with: node ${UPDATED_FILE}`);
}

// --- Run ---
upgradeKrieger().catch((err) => {
  console.error('The upgrade process encountered an error:', err);
});
