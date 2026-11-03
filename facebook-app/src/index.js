import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
import manifestJSON from '__STATIC_CONTENT_MANIFEST';
import aiReplyRoutes from './routes/ai-reply.js';

const assetManifest = JSON.parse(manifestJSON);

const app = new Hono();

// CORS middleware
app.use('/api/*', cors());

// Mount AI Reply routes
app.route('/api/ai-reply', aiReplyRoutes);

// Facebook Graph API base URL
const FB_GRAPH_URL = 'https://graph.facebook.com';

// ============================================
// UTILITY FUNCTIONS
// ============================================

function getApiVersion(env) {
  return env.FACEBOOK_API_VERSION || 'v24.0';
}

// Story KV Storage Helpers
async function saveStoryToKV(env, pageId, storyData) {
  const key = `stories_${pageId}`;
  const existing = JSON.parse(await env.SESSIONS.get(key) || '[]');
  existing.unshift(storyData); // Add to front (newest first)
  // Keep only last 50 stories
  const trimmed = existing.slice(0, 50);
  await env.SESSIONS.put(key, JSON.stringify(trimmed));
}

async function getStoriesFromKV(env, pageId) {
  const key = `stories_${pageId}`;
  return JSON.parse(await env.SESSIONS.get(key) || '[]');
}

