# Krieger: A Multi-Model AI Orchestrator

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Krieger is a command-line AI tool that uses a multi-model orchestration system to generate comprehensive answers. It leverages the OpenRouter API to manage a "silent debate" between several AI models, each assigned a specific role, to build a detailed and well-rounded response.

## Core Concept: The Silent Debate

Krieger's approach is based on a multi-agent system that simulates a 'silent debate'. When a query is received, it follows this process:

1.  **Model Roles:** A team of 8+ AI models are assigned distinct roles (e.g., "Critical logician," "Creative coder").
2.  **Debate Rounds:** The user's query is processed in multiple rounds. In each round, every model provides its perspective based on the original query and the previous responses from its peers.
3.  **Final Synthesis:** After the debate concludes, a final "Moderator" model reviews the entire debate transcript and synthesizes the information into a single, coherent answer.

This process is designed to encourage error correction, diverse analysis, and a more detailed final response.

## Features

-   **Multi-Agent System:** Orchestrates a multi-round debate between specialized AI models.
-   **OpenRouter Integration:** Configured to use a variety of models available through the OpenRouter API.
-   **Command Execution:** Can run shell commands identified by the `KRIEGER_CMD` prefix in the AI's output.
-   **Persistent Memory:** Saves and loads conversation history across sessions (`memory.json`).
-   **Quick Mode:** Includes a `!quick` command for fast, single-model answers.
-   **Self-Evaluation:** The AI provides a brief evaluation of its own generated answers.

## Model Configuration

Krieger's debate team is configured with the following roles and models:

| Model Key | Role                                            | Model Identifier (via OpenRouter)                       |
| :-------- | :---------------------------------------------- | :------------------------------------------------------ |
| `deepseek1`  | Critical logician                               | `deepseek/deepseek-chat-v3.1:free`                      |
| `mistral`   | Concise factual summarizer and pattern extractor| `cognitivecomputations/dolphin-mistral-24b-venice-edition:free` |
| `qwen`      | Creative coder and linguistic problem-solver    | `qwen/qwen3-coder:free`                                 |
| `glm`       | Philosophical / ethical reasoning               | `z-ai/glm-4.5-air:free`                                 |
| `kimi`      | Experimental AI perspective                     | `moonshotai/kimi-k2:free`                               |
| `deepseek2`       | Complex scientific reasoning                    | `deepseek/deepseek-r1-distill-llama-70b:free`           |
| `gemma`     | Multimodal reasoning and math                   | `google/gemma-3-12b-it:free`                            |
| `llama`     | Philosophical and ethical reasoning             | `meta-llama/llama-4-maverick:free`                      |
| `deepseek3`    | **Moderator** — Final synthesis and consistency | `deepseek/deepseek-r1-0528:free`                        |

## Getting Started

### Prerequisites

-   [Node.js](https://nodejs.org/) (v18.x or later recommended)
-   `npm` (comes with Node.js)
-   An [OpenRouter API Key](https://openrouter.ai/keys)

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/LuckyTheDead/Krieger.git
    cd Krieger
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Set up your environment:**
    Create a file named `.env` in the project root and add your OpenRouter API key:
    ```env
    OPENROUTER_API_KEY="sk-or-..."
    ```

## Usage

Run the application from your terminal:

```bash
node krieger_or.mjs