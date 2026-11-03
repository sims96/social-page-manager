// ============================================
// CONFIG & STATE
// ============================================
const FEATURES = Object.assign(
  { stories: true, multiPhoto: true, aiReply: true },
  window.APP_FEATURES || {}
);
const MAX_PHOTOS = FEATURES.multiPhoto ? 5 : 1;
const VIEWS = ['home', 'posts', 'compose', 'comments', 'insights', 'settings'];

const state = {
  view: null,
  page: null,               // { pageId, pageName, configured }
  sessionPages: [],         // pages returned after Facebook login
  overview: null,           // cached promise for /api/analytics/overview
  loaded: new Set(),        // views whose data is loaded
  posts: new Map(),         // postId -> post (for comment sheets and menus)
  comments: [],             // Comments tab data
  commentsPaging: null,     // { after, hasMore, posts, since }
  commentFilter: 'all',
  postsSegment: 'feed',
  composeType: 'text',
  uploadModes: { photo: 'file', video: 'file' },
  photos: [],               // [{ file, url }]
  videoUrl: null,
  analyticsDays: 28,
  aiConfig: null,
};

// Every rendered comment is backed by one entry here, so all copies of a
// comment (Comments tab + post sheet) re-render from the same data.
const commentIndex = new Map(); // id -> { comment, postMessage, liked, repliesOpen }
const deletedComments = new Set();

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', init);

async function init() {
  applyFeatureFlags();
  bindGlobalEvents();
  bindCompose();
  bindComments();
  bindPosts();
  bindInsights();
  bindSettings();
  checkUrlParams();

  await Promise.all([
    loadActivePage(),
    FEATURES.aiReply ? loadAIConfig() : null,
  ]);

  showView(viewFromHash());
}

function applyFeatureFlags() {
  document.querySelectorAll('[data-feature]').forEach(el => {
    if (!FEATURES[el.dataset.feature]) el.hidden = true;
  });

  const photoInput = document.getElementById('photoFile');
  photoInput.multiple = MAX_PHOTOS > 1;
  document.getElementById('photoPickerTitle').textContent = MAX_PHOTOS > 1 ? `Add photos (up to ${MAX_PHOTOS})` : 'Add a photo';
}

function bindGlobalEvents() {
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      e.preventDefault();
      navigate(nav.dataset.nav);
      return;
    }
    const actionEl = e.target.closest('[data-action]');
    if (actionEl) handleAction(actionEl, e);
  });

  window.addEventListener('hashchange', () => showView(viewFromHash()));

  window.addEventListener('scroll', () => {
    document.querySelector('.topbar').classList.toggle('scrolled', window.scrollY > 4);
  }, { passive: true });

  document.getElementById('refreshBtn').addEventListener('click', refreshCurrentView);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheetStack.length) sheetStack[sheetStack.length - 1].close();
  });
}

function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);

  if (params.get('error')) {
    showToast(params.get('error'), 'error');
    window.history.replaceState({}, '', '/');
  }

  if (params.get('success') && params.get('session')) {
    loadPagesFromSession(params.get('session'));
    window.history.replaceState({}, '', '/#settings');
  }
}

// ============================================
// NAVIGATION
// ============================================
function viewFromHash() {
  const view = window.location.hash.replace('#', '');
  return VIEWS.includes(view) ? view : 'home';
}

function navigate(view) {
  if (viewFromHash() === view && state.view === view) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  window.location.hash = view;
}

function showView(view) {
  const changed = state.view !== view;
  state.view = view;

  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  document.querySelectorAll('.tab[data-nav]').forEach(t => t.classList.toggle('active', t.dataset.nav === view));

  const section = document.getElementById(`view-${view}`);
  document.getElementById('viewTitle').textContent = section.dataset.title;
  document.getElementById('refreshBtn').hidden = view === 'compose' || view === 'settings';
  document.querySelector('.topbar [data-nav="settings"]').hidden = view === 'settings';

  if (changed) window.scrollTo(0, 0);
  loadView(view);
}

function loadView(view, force = false) {
  if (view === 'settings') return renderSettings();
  if (!force && state.loaded.has(view)) return;
  state.loaded.add(view);

  switch (view) {
    case 'home': return loadHome();
    case 'posts': return loadPostsView();
    case 'comments': return loadComments();
    case 'insights': return loadInsights();
  }
}

function invalidate(...views) {
  views.forEach(v => state.loaded.delete(v));
}

async function refreshCurrentView() {
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning');
  state.overview = null;
  invalidate('home', 'posts', 'comments', 'insights');
  try {
    await loadView(state.view, true);
  } finally {
    setTimeout(() => btn.classList.remove('spinning'), 300);
  }
}

