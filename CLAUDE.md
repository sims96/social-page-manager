# Social Page Manager

Apps for managing social media pages, each deployed separately to Cloudflare Workers.

- `facebook-app/`: main Facebook page manager (worker `fb-page-manager`), including AI replies (Claude, Gemini backup) and the Lyza voice
- `facebook-app-2/`: second Facebook page manager (worker `fb-page-manager-2`, AI replies off)
- `google-app/`: planned

Deploy an app with `npx wrangler deploy` from inside its folder. Secrets are set with `npx wrangler secret put <NAME>` and never committed.

## Git rules

- Commits are authored by the repo owner only. Never add a `Co-Authored-By: Claude` trailer or any other Claude/AI attribution to commit messages or PR descriptions.
- This repo is public: never commit API keys, tokens, workspace IDs or `.dev.vars` / `.env` files.
