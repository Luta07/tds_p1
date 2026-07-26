# TDS Data-Analyst Telegram Bot

A free-to-run Telegram bot that answers data-analysis questions (MOSPI and
similar public datasets) using an LLM agent, and logs every run to a public
JSONL file in this repository.

## How it works

1. Telegram sends your message to a Cloudflare Worker via webhook.
2. The Worker logs the incoming message to `logs/run.jsonl` (in this repo).
3. The Worker asks Gemini (with web-search grounding) to research and answer.
4. The Worker logs the final answer, then replies to you on Telegram with it.

## Stack (100% free tier)

- **Cloudflare Workers** - hosting, no idle server, no cost
- **Google Gemini API** - free tier LLM with search grounding
- **GitHub Contents API** - used as free, public log storage

## Files

- `src/index.js` - all the bot logic
- `wrangler.toml` - Cloudflare Worker config (edit `GITHUB_OWNER`/`GITHUB_REPO`)
- `logs/run.jsonl` - the run log (public, wget-able via raw.githubusercontent.com)

## Setup

```bash
npm install -g wrangler
npm install
npx wrangler login
```

Edit `wrangler.toml` and set `GITHUB_OWNER` / `GITHUB_REPO` to your own.

Set secrets (never commit these):

```bash
npx wrangler secret put TELEGRAM_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GITHUB_TOKEN
```

Deploy:

```bash
npx wrangler deploy
```

This prints a URL like `https://tds-data-bot.<you>.workers.dev`.

Point Telegram at it:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook?url=https://tds-data-bot.<you>.workers.dev"
```

## Log URL

Once `logs/run.jsonl` exists in this repo, it is public at:

```
https://raw.githubusercontent.com/<GITHUB_OWNER>/<GITHUB_REPO>/main/logs/run.jsonl
```

This is the `log_url` your bot returns in every answer.
