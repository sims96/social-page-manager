/**
 * AI Reply Routes
 * Handles AI-powered comment reply generation and posting
 */

import { Hono } from 'hono';
import { generateReply, isEligibleForReply, getDefaultConfig } from '../services/gemini.js';

const aiReply = new Hono();

// Facebook Graph API base URL
const FB_GRAPH_URL = 'https://graph.facebook.com';

/**
 * GET /api/ai-reply/config
 * Get AI reply configuration for current page
 */
aiReply.get('/config', async (c) => {
  const env = c.env;

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, pageName } = JSON.parse(pageData);
  const configKey = `ai_config_${pageId}`;
  const stored = await env.SESSIONS.get(configKey);

  if (stored) {
    const config = JSON.parse(stored);
    // Ensure pageName is included
    config.pageContext = config.pageContext || {};
    config.pageContext.pageName = pageName;
    return c.json(config);
  }

  // Return default config with page name
  const defaultConfig = getDefaultConfig();
  defaultConfig.pageContext.pageName = pageName;
  return c.json(defaultConfig);
});

/**
 * PUT /api/ai-reply/config
 * Save AI reply configuration
 */
aiReply.put('/config', async (c) => {
  const env = c.env;

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId } = JSON.parse(pageData);
  const config = await c.req.json();

  // Validate required fields
  if (typeof config.replyProbability !== 'number' || config.replyProbability < 0 || config.replyProbability > 100) {
    return c.json({ error: 'Reply probability must be between 0 and 100' }, 400);
  }

  if (typeof config.minCommentLength !== 'number' || config.minCommentLength < 1) {
    return c.json({ error: 'Minimum comment length must be at least 1' }, 400);
  }

  // Save to KV
  const configKey = `ai_config_${pageId}`;
  config.updatedAt = new Date().toISOString();
  await env.SESSIONS.put(configKey, JSON.stringify(config));

  return c.json({ success: true, config });
});

/**
 * POST /api/ai-reply/generate
 * Generate an AI reply for a comment (preview only, doesn't post)
 */
aiReply.post('/generate', async (c) => {
  const env = c.env;

  // Check for API key
  if (!env.ANTHROPIC_API_KEY && !env.GEMINI_API_KEY) {
    return c.json({ error: 'AI API key not configured' }, 500);
  }

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, pageName } = JSON.parse(pageData);
  const { commentId, commentMessage, commenterName, postContent, postCreatedTime, tone } = await c.req.json();

  if (!commentMessage) {
    return c.json({ error: 'Comment message is required' }, 400);
  }

  // Get AI config
  const configKey = `ai_config_${pageId}`;
  const storedConfig = await env.SESSIONS.get(configKey);
  const config = storedConfig ? JSON.parse(storedConfig) : getDefaultConfig();

  // Check eligibility
  const eligibility = isEligibleForReply({ message: commentMessage }, config);
  if (!eligibility.eligible) {
    return c.json({
      success: false,
      eligible: false,
      reason: eligibility.reason,
      message: `Comment not eligible: ${eligibility.reason.replace('_', ' ')}`
    });
  }

  try {
    const reply = await generateReply(env, {
      comment: {
        message: commentMessage,
        commenterName: commenterName
      },
      postContent,
      postCreatedTime,
      pageContext: {
        ...config.pageContext,
        ...(tone ? { tone } : {}),
        pageName
      },
      customInstructions: config.customInstructions
    });

    return c.json({
      success: true,
      eligible: true,
      commentId,
      generatedReply: reply
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

/**
 * POST /api/ai-reply/post
 * Generate an AI reply and post it to Facebook
 */
aiReply.post('/post', async (c) => {
  const env = c.env;

  // Check for API key
  if (!env.ANTHROPIC_API_KEY && !env.GEMINI_API_KEY) {
    return c.json({ error: 'AI API key not configured' }, 500);
  }

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId, pageName, accessToken } = JSON.parse(pageData);
  const { commentId, commentMessage, commenterName, postContent, customReply } = await c.req.json();

  if (!commentId) {
    return c.json({ error: 'Comment ID is required' }, 400);
  }

  // Get AI config
  const configKey = `ai_config_${pageId}`;
  const storedConfig = await env.SESSIONS.get(configKey);
  const config = storedConfig ? JSON.parse(storedConfig) : getDefaultConfig();

  let replyText = customReply;

  // Generate reply if not provided
  if (!replyText) {
    if (!commentMessage) {
      return c.json({ error: 'Comment message is required for generation' }, 400);
    }

    try {
      replyText = await generateReply(env, {
        comment: {
          message: commentMessage,
          commenterName: commenterName
        },
        postContent,
        pageContext: {
          ...config.pageContext,
          pageName
        },
        customInstructions: config.customInstructions
      });
    } catch (err) {
      return c.json({ error: `Failed to generate reply: ${err.message}` }, 500);
    }
  }

  // Post reply to Facebook
  try {
    const fbResponse = await fetch(
      `${FB_GRAPH_URL}/v23.0/${commentId}/comments?access_token=${accessToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: replyText })
      }
    );

    const fbData = await fbResponse.json();

    if (fbData.error) {
      throw new Error(fbData.error.message);
    }

    // Track this reply to avoid duplicates
    await trackRepliedComment(env, pageId, commentId);

    return c.json({
      success: true,
      commentId,
      replyId: fbData.id,
      replyText
    });
  } catch (err) {
    return c.json({ error: `Failed to post reply: ${err.message}` }, 500);
  }
});

/**
 * GET /api/ai-reply/check/:commentId
 * Check if a comment has already been replied to
 */
aiReply.get('/check/:commentId', async (c) => {
  const env = c.env;
  const commentId = c.req.param('commentId');

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId } = JSON.parse(pageData);
  const replied = await hasBeenReplied(env, pageId, commentId);

  return c.json({ commentId, replied });
});

/**
 * POST /api/ai-reply/check-eligibility
 * Check if a comment is eligible for AI reply
 */
aiReply.post('/check-eligibility', async (c) => {
  const env = c.env;

  const pageData = await env.SESSIONS.get('active_page');
  if (!pageData) {
    return c.json({ error: 'No page configured' }, 400);
  }

  const { pageId } = JSON.parse(pageData);
  const { commentMessage } = await c.req.json();

  // Get AI config
  const configKey = `ai_config_${pageId}`;
  const storedConfig = await env.SESSIONS.get(configKey);
  const config = storedConfig ? JSON.parse(storedConfig) : getDefaultConfig();

  const result = isEligibleForReply({ message: commentMessage }, config);
  return c.json(result);
});

// Helper: Track replied comments
async function trackRepliedComment(env, pageId, commentId) {
  const key = `ai_replied_${pageId}`;
  const existing = await env.SESSIONS.get(key);
  const replied = existing ? JSON.parse(existing) : [];

  if (!replied.includes(commentId)) {
    replied.push(commentId);
    // Keep only last 500 to avoid unbounded growth
    const trimmed = replied.slice(-500);
    await env.SESSIONS.put(key, JSON.stringify(trimmed));
  }
}

// Helper: Check if comment was replied to
async function hasBeenReplied(env, pageId, commentId) {
  const key = `ai_replied_${pageId}`;
  const existing = await env.SESSIONS.get(key);
  if (!existing) return false;

  const replied = JSON.parse(existing);
  return replied.includes(commentId);
}

export default aiReply;