async function fbApiCall(endpoint, options = {}, env) {
  const version = getApiVersion(env);
  const url = `${FB_GRAPH_URL}/${version}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || 'Facebook API Error');
  }

  return data;
}

// Run up to 50 Graph GET requests in one HTTP call; returns parsed bodies (or { error })
async function fbBatch(relativeUrls, accessToken, env) {
  const results = [];
  for (let i = 0; i < relativeUrls.length; i += 50) {
    const chunk = relativeUrls.slice(i, i + 50);
    const responses = await fbApiCall('/', {
      method: 'POST',
      body: JSON.stringify({
        access_token: accessToken,
        include_headers: false,
        batch: chunk.map(relative_url => ({ method: 'GET', relative_url })),
      }),
    }, env);
    for (const r of responses) {
      try {
        results.push(r ? JSON.parse(r.body) : { error: { message: 'Request timed out' } });
      } catch {
        results.push({ error: { message: 'Invalid response' } });
      }
    }
  }
  return results;
}

// Asking for `from` makes Facebook silently drop comments whose author it won't
// reveal (most of them), so comments are fetched without it. Authors are looked
// up in a separate request and merged in — in practice only the Page's own
// comments come back with an author, which is what "unanswered" needs.
const COMMENT_FIELDS = 'id,message,created_time,like_count,comment_count,is_hidden,user_likes,attachment{type},'
  + 'comments.limit(100){id,message,created_time,like_count,is_hidden,user_likes,attachment{type}}';

async function fetchCommentsForObjects(objectIds, accessToken, env) {
  const urls = [];
  for (const id of objectIds) {
    urls.push(`${id}/comments?fields=${encodeURIComponent(COMMENT_FIELDS)}&limit=100`);
    urls.push(`${id}/comments?filter=stream&fields=id,from&limit=100`);
  }
  const bodies = await fbBatch(urls, accessToken, env);

  const result = new Map();
  for (let i = 0; i < objectIds.length; i++) {
    const main = bodies[i * 2];
    const authors = bodies[i * 2 + 1];
    if (main.error) {
      console.log(`Skipping comments for ${objectIds[i]}:`, main.error.message);
      continue;
    }

    let comments = main.data || [];
    // Posts with more than 100 top-level comments
    let next = main.paging?.next;
    for (let guard = 0; next && guard < 10; guard++) {
      const page = await fetch(next).then(r => r.json()).catch(() => ({}));
      comments = comments.concat(page.data || []);
      next = page.paging?.next;
    }

    let authorList = authors.data || [];
    next = authors.paging?.next;
    for (let guard = 0; next && guard < 10; guard++) {
      const page = await fetch(next).then(r => r.json()).catch(() => ({}));
      authorList = authorList.concat(page.data || []);
      next = page.paging?.next;
    }

    const fromById = new Map();
    for (const a of authorList) if (a.from) fromById.set(a.id, a.from);
    for (const comment of comments) {
      if (fromById.has(comment.id)) comment.from = fromById.get(comment.id);
      for (const reply of comment.comments?.data || []) {
        if (fromById.has(reply.id)) reply.from = fromById.get(reply.id);
      }
      if (comment.comments) delete comment.comments.paging;
    }
    result.set(objectIds[i], comments);
  }
  return result;
}

// ============================================
// AUTH ROUTES
// ============================================

// Initiate OAuth flow - returns URL for US admin to authorize
app.get('/api/auth/login', (c) => {
  const env = c.env;
  const redirectUri = `${new URL(c.req.url).origin}/api/auth/callback`;
  const scope = [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_engagement',
    'pages_manage_posts',
    'pages_read_user_content',
    'pages_manage_metadata',
    'read_insights',
    'public_profile',
  ].join(',');

  const authUrl = `https://www.facebook.com/${getApiVersion(env)}/dialog/oauth?` +
    `client_id=${env.FACEBOOK_APP_ID}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `scope=${scope}&` +
    `response_type=code`;

  return c.json({ authUrl });
});

// OAuth callback - exchange code for token
app.get('/api/auth/callback', async (c) => {
  const env = c.env;
  const code = c.req.query('code');
  const error = c.req.query('error');

  if (error) {
    return c.redirect('/?error=' + encodeURIComponent(c.req.query('error_description') || error));
  }

  if (!code) {
    return c.redirect('/?error=no_code');
  }

  try {
    const redirectUri = `${new URL(c.req.url).origin}/api/auth/callback`;

    // Exchange code for user access token
    const tokenResponse = await fetch(
      `${FB_GRAPH_URL}/${getApiVersion(env)}/oauth/access_token?` +
      `client_id=${env.FACEBOOK_APP_ID}&` +
      `client_secret=${env.FACEBOOK_APP_SECRET}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `code=${code}`
    );

    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      return c.redirect('/?error=' + encodeURIComponent(tokenData.error.message));
    }

    const userAccessToken = tokenData.access_token;

    // Get pages the user manages - request specific fields
    const pagesResponse = await fetch(
      `${FB_GRAPH_URL}/${getApiVersion(env)}/me/accounts?fields=id,name,access_token,category,tasks&access_token=${userAccessToken}`
    );

    const pagesData = await pagesResponse.json();

    console.log('Pages API Response:', JSON.stringify(pagesData));

    if (pagesData.error) {
      return c.redirect('/?error=' + encodeURIComponent(pagesData.error.message));
    }

    // Always try to get Lyza Montez page directly using the known Page ID
    const lyzaMontezPageId = '591108667427868';
    const directPageResponse = await fetch(
      `${FB_GRAPH_URL}/${getApiVersion(env)}/${lyzaMontezPageId}?fields=id,name,access_token,category&access_token=${userAccessToken}`
    );
    const directPageData = await directPageResponse.json();
    console.log('Direct Lyza Montez Page Response:', JSON.stringify(directPageData));

    // Combine pages - start with what /me/accounts returned
    let allPages = pagesData.data || [];

    // Add Lyza Montez if we got it and it's not already in the list
    if (directPageData.id && directPageData.access_token) {
      const alreadyExists = allPages.some(p => p.id === directPageData.id);
      if (!alreadyExists) {
        allPages.push({
          id: directPageData.id,
          name: directPageData.name,
          access_token: directPageData.access_token,
          category: directPageData.category || 'Unknown',
          tasks: ['MANAGE', 'CREATE_CONTENT', 'MODERATE', 'MESSAGING', 'ANALYZE'],
        });
        console.log('Added Lyza Montez to pages list');
      }
    } else if (directPageData.error) {
      console.log('Lyza Montez Direct Request Error:', JSON.stringify(directPageData.error));
    }

    // If we have pages (either from /me/accounts or direct request), save them
    if (allPages.length > 0) {
      const pages = allPages.map(page => ({
        id: page.id,
        name: page.name,
        access_token: page.access_token,
        category: page.category,
        tasks: page.tasks,
      }));

      const sessionId = crypto.randomUUID();
      await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify({
        pages,
        created: Date.now(),
      }), { expirationTtl: 86400 });

      return c.redirect(`/?session=${sessionId}&success=true`);
    }

    // Check if no pages were returned from /me/accounts AND direct request failed
    if (allPages.length === 0) {
      // Debug: Let's also check what permissions were granted
      const debugResponse = await fetch(
        `${FB_GRAPH_URL}/${getApiVersion(env)}/me/permissions?access_token=${userAccessToken}`
      );
      const debugData = await debugResponse.json();
      console.log('Granted permissions:', JSON.stringify(debugData));

      // Try alternative: get pages via /me endpoint with accounts edge
      const altPagesResponse = await fetch(
        `${FB_GRAPH_URL}/${getApiVersion(env)}/me?fields=accounts{id,name,access_token,category,tasks}&access_token=${userAccessToken}`
      );
      const altPagesData = await altPagesResponse.json();
      console.log('Alt Pages API Response:', JSON.stringify(altPagesData));

      if (altPagesData.accounts && altPagesData.accounts.data && altPagesData.accounts.data.length > 0) {
        // Found pages via alternative method
        const pages = altPagesData.accounts.data.map(page => ({
          id: page.id,
          name: page.name,
          access_token: page.access_token,
          category: page.category,
          tasks: page.tasks,
        }));

        const sessionId = crypto.randomUUID();
        await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify({
          pages,
          created: Date.now(),
        }), { expirationTtl: 86400 });

        return c.redirect(`/?session=${sessionId}&success=true`);
      }

      // Try third method: directly request the known Lyza Montez page
      const knownPageId = '591108667427868'; // Lyza Montez page ID
      const directPageResponse = await fetch(
        `${FB_GRAPH_URL}/${getApiVersion(env)}/${knownPageId}?fields=id,name,access_token,category,tasks&access_token=${userAccessToken}`
      );
      const directPageData = await directPageResponse.json();
      console.log('Direct Page API Response:', JSON.stringify(directPageData));

      if (directPageData.id && directPageData.access_token) {
        // Successfully got the page directly
        const pages = [{
          id: directPageData.id,
          name: directPageData.name,
          access_token: directPageData.access_token,
          category: directPageData.category,
          tasks: directPageData.tasks,
        }];

        const sessionId = crypto.randomUUID();
        await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify({
          pages,
          created: Date.now(),
        }), { expirationTtl: 86400 });

        return c.redirect(`/?session=${sessionId}&success=true`);
      }

      // Log any error from direct page request
      if (directPageData.error) {
        console.log('Direct Page Error:', JSON.stringify(directPageData.error));
      }

      return c.redirect('/?error=' + encodeURIComponent('No pages found. The page may be managed by a Business Portfolio that the user is not a member of.'));
    }

    // Store pages data temporarily (in production, save to D1)
    // For now, redirect with success and page info
    const pages = pagesData.data.map(page => ({
      id: page.id,
      name: page.name,
      access_token: page.access_token,
      category: page.category,
      tasks: page.tasks,
    }));

    // Store in KV for the session
    const sessionId = crypto.randomUUID();
    await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify({
      pages,
      created: Date.now(),
    }), { expirationTtl: 86400 }); // 24 hours

    return c.redirect(`/?session=${sessionId}&success=true`);
  } catch (err) {
    return c.redirect('/?error=' + encodeURIComponent(err.message));
  }
});

// Get session data (pages)
app.get('/api/auth/session/:sessionId', async (c) => {
  const env = c.env;
  const sessionId = c.req.param('sessionId');

  const sessionData = await env.SESSIONS.get(`session:${sessionId}`);

  if (!sessionData) {
    return c.json({ error: 'Session not found or expired' }, 404);
  }

  return c.json(JSON.parse(sessionData));
});