// ============================================
// API
// ============================================
async function api(path, options = {}) {
  const res = await fetch(path, options);
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Some endpoints return useful data alongside an error field
async function apiRaw(path) {
  const res = await fetch(path);
  return res.json();
}

function jsonBody(body, method = 'POST') {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function getOverview() {
  if (!state.overview) {
    state.overview = api('/api/analytics/overview').catch(err => {
      state.overview = null;
      throw err;
    });
  }
  return state.overview;
}

// ============================================
// AUTH & CONNECTION
// ============================================
async function connectFacebook() {
  try {
    const data = await api('/api/auth/login');
    if (!data.authUrl) throw new Error('Could not start Facebook login');
    window.location.href = data.authUrl;
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadPagesFromSession(sessionId) {
  try {
    const data = await api(`/api/auth/session/${encodeURIComponent(sessionId)}`);
    state.sessionPages = data.pages || [];
    if (state.sessionPages.length === 0) {
      showToast('No pages found. Make sure you are an admin of a Facebook Page.', 'error');
    }
    renderSettings();
  } catch (err) {
    showToast('Could not load your pages: ' + err.message, 'error');
  }
}

async function selectPage(index) {
  const page = state.sessionPages[index];
  if (!page) return;

  try {
    await api('/api/auth/save-page', jsonBody({ pageId: page.id, pageName: page.name, accessToken: page.access_token }));
    state.sessionPages = [];
    await loadActivePage();
    resetPageData();
    if (FEATURES.aiReply) await loadAIConfig();
    showToast(`Connected to ${page.name}`);
    navigate('home');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadActivePage() {
  try {
    const page = await api('/api/auth/active-page');
    state.page = page.configured ? page : null;
  } catch {
    state.page = null;
  }
}

async function disconnectPage() {
  const ok = await confirmSheet({
    title: 'Disconnect page?',
    message: 'The app will stop managing this page until you connect it again.',
    confirmLabel: 'Disconnect',
    danger: true,
  });
  if (!ok) return;

  try {
    await api('/api/auth/disconnect', { method: 'DELETE' });
    state.page = null;
    state.aiConfig = null;
    resetPageData();
    renderSettings();
    showToast('Page disconnected');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function resetPageData() {
  state.overview = null;
  state.posts.clear();
  state.comments = [];
  commentIndex.clear();
  deletedComments.clear();
  invalidate('home', 'posts', 'comments', 'insights', 'settings');
}

function notConnectedHtml(message) {
  return `
    <div class="empty">
      <i class="fas fa-plug"></i>
      <p>No page connected</p>
      <small>${esc(message)}</small>
      <button type="button" class="btn btn-primary btn-sm" data-action="connect"><i class="fab fa-facebook"></i> Connect page</button>
    </div>`;
}

// ============================================
// HOME
// ============================================
async function loadHome() {
  const card = document.getElementById('pageCard');
  const recent = document.getElementById('recentPosts');
  const kpis = ['homeFollowers', 'homeViews', 'homeReach', 'homeEngagements'];

  if (!state.page) {
    card.className = 'page-card disconnected';
    card.innerHTML = `
      <div class="page-card-name">Connect your Facebook Page</div>
      <p>Publish posts, answer comments and follow your numbers, all from here.</p>
      <button type="button" class="btn btn-primary" data-action="connect"><i class="fab fa-facebook"></i> Connect page</button>`;
    kpis.forEach(id => setText(id, '–'));
    recent.innerHTML = `<div class="empty"><i class="fas fa-newspaper"></i><small>Your recent posts will show up here.</small></div>`;
    return;
  }

  card.className = 'page-card';
  card.innerHTML = `
    <div class="avatar avatar-lg">${esc(initial(state.page.pageName))}</div>
    <div class="page-card-main">
      <div class="page-card-name">${esc(state.page.pageName)}</div>
      <div class="page-card-status"><span class="dot online"></span> Connected</div>
    </div>
    <button type="button" class="icon-btn" data-nav="settings" aria-label="Page settings"><i class="fas fa-chevron-right"></i></button>`;

  recent.innerHTML = skeletonRows(3);

  getOverview()
    .then(o => {
      setText('homeFollowers', formatNumber(o.followers));
      setText('homeViews', formatNumber(o.impressions));
      setText('homeReach', formatNumber(o.reach));
      setText('homeEngagements', formatNumber(o.engaged_users));
    })
    .catch(() => kpis.forEach(id => setText(id, '–')));

  try {
    const data = await api('/api/posts?limit=5');
    const posts = rememberPosts(data.data || []);
    if (posts.length === 0) {
      recent.innerHTML = `<div class="empty"><i class="fas fa-newspaper"></i><p>No posts yet</p><button type="button" class="btn btn-primary btn-sm" data-nav="compose">Create your first post</button></div>`;
      return;
    }
    recent.innerHTML = posts.map(renderPostRow).join('');
  } catch (err) {
    recent.innerHTML = errorHtml(err);
  }
}

function renderPostRow(post) {
  return `
    <button type="button" class="list-row" data-action="post-comments" data-id="${esc(post.id)}">
      ${thumbHtml(post.full_picture, post.is_video)}
      <div class="list-main">
        <div class="list-title">${esc(postText(post)) || '<span style="color:var(--text-3)">No text</span>'}</div>
        <div class="list-sub">
          <span>${formatDate(post.created_time)}</span>
          <span><i class="fas fa-heart"></i>${formatNumber(post.reactions?.summary?.total_count)}</span>
          <span><i class="fas fa-comment"></i>${formatNumber(post.comments?.summary?.total_count)}</span>
        </div>
      </div>
      <i class="fas fa-chevron-right row-chevron"></i>
    </button>`;
}

// ============================================
// POSTS
// ============================================
function bindPosts() {
  document.getElementById('postsSegment').addEventListener('click', (e) => {
    const seg = e.target.closest('.seg');
    if (!seg) return;
    state.postsSegment = seg.dataset.seg;
    document.querySelectorAll('#postsSegment .seg').forEach(s => s.classList.toggle('active', s === seg));
    document.getElementById('postsFeedPane').hidden = state.postsSegment !== 'feed';
    document.getElementById('postsStoriesPane').hidden = state.postsSegment !== 'stories';
    if (state.postsSegment === 'stories') loadStories();
  });
}

function loadPostsView() {
  loadPosts();
  if (FEATURES.stories && state.postsSegment === 'stories') loadStories();
}

async function loadPosts() {
  const container = document.getElementById('postsList');

  if (!state.page) {
    container.innerHTML = `<div class="card">${notConnectedHtml('Connect a page to see its posts.')}</div>`;
    return;
  }

  container.innerHTML = `<div class="card">${skeletonRows(4)}</div>`;

  try {
    const data = await api('/api/posts?limit=25');
    const posts = rememberPosts(data.data || []);

    if (posts.length === 0) {
      container.innerHTML = `<div class="card"><div class="empty"><i class="fas fa-newspaper"></i><p>No posts yet</p><button type="button" class="btn btn-primary btn-sm" data-nav="compose">Create a post</button></div></div>`;
      return;
    }
    container.innerHTML = posts.map(renderPostCard).join('');
  } catch (err) {
    container.innerHTML = `<div class="card">${errorHtml(err)}</div>`;
  }
}

function renderPostCard(post) {
  const text = postText(post);
  const permalink = safeUrl(post.permalink_url);

  return `
    <article class="post" data-post-id="${esc(post.id)}">
      <div class="post-head">
        <div class="avatar">${esc(initial(state.page?.pageName))}</div>
        <div class="post-head-main">
          <div class="post-author">${esc(state.page?.pageName || 'Your page')}</div>
          <div class="post-time">${formatDate(post.created_time)}${post.is_video ? ' <span class="badge"><i class="fas fa-video"></i> Video</span>' : ''}</div>
        </div>
        <button type="button" class="icon-btn" data-action="post-menu" data-id="${esc(post.id)}" aria-label="Post options"><i class="fas fa-ellipsis"></i></button>
      </div>
      ${text
        ? `<p class="post-text" data-action="expand">${esc(text)}</p>`
        : (post.full_picture ? '' : '<p class="post-text muted">No text</p>')}
      ${post.full_picture ? `
        <div class="post-media">
          <img src="${esc(safeUrl(post.full_picture))}" alt="" loading="lazy">
          ${post.is_video ? '<div class="play"><i class="fas fa-circle-play"></i></div>' : ''}
        </div>` : ''}
      <div class="post-stats">
        <span><i class="fas fa-heart"></i>${formatNumber(post.reactions?.summary?.total_count)}</span>
        <span><i class="fas fa-comment"></i>${formatNumber(post.comments?.summary?.total_count)}</span>
        <span><i class="fas fa-share"></i>${formatNumber(post.shares?.count)}</span>
        ${post.is_video && post.video_length ? `<span><i class="fas fa-clock"></i>${formatDuration(post.video_length)}</span>` : ''}
      </div>
      <div class="post-actions">
        <button type="button" class="post-action" data-action="post-comments" data-id="${esc(post.id)}"><i class="far fa-comment"></i> Comments</button>
        ${permalink ? `<a class="post-action" href="${esc(permalink)}" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i> Open</a>` : ''}
      </div>
    </article>`;
}

function openPostMenu(postId) {
  const post = state.posts.get(postId);
  if (!post) return;

  const mediaUrl = post.is_video ? post.video_source : post.full_picture;
  const permalink = safeUrl(post.permalink_url);
  const items = [
    { icon: 'far fa-comment', label: 'View comments', onSelect: () => openPostComments(postId) },
  ];
  if (permalink) items.push({ icon: 'fas fa-arrow-up-right-from-square', label: 'Open on Facebook', onSelect: () => window.open(permalink, '_blank', 'noopener') });
  if (mediaUrl) items.push({ icon: 'fas fa-circle-plus', label: 'Share to story', onSelect: () => openStoryPreview({ url: mediaUrl, isVideo: !!post.is_video }) });
  items.push({ icon: 'fas fa-trash', label: 'Delete post', danger: true, onSelect: () => deletePost(postId) });

  menuSheet(items);
}

async function deletePost(postId) {
  const ok = await confirmSheet({
    title: 'Delete this post?',
    message: 'It will be removed from your Facebook Page. This can’t be undone.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;

  try {
    await api(`/api/posts/${encodeURIComponent(postId)}`, { method: 'DELETE' });
    document.querySelectorAll(`[data-post-id="${CSS.escape(postId)}"]`).forEach(el => el.remove());
    state.posts.delete(postId);
    state.overview = null;
    invalidate('home', 'insights');
    showToast('Post deleted');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============================================
// NEW STORY
// ============================================
const MAX_STORY_UPLOAD = 100 * 1024 * 1024; // Cloudflare request body limit

function openNewStorySheet() {
  if (!state.page) {
    showToast('Connect a page first', 'error');
    return;
  }
  menuSheet([
    { icon: 'fas fa-mobile-screen', label: 'Upload a photo or video', onSelect: pickStoryFile },
    { icon: 'far fa-images', label: 'Use a photo from your posts', onSelect: openStoryPhotoPicker },
  ]);
}

function pickStoryFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,video/*';
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > MAX_STORY_UPLOAD) {
      showToast(`That file is ${formatFileSize(file.size)}. The limit is 100 MB.`, 'error');
      return;
    }
    openStoryPreview({ file, isVideo: file.type.startsWith('video/') });
  });
  input.click();
}

// Grid of photos from recent posts (every photo of multi-photo posts too)
async function openStoryPhotoPicker() {
  const sheet = openSheet({
    title: 'Choose a photo',
    size: 'tall',
    body: `<div class="media-picker">${'<div class="skeleton"></div>'.repeat(9)}</div>`,
  });
  const grid = sheet.el.querySelector('.media-picker');

  try {
    const data = await api('/api/posts?limit=50');
    const posts = rememberPosts(data.data || []);
    const urls = [];
    for (const post of posts) {
      if (post.is_video) continue;
      const subs = post.attachments?.data?.[0]?.subattachments?.data || [];
      const images = subs.length
        ? subs.filter(s => s.type === 'photo' || s.media?.image).map(s => s.media?.image?.src)
        : [post.full_picture];
      images.forEach(src => { if (safeUrl(src) && !urls.includes(src)) urls.push(src); });
    }

    if (urls.length === 0) {
      grid.outerHTML = '<div class="empty"><i class="far fa-images"></i><p>No photos yet</p><small>Photos from your recent posts show up here.</small></div>';
      return;
    }
    grid.innerHTML = urls.map((src, i) => `
      <button type="button" class="media-pick" data-index="${i}" aria-label="Use this photo">
        <img src="${esc(src)}" alt="" loading="lazy">
      </button>`).join('');
    grid.addEventListener('click', (e) => {
      const pick = e.target.closest('.media-pick');
      if (!pick) return;
      openStoryPreview({ url: urls[parseInt(pick.dataset.index, 10)], isVideo: false, onShared: () => sheet.close() });
    });
  } catch (err) {
    grid.outerHTML = errorHtml(err);
  }
}

// Shows exactly what will be shared (media only, no caption), then publishes
function openStoryPreview({ file, url, isVideo, onShared }) {
  const src = file ? URL.createObjectURL(file) : safeUrl(url);
  const sheet = openSheet({
    title: 'Share to story',
    body: `
      <div class="story-preview">
        ${isVideo
          ? `<video src="${esc(src)}" playsinline muted loop autoplay></video>`
          : `<img src="${esc(src)}" alt="">`}
      </div>
      <p class="sheet-note"><i class="fas fa-circle-info"></i> Only the ${isVideo ? 'video' : 'photo'} is shared, with no caption. Stories stay up for 24 hours.</p>`,
    footer: `
      <button type="button" class="btn btn-secondary" data-sheet-close>Cancel</button>
      <button type="button" class="btn btn-primary" id="shareStoryBtn"><i class="fas fa-circle-plus"></i> Share</button>`,
    onClose: () => { if (file) URL.revokeObjectURL(src); },
  });

  const btn = sheet.el.querySelector('#shareStoryBtn');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${file ? 'Uploading…' : 'Sharing…'}`;
    try {
      if (file) {
        const form = new FormData();
        form.append('media', file);
        await api('/api/stories/upload', { method: 'POST', body: form });
      } else if (isVideo) {
        await api('/api/stories/video', jsonBody({ videoUrl: url }));
      } else {
        await api('/api/stories/photo', jsonBody({ imageUrl: url }));
      }
      sheet.close();
      if (onShared) onShared();
      showToast('Shared to your story');
      invalidate('posts');
      if (state.view === 'posts' && state.postsSegment === 'stories') loadStories();
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-circle-plus"></i> Share';
      showToast(err.message, 'error');
    }
  });
}

// Stories
async function loadStories() {
  const container = document.getElementById('storiesList');
  const ids = ['storiesTotalViews', 'storiesActive', 'storiesAvgViews'];

  if (!state.page) {
    ids.forEach(id => setText(id, '–'));
    container.innerHTML = `<div class="card" style="grid-column:1/-1">${notConnectedHtml('Connect a page to see its stories.')}</div>`;
    return;
  }

  container.innerHTML = '<div class="story skeleton"></div><div class="story skeleton"></div>';

  try {
    const data = await api('/api/stories');
    const summary = data.summary || {};
    setText('storiesTotalViews', formatNumber(summary.totalImpressions));
    setText('storiesActive', formatNumber(summary.activeStories));
    setText('storiesAvgViews', formatNumber(summary.avgImpressions));

    const stories = data.data || [];
    const newTile = `
      <button type="button" class="story story-new" data-action="new-story">
        <span class="story-new-icon"><i class="fas fa-plus"></i></span>
        <span>New story</span>
      </button>`;
    if (stories.length === 0) {
      container.innerHTML = newTile + `
        <div class="story-hint">
          <p>No stories yet</p>
          <small>Upload a photo or video, or reuse a photo from your posts. Stories shared from this app show up here with their views.</small>
        </div>`;
      return;
    }

    container.innerHTML = newTile + stories.map(story => {
      const active = isStoryActive(story.created_time);
      const img = safeUrl(story.thumbnail_url || story.media_url);
      const isVideo = story.media_type === 'video';
      const permalink = safeUrl(story.permalink);
      const tag = permalink ? 'a' : 'div';
      return `
        <${tag} class="story ${active ? '' : 'expired'}" ${permalink ? `href="${esc(permalink)}" target="_blank" rel="noopener"` : ''}>
          ${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : `<div class="story-placeholder"><i class="fas fa-${isVideo ? 'video' : 'image'}"></i></div>`}
          <div class="story-top">
            <span class="story-pill ${active ? 'live' : ''}">${active ? 'Live' : 'Expired'}</span>
            <span class="story-pill"><i class="fas fa-${isVideo ? 'video' : 'image'}"></i></span>
          </div>
          <div class="story-bottom">
            <span><i class="fas fa-eye"></i>${formatNumber(story.insights?.impressions)}</span>
            <span>${formatDate(story.created_time)}</span>
          </div>
        </${tag}>`;
    }).join('');
  } catch (err) {
    container.innerHTML = `<div class="card" style="grid-column:1/-1">${errorHtml(err)}</div>`;
  }
}

function isStoryActive(createdTime) {
  return !!createdTime && (Date.now() - new Date(createdTime)) < 24 * 3600 * 1000;
}

// ============================================
// COMPOSE
// ============================================
function bindCompose() {
  const textarea = document.getElementById('postMessage');
  textarea.addEventListener('input', () => {
    setText('charCount', textarea.value.length);
    textarea.style.height = 'auto';
    textarea.style.height = Math.max(140, textarea.scrollHeight) + 'px';
  });

  document.getElementById('composeType').addEventListener('click', (e) => {
    const seg = e.target.closest('.seg');
    if (!seg) return;
    state.composeType = seg.dataset.type;
    document.querySelectorAll('#composeType .seg').forEach(s => s.classList.toggle('active', s === seg));
    document.getElementById('photoField').hidden = state.composeType !== 'photo';
    document.getElementById('videoField').hidden = state.composeType !== 'video';
    document.getElementById('linkField').hidden = state.composeType !== 'link';
  });

  document.querySelectorAll('[data-mode-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.modeToggle;
      const mode = state.uploadModes[type] === 'file' ? 'url' : 'file';
      state.uploadModes[type] = mode;
      document.getElementById(`${type}FileSection`).hidden = mode !== 'file';
      document.getElementById(`${type}UrlSection`).hidden = mode !== 'url';
      btn.textContent = mode === 'file'
        ? `Use ${type === 'photo' ? 'an image' : 'a video'} URL instead`
        : 'Upload a file instead';
    });
  });

  document.getElementById('photoFile').addEventListener('change', (e) => {
    addPhotos(Array.from(e.target.files || []));
    e.target.value = ''; // allow picking the same file again
  });

  document.getElementById('videoFile').addEventListener('change', (e) => {
    setVideo(e.target.files?.[0] || null);
  });

  document.getElementById('clearComposeBtn').addEventListener('click', clearCompose);

  document.getElementById('composeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    publishPost();
  });
}

function addPhotos(files) {
  const images = files.filter(f => f.type.startsWith('image/'));
  if (images.length === 0) {
    if (files.length) showToast('Pick an image file', 'error');
    return;
  }
  const slots = MAX_PHOTOS - state.photos.length;

  if (MAX_PHOTOS === 1) {
    clearPhotos();
    state.photos.push({ file: images[0], url: URL.createObjectURL(images[0]) });
  } else {
    if (slots <= 0) {
      showToast(`You can add up to ${MAX_PHOTOS} photos`, 'error');
      return;
    }
    images.slice(0, slots).forEach(file => state.photos.push({ file, url: URL.createObjectURL(file) }));
    if (images.length > slots) showToast(`Added ${slots} — max ${MAX_PHOTOS} photos`);
  }
  renderPhotos();
}

function removePhoto(index) {
  const [removed] = state.photos.splice(index, 1);
  if (removed) URL.revokeObjectURL(removed.url);
  renderPhotos();
}

function clearPhotos() {
  state.photos.forEach(p => URL.revokeObjectURL(p.url));
  state.photos = [];
  renderPhotos();
}

function renderPhotos() {
  document.getElementById('photoPreview').innerHTML = state.photos.map((p, i) => `
    <div class="photo-item">
      <img src="${p.url}" alt="Photo ${i + 1}">
      <button type="button" class="remove-btn" data-action="remove-photo" data-index="${i}" aria-label="Remove photo"><i class="fas fa-xmark"></i></button>
    </div>`).join('');

  const full = state.photos.length >= MAX_PHOTOS;
  document.querySelector('label[for="photoFile"]').hidden = full && MAX_PHOTOS > 1;
  setText('photoPickerHint', state.photos.length
    ? `${state.photos.length} of ${MAX_PHOTOS} selected · tap to ${MAX_PHOTOS > 1 ? 'add more' : 'replace'}`
    : 'JPG or PNG');
}

function setVideo(file) {
  const preview = document.getElementById('videoPreview');
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = null;

  if (!file) {
    preview.innerHTML = '';
    document.getElementById('videoFile').value = '';
    document.querySelector('label[for="videoFile"]').hidden = false;
    return;
  }

  state.videoUrl = URL.createObjectURL(file);
  document.querySelector('label[for="videoFile"]').hidden = true;
  preview.innerHTML = `
    <div class="video-preview">
      <video src="${state.videoUrl}" controls playsinline></video>
      <button type="button" class="remove-btn" data-action="remove-video" aria-label="Remove video"><i class="fas fa-xmark"></i></button>
    </div>
    <div class="file-meta"><span>${esc(file.name)}</span><span>${formatFileSize(file.size)}</span></div>`;
}

async function publishPost() {
  const message = document.getElementById('postMessage').value.trim();
  const type = state.composeType;

  if (!state.page) {
    showToast('Connect a Facebook Page first', 'error');
    return;
  }
  if (type === 'text' && !message) {
    showToast('Write something to publish', 'error');
    return;
  }

  const btn = document.getElementById('publishBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Publishing…';

  try {
    let request;

    if (type === 'photo') {
      const url = document.getElementById('photoUrl').value.trim();
      if (state.uploadModes.photo === 'file' && state.photos.length > 1) {
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading photos…';
        const form = new FormData();
        form.append('caption', message);
        state.photos.forEach((p, i) => form.append(`photo_${i}`, p.file));
        request = ['/api/posts/photos/upload', { method: 'POST', body: form }];
      } else if (state.uploadModes.photo === 'file' && state.photos.length === 1) {
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading photo…';
        const form = new FormData();
        form.append('photo', state.photos[0].file);
        form.append('caption', message);
        request = ['/api/posts/photo/upload', { method: 'POST', body: form }];
      } else if (state.uploadModes.photo === 'url' && url) {
        request = ['/api/posts/photo', jsonBody({ url, caption: message })];
      } else {
        throw new Error(state.uploadModes.photo === 'url' ? 'Enter an image URL' : 'Add a photo first');
      }
    } else if (type === 'video') {
      const file = document.getElementById('videoFile').files?.[0];
      const url = document.getElementById('videoUrl').value.trim();
      const title = document.getElementById('videoTitle').value.trim();
      if (state.uploadModes.video === 'file' && file) {
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading video…';
        const form = new FormData();
        form.append('video', file);
        form.append('description', message);
        if (title) form.append('title', title);
        request = ['/api/posts/video/upload', { method: 'POST', body: form }];
      } else if (state.uploadModes.video === 'url' && url) {
        request = ['/api/posts/video', jsonBody({ file_url: url, description: message, title })];
      } else {
        throw new Error(state.uploadModes.video === 'url' ? 'Enter a video URL' : 'Add a video first');
      }
    } else if (type === 'link') {
      const link = document.getElementById('linkUrl').value.trim();
      if (!link) throw new Error('Enter a link');
      request = ['/api/posts', jsonBody({ message, link })];
    } else {
      request = ['/api/posts', jsonBody({ message })];
    }

    await api(...request);

    showToast('Published');
    clearCompose();
    state.overview = null;
    invalidate('home', 'posts', 'insights');
    navigate('posts');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Publish';
  }
}

function clearCompose() {
  const textarea = document.getElementById('postMessage');
  textarea.value = '';
  textarea.style.height = '';
  ['photoUrl', 'videoUrl', 'videoTitle', 'linkUrl'].forEach(id => { document.getElementById(id).value = ''; });
  setText('charCount', 0);
  clearPhotos();
  setVideo(null);
}

// ============================================
// COMMENTS
// ============================================
function bindComments() {
  document.getElementById('commentFilter').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.commentFilter = chip.dataset.filter;
    document.querySelectorAll('#commentFilter .chip').forEach(c => c.classList.toggle('active', c === chip));
    renderComments();
  });
}

async function loadComments() {
  const container = document.getElementById('commentsList');

  if (!state.page) {
    container.innerHTML = `<div class="card">${notConnectedHtml('Connect a page to manage its comments.')}</div>`;
    return;
  }

  container.innerHTML = `<div class="card">${skeletonRows(4, false)}</div>`;
  state.comments = [];
  state.commentsPaging = null;

  try {
    await fetchCommentsPage();
  } catch (err) {
    container.innerHTML = `<div class="card">${errorHtml(err)}</div>`;
  }
}

// Loads comments for the next batch of posts (25 at a time, newest first)
async function fetchCommentsPage() {
  const after = state.commentsPaging?.after;
  const data = await api(`/api/comments/all?limit=25${after ? `&after=${encodeURIComponent(after)}` : ''}`);
  const fresh = (data.data || []).map(c => rememberComment(c, c.post?.message, c.post?.created_time));
  state.comments = state.comments.concat(fresh.filter(c => !state.comments.includes(c)));
  state.commentsPaging = {
    after: data.paging?.after,
    hasMore: !!data.paging?.hasMore,
    posts: (state.commentsPaging?.posts || 0) + (data.posts || 0),
    since: data.oldestPost || state.commentsPaging?.since,
  };
  renderComments();
}

async function loadMoreComments(btn) {
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading…';
  try {
    await fetchCommentsPage();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Load older posts';
    showToast(err.message, 'error');
  }
}

function renderComments() {
  const container = document.getElementById('commentsList');
  if (!state.page) return;

  // Counts on the filter chips
  document.querySelectorAll('#commentFilter .chip').forEach(chip => {
    const n = filterComments(state.comments, chip.dataset.filter).length;
    let count = chip.querySelector('.count');
    if (!count) {
      count = document.createElement('span');
      count.className = 'count';
      chip.append(count);
    }
    count.textContent = n;
  });

  const paging = state.commentsPaging || {};
  const scope = paging.posts
    ? `<div class="list-note">From your ${paging.posts} most recent posts${paging.since ? ` · since ${formatDate(paging.since)}` : ''}</div>`
    : '';
  const more = paging.hasMore
    ? '<button type="button" class="btn btn-secondary load-more" data-action="more-comments">Load older posts</button>'
    : '';

  const list = filterComments(state.comments, state.commentFilter);
  if (list.length === 0) {
    const messages = {
      all: ['No comments yet', 'Comments on your posts appear here.'],
      unanswered: ['You’re all caught up', 'Every visible comment has a reply from your page.'],
      hidden: ['No hidden comments', 'Comments you or Facebook hide will show up here.'],
    };
    const [title, sub] = messages[state.commentFilter];
    container.innerHTML = `${scope}<div class="card"><div class="empty"><i class="fas fa-comment-dots"></i><p>${title}</p><small>${sub}</small></div></div>${more}`;
    return;
  }
  container.innerHTML = scope + list.map(c => renderComment(c, { context: true })).join('') + more;
}

function filterComments(list, filter) {
  let out = list.filter(c => !deletedComments.has(c.id));
  // Hidden: hidden comments, plus visible ones that have hidden replies
  if (filter === 'hidden') out = out.filter(c => c.is_hidden || (c.comments?.data || []).some(r => r.is_hidden && !deletedComments.has(r.id)));
  if (filter === 'unanswered') out = out.filter(c => !c.is_hidden && !hasPageReply(c));
  if (filter === 'oldest') out = [...out].sort((a, b) => new Date(a.created_time) - new Date(b.created_time));
  else out = [...out].sort((a, b) => new Date(b.created_time) - new Date(a.created_time));
  return out;
}

function hasPageReply(comment) {
  const replies = comment.comments?.data || [];
  return replies.some(r => r.mine || (state.page && r.from?.id === state.page.pageId));
}

// Returns the single shared object for this comment (merging fresh data in)
function rememberComment(comment, postMessage, postTime) {
  const existing = commentIndex.get(comment.id);
  if (existing) {
    Object.assign(existing.comment, comment);
    if (postMessage) existing.postMessage = postMessage;
    if (postTime) existing.postTime = postTime;
    return existing.comment;
  }
  commentIndex.set(comment.id, { comment, postMessage: postMessage || '', postTime: postTime || '', liked: !!comment.user_likes, repliesOpen: false });
  return comment;
}

// Stickers, GIFs and photos come without text
function commentBodyHtml(c, cls) {
  if (c.message) return `<p class="${cls}" data-action="expand">${esc(c.message)}</p>`;
  const labels = { sticker: 'Sticker', animated_image_share: 'GIF', animated_image_autoplay: 'GIF', photo: 'Photo', video_inline: 'Video', share: 'Link' };
  const type = c.attachment?.type;
  return `<p class="${cls} attachment-note"><i class="far fa-image"></i> ${esc(labels[type] || (type ? 'Attachment' : 'No text'))}</p>`;
}

function renderComment(c, { context = false } = {}) {
  const entry = commentIndex.get(c.id) || {};
  const name = c.from?.name || 'Facebook user';
  const replies = (c.comments?.data || []).filter(r => !deletedComments.has(r.id));
  const replyCount = Math.max(c.comment_count || 0, replies.length);
  const hiddenReplies = replies.filter(r => r.is_hidden).length;
  const likes = c.like_count || 0;
  const showAI = FEATURES.aiReply && isCommentEligibleForAI(c.message);

  return `
    <div class="comment ${c.is_hidden ? 'is-hidden' : ''}" data-comment-id="${esc(c.id)}" data-context="${context ? 1 : 0}">
      <div class="comment-top">
        <div class="avatar avatar-sm">${esc(initial(name))}</div>
        <div class="comment-main">
          <div class="comment-meta">
            <span class="comment-author">${esc(name)}</span>
            <span>${formatDate(c.created_time)}</span>
            ${c.is_hidden ? '<span class="hidden-tag"><i class="fas fa-eye-slash"></i> Hidden</span>' : ''}
            ${likes ? `<span><i class="fas fa-heart"></i> ${likes}</span>` : ''}
          </div>
          ${context && entry.postMessage ? `<div class="comment-context">On “${esc(truncate(entry.postMessage, 70))}”</div>` : ''}
          ${commentBodyHtml(c, 'comment-text')}
          ${replyCount ? `<button type="button" class="replies-toggle" data-action="toggle-replies">${entry.repliesOpen ? 'Hide replies' : `View ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}${hiddenReplies ? ` · ${hiddenReplies} hidden` : ''}`}</button>` : ''}
          ${entry.repliesOpen && replies.length ? `<div class="replies">${replies.map(renderReply).join('')}</div>` : ''}
          <div class="comment-actions">
            <button type="button" class="c-action" data-action="reply"><i class="fas fa-reply"></i> Reply</button>
            <button type="button" class="c-action ${entry.liked ? 'liked' : ''}" data-action="like"><i class="${entry.liked ? 'fas' : 'far'} fa-heart"></i> ${entry.liked ? 'Liked' : 'Like'}</button>
            ${showAI ? '<button type="button" class="c-action ai" data-action="ai-reply"><i class="fas fa-wand-magic-sparkles"></i> AI reply</button>' : ''}
            <button type="button" class="c-action more" data-action="comment-menu" aria-label="More actions"><i class="fas fa-ellipsis"></i></button>
          </div>
        </div>
      </div>
    </div>`;
}

function renderReply(r) {
  const mine = r.mine || (state.page && r.from?.id === state.page.pageId);
  const name = mine ? (state.page?.pageName || 'Your page') : (r.from?.name || 'Facebook user');
  return `
    <div class="reply ${r.pending ? 'pending' : ''} ${r.is_hidden ? 'is-hidden' : ''}" ${r.id ? `data-reply-id="${esc(r.id)}"` : ''}>
      <div class="reply-body">
        <div class="reply-author">${esc(name)}${mine ? '<span class="you">YOU</span>' : ''}<span class="reply-time">${r.pending ? 'Sending…' : formatDate(r.created_time)}</span>${r.is_hidden ? '<span class="hidden-tag"><i class="fas fa-eye-slash"></i> Hidden</span>' : ''}</div>
        ${commentBodyHtml(r, 'reply-text')}
      </div>
      ${r.id && !r.pending ? '<button type="button" class="icon-btn reply-more" data-action="reply-menu" aria-label="Reply options"><i class="fas fa-ellipsis"></i></button>' : ''}
    </div>`;
}

function openReplyMenu(entry, reply) {
  const mine = reply.mine || (state.page && reply.from?.id === state.page.pageId);
  const items = [];
  if (!mine) {
    items.push({
      icon: reply.is_hidden ? 'fas fa-eye' : 'fas fa-eye-slash',
      label: reply.is_hidden ? 'Unhide reply' : 'Hide reply',
      onSelect: () => toggleHideComment(entry, reply),
    });
  }
  items.push({ icon: 'fas fa-trash', label: 'Delete reply', danger: true, onSelect: () => deleteComment(entry, reply) });
  menuSheet(items);
}

// Re-render every on-screen copy of a comment from its index entry
function refreshCommentCards(id) {
  const entry = commentIndex.get(id);
  document.querySelectorAll(`[data-comment-id="${CSS.escape(id)}"]`).forEach(card => {
    if (!entry || deletedComments.has(id)) {
      card.classList.add('removing');
      setTimeout(() => card.remove(), 250);
      return;
    }
    card.outerHTML = renderComment(entry.comment, { context: card.dataset.context === '1' });
  });
}

function commentFromCard(el) {
  const card = el.closest('[data-comment-id]');
  return card ? commentIndex.get(card.dataset.commentId) : null;
}

function openReplySheet(entry) {
  const c = entry.comment;
  const sheet = openSheet({
    title: 'Reply',
    body: `
      <div class="sheet-quote"><strong>${esc(c.from?.name || 'Facebook user')}</strong>${esc(c.message || '')}</div>
      <textarea class="input" id="replyText" rows="4" placeholder="Write a reply…"></textarea>`,
    footer: `
      <button type="button" class="btn btn-secondary" data-sheet-close>Cancel</button>
      <button type="button" class="btn btn-primary" id="sendReplyBtn"><i class="fas fa-paper-plane"></i> Send</button>`,
  });
  const textarea = sheet.el.querySelector('#replyText');
  setTimeout(() => textarea.focus(), 280);

  sheet.el.querySelector('#sendReplyBtn').addEventListener('click', () => {
    const text = textarea.value.trim();
    if (!text) {
      showToast('Write a reply first', 'error');
      return;
    }
    sheet.close();
    sendReply(entry, text, (message) => api(`/api/comments/${encodeURIComponent(c.id)}/reply`, jsonBody({ message })));
  });
}

// Optimistically show the reply, then confirm or roll back
async function sendReply(entry, text, send) {
  const c = entry.comment;
  c.comments = c.comments || { data: [] };
  c.comments.data = c.comments.data || [];
  const reply = { message: text, mine: true, pending: true, created_time: new Date().toISOString() };
  c.comments.data.push(reply);
  c.comment_count = (c.comment_count || 0) + 1;
  entry.repliesOpen = true;
  refreshCommentCards(c.id);

  try {
    const res = await send(text);
    if (res?.id) reply.id = res.id;
    reply.pending = false;
    showToast('Reply sent');
  } catch (err) {
    c.comments.data = c.comments.data.filter(r => r !== reply);
    c.comment_count = Math.max(0, c.comment_count - 1);
    showToast(err.message, 'error');
  }
  refreshCommentCards(c.id);
}

async function toggleLike(entry, btn) {
  const c = entry.comment;
  const like = !entry.liked;
  btn.disabled = true;

  try {
    await api(`/api/comments/${encodeURIComponent(c.id)}/like`, { method: like ? 'POST' : 'DELETE' });
    entry.liked = like;
    c.like_count = Math.max(0, (c.like_count || 0) + (like ? 1 : -1));
    refreshCommentCards(c.id);
  } catch (err) {
    btn.disabled = false;
    showToast(err.message, 'error');
  }
}

function openCommentMenu(entry) {
  const c = entry.comment;
  menuSheet([
    { icon: 'fas fa-reply', label: 'Reply', onSelect: () => openReplySheet(entry) },
    {
      icon: c.is_hidden ? 'fas fa-eye' : 'fas fa-eye-slash',
      label: c.is_hidden ? 'Unhide comment' : 'Hide comment',
      onSelect: () => toggleHideComment(entry),
    },
    { icon: 'fas fa-trash', label: 'Delete comment', danger: true, onSelect: () => deleteComment(entry) },
  ]);
}

// `target` is the comment itself or one of its replies
async function toggleHideComment(entry, target = entry.comment) {
  const hide = !target.is_hidden;
  const what = target === entry.comment ? 'Comment' : 'Reply';
  try {
    await api(`/api/comments/${encodeURIComponent(target.id)}/hide`, jsonBody({ is_hidden: hide }));
    target.is_hidden = hide;
    refreshCommentCards(entry.comment.id);
    if (state.view === 'comments') renderComments();
    showToast(hide ? `${what} hidden` : `${what} visible again`);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteComment(entry, target = entry.comment) {
  const isReply = target !== entry.comment;
  const ok = await confirmSheet({
    title: isReply ? 'Delete reply?' : 'Delete comment?',
    message: `The ${isReply ? 'reply' : 'comment'} will be removed from Facebook. This can’t be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;

  const id = target.id;
  try {
    await api(`/api/comments/${encodeURIComponent(id)}`, { method: 'DELETE' });
    deletedComments.add(id);
    if (isReply) entry.comment.comment_count = Math.max(0, (entry.comment.comment_count || 1) - 1);
    refreshCommentCards(entry.comment.id);
    if (state.view === 'comments') renderComments();
    showToast(isReply ? 'Reply deleted' : 'Comment deleted');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Comments for a single post, in a tall sheet
async function openPostComments(postId) {
  const post = state.posts.get(postId);
  const postMessage = post ? postText(post) : '';
  let list = [];
  let sort = 'newest';

  const sheet = openSheet({
    title: 'Comments',
    size: 'tall',
    body: `
      ${postMessage ? `<div class="sheet-quote">${esc(truncate(postMessage, 160))}</div>` : ''}
      <div class="chips chips-small" data-role="sort">
        <button type="button" class="chip active" data-sort="newest">Newest</button>
        <button type="button" class="chip" data-sort="oldest">Oldest</button>
        <button type="button" class="chip" data-sort="unanswered">Unanswered</button>
        <button type="button" class="chip" data-sort="hidden">Hidden</button>
      </div>
      <div data-role="list">${skeletonRows(3, false)}</div>`,
  });
  const listEl = sheet.el.querySelector('[data-role="list"]');

  const render = () => {
    const items = filterComments(list, sort === 'newest' ? 'all' : sort);
    listEl.innerHTML = items.length
      ? items.map(c => renderComment(c)).join('')
      : `<div class="empty"><i class="fas fa-comment-dots"></i><p>${list.length ? 'Nothing here' : 'No comments yet'}</p></div>`;
  };

  sheet.el.querySelector('[data-role="sort"]').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    sort = chip.dataset.sort;
    sheet.el.querySelectorAll('[data-role="sort"] .chip').forEach(ch => ch.classList.toggle('active', ch === chip));
    render();
  });

  try {
    const data = await api(`/api/posts/${encodeURIComponent(postId)}/comments?all=true`);
    list = (data.data || []).map(c => rememberComment(c, postMessage, post?.created_time));
    sheet.setTitle(`Comments · ${list.length}`);
    render();
  } catch (err) {
    listEl.innerHTML = errorHtml(err);
  }
}

// ============================================
// AI REPLIES
// ============================================
async function loadAIConfig() {
  try {
    state.aiConfig = await api('/api/ai-reply/config');
    populateAIConfigForm(state.aiConfig);
  } catch {
    state.aiConfig = null;
  }
}

function populateAIConfigForm(config) {
  document.getElementById('aiEnabled').checked = !!config.enabled;
  document.getElementById('aiPageDescription').value = config.pageContext?.description || '';
  document.getElementById('aiPageNiche').value = config.pageContext?.niche || 'General';
  document.getElementById('aiPageTone').value = config.pageContext?.tone || 'Friendly and casual';
  document.getElementById('aiCustomInstructions').value = config.customInstructions || '';
  document.getElementById('aiReplyProbability').value = config.replyProbability || 30;
  document.getElementById('aiMinCommentLength').value = config.minCommentLength || 20;
  setText('probabilityValue', (config.replyProbability || 30) + '%');
}

async function saveAIConfig() {
  const btn = document.getElementById('saveAIConfigBtn');
  const config = {
    enabled: document.getElementById('aiEnabled').checked,
    replyProbability: parseInt(document.getElementById('aiReplyProbability').value, 10),
    minCommentLength: parseInt(document.getElementById('aiMinCommentLength').value, 10),
    pageContext: {
      description: document.getElementById('aiPageDescription').value,
      niche: document.getElementById('aiPageNiche').value,
      tone: document.getElementById('aiPageTone').value,
    },
    customInstructions: document.getElementById('aiCustomInstructions').value,
    skipPatterns: ['nice', 'cool', 'wow', 'love it', 'amazing', 'great', 'awesome', 'beautiful'],
  };

  btn.disabled = true;
  try {
    const data = await api('/api/ai-reply/config', jsonBody(config, 'PUT'));
    state.aiConfig = data.config || config;
    showToast('AI settings saved');
    // AI buttons depend on these settings
    commentIndex.forEach((_, id) => refreshCommentCards(id));
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function isCommentEligibleForAI(message) {
  const config = state.aiConfig;
  if (!config || !config.enabled || !message) return false;
  if (message.length < (config.minCommentLength || 20)) return false;

  const skip = config.skipPatterns || ['nice', 'cool', 'wow', 'love it', 'amazing', 'great', 'awesome'];
  const normalized = message.toLowerCase().trim();
  if (skip.some(p => normalized === p.toLowerCase())) return false;
  if (message.trim().split(/\s+/).length < 2) return false;

  const withoutEmoji = message.replace(/\p{Extended_Pictographic}/gu, '');
  return withoutEmoji.trim().length > 0;
}

const LYZA_TONE = 'Lyza';

function openAIReplySheet(entry) {
  const c = entry.comment;
  const pageTone = state.aiConfig?.pageContext?.tone || 'Friendly and casual';
  let tone = pageTone;
  try { tone = localStorage.getItem('aiReplyTone') || pageTone; } catch {}
  if (tone !== LYZA_TONE) tone = pageTone;

  const sheet = openSheet({
    title: 'AI reply',
    body: `
      <div class="chips chips-small ai-voice" data-role="voice">
        <button type="button" class="chip" data-tone="page">Page tone</button>
        <button type="button" class="chip" data-tone="lyza">Lyza</button>
      </div>
      <div class="sheet-quote"><strong>${esc(c.from?.name || 'Facebook user')}</strong>${esc(c.message || '')}</div>
      <textarea class="input" id="aiReplyText" rows="4" placeholder="Writing a reply…"></textarea>`,
    footer: `
      <button type="button" class="btn btn-secondary" id="aiRegenBtn"><i class="fas fa-rotate"></i> Try again</button>
      <button type="button" class="btn btn-primary" id="aiSendBtn"><i class="fas fa-paper-plane"></i> Send</button>`,
  });
  const textarea = sheet.el.querySelector('#aiReplyText');
  const regenBtn = sheet.el.querySelector('#aiRegenBtn');
  const sendBtn = sheet.el.querySelector('#aiSendBtn');
  const voiceChips = sheet.el.querySelectorAll('[data-role="voice"] .chip');

  const markVoice = () => voiceChips.forEach(chip =>
    chip.classList.toggle('active', (chip.dataset.tone === 'lyza') === (tone === LYZA_TONE)));
  voiceChips.forEach(chip => chip.addEventListener('click', () => {
    const next = chip.dataset.tone === 'lyza' ? LYZA_TONE : pageTone;
    if (next === tone) return;
    tone = next;
    try { localStorage.setItem('aiReplyTone', chip.dataset.tone === 'lyza' ? LYZA_TONE : ''); } catch {}
    markVoice();
    generate();
  }));
  markVoice();

  const generate = async () => {
    textarea.value = '';
    textarea.placeholder = 'Writing a reply…';
    regenBtn.disabled = true;
    sendBtn.disabled = true;
    try {
      const data = await api('/api/ai-reply/generate', jsonBody({
        commentId: c.id,
        commentMessage: c.message,
        commenterName: c.from?.name || 'Someone',
        postContent: entry.postMessage || '',
        postCreatedTime: entry.postTime || undefined,
        tone,
      }));
      if (!data.eligible) {
        textarea.placeholder = `This comment isn’t a good fit for an AI reply (${String(data.reason || '').replace(/_/g, ' ')}).`;
        return;
      }
      textarea.value = data.generatedReply || '';
      textarea.placeholder = 'Edit the reply…';
      sendBtn.disabled = false;
    } catch (err) {
      textarea.placeholder = 'Couldn’t write a reply: ' + err.message;
    } finally {
      regenBtn.disabled = false;
    }
  };

  regenBtn.addEventListener('click', generate);
  sendBtn.addEventListener('click', () => {
    const text = textarea.value.trim();
    if (!text) {
      showToast('The reply is empty', 'error');
      return;
    }
    sheet.close();
    sendReply(entry, text, (customReply) => api('/api/ai-reply/post', jsonBody({ commentId: c.id, customReply })));
  });

  generate();
}

// ============================================
// INSIGHTS
// ============================================
function bindInsights() {
  document.getElementById('analyticsPeriod').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.analyticsDays = parseInt(chip.dataset.days, 10);
    document.querySelectorAll('#analyticsPeriod .chip').forEach(c => c.classList.toggle('active', c === chip));
    if (state.page) {
      loadGrowthChart();
      loadEarnings();
    }
  });
}

async function loadInsights() {
  const ids = ['analyticsFollowers', 'analyticsViews', 'analyticsReach', 'analyticsEngagement'];

  if (!state.page) {
    ids.forEach(id => setText(id, '–'));
    document.getElementById('growthChart').innerHTML = notConnectedHtml('Connect a page to see its insights.');
    ['topPostsList', 'videosList', 'earningsContainer'].forEach(id => {
      document.getElementById(id).innerHTML = '<div class="empty"><small>No data yet</small></div>';
    });
    return;
  }

  getOverview()
    .then(o => {
      setText('analyticsFollowers', formatNumber(o.followers));
      setText('analyticsViews', formatNumber(o.impressions));
      setText('analyticsReach', formatNumber(o.reach));
      setText('analyticsEngagement', formatNumber(o.engaged_users));
    })
    .catch(() => ids.forEach(id => setText(id, '–')));

  await Promise.all([loadGrowthChart(), loadTopPosts(), loadVideoAnalytics(), loadEarnings()]);
}

async function loadGrowthChart() {
  const container = document.getElementById('growthChart');
  const days = state.analyticsDays;
  container.innerHTML = '<div class="skeleton" style="height:190px"></div>';

  try {
    const data = await apiRaw(`/api/analytics/growth?days=${days}`);
    if (days !== state.analyticsDays) return; // a newer period was picked

    if (data.error) {
      container.innerHTML = `
        <div class="empty">
          <i class="fas fa-lock"></i>
          <p>Insights aren’t available</p>
          <small>Try reconnecting your page in Settings so the app can read insights.</small>
        </div>`;
      return;
    }

    const views = data.metrics?.page_media_view || [];
    const unique = data.metrics?.page_total_media_view_unique || [];

    if (views.length === 0) {
      container.innerHTML = '<div class="empty"><i class="fas fa-chart-simple"></i><p>No trend data yet</p><small>Facebook can take a day or two to report new numbers.</small></div>';
      return;
    }

    const total = views.reduce((sum, d) => sum + (Number(d.value) || 0), 0);
    const max = Math.max(...views.map(d => Number(d.value) || 0), ...unique.map(d => Number(d.value) || 0), 1);
    const fmt = (d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

    container.innerHTML = `
      <div class="chart-total">${formatNumber(total)}</div>
      <div class="chart-total-label">views in the last ${days} days</div>
      <div class="chart-legend">
        <span><span class="legend-dot a"></span>Views</span>
        <span><span class="legend-dot b"></span>Unique viewers</span>
      </div>
      <div class="bars">
        ${views.map((d, i) => {
          const v = Number(d.value) || 0;
          const u = Number(unique[i]?.value) || 0;
          return `
            <div class="bar-col" title="${esc(fmt(d.date))}: ${formatNumber(v)} views, ${formatNumber(u)} unique">
              <div class="bar a" style="height:${(v / max) * 100}%"></div>
              <div class="bar b" style="height:${(u / max) * 100}%"></div>
            </div>`;
        }).join('')}
      </div>
      <div class="bar-axis"><span>${esc(fmt(views[0].date))}</span><span>${esc(fmt(views[views.length - 1].date))}</span></div>`;
  } catch (err) {
    container.innerHTML = errorHtml(err);
  }
}

async function loadTopPosts() {
  const container = document.getElementById('topPostsList');
  container.innerHTML = skeletonRows(3);

  try {
    const data = await api('/api/analytics/posts?limit=5');
    const posts = data.data || [];
    if (posts.length === 0) {
      container.innerHTML = '<div class="empty"><small>No posts yet</small></div>';
      return;
    }
    container.innerHTML = posts.map(post => {
      const href = safeUrl(post.permalink_url);
      const tag = href ? 'a' : 'div';
      return `
        <${tag} class="list-row" ${href ? `href="${esc(href)}" target="_blank" rel="noopener"` : ''}>
          ${thumbHtml(post.full_picture)}
          <div class="list-main">
            <div class="list-title">${esc(truncate(post.message, 120)) || '<span style="color:var(--text-3)">No text</span>'}</div>
            <div class="list-sub">
              <span>${formatDate(post.created_time)}</span>
              <span><i class="fas fa-heart"></i>${formatNumber(post.reactions)}</span>
              <span><i class="fas fa-comment"></i>${formatNumber(post.comments)}</span>
              <span><i class="fas fa-share"></i>${formatNumber(post.shares)}</span>
            </div>
          </div>
          <div class="list-end">
            <div class="list-metric">${formatNumber(post.engagement)}</div>
            <div class="list-metric-label">engaged</div>
          </div>
        </${tag}>`;
    }).join('');
  } catch (err) {
    container.innerHTML = errorHtml(err);
  }
}

async function loadVideoAnalytics() {
  const container = document.getElementById('videosList');
  container.innerHTML = skeletonRows(2);

  try {
    const data = await api('/api/analytics/videos?limit=5');
    const videos = data.data || [];
    if (videos.length === 0) {
      container.innerHTML = '<div class="empty"><small>No videos yet</small></div>';
      return;
    }
    container.innerHTML = videos.map(video => {
      const href = safeUrl(video.permalink_url);
      const tag = href ? 'a' : 'div';
      return `
        <${tag} class="list-row" ${href ? `href="${esc(href)}" target="_blank" rel="noopener"` : ''}>
          ${thumbHtml(video.picture, true)}
          <div class="list-main">
            <div class="list-title">${esc(truncate(video.title, 120)) || '<span style="color:var(--text-3)">Untitled video</span>'}</div>
            <div class="list-sub">
              <span>${formatDate(video.created_time)}</span>
              ${video.length ? `<span><i class="fas fa-clock"></i>${formatDuration(video.length)}</span>` : ''}
              <span><i class="fas fa-heart"></i>${formatNumber(video.likes)}</span>
              <span><i class="fas fa-comment"></i>${formatNumber(video.comments)}</span>
            </div>
          </div>
          <div class="list-end">
            <div class="list-metric">${formatNumber(video.views)}</div>
            <div class="list-metric-label">views</div>
          </div>
        </${tag}>`;
    }).join('');
  } catch (err) {
    container.innerHTML = errorHtml(err);
  }
}

async function loadEarnings() {
  const container = document.getElementById('earningsContainer');
  const days = state.analyticsDays;
  container.innerHTML = skeletonRows(1);

  try {
    const data = await apiRaw(`/api/analytics/earnings?days=${days}`);
    if (days !== state.analyticsDays) return;
    const suiteUrl = safeUrl(data.helpLinks?.businessSuite) || 'https://business.facebook.com/';
    const helpUrl = safeUrl(data.helpLinks?.monetizationHelp) || 'https://www.facebook.com/business/help/2606688282612991';

    if (data.error || data.enrolled === false || !data.summary) {
      if (data.videoStats?.totalVideos > 0) {
        container.innerHTML = `
          <div class="earnings">
            <div class="earnings-sub">Earnings aren’t available through the API</div>
            <div class="earnings-split">
              <div><strong>${formatNumber(data.videoStats.totalVideos)}</strong><span>Monetized videos</span></div>
              <div><strong>${formatNumber(data.videoStats.totalViews)}</strong><span>Video views</span></div>
            </div>
          </div>
          <div class="note" style="border-top:1px solid var(--border)"><i class="fas fa-circle-info"></i><span>See exact earnings in <a href="${esc(suiteUrl)}" target="_blank" rel="noopener">Meta Business Suite</a>.</span></div>`;
      } else {
        container.innerHTML = `
          <div class="note">
            <i class="fas fa-circle-info"></i>
            <span>${esc(data.hint || 'Earnings aren’t available through the API for this page.')}
              <a href="${esc(suiteUrl)}" target="_blank" rel="noopener">Open Business Suite</a> ·
              <a href="${esc(helpUrl)}" target="_blank" rel="noopener">Learn more</a></span>
          </div>`;
      }
      return;
    }

    const daily = (data.dailyEarnings || []).map(d => ({ date: d.date, earnings: Number(d.earnings) || 0 }));
    const total = Number(data.summary.totalEarnings) || 0;
    const activeDays = daily.filter(d => d.earnings > 0).length;
    const best = daily.reduce((b, d) => (d.earnings > b.earnings ? d : b), { date: null, earnings: 0 });
    const max = Math.max(...daily.map(d => d.earnings), 0.01);

    container.innerHTML = `
      <div class="earnings">
        <div class="earnings-total">$${total.toFixed(2)}</div>
        <div class="earnings-sub">Estimated earnings · last ${data.period?.days || days} days</div>
        <div class="earnings-split">
          <div><strong>$${(activeDays ? total / activeDays : 0).toFixed(2)}</strong><span>Daily average</span></div>
          <div><strong>$${best.earnings.toFixed(2)}</strong><span>Best day${best.date ? ' · ' + esc(new Date(best.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })) : ''}</span></div>
        </div>
        ${daily.length ? `<div class="bars">${daily.slice(-14).map(d => `
          <div class="bar-col" title="$${d.earnings.toFixed(2)}"><div class="bar a" style="height:${Math.max((d.earnings / max) * 100, 2)}%"></div></div>`).join('')}</div>` : ''}
      </div>`;
  } catch (err) {
    container.innerHTML = errorHtml(err);
  }
}

// ============================================
// SETTINGS
// ============================================
function bindSettings() {
  document.getElementById('saveAIConfigBtn').addEventListener('click', saveAIConfig);
  document.getElementById('aiReplyProbability').addEventListener('input', (e) => setText('probabilityValue', e.target.value + '%'));
}

function renderSettings() {
  const status = document.getElementById('connectionStatus');

  if (state.page) {
    status.innerHTML = `
      <div class="row">
        <div class="avatar">${esc(initial(state.page.pageName))}</div>
        <div class="row-main">
          <span class="row-title">${esc(state.page.pageName)}</span>
          <span class="row-sub"><span class="dot online" style="display:inline-block;margin-right:6px"></span>Connected</span>
        </div>
      </div>
      <button type="button" class="row accent" data-action="connect">
        <i class="fas fa-arrows-rotate row-icon"></i>
        <div class="row-main"><span class="row-title">Switch page</span></div>
      </button>
      <button type="button" class="row danger" data-action="disconnect">
        <i class="fas fa-link-slash row-icon"></i>
        <div class="row-main"><span class="row-title">Disconnect</span></div>
      </button>`;
  } else {
    status.innerHTML = `
      <div class="row">
        <div class="avatar"><i class="fas fa-link-slash"></i></div>
        <div class="row-main"><span class="row-title">No page connected</span><span class="row-sub">Log in with Facebook to pick a page</span></div>
      </div>
      <button type="button" class="row accent" data-action="connect">
        <i class="fab fa-facebook row-icon"></i>
        <div class="row-main"><span class="row-title">Connect Facebook Page</span></div>
        <i class="fas fa-chevron-right row-chevron"></i>
      </button>`;
  }

  const selection = document.getElementById('pageSelectionSection');
  selection.hidden = state.sessionPages.length === 0;
  document.getElementById('pagesList').innerHTML = state.sessionPages.map((p, i) => `
    <button type="button" class="row" data-action="select-page" data-index="${i}">
      <div class="avatar avatar-sm">${esc(initial(p.name))}</div>
      <div class="row-main"><span class="row-title">${esc(p.name)}</span></div>
      <i class="fas fa-chevron-right row-chevron"></i>
    </button>`).join('');

  // AI settings only make sense with a connected page
  if (FEATURES.aiReply) document.getElementById('aiReplySection').hidden = !state.page;
}

// ============================================
// ACTION DISPATCH
// ============================================
function handleAction(el, e) {
  const action = el.dataset.action;
  const entry = () => commentFromCard(el);

  switch (action) {
    case 'connect': return connectFacebook();
    case 'disconnect': return disconnectPage();
    case 'select-page': return selectPage(parseInt(el.dataset.index, 10));
    case 'post-menu': return openPostMenu(el.dataset.id);
    case 'post-comments': return openPostComments(el.dataset.id);
    case 'expand': return el.classList.toggle('expanded');
    case 'remove-photo': e.preventDefault(); return removePhoto(parseInt(el.dataset.index, 10));
    case 'remove-video': e.preventDefault(); return setVideo(null);
    case 'toggle-replies': {
      const en = entry();
      if (!en) return;
      en.repliesOpen = !en.repliesOpen;
      return refreshCommentCards(en.comment.id);
    }
    case 'reply': { const en = entry(); return en && openReplySheet(en); }
    case 'ai-reply': { const en = entry(); return en && openAIReplySheet(en); }
    case 'like': { const en = entry(); return en && toggleLike(en, el); }
    case 'comment-menu': { const en = entry(); return en && openCommentMenu(en); }
    case 'reply-menu': {
      const en = entry();
      const id = el.closest('[data-reply-id]')?.dataset.replyId;
      const reply = en && (en.comment.comments?.data || []).find(r => r.id === id);
      return reply && openReplyMenu(en, reply);
    }
    case 'more-comments': return loadMoreComments(el);
    case 'new-story': return openNewStorySheet();
  }
}

// ============================================
// SHEETS
// ============================================
const sheetStack = [];

function openSheet({ title = '', body = '', footer = '', size = '', onClose } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';

  const sheet = document.createElement('div');
  sheet.className = `sheet ${size} ${title ? '' : 'untitled'}`;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-header">
      <h3>${esc(title)}</h3>
      <button type="button" class="icon-btn" data-sheet-close aria-label="Close"><i class="fas fa-xmark"></i></button>
    </div>
    <div class="sheet-body">${body}</div>
    <div class="sheet-footer">${footer}</div>`;

  const z = 100 + sheetStack.length * 2;
  backdrop.style.zIndex = z;
  sheet.style.zIndex = z + 1;
  document.body.append(backdrop, sheet);
  document.body.style.overflow = 'hidden';

  const handle = {
    el: sheet,
    closed: false,
    setTitle: (t) => { sheet.querySelector('.sheet-header h3').textContent = t; },
    close() {
      if (handle.closed) return;
      handle.closed = true;
      sheetStack.splice(sheetStack.indexOf(handle), 1);
      sheet.classList.remove('open');
      backdrop.classList.remove('open');
      setTimeout(() => { sheet.remove(); backdrop.remove(); }, 280);
      if (sheetStack.length === 0) document.body.style.overflow = '';
      if (onClose) onClose();
    },
  };

  backdrop.addEventListener('click', handle.close);
  sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-sheet-close]')) handle.close();
  });
  enableSwipeToClose(sheet, handle);

  sheetStack.push(handle);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    backdrop.classList.add('open');
    sheet.classList.add('open');
  }));
  return handle;
}

// Drag the handle/header down to dismiss (phone layout only)
function enableSwipeToClose(sheet, handle) {
  const grip = [sheet.querySelector('.sheet-handle'), sheet.querySelector('.sheet-header')];
  let startY = null;
  let dy = 0;

  const start = (e) => {
    if (window.innerWidth >= 640 || e.target.closest('button')) return;
    startY = e.touches[0].clientY;
    dy = 0;
    sheet.style.transition = 'none';
  };
  const move = (e) => {
    if (startY === null) return;
    dy = Math.max(0, e.touches[0].clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  };
  const end = () => {
    if (startY === null) return;
    startY = null;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > 90) handle.close();
  };

  grip.forEach(el => {
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', end);
  });
}

function menuSheet(items) {
  const sheet = openSheet({
    size: 'small',
    body: `<div class="menu">${items.map((item, i) => `
      <button type="button" class="menu-item ${item.danger ? 'danger' : ''}" data-index="${i}">
        <i class="${item.icon}"></i><span>${esc(item.label)}</span>
      </button>`).join('')}</div>`,
  });
  sheet.el.querySelector('.menu').addEventListener('click', (e) => {
    const btn = e.target.closest('.menu-item');
    if (!btn) return;
    sheet.close();
    items[parseInt(btn.dataset.index, 10)].onSelect();
  });
}

function confirmSheet({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    let result = false;
    const sheet = openSheet({
      title,
      size: 'small',
      body: `<p class="sheet-message">${esc(message)}</p>`,
      footer: `
        <button type="button" class="btn btn-secondary" data-result="0">Cancel</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-result="1">${esc(confirmLabel)}</button>`,
      onClose: () => resolve(result),
    });
    sheet.el.querySelector('.sheet-footer').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-result]');
      if (!btn) return;
      result = btn.dataset.result === '1';
      sheet.close();
    });
  });
}

// ============================================
// UTILITIES
// ============================================
let toastTimer = null;
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type === 'error' ? 'error' : ''}`;
  void toast.offsetWidth; // restart transition
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), type === 'error' ? 4500 : 2600);
}

function rememberPosts(posts) {
  posts.forEach(p => state.posts.set(p.id, p));
  return posts;
}

function postText(post) {
  return post.message || post.video_title || '';
}

function thumbHtml(src, isVideo = false) {
  const url = safeUrl(src);
  return `
    <div class="list-thumb">
      ${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : `<i class="fas fa-${isVideo ? 'video' : 'align-left'}"></i>`}
      ${url && isVideo ? '<i class="fas fa-play play"></i>' : ''}
    </div>`;
}

function skeletonRows(n, thumb = true) {
  return Array.from({ length: n }, () => `
    <div class="skeleton-row">
      ${thumb ? '<div class="skeleton skeleton-thumb"></div>' : '<div class="skeleton" style="width:32px;height:32px;border-radius:50%"></div>'}
      <div class="skeleton-lines"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>
    </div>`).join('');
}

function errorHtml(err) {
  return `
    <div class="empty">
      <i class="fas fa-triangle-exclamation"></i>
      <p>Something went wrong</p>
      <small>${esc(err?.message || 'Please try again.')}</small>
    </div>`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
}

function initial(name) {
  const ch = String(name || '').trim().charAt(0);
  return ch || '?';
}

function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const diff = Date.now() - date;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d`;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

function formatNumber(value) {
  const num = Number(value) || 0;
  if (num >= 1e6) return (num / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(num));
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(1))} ${units[i]}`;
}

function truncate(str, length) {
  if (!str) return '';
  return str.length <= length ? str : str.slice(0, length).trimEnd() + '…';
}
