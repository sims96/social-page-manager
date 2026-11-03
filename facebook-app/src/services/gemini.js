/**
 * AI reply service
 * Uses Claude when ANTHROPIC_API_KEY is set, with Gemini as the backup
 */

import Anthropic from '@anthropic-ai/sdk';

const CLAUDE_MODEL = 'claude-opus-5-5';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Newest first; the next one is tried if a model isn't available to this API key
const GEMINI_MODELS = ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-2.5-flash'];

export const LYZA_TONE = 'Lyza';

/**
 * Generate an AI reply for a Facebook comment
 */
export async function generateReply(env, context) {
  const { comment, postContent, postCreatedTime, pageContext, customInstructions } = context;
  const isLyza = pageContext.tone === LYZA_TONE;

  const prompt = isLyza
    ? buildLyzaPrompt(comment, postContent, customInstructions, isFreshPost(postCreatedTime))
    : buildPrompt(comment, postContent, pageContext, customInstructions);

  if (env.ANTHROPIC_API_KEY) {
    try {
      const reply = await generateWithClaude(env, prompt);
      return isLyza ? cleanLyzaReply(reply) : reply;
    } catch (err) {
      console.error('Claude error:', err.message);
      if (!env.GEMINI_API_KEY) throw new Error(`Claude API error: ${err.message}`);
    }
  }

  const reply = await generateWithGemini(env, prompt);
  return isLyza ? cleanLyzaReply(reply) : reply;
}

async function generateWithClaude(env, prompt) {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    timeout: 25000,
    maxRetries: 1,
    // Org-wide keys must name the workspace to bill
    ...(env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID } } : {})
  });

  const response = await client.beta.messages.create({
    model: env.CLAUDE_MODEL || CLAUDE_MODEL,
    // Room for its (low effort) thinking plus a one-line reply
    max_tokens: 2000,
    output_config: { effort: 'low' },
    // If a comment trips a safety filter, the API retries on another model
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content: prompt }]
  });

  if (response.stop_reason === 'refusal') throw new Error('Request declined');

  const reply = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  if (!reply) throw new Error('No reply generated');
  return reply;
}