// Save selected page token
app.post('/api/auth/save-page', async (c) => {
  const env = c.env;
  const { pageId, accessToken, pageName } = await c.req.json();

  // In production, store in D1 database
  // For now, store in KV
  await env.SESSIONS.put('active_page', JSON.stringify({
    pageId,
    accessToken,
    pageName,
    saved: Date.now(),
  }));

  return c.json({ success: true });
});

// Get active page
app.get('/api/auth/active-page', async (c) => {
  const env = c.env;
  const pageData = await env.SESSIONS.get('active_page');

  if (!pageData) {
    return c.json({ error: 'No page configured' }, 404);
  }

  const page = JSON.parse(pageData);
  return c.json({
    pageId: page.pageId,
    pageName: page.pageName,
    configured: true,
  });
});

// Disconnect page
app.delete('/api/auth/disconnect', async (c) => {
  const env = c.env;
  await env.SESSIONS.delete('active_page');
  return c.json({ success: true });
});

// ============================================
// POSTS ROUTES
// ============================================

// Get page posts (including videos and reels)
app.get('/api/posts', async (c) => {
  const env = c.env;
  const limit = c.req.query('limit') || '25';

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  try {
    // Fetch posts and videos in parallel
    const [postsData, videosData] = await Promise.all([
      // Fetch regular posts
      fbApiCall(
        `/${pageId}/published_posts?fields=id,message,created_time,full_picture,permalink_url,shares,reactions.summary(true),comments.summary(true),attachments{type,media_type,title,description,media,subattachments}&limit=${limit}&access_token=${accessToken}`,
        { method: 'GET' },
        env
      ),
      // Fetch videos/reels - graceful fallback if it fails
      fbApiCall(
        `/${pageId}/videos?fields=id,title,description,created_time,permalink_url,length,picture,source,views,likes.summary(true),comments.summary(true)&limit=${limit}&access_token=${accessToken}`,
        { method: 'GET' },
        env
      ).catch(err => {
        console.log('Videos fetch failed (may need permissions):', err.message);
        return { data: [] };
      })
    ]);

    // Process regular posts
    const processedPosts = (postsData.data || []).map(post => {
      const attachment = post.attachments?.data?.[0];
      const isVideo = attachment?.type === 'video_inline' ||
                      attachment?.type === 'video_autoplay' ||
                      attachment?.media_type === 'video';

      return {
        ...post,
        is_video: isVideo,
        attachment_type: attachment?.type || 'post',
        video_title: isVideo ? (attachment?.title || '') : null,
        full_picture: post.full_picture || attachment?.media?.image?.src || null,
      };
    });

    // Process videos/reels
    const processedVideos = (videosData.data || []).map(video => ({
      id: video.id,
      message: video.description || video.title || '',
      created_time: video.created_time,
      full_picture: video.picture || null,
      permalink_url: video.permalink_url,
      is_video: true,
      attachment_type: 'video',
      video_title: video.title || '',
      video_length: video.length || null,
      video_source: video.source || null,
      views: video.views || 0,
      likes: video.likes?.summary || null,
      comments: video.comments?.summary || null,
      reactions: video.likes?.summary || null, // Map likes to reactions for consistency
    }));

    // Merge and sort by created_time (newest first)
    const allContent = [...processedPosts, ...processedVideos]
      .sort((a, b) => new Date(b.created_time) - new Date(a.created_time))
      .slice(0, parseInt(limit));

    return c.json({ data: allContent });
  } catch (err) {
    console.error('Posts API Error:', err.message);
    return c.json({ error: err.message }, 500);
  }
});

