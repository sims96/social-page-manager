# Social Page Manager

Lightweight web apps for managing social media pages, built on Cloudflare Workers and Hono.

| Folder | What it is |
|---|---|
| `facebook-app/` | Facebook page manager: posts, comments, stories, insights, AI replies |
| `facebook-app-2/` | A second Facebook page manager for another page |
| `google-app/` | Coming later |

Each app has its own `package.json` and `wrangler.toml`. To run or deploy one:

```
cd facebook-app
npm install
npx wrangler deploy
```