async function generateWithGemini(env, prompt) {
  const models = env.GEMINI_MODEL ? [env.GEMINI_MODEL, ...GEMINI_MODELS] : GEMINI_MODELS;
  let lastError;

  for (const model of models) {
    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 1.0,
        // Thinking counts against this budget
        maxOutputTokens: 4096,
        // A short reply needs little reasoning; keeps replies fast
        thinkingConfig: model.startsWith('gemini-2.5') ? { thinkingBudget: 0 } : { thinkingLevel: 'low' }
      }
    };

    let response, data;
    try {
      response = await fetch(`${GEMINI_BASE_URL}/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(25000)
      });
      data = await response.json().catch(() => ({}));
    } catch (err) {
      lastError = `${model} timed out`;
      console.error(lastError);
      continue;
    }

    if (!response.ok || data.error) {
      lastError = data.error?.message || `HTTP ${response.status}`;
      console.error(`Gemini ${model} error:`, lastError);
      // Model missing, not enabled, out of quota (the free tier gives some models
      // none at all) or overloaded: try the next one
      if (response.status === 429 || response.status >= 500 ||
          ([400, 403, 404].includes(response.status) && /model|not found|not supported|permission/i.test(lastError))) continue;
      throw new Error(`Gemini API error: ${lastError}`);
    }

    const reply = (data.candidates?.[0]?.content?.parts || [])
      .filter(p => !p.thought)
      .map(p => p.text || '')
      .join('')
      .trim();

    if (!reply) throw new Error('No reply generated');
    return reply;
  }

  throw new Error(`Gemini API error: ${lastError}`);
}

// Emojis Lyza uses; at most one per reply, and most replies have none
// Mostly hearts and kisses, the way women actually sign off on Facebook
const LYZA_EMOJIS = ['❤️', '❤️', '😘', '😘', '🥰', '💕', '😊', '☺️', '🙈', '❤️😘'];

// Sign-offs, picked at random so she doesn't default to "have a lovely day"
const LYZA_WISHES = [
  'take care', 'stay blessed', 'hugs', 'big hugs', 'much love', 'sending love',
  'enjoy your day', 'be good', 'have a good one', 'you too', 'kisses',
  'enjoy the rest of your day', 'have a beautiful week', 'stay safe', 'xx'
];

// What she calls people; without this nearly every reply says "dear"
const LYZA_PET_NAMES = ['dear', 'love', 'darling', 'hun', 'sweetie', 'my dear', 'dear one', 'lovely'];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// While a post is new, replies that start conversations help it get shown more
const FRESH_POST_HOURS = 3;

function isFreshPost(createdTime) {
  const age = Date.now() - new Date(createdTime).getTime();
  return age >= 0 && age < FRESH_POST_HOURS * 3600 * 1000;
}

/**
 * Lyza persona: replies as her, the way she'd type on her phone
 */
function buildLyzaPrompt(comment, postContent, customInstructions, freshPost) {
  // Emoji is rolled here rather than left to the model, so it stays natural:
  // usually a heart or kiss at the end, sometimes nothing
  const emojiRule = Math.random() < 0.75
    ? `End with ${pick(LYZA_EMOJIS)} (no other emoji).`
    : 'No emoji this time.';

  const wishRule = Math.random() < 0.45
    ? `Don't add any wish or sign-off this time (no "have a ... day", no "happy [day]").`
    : `If a sign-off fits, use something like "${pick(LYZA_WISHES)}" (adapt it to their language). Never "have a lovely day", "have a nice day" or "have a lovely [day of the week]".`;

  const nameRule = Math.random() < 0.4
    ? `Don't call them anything this time (no "dear", "love" or similar).`
    : `If you call them something, use "${pick(LYZA_PET_NAMES)}" (or the natural equivalent in their language). Not "dear" unless that's the word given.`;

  // Only sometimes, so it doesn't read like a tactic
  const questionRule = freshPost && Math.random() < 0.45
    ? '\nFOR THIS REPLY: after the thank you or answer, add a short, light open question back to them (3 to 6 words), the kind a friend asks, like "how was your day?", "what about you?", "have you been there?", "where are you from?". Make it fit their comment. This goes beyond the usual word limit, that is fine. Skip it only if the comment is rude, flirty or asks for her number.\n'
    : '';

  return `You are Lyza, replying to a comment on your own Facebook post, quickly from your phone.

WHO LYZA IS:
A beautiful, kind, warm woman. Intelligent and deep, but she doesn't show off. Busy, so she replies the way real people do on Facebook: short, simple, sweet. Never needy, never over eager.

HOW SHE REPLIES (this is what real people write, keep it this simple):
- Compliments ("you're beautiful", "lovely pic", "gorgeous"): just thank them warmly. Like:
  "thank u", "thank you so much", "thanks a lot", "aww thank u", "thank you", "merci beaucoup".
  Vary it, don't always use the same one. Nothing clever or poetic.
- Greetings ("good morning", "hello beautiful"): greet back simply, e.g. "good morning".
- Questions: answer in a few plain words, like a busy person would. A deep question gets one honest, thoughtful line.
- Flirty or asking for her number: stay sweet and brief, don't give anything, e.g. "haha thank you".
- Rude or negative: short and classy, or just a light "haha". Never argue.
- ${nameRule}
- ${wishRule}
- ${emojiRule}
- Mostly 2 to 10 words. Never more than two short sentences.
- Casual texting style: "thank u" or "thank you", lowercase is fine. No hashtags, no em dashes, no formal words.
- Never repeat or paraphrase what they said. Never say "that's sweet of you", "you're sweet", "Thank you for your kind words", "I appreciate", "Absolutely".
- Never invent facts about her life (places, names, dates, plans, prices) that aren't in her post or notes. If asked something she can't know from them, stay light and vague, or turn it back with a little mystery.
- Reply in the same language the comment is written in.
- Use their first name only rarely.
- Never say or hint that you're an AI, a page, an assistant or a team. You are Lyza.
${customInstructions ? `\nEXTRA NOTES:\n${customInstructions}\n` : ''}
HER POST: "${postContent?.substring(0, 300) || 'a recent post'}"

COMMENT from ${comment.commenterName || 'someone'}:
"${comment.message}"

${questionRule}Write only Lyza's final reply on one line, nothing else (no notes or corrections):`;
}

/**
 * Strip habits that make a reply read as machine written
 */
function cleanLyzaReply(text) {
  // Her replies are one line; anything before the last line is the model
  // thinking out loud ("Hmm... Better:"), which must never be posted
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let reply = (lines[lines.length - 1] || '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/^lyza:\s*/i, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/!{2,}/g, '!')
    .replace(/#\w+/g, '')
    .trim();

  // Keep at most two emojis
  let seen = 0;
  reply = reply.replace(/\p{Extended_Pictographic}️?/gu, (m) => (++seen > 2 ? '' : m));
  return reply.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Build the prompt for generating a reply
 */
function buildPrompt(comment, postContent, pageContext, customInstructions) {
  return `You are the social media manager for "${pageContext.pageName}", a ${pageContext.niche} page.

PAGE CONTEXT:
- Description: ${pageContext.description}
- Tone: ${pageContext.tone}

RULES:
- Reply as the page owner (use "I", "we", "my")
- Keep replies short (1-3 sentences max)
- Be natural and human-like
- Use emojis sparingly (0-2 max)
- Address commenter by first name when it feels natural
- Never mention you're AI or automated
- Match the energy of the comment
- If it's a question, answer helpfully
- If it's a compliment, express genuine thanks
- Vary your responses - don't be repetitive
- Never repeat or paraphrase the comment back, and avoid stock phrases like "Thank you for your kind words"

${customInstructions ? `ADDITIONAL INSTRUCTIONS:\n${customInstructions}` : ''}

POST CONTEXT: "${postContent?.substring(0, 300) || 'A recent post'}"

COMMENT from ${comment.commenterName || 'Someone'}:
"${comment.message}"

Write a natural, human-like reply (just the reply text, nothing else):`;
}

/**
 * Check if a comment is eligible for AI reply
 */
export function isEligibleForReply(comment, config) {
  const msg = comment.message || '';

  // Too short
  if (msg.length < (config.minCommentLength || 20)) {
    return { eligible: false, reason: 'too_short' };
  }

  // Emoji only
  if (isEmojiOnly(msg)) {
    return { eligible: false, reason: 'emoji_only' };
  }

  // Skip patterns (common short responses)
  const normalized = msg.toLowerCase().trim();
  const skipPatterns = config.skipPatterns || ['nice', 'cool', 'wow', 'love it', 'amazing', 'great', 'awesome'];
  if (skipPatterns.some(p => normalized === p.toLowerCase())) {
    return { eligible: false, reason: 'skip_pattern' };
  }

  // Single word
  if (msg.trim().split(/\s+/).length < 2) {
    return { eligible: false, reason: 'single_word' };
  }

  return { eligible: true };
}

/**
 * Check if text is only emojis
 */
function isEmojiOnly(text) {
  const withoutEmoji = text.replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]/gu, '');
  return withoutEmoji.trim().length === 0;
}

/**
 * Determine if we should reply based on probability
 */
export function shouldReplyByProbability(probability) {
  return Math.random() * 100 < (probability || 30);
}

/**
 * Get default AI config
 */
export function getDefaultConfig() {
  return {
    enabled: false,
    replyProbability: 30,
    minCommentLength: 20,
    pageContext: {
      description: '',
      niche: 'General',
      tone: 'Friendly and casual'
    },
    customInstructions: '',
    skipPatterns: ['nice', 'cool', 'wow', 'love it', 'amazing', 'great', 'awesome', 'beautiful']
  };
}