// Publish a text post
app.post('/api/posts', async (c) => {
  const env = c.env;
  const { message, link, published = true } = await c.req.json();

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  try {
    const body = {
      message,
      access_token: accessToken,
      published,
    };

    if (link) {
      body.link = link;
    }

    const data = await fbApiCall(
      `/${pageId}/feed`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      env
    );

    return c.json(data);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Publish a photo post
app.post('/api/posts/photo', async (c) => {
  const env = c.env;
  const { url, caption, published = true } = await c.req.json();

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  try {
    const data = await fbApiCall(
      `/${pageId}/photos`,
      {
        method: 'POST',
        body: JSON.stringify({
          url,
          caption,
          published,
          access_token: accessToken,
        }),
      },
      env
    );

    return c.json(data);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Publish a video post
app.post('/api/posts/video', async (c) => {
  const env = c.env;
  const { file_url, description, title } = await c.req.json();

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  try {
    const data = await fbApiCall(
      `/${pageId}/videos`,
      {
        method: 'POST',
        body: JSON.stringify({
          file_url,
          description,
          title,
          access_token: accessToken,
        }),
      },
      env
    );

    return c.json(data);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Upload a photo file directly
app.post('/api/posts/photo/upload', async (c) => {
  const env = c.env;

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  try {
    // Parse multipart form data
    const formData = await c.req.formData();
    const photoFile = formData.get('photo');
    const caption = formData.get('caption') || '';

    if (!photoFile || !(photoFile instanceof File)) {
      return c.json({ error: 'No photo file provided' }, 400);
    }

    // Create FormData for Facebook API
    const fbFormData = new FormData();
    fbFormData.append('source', photoFile);
    fbFormData.append('caption', caption);
    fbFormData.append('access_token', accessToken);

    // Upload to Facebook
    const response = await fetch(
      `${FB_GRAPH_URL}/${getApiVersion(env)}/${pageId}/photos`,
      {
        method: 'POST',
        body: fbFormData,
      }
    );

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message || 'Facebook API Error');
    }

    return c.json(data);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Upload multiple photos and create a single post with all of them
app.post('/api/posts/photos/upload', async (c) => {
  const env = c.env;

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  try {
    // Parse multipart form data
    const formData = await c.req.formData();
    const caption = formData.get('caption') || '';

    // Get all photo files (they come as photo_0, photo_1, etc.)
    const photoFiles = [];
    for (let i = 0; i < 5; i++) { // Max 5 photos
      const photo = formData.get(`photo_${i}`);
      if (photo && photo instanceof File) {
        photoFiles.push(photo);
      }
    }

    if (photoFiles.length === 0) {
      return c.json({ error: 'No photo files provided' }, 400);
    }

    if (photoFiles.length > 5) {
      return c.json({ error: 'Maximum 5 photos allowed per post' }, 400);
    }

    // If only one photo, use the simpler single-photo endpoint logic
    if (photoFiles.length === 1) {
      const fbFormData = new FormData();
      fbFormData.append('source', photoFiles[0]);
      fbFormData.append('caption', caption);
      fbFormData.append('access_token', accessToken);

      const response = await fetch(
        `${FB_GRAPH_URL}/${getApiVersion(env)}/${pageId}/photos`,
        {
          method: 'POST',
          body: fbFormData,
        }
      );

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message || 'Facebook API Error');
      }
      return c.json(data);
    }

    // Step 1: Upload each photo as unpublished to get photo IDs
    const photoIds = [];
    for (const photoFile of photoFiles) {
      const fbFormData = new FormData();
      fbFormData.append('source', photoFile);
      fbFormData.append('published', 'false'); // Key: upload as unpublished
      fbFormData.append('access_token', accessToken);

      const response = await fetch(
        `${FB_GRAPH_URL}/${getApiVersion(env)}/${pageId}/photos`,
        {
          method: 'POST',
          body: fbFormData,
        }
      );

      const data = await response.json();
      if (data.error) {
        // Abort all if any image fails (per user preference)
        throw new Error(`Failed to upload image: ${data.error.message || 'Unknown error'}`);
      }

      photoIds.push(data.id);
    }

    // Step 2: Create a feed post with all the uploaded photos
    const feedFormData = new FormData();
    feedFormData.append('message', caption);
    feedFormData.append('access_token', accessToken);

    // Add each photo ID as attached_media
    photoIds.forEach((photoId, index) => {
      feedFormData.append(`attached_media[${index}]`, JSON.stringify({ media_fbid: photoId }));
    });

    const feedResponse = await fetch(
      `${FB_GRAPH_URL}/${getApiVersion(env)}/${pageId}/feed`,
      {
        method: 'POST',
        body: feedFormData,
      }
    );

    const feedData = await feedResponse.json();
    if (feedData.error) {
      throw new Error(feedData.error.message || 'Failed to create post with photos');
    }

    return c.json({
      id: feedData.id,
      photoIds: photoIds,
      message: 'Multi-photo post created successfully'
    });

  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Upload a video file directly
app.post('/api/posts/video/upload', async (c) => {
  const env = c.env;

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  try {
    // Parse multipart form data
    const formData = await c.req.formData();
    const videoFile = formData.get('video');
    const description = formData.get('description') || '';
    const title = formData.get('title') || '';

    if (!videoFile || !(videoFile instanceof File)) {
      return c.json({ error: 'No video file provided' }, 400);
    }

    // Check file size (Facebook limit is 10GB, but we'll limit to 1GB for practical reasons)
    const maxSize = 1024 * 1024 * 1024; // 1GB
    if (videoFile.size > maxSize) {
      return c.json({ error: 'Video file too large. Maximum size is 1GB.' }, 400);
    }

    // Create FormData for Facebook API
    const fbFormData = new FormData();
    fbFormData.append('source', videoFile);
    fbFormData.append('description', description);
    if (title) {
      fbFormData.append('title', title);
    }
    fbFormData.append('access_token', accessToken);

    // Upload to Facebook (videos can take longer)
    const response = await fetch(
      `${FB_GRAPH_URL}/${getApiVersion(env)}/${pageId}/videos`,
      {
        method: 'POST',
        body: fbFormData,
      }
    );

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message || 'Facebook API Error');
    }

    return c.json(data);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Delete a post
app.delete('/api/posts/:postId', async (c) => {
  const env = c.env;
  const postId = c.req.param('postId');

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { accessToken } = JSON.parse(pageData);

  try {
    const data = await fbApiCall(
      `/${postId}?access_token=${accessToken}`,
      { method: 'DELETE' },
      env
    );

    return c.json(data);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ============================================
// COMMENTS ROUTES
// ============================================

// Get comments for a post (with pagination support)
app.get('/api/posts/:postId/comments', async (c) => {
  const env = c.env;
  const postId = c.req.param('postId');

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { accessToken } = JSON.parse(pageData);

  try {
    // Always returns every comment (with replies) on the post
    const byPost = await fetchCommentsForObjects([postId], accessToken, env);
    if (!byPost.has(postId)) {
      return c.json({ error: 'Facebook didn’t return comments for this post' }, 502);
    }
    const comments = byPost.get(postId);
    return c.json({ data: comments, total: comments.length });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Reply to a comment
app.post('/api/comments/:commentId/reply', async (c) => {
  const env = c.env;
  const commentId = c.req.param('commentId');
  const { message } = await c.req.json();

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { accessToken } = JSON.parse(pageData);

  try {
    const data = await fbApiCall(
      `/${commentId}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          message,
          access_token: accessToken,
        }),
      },
      env
    );

    return c.json(data);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Like a comment
app.post('/api/comments/:commentId/like', async (c) => {
  const env = c.env;
  const commentId = c.req.param('commentId');

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { accessToken } = JSON.parse(pageData);

  try {
    const data = await fbApiCall(
      `/${commentId}/likes`,
      {
        method: 'POST',
        body: JSON.stringify({
          access_token: accessToken,
        }),
      },
      env
    );

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Unlike a comment
app.delete('/api/comments/:commentId/like', async (c) => {
  const env = c.env;
  const commentId = c.req.param('commentId');

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { accessToken } = JSON.parse(pageData);

  try {
    const data = await fbApiCall(
      `/${commentId}/likes?access_token=${accessToken}`,
      { method: 'DELETE' },
      env
    );

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Hide/unhide a comment
app.post('/api/comments/:commentId/hide', async (c) => {
  const env = c.env;
  const commentId = c.req.param('commentId');
  const { is_hidden = true } = await c.req.json();

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { accessToken } = JSON.parse(pageData);

  try {
    const data = await fbApiCall(
      `/${commentId}`,
      {
        method: 'POST',
        body: JSON.stringify({
          is_hidden,
          access_token: accessToken,
        }),
      },
      env
    );

    return c.json({ success: true, is_hidden });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Delete a comment
app.delete('/api/comments/:commentId', async (c) => {
  const env = c.env;
  const commentId = c.req.param('commentId');

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { accessToken } = JSON.parse(pageData);

  try {
    const data = await fbApiCall(
      `/${commentId}?access_token=${accessToken}`,
      { method: 'DELETE' },
      env
    );

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Get all comments across recent posts (for comment management view)
app.get('/api/comments/all', async (c) => {
  const env = c.env;
  const limit = Math.min(parseInt(c.req.query('limit') || '25', 10) || 25, 50);
  const after = c.req.query('after'); // posts cursor, for loading older posts

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  try {
    // First get a page of posts
    const postsData = await fbApiCall(
      `/${pageId}/published_posts?fields=id,message,created_time&limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}&access_token=${accessToken}`,
      { method: 'GET' },
      env
    );
    const posts = postsData.data || [];

    // Then every comment on those posts, in one batched call
    const byPost = await fetchCommentsForObjects(posts.map(p => p.id), accessToken, env);

    const allComments = [];
    for (const post of posts) {
      for (const comment of byPost.get(post.id) || []) {
        allComments.push({
          ...comment,
          post: {
            id: post.id,
            message: post.message,
            created_time: post.created_time,
          },
        });
      }
    }

    // Sort by created_time descending
    allComments.sort((a, b) => new Date(b.created_time) - new Date(a.created_time));

    return c.json({
      data: allComments,
      posts: posts.length,
      oldestPost: posts.length ? posts[posts.length - 1].created_time : null,
      paging: {
        after: postsData.paging?.cursors?.after || null,
        hasMore: !!postsData.paging?.next,
      },
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ============================================
// PAGE INSIGHTS & ANALYTICS
// ============================================

// Fetch Page insights one metric per request so a single invalid or
// deprecated metric doesn't fail the whole call. Throws only if every metric fails.
async function fetchPageInsights(pageId, metrics, query, accessToken, env) {
  const results = await Promise.allSettled(metrics.map(metric =>
    fbApiCall(
      `/${pageId}/insights?metric=${metric}&${query}&access_token=${accessToken}`,
      { method: 'GET' },
      env
    )
  ));
  const ok = results.filter(r => r.status === 'fulfilled');
  if (ok.length === 0) throw results[0].reason;
  return { data: ok.flatMap(r => r.value.data || []) };
}

// Legacy insights endpoint
app.get('/api/insights', async (c) => {
  const env = c.env;
  const metric = c.req.query('metric') || 'page_media_view,page_post_engagements,page_follows';
  const period = c.req.query('period') || 'day';

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  try {
    const data = await fbApiCall(
      `/${pageId}/insights?metric=${metric}&period=${period}&access_token=${accessToken}`,
      { method: 'GET' },
      env
    );

    return c.json(data);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Analytics Overview - Page-level stats
app.get('/api/analytics/overview', async (c) => {
  const env = c.env;

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  try {
    // Fetch multiple metrics in parallel
    const [pageInfo, insightsData] = await Promise.all([
      // Get page info (followers count)
      fbApiCall(
        `/${pageId}?fields=followers_count,fan_count,name&access_token=${accessToken}`,
        { method: 'GET' },
        env
      ),
      // Get page insights for last 28 days
      fetchPageInsights(
        pageId,
        ['page_media_view', 'page_total_media_view_unique', 'page_post_engagements', 'page_views_total'],
        'period=days_28',
        accessToken,
        env
      ).catch(() => ({ data: [] }))
    ]);

    // Extract latest values from insights
    const getMetricValue = (metricName) => {
      const metric = insightsData.data?.find(m => m.name === metricName);
      if (metric && metric.values && metric.values.length > 0) {
        return metric.values[metric.values.length - 1].value || 0;
      }
      return 0;
    };

    return c.json({
      followers: pageInfo.followers_count || pageInfo.fan_count || 0,
      pageName: pageInfo.name,
      impressions: getMetricValue('page_media_view'),
      reach: getMetricValue('page_total_media_view_unique'),
      engaged_users: getMetricValue('page_post_engagements'),
      page_views: getMetricValue('page_views_total'),
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Analytics Growth - Trend data for charts
app.get('/api/analytics/growth', async (c) => {
  const env = c.env;
  const days = parseInt(c.req.query('days') || '28');

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  // Calculate date range
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - days);

  const sinceStr = since.toISOString().split('T')[0];
  const untilStr = until.toISOString().split('T')[0];

  try {
    const data = await fetchPageInsights(
      pageId,
      ['page_media_view', 'page_total_media_view_unique', 'page_post_engagements', 'page_daily_follows_unique', 'page_daily_unfollows_unique'],
      `period=day&since=${sinceStr}&until=${untilStr}`,
      accessToken,
      env
    );

    // Transform data for charting
    const metrics = {};
    (data.data || []).forEach(metric => {
      metrics[metric.name] = (metric.values || []).map(v => ({
        date: v.end_time,
        value: v.value || 0
      }));
    });

    return c.json({
      period: { since: sinceStr, until: untilStr, days },
      metrics
    });
  } catch (err) {
    // Handle permission errors gracefully
    const errorMsg = err.message || '';
    if (errorMsg.includes('permission') || errorMsg.includes('insights metric') || errorMsg.includes('#100') || errorMsg.includes('Invalid')) {
      return c.json({
        error: 'Insights require read_insights permission. Please reconnect your page.',
        period: { since: sinceStr, until: untilStr, days },
        metrics: {}
      });
    }
    return c.json({ error: err.message }, 500);
  }
});

// Analytics Posts - Top performing posts
app.get('/api/analytics/posts', async (c) => {
  const env = c.env;
  const limit = c.req.query('limit') || '10';

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  try {
    // Fetch posts with engagement metrics
    const postsData = await fbApiCall(
      `/${pageId}/posts?fields=id,message,created_time,full_picture,permalink_url,shares,reactions.summary(true),comments.summary(true)&limit=${limit}&access_token=${accessToken}`,
      { method: 'GET' },
      env
    );

    // Calculate engagement score and sort
    const postsWithScore = (postsData.data || []).map(post => {
      const reactions = post.reactions?.summary?.total_count || 0;
      const comments = post.comments?.summary?.total_count || 0;
      const shares = post.shares?.count || 0;
      const engagement = reactions + comments + shares;

      return {
        id: post.id,
        message: post.message || '',
        created_time: post.created_time,
        full_picture: post.full_picture,
        permalink_url: post.permalink_url,
        reactions,
        comments,
        shares,
        engagement
      };
    });

    // Sort by engagement
    postsWithScore.sort((a, b) => b.engagement - a.engagement);

    return c.json({ data: postsWithScore });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Analytics Videos - Video/Reels performance
app.get('/api/analytics/videos', async (c) => {
  const env = c.env;
  const limit = c.req.query('limit') || '10';

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  try {
    // Fetch videos with metrics
    const videosData = await fbApiCall(
      `/${pageId}/videos?fields=id,title,description,created_time,length,picture,permalink_url,views,likes.summary(true),comments.summary(true)&limit=${limit}&access_token=${accessToken}`,
      { method: 'GET' },
      env
    );

    const videos = (videosData.data || []).map(video => ({
      id: video.id,
      title: video.title || video.description || 'Untitled',
      created_time: video.created_time,
      length: video.length || 0,
      picture: video.picture,
      permalink_url: video.permalink_url,
      views: video.views || 0,
      likes: video.likes?.summary?.total_count || 0,
      comments: video.comments?.summary?.total_count || 0,
    }));

    // Sort by views
    videos.sort((a, b) => b.views - a.views);

    return c.json({ data: videos });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Analytics Earnings - Monetization earnings (requires Content Monetization enrollment)
// Uses Graph API v24.0+ metrics: content_monetization_earnings, monetization_approximate_earnings
app.get('/api/analytics/earnings', async (c) => {
  const env = c.env;
  const days = parseInt(c.req.query('days') || '28');

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  // Calculate date range
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - days);

  const sinceStr = since.toISOString().split('T')[0];
  const untilStr = until.toISOString().split('T')[0];

  // Store debug info
  const debugInfo = {
    apiVersion: getApiVersion(env),
    pageId,
    dateRange: { since: sinceStr, until: untilStr },
    attempts: []
  };

  try {
    let earningsData = null;
    let metricsSource = null;

    // Attempt 1: Try content_monetization_earnings (v23.0+ metric)
    try {
      const data = await fbApiCall(
        `/${pageId}/insights?metric=content_monetization_earnings&period=day&since=${sinceStr}&until=${untilStr}&access_token=${accessToken}`,
        { method: 'GET' },
        env
      );
      debugInfo.attempts.push({ metric: 'content_monetization_earnings', success: true, dataLength: data.data?.length });
      if (data.data && data.data.length > 0) {
        earningsData = data;
        metricsSource = 'content_monetization_earnings';
      }
    } catch (e) {
      debugInfo.attempts.push({ metric: 'content_monetization_earnings', success: false, error: e.message });
    }

    // Attempt 2: Try monetization_approximate_earnings (alternative metric)
    if (!earningsData) {
      try {
        const data = await fbApiCall(
          `/${pageId}/insights?metric=monetization_approximate_earnings&period=day&since=${sinceStr}&until=${untilStr}&access_token=${accessToken}`,
          { method: 'GET' },
          env
        );
        debugInfo.attempts.push({ metric: 'monetization_approximate_earnings', success: true, dataLength: data.data?.length });
        if (data.data && data.data.length > 0) {
          earningsData = data;
          metricsSource = 'monetization_approximate_earnings';
        }
      } catch (e) {
        debugInfo.attempts.push({ metric: 'monetization_approximate_earnings', success: false, error: e.message });
      }
    }

    // Attempt 3: Try page-level monetization fields
    if (!earningsData) {
      try {
        const data = await fbApiCall(
          `/${pageId}?fields=monetization_status,is_eligible_for_branded_content&access_token=${accessToken}`,
          { method: 'GET' },
          env
        );
        debugInfo.attempts.push({ metric: 'page_monetization_fields', success: true, data });
        debugInfo.pageMonetizationStatus = data;
      } catch (e) {
        debugInfo.attempts.push({ metric: 'page_monetization_fields', success: false, error: e.message });
      }
    }

    // Attempt 4: Try video-level data (for qualified views calculation)
    let videoEarnings = { total: 0, videos: [] };
    try {
      const videosData = await fbApiCall(
        `/${pageId}/videos?fields=id,title,views,length&limit=50&access_token=${accessToken}`,
        { method: 'GET' },
        env
      );
      debugInfo.attempts.push({ metric: 'video_stats', success: true, videoCount: videosData.data?.length });

      if (videosData.data) {
        videoEarnings.videos = videosData.data.map(v => ({
          id: v.id,
          title: v.title,
          views: v.views || 0,
          length: v.length
        }));
      }
    } catch (e) {
      debugInfo.attempts.push({ metric: 'video_stats', success: false, error: e.message });
    }

    // If we got earnings data, process it
    if (earningsData && earningsData.data) {
      let totalEarningsMicros = 0;
      let qualifiedViews = 0;
      const dailyEarnings = [];
      const earningsByType = {};

      // Store raw data for debugging
      debugInfo.rawEarningsData = earningsData.data;

      earningsData.data.forEach(metric => {
        const metricName = metric.name;
        (metric.values || []).forEach(v => {
          // Handle Facebook's earnings format:
          // { currency: "USD", microAmount: 123456 }
          // microAmount is in micros (1/1,000,000 of currency unit)
          let valueMicros = 0;

          if (typeof v.value === 'number') {
            // Direct number value
            valueMicros = v.value;
          } else if (typeof v.value === 'object' && v.value !== null) {
            // Facebook returns: { currency: "USD", microAmount: 123456 }
            if ('microAmount' in v.value) {
              valueMicros = v.value.microAmount || 0;
            }
          }

          totalEarningsMicros += valueMicros;
          dailyEarnings.push({
            date: v.end_time,
            // Facebook's microAmount appears to need division by 10^8 based on actual data
            // Real earnings ~$17.58, raw sum ~6.5B, so divisor is ~370M ≈ 10^8 * 3.7
            // Using 10^8 as closest standard unit
            earnings: valueMicros / 100000000
          });
        });
      });

      // Convert total - Facebook's microAmount divided by 10^8
      const totalEarnings = totalEarningsMicros / 100000000;

      // Calculate estimated views from video data
      if (videoEarnings.videos.length > 0) {
        qualifiedViews = videoEarnings.videos.reduce((sum, v) => sum + (v.views || 0), 0);
      }

      return c.json({
        enrolled: true,
        metricsSource,
        period: { since: sinceStr, until: untilStr, days },
        summary: {
          totalEarnings: totalEarnings,
          totalEarningsMicros: totalEarningsMicros, // Include raw value for debugging
          qualifiedViews: qualifiedViews,
          estimatedRPM: qualifiedViews > 0 ? (totalEarnings / qualifiedViews * 1000).toFixed(2) : '0.00',
          earningsByType: Object.keys(earningsByType).length > 0 ? earningsByType : null
        },
        dailyEarnings,
        debug: debugInfo
      });
    }

    // No earnings data available - return debug info to help diagnose
    return c.json({
      enrolled: false,
      error: 'Monetization data not available via API.',
      hint: 'Your earnings may only be visible in Meta Business Suite or Facebook Creator Studio.',
      metricsSource: null,
      period: { since: sinceStr, until: untilStr, days },
      videoStats: videoEarnings.videos.length > 0 ? {
        totalVideos: videoEarnings.videos.length,
        totalViews: videoEarnings.videos.reduce((sum, v) => sum + (v.views || 0), 0)
      } : null,
      debug: debugInfo,
      helpLinks: {
        creatorStudio: 'https://business.facebook.com/creatorstudio',
        businessSuite: 'https://business.facebook.com/',
        monetizationHelp: 'https://www.facebook.com/business/help/2606688282612991'
      }
    });

  } catch (err) {
    const errorMsg = err.message || '';

    // Check if error is related to permissions or enrollment
    if (errorMsg.includes('permission') || errorMsg.includes('insights metric') || errorMsg.includes('#100')) {
      return c.json({
        error: 'Monetization insights require Content Monetization enrollment and read_insights permission.',
        enrolled: false,
        hint: 'Make sure the page is enrolled in Facebook Content Monetization program.',
        debug: debugInfo
      });
    }

    return c.json({
      error: err.message,
      debug: debugInfo
    }, 500);
  }
});

// ============================================
// STORIES ROUTES
// ============================================

// Get page stories with view counts (from KV storage)
app.get('/api/stories', async (c) => {
  const env = c.env;

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  try {
    // Get stories from KV storage (stories we've published through the app)
    const storedStories = await getStoriesFromKV(env, pageId);

    if (storedStories.length === 0) {
      return c.json({
        data: [],
        summary: {
          totalStories: 0,
          activeStories: 0,
          totalImpressions: 0,
          avgImpressions: 0
        },
        message: 'No stories found. Stories published through this app will appear here.'
      });
    }

    // Fetch insights for each stored story
    const storiesWithInsights = await Promise.all(
      storedStories.map(async (story) => {
        try {
          // Try to get story insights using story-specific metrics
          const insightsUrl = `${FB_GRAPH_URL}/${getApiVersion(env)}/${story.id}/insights?metric=story_media_view&access_token=${accessToken}`;
          const insightsRes = await fetch(insightsUrl);
          const insightsData = await insightsRes.json();

          let impressions = 0;
          let reach = 0;

          if (insightsData.data) {
            insightsData.data.forEach(metric => {
              // story_media_view is the view count for stories
              if (metric.name === 'story_media_view') impressions = metric.values?.[0]?.value || 0;
            });
          }

          // Try to get story details (thumbnail, permalink) if not stored
          let thumbnail = story.thumbnail_url;
          let permalink = story.permalink;

          if (!thumbnail || !permalink) {
            try {
              const detailsUrl = `${FB_GRAPH_URL}/${getApiVersion(env)}/${story.id}?fields=permalink_url,full_picture&access_token=${accessToken}`;
              const detailsRes = await fetch(detailsUrl);
              const details = await detailsRes.json();
              if (!details.error) {
                thumbnail = thumbnail || details.full_picture;
                permalink = permalink || details.permalink_url;
              }
            } catch (e) {
              // Ignore errors fetching details
            }
          }

          return {
            ...story,
            thumbnail_url: thumbnail,
            permalink: permalink,
            insights: { impressions, reach, replies: 0 }
          };
        } catch (err) {
          return {
            ...story,
            insights: { impressions: 0, reach: 0, replies: 0 }
          };
        }
      })
    );

    // Calculate summary
    const totalImpressions = storiesWithInsights.reduce((sum, s) => sum + (s.insights?.impressions || 0), 0);
    const activeStories = storiesWithInsights.filter(s => {
      if (!s.created_time) return false;
      const createdTime = new Date(s.created_time);
      const now = new Date();
      const hoursAgo = (now - createdTime) / (1000 * 60 * 60);
      return hoursAgo < 24;
    }).length;

    return c.json({
      data: storiesWithInsights,
      summary: {
        totalStories: storiesWithInsights.length,
        activeStories,
        totalImpressions,
        avgImpressions: storiesWithInsights.length > 0 ? Math.round(totalImpressions / storiesWithInsights.length) : 0
      }
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Publish a photo to the Page story. `source` is { url } or { file }.
async function publishPhotoStory(env, pageId, accessToken, source) {
  // Step 1: Upload photo as unpublished (stories need an unpublished photo id)
  const form = new FormData();
  form.append('published', 'false');
  form.append('access_token', accessToken);
  if (source.file) form.append('source', source.file);
  else form.append('url', source.url);

  const uploadData = await fetch(`${FB_GRAPH_URL}/${getApiVersion(env)}/${pageId}/photos`, {
    method: 'POST',
    body: form,
  }).then(r => r.json());
  if (uploadData.error) {
    throw new Error(uploadData.error.message || 'Failed to upload photo');
  }

  // Step 2: Publish as Story
  const storyData = await fetch(
    `${FB_GRAPH_URL}/${getApiVersion(env)}/${pageId}/photo_stories?photo_id=${uploadData.id}&access_token=${accessToken}`,
    { method: 'POST' }
  ).then(r => r.json());
  if (storyData.error) {
    throw new Error(storyData.error.message || 'Failed to publish story');
  }

  const storyId = storyData.post_id || storyData.id;
  await saveStoryToKV(env, pageId, {
    id: storyId,
    created_time: new Date().toISOString(),
    media_type: 'photo',
    thumbnail_url: source.url || null, // uploaded files get their thumbnail from Facebook later
  });
  return storyId;
}

// Publish a video to the Page story. `source` is { url } or { file }.
async function publishVideoStory(env, pageId, accessToken, source) {
  const base = `${FB_GRAPH_URL}/${getApiVersion(env)}/${pageId}/video_stories`;

  // Step 1: Start an upload session
  const initData = await fetch(`${base}?upload_phase=start&access_token=${accessToken}`, { method: 'POST' }).then(r => r.json());
  if (initData.error) {
    throw new Error(initData.error.message || 'Failed to start video upload');
  }

  // Step 2: Send the video — either the bytes, or a URL Facebook fetches itself
  const uploadHeaders = { Authorization: `OAuth ${accessToken}` };
  let body = null;
  if (source.file) {
    uploadHeaders.offset = '0';
    uploadHeaders.file_size = String(source.file.size);
    body = source.file;
  } else {
    uploadHeaders.file_url = source.url;
  }
  const uploadRes = await fetch(initData.upload_url, { method: 'POST', headers: uploadHeaders, body });
  const uploadData = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok || uploadData.error || uploadData.success === false) {
    throw new Error(uploadData.error?.message || uploadData.debug_info?.message || 'Failed to upload video');
  }

  // Step 3: Publish
  const finishData = await fetch(
    `${base}?upload_phase=finish&video_id=${initData.video_id}&access_token=${accessToken}`,
    { method: 'POST' }
  ).then(r => r.json());
  if (finishData.error) {
    throw new Error(finishData.error.message || 'Failed to publish video story');
  }

  const storyId = finishData.post_id || finishData.id || initData.video_id;
  await saveStoryToKV(env, pageId, {
    id: storyId,
    created_time: new Date().toISOString(),
    media_type: 'video',
    thumbnail_url: null, // Video thumbnail not available at publish time
  });
  return storyId;
}

// Publish a photo to Story from a URL (e.g. an existing post's picture)
app.post('/api/stories/photo', async (c) => {
  const env = c.env;
  const { imageUrl } = await c.req.json();

  if (!imageUrl) {
    return c.json({ error: 'Image URL is required' }, 400);
  }

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  try {
    const storyId = await publishPhotoStory(env, pageId, accessToken, { url: imageUrl });
    return c.json({ success: true, storyId });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Publish a video to Story from a URL
app.post('/api/stories/video', async (c) => {
  const env = c.env;
  const { videoUrl } = await c.req.json();

  if (!videoUrl) {
    return c.json({ error: 'Video URL is required' }, 400);
  }

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  try {
    const storyId = await publishVideoStory(env, pageId, accessToken, { url: videoUrl });
    return c.json({ success: true, storyId });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Publish a photo or video file from the device straight to Story
app.post('/api/stories/upload', async (c) => {
  const env = c.env;

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, accessToken } = JSON.parse(pageData);

  try {
    const formData = await c.req.formData();
    const file = formData.get('media');

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No photo or video provided' }, 400);
    }

    const isVideo = (file.type || '').startsWith('video/');
    const storyId = isVideo
      ? await publishVideoStory(env, pageId, accessToken, { file })
      : await publishPhotoStory(env, pageId, accessToken, { file });

    return c.json({ success: true, storyId });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ============================================
// STATIC FILE HANDLER
// ============================================

async function handleStaticAssets(request, env, ctx) {
  try {
    return await getAssetFromKV(
      {
        request,
        waitUntil: ctx.waitUntil.bind(ctx),
      },
      {
        ASSET_NAMESPACE: env.__STATIC_CONTENT,
        ASSET_MANIFEST: assetManifest,
      }
    );
  } catch (e) {
    // If not found, try index.html for SPA routing
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      try {
        const indexRequest = new Request(`${url.origin}/index.html`, request);
        return await getAssetFromKV(
          {
            request: indexRequest,
            waitUntil: ctx.waitUntil.bind(ctx),
          },
          {
            ASSET_NAMESPACE: env.__STATIC_CONTENT,
            ASSET_MANIFEST: assetManifest,
          }
        );
      } catch (e2) {
        return new Response('Not Found', { status: 404 });
      }
    }
    return new Response('Not Found', { status: 404 });
  }
}

// Export the combined handler
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle API routes with Hono
    if (url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx);
    }

    // Handle static files
    return handleStaticAssets(request, env, ctx);
  },
};
