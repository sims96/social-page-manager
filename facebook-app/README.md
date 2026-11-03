# FB Page Manager

Lightweight Facebook Page Management App built with Cloudflare Workers. Post content, manage comments, like, reply, hide/delete - all via Facebook Graph API.

## Features

- **Post Publishing**: Text, photos, videos, and link posts
- **Comment Management**: View, reply, like, hide, delete comments
- **Dashboard**: Quick overview of recent posts and engagement
- **OAuth Flow**: Secure Facebook authorization for US admin

## Tech Stack

- **Backend**: Cloudflare Workers + Hono framework
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **Storage**: Cloudflare KV (sessions) + D1 (optional database)
- **API**: Facebook Graph API v22.0

## Setup Instructions

### 1. Prerequisites

- Node.js 18+
- Cloudflare account (free tier works)
- Facebook Developer account
- Facebook Page with admin access

### 2. Facebook App Setup

1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Create a new app (Type: Business)
3. Add "Facebook Login" product
4. Configure OAuth settings:
   - Valid OAuth Redirect URIs: `https://your-worker.workers.dev/api/auth/callback`
5. Note your **App ID** and **App Secret**

### 3. Required Permissions

Your Facebook App needs these permissions (work in Development mode for admins):

- `pages_show_list` - List available pages
- `pages_read_engagement` - Read comments, reactions
- `pages_manage_engagement` - Reply to comments, like posts
- `pages_manage_posts` - Publish posts
- `pages_read_user_content` - Read page content

### 4. Cloudflare Setup

```bash
# Install dependencies
npm install

# Login to Cloudflare
npx wrangler login

# Create KV namespace for sessions
npx wrangler kv:namespace create SESSIONS
# Copy the ID and update wrangler.toml

# (Optional) Create D1 database
npx wrangler d1 create fb-page-manager-db
# Copy the ID and update wrangler.toml

# Set secrets
npx wrangler secret put FACEBOOK_APP_ID
npx wrangler secret put FACEBOOK_APP_SECRET
```

### 5. Update wrangler.toml

Replace placeholder IDs with your actual KV namespace and D1 database IDs:

```toml
[[kv_namespaces]]
binding = "SESSIONS"
id = "your-actual-kv-id"

[[d1_databases]]
binding = "DB"
database_name = "fb-page-manager-db"
database_id = "your-actual-d1-id"
```

### 6. Development

```bash
# Run locally
npm run dev

# Deploy to Cloudflare
npm run deploy
```

## Usage

### First Time Setup

1. Deploy the app to Cloudflare Workers
2. Visit your worker URL
3. Go to Settings > Connect Facebook Page
4. **US Admin** authorizes the app (from US location)
5. Select the page to manage
6. Start posting and managing comments!

### Posting Content

1. Go to Compose tab
2. Select post type (Text, Photo, Video, Link)
3. Enter your content
4. Click "Publish Now"

### Managing Comments

1. Go to Comments tab
2. View all recent comments across posts
3. Filter by: All, Unanswered, Hidden
4. Actions: Reply, Like, Hide, Delete

## API Endpoints

### Auth
- `GET /api/auth/login` - Get OAuth URL
- `GET /api/auth/callback` - OAuth callback
- `GET /api/auth/session/:id` - Get session data
- `POST /api/auth/save-page` - Save selected page
- `GET /api/auth/active-page` - Get active page info

### Posts
- `GET /api/posts` - List page posts
- `POST /api/posts` - Create text post
- `POST /api/posts/photo` - Create photo post
- `POST /api/posts/video` - Create video post
- `DELETE /api/posts/:id` - Delete post

### Comments
- `GET /api/posts/:id/comments` - Get post comments
- `GET /api/comments/all` - Get all recent comments
- `POST /api/comments/:id/reply` - Reply to comment
- `POST /api/comments/:id/like` - Like comment
- `DELETE /api/comments/:id/like` - Unlike comment
- `POST /api/comments/:id/hide` - Hide/unhide comment
- `DELETE /api/comments/:id` - Delete comment

### Insights
- `GET /api/insights` - Page insights/analytics

## Security Notes

- Page Access Tokens stored in Cloudflare KV (encrypted at rest)
- OAuth state validation prevents CSRF
- Only US admin should authorize the app
- Cloud infrastructure IPs are expected by Facebook

## Environment Variables

| Variable | Description |
|----------|-------------|
| `FACEBOOK_APP_ID` | Your Facebook App ID |
| `FACEBOOK_APP_SECRET` | Your Facebook App Secret |
| `FACEBOOK_API_VERSION` | API version (default: v22.0) |

## Cost

- **Cloudflare Workers**: Free tier (100k requests/day)
- **Cloudflare KV**: Free tier (100k reads/day, 1k writes/day)
- **Cloudflare D1**: Free tier (5M rows read/day)

Estimated cost: **$0/month** for typical usage

## Troubleshooting

### "Invalid OAuth access token" (Error 190)
Token expired. Reconnect the Facebook Page in Settings.

### "Requires pages_manage_engagement permission" (Error 200)
US admin needs to reauthorize with proper permissions.

### Rate Limits
Facebook limits: ~200 calls/hour per user token. Page tokens have higher limits.

## License

MIT
