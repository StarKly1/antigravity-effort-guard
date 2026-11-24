# Effort Guard for Antigravity

A lightweight, zero-dependency Antigravity plugin (Option B — Effort Guard) that classifies incoming user prompts on `PreInvocation` (`invocationNum === 0`) via **TypeSafe AI's Jev System One API** and displays a native-styled right-pane sidecar HUD for live verdicts, session savings, and policy controls.

## Features

- **Jev System One Judge (`PreInvocation` only):** Runs exclusively on `invocationNum === 0` against `POST https://api.typesafe.ai/v1/systemone` (`jev-latest` default, optional `jev-1.14` / `jev-1.13`), evaluating a typed `choice` (`low` | `medium` | `high`) plus parallel `noul` complexity signals in a single non-autoregressive pass with calibrated probabilities (`$0.042/1M` input tokens, free outputs).
- **Guard, Passive, and Off Modes:**
  - **Guard:** Pauses over-specced turns (`errorMessage` + `terminationBehavior: "terminate"`) when recommended effort is lower than active effort and meets your trigger rule & calibrated confidence floor — spending 0 thinking tokens on the paused turn.
  - **Passive:** Never pauses; renders a lightweight inline advisory via `metadata.user_markdown` with empty `systemMessage: ""` (0 model tokens, prompt-cache safe).
  - **Off:** Passes prompts straight through immediately.
- **Instant `!` Bypass:** Prefix any prompt with `!` to skip the judge and run at your active effort immediately.
- **Strict Fail-Open (`2.5s`):** Timeouts, network issues, or a missing API key never block a prompt.
- **Native Side-Pane HUD:** Adapts automatically to Antigravity's light/dark host theme tokens (`--background`, `--foreground`, `--primary`, `--card-bg`, `--editor-font-family`), persists live verdicts and policy settings locally, and controls hook behavior live without restarting.

---

## Requirements

- Node.js 18+ (uses built-in `fetch`, `AbortController`, and `node:http`; zero npm dependencies)
- TypeSafe / Jev API key — paste it directly into **Effort Guard → Configure** (stored locally in `~/.gemini/antigravity/effort-guard/credentials.json` with `0600` permissions) or export `TYPESAFE_API_KEY` / `JEV_API_KEY`
- Optional: `JEV_API_URL` (or `TYPESAFE_API_URL`) to override `https://api.typesafe.ai/v1/systemone`

---

## Installation

### Antigravity CLI

```bash
agy plugin install https://github.com/StarKly1/antigravity-effort-guard
```

### Git Clone

```bash
git clone https://github.com/StarKly1/antigravity-effort-guard.git ~/.gemini/config/plugins/effort-guard
```

After installing, export `TYPESAFE_API_KEY` (or `JEV_API_KEY`) in your environment, enable **effort-guard** in **Customizations → Installed**, and open **Effort Guard** in the right auxiliary side pane.

---

## Plugin Structure

```text
effort-guard/
├── plugin.json                     # Plugin manifest
├── hooks.json                      # PreInvocation hook (invocationNum === 0)
├── lib/
│   ├── effort.mjs                  # Active effort detection & policy evaluation
│   ├── judge.mjs                   # TypeSafe AI Jev System One client (2.5s fail-open)
│   └── store.mjs                   # Atomic local persistence for settings & verdicts
├── scripts/
│   └── effort_guard.mjs            # PreInvocation hook entrypoint
├── sidecars/
│   └── effort-guard/
│       ├── sidecar.json            # Auxiliary side-pane sidecar manifest
│       ├── server.mjs              # Local 127.0.0.1 HTTP server & live policy API
│       └── ui.html                 # Self-contained native-styled sidecar HUD
└── tests/
    └── effort_guard.test.mjs       # Automated unit & integration tests
```

## Running Tests

```bash
node --test tests/effort_guard.test.mjs
```
