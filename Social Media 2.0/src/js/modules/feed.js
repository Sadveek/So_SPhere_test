import {
  getUserProfile,
  createPostRecord,
  createCommentRecord,
  deletePostRecord,
  listPostsPage,
  subscribeToComments,
  subscribeToFeed,
  toggleLikeRecord,
  updatePostRecord,
  votePollOptionRecord
} from "../services/firebase.js";
import {
  getState,
  replaceFeed,
  setPending,
  setState,
  upsertFeedPost,
  removeFeedPost
} from "../state/store.js";
import { toggleLikeSnapshot } from "../utils/likeMath.js";
import { AVATAR_OPTIONS } from "../utils/avatars.js";
import { formatRelativeTime } from "../utils/time.js";
import { MAX_POST_LENGTH, sanitizeText, validateCommentContent, validatePostContent } from "../utils/validators.js";
import { pushNotification, setButtonBusy, shouldNotify, showToast } from "./ui.js";
let editingPostId = null;
let openProfileCallback = () => {};
let unsubscribeRealtimeFeed = null;
let allFeedRefreshTimer = null;
let hasPrimedFeedNotificationSnapshot = false;
const knownFeedPostIds = new Set();
const FEED_SCOPE_KEY = "socialsphere.feed.scope.v1";
const FEED_COMPACT_KEY = "socialsphere.feed.compact.v1";
const POST_DRAFT_KEY = "socialsphere.feed.postDraft.v1";
const FEED_SCROLL_KEY = "socialsphere.feed.scrollY.v1";
const FEED_SEARCH_PANEL_KEY = "socialsphere.feed.searchPanel.v1";
const FEED_FILTER_PANEL_KEY = "socialsphere.feed.filterPanel.v1";
const FEED_TAG_KEY = "socialsphere.feed.tag.v1";
const savedFeedScope = localStorage.getItem(FEED_SCOPE_KEY);
let activeFeedScope = savedFeedScope === "following" || savedFeedScope === "everyone" ? savedFeedScope : "everyone";
const savedCompactFeed = localStorage.getItem(FEED_COMPACT_KEY);
let compactFeedEnabled = savedCompactFeed === null
  ? window.matchMedia("(max-width: 900px)").matches
  : savedCompactFeed === "true";
let feedSearchQuery = "";
let feedSortMode = "latest";
let feedTagFilter = sanitizeText(localStorage.getItem(FEED_TAG_KEY) || "all").toLowerCase() || "all";
let pendingIncomingCount = 0;
const openCommentPosts = new Set();
const expandedCommentPosts = new Set();
const commentSubscriptions = new Map();
const commentsByPost = new Map();
const profileAvatarCache = new Map();
const profilePrivacyCache = new Map();
function syncKnownFeedPostIds(posts) {
  knownFeedPostIds.clear();
  for (const post of posts) {
    knownFeedPostIds.add(post.id);
  }
}
function notifyIncomingFeedPosts(incoming, pluralText) {
  if (incoming.length <= 0) {
    return;
  }
  if ((window.scrollY || 0) > 260) {
    pendingIncomingCount += incoming.length;
    updateNewPostsPill(true, pendingIncomingCount);
  }
  const text = incoming.length === 1
    ? `${incoming[0].authorName || "Someone"} posted a new update.`
    : pluralText;
  if (shouldNotify("followers")) {
    showToast(text, "success");
  }
  pushNotification(text, "followers");
}
function defaultAvatar() {
  return AVATAR_OPTIONS[0] || "";
}
function getAvatarUrlByUserId(userId) {
  if (!userId) {
    return defaultAvatar();
  }
  return profileAvatarCache.get(userId) || defaultAvatar();
}
async function hydrateAvatarCache(posts = []) {
  const state = getState();
  if (state.profile?.uid) {
    profileAvatarCache.set(state.profile.uid, state.profile.avatarUrl || defaultAvatar());
  }
  const missingUserIds = new Set();
  for (const post of posts) {
    if (post?.authorId && !profileAvatarCache.has(post.authorId)) {
      missingUserIds.add(post.authorId);
    }
  }
  for (const comments of commentsByPost.values()) {
    for (const comment of comments || []) {
      if (comment?.authorId && !profileAvatarCache.has(comment.authorId)) {
        missingUserIds.add(comment.authorId);
      }
    }
  }
  if (!missingUserIds.size) {
    return;
  }
  let didChange = false;
  await Promise.all(
    [...missingUserIds].map(async (uid) => {
      try {
        const profile = await getUserProfile(uid);
        const avatarUrl = profile?.avatarUrl || defaultAvatar();
        if (profileAvatarCache.get(uid) !== avatarUrl) {
          didChange = true;
          profileAvatarCache.set(uid, avatarUrl);
        }
      } catch {
        if (!profileAvatarCache.has(uid)) {
          didChange = true;
          profileAvatarCache.set(uid, defaultAvatar());
        }
      }
    })
  );
  if (didChange) {
    renderFeed();
  }
}
async function filterEveryoneScopePosts(posts, currentUid) {
  const uniqueAuthorIds = [...new Set(posts.map((post) => post.authorId).filter(Boolean))];
  await Promise.all(
    uniqueAuthorIds.map(async (uid) => {
      if (profilePrivacyCache.has(uid)) {
        return;
      }
      try {
        const profile = await getUserProfile(uid);
        profilePrivacyCache.set(uid, profile.isPrivate !== false);
      } catch {
        profilePrivacyCache.set(uid, true);
      }
    })
  );
  return posts.filter((post) => {
    if (post.authorId === currentUid) {
      return true;
    }
    return profilePrivacyCache.get(post.authorId) === false;
  });
}
export const postService = {
  async createPost(content, postType, mediaUrl, pollOptions = []) {
    const state = getState();
    const session = state.session;
    const profile = state.profile;
    if (!session || !profile) {
      throw new Error("Please log in first.");
    }
    return createPostRecord({
      authorId: session.uid,
      authorName: profile.displayName,
      authorHandle: profile.handle,
      content,
      postType,
      mediaUrl,
      pollOptions
    });
  },
  async updatePost(postId, content) {
    const state = getState();
    if (!state.session) {
      throw new Error("Please log in first.");
    }
    return updatePostRecord(postId, content, state.session.uid);
  },
  async deletePost(postId) {
    const state = getState();
    if (!state.session) {
      throw new Error("Please log in first.");
    }
    return deletePostRecord(postId, state.session.uid);
  },
  async toggleLike(postId, userId) {
    return toggleLikeRecord(postId, userId);
  },
  async addComment(postId, content) {
    const state = getState();
    if (!state.session || !state.profile) {
      throw new Error("Please log in first.");
    }
    return createCommentRecord({
      postId,
      content,
      authorId: state.session.uid,
      authorName: state.profile.displayName,
      authorHandle: state.profile.handle
    });
  },
  async votePoll(postId, optionIndex) {
    const state = getState();
    if (!state.session) {
      throw new Error("Please log in first.");
    }
    return votePollOptionRecord(postId, state.session.uid, optionIndex);
  }
};
function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function updatePostCharCount() {
  const input = document.getElementById("post-input");
  const counter = document.getElementById("post-char-count");
  const progressBar = document.getElementById("post-progress-bar");
  if (!input || !counter) {
    return;
  }
  const max = Number(input.getAttribute("maxlength") || MAX_POST_LENGTH);
  const current = String(input.value || "").length;
  const ratio = Math.min(1, current / max);
  counter.textContent = `${current}/${max}`;
  if (progressBar) {
    progressBar.style.width = `${Math.round(ratio * 100)}%`;
    progressBar.classList.toggle("bg-red-500", ratio > 0.9);
    progressBar.classList.toggle("bg-amber-500", ratio > 0.7 && ratio <= 0.9);
    progressBar.classList.toggle("bg-brand", ratio <= 0.7);
  }
}
function updatePostMetaFieldsVisibility() {
  const input = document.getElementById("post-input");
  const typeSelect = document.getElementById("post-type-select");
  const mediaInput = document.getElementById("post-media-input");
  const pollFields = document.getElementById("post-poll-fields");
  const metaFields = document.getElementById("post-meta-fields");
  if (!input || !typeSelect || !mediaInput || !metaFields) {
    return;
  }
  const hasContent = sanitizeText(input.value || "").length > 0;
  metaFields.classList.toggle("hidden", !hasContent);
  if (!hasContent) {
    typeSelect.value = "none";
    mediaInput.value = "";
    setPollOptionInputs([]);
    pollFields?.classList.add("hidden");
    return;
  }
  pollFields?.classList.toggle("hidden", typeSelect.value !== "poll");
}
function savePostDraft() {
  const input = document.getElementById("post-input");
  const typeSelect = document.getElementById("post-type-select");
  const mediaInput = document.getElementById("post-media-input");
  const pollOptions = [...document.querySelectorAll("#post-poll-options [data-poll-option]")]
    .map((el) => el.value || "");
  if (!input || !typeSelect || !mediaInput) {
    return;
  }
  localStorage.setItem(
    POST_DRAFT_KEY,
    JSON.stringify({
      content: input.value || "",
      postType: typeSelect.value || "none",
      mediaUrl: mediaInput.value || "",
      pollOptions
    })
  );
}
function restorePostDraft() {
  const input = document.getElementById("post-input");
  const typeSelect = document.getElementById("post-type-select");
  const mediaInput = document.getElementById("post-media-input");
  const pollFields = document.getElementById("post-poll-fields");
  if (!input || !typeSelect || !mediaInput) {
    return;
  }
  try {
    const raw = localStorage.getItem(POST_DRAFT_KEY);
    if (!raw) {
      updatePostCharCount();
      updatePostMetaFieldsVisibility();
      return;
    }
    const draft = JSON.parse(raw);
    input.value = String(draft.content || "").slice(0, MAX_POST_LENGTH);
    typeSelect.value = String(draft.postType || "none");
    mediaInput.value = String(draft.mediaUrl || "").slice(0, 500);
    const pollOptions = Array.isArray(draft.pollOptions) ? draft.pollOptions : [];
    setPollOptionInputs(pollOptions);
    updatePostMetaFieldsVisibility();
    if (sanitizeText(input.value || "").length > 0) {
      pollFields?.classList.toggle("hidden", typeSelect.value !== "poll");
    }
  } catch {
    // Ignore malformed draft data.
  }
  updatePostCharCount();
  updatePostMetaFieldsVisibility();
}
function clearPostDraft() {
  localStorage.removeItem(POST_DRAFT_KEY);
}
function addPollOptionInput(value = "") {
  const host = document.getElementById("post-poll-options");
  if (!host) return;
  const index = host.querySelectorAll("[data-poll-option]").length;
  if (index >= 10) return;
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 40;
  input.autocomplete = "off";
  input.setAttribute("autocorrect", "off");
  input.setAttribute("autocapitalize", "off");
  input.spellcheck = false;
  input.className = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm";
  input.setAttribute("data-poll-option", String(index));
  input.placeholder = `Poll option ${index + 1}`;
  input.value = String(value || "").slice(0, 40);
  host.appendChild(input);
}
function setPollOptionInputs(options = []) {
  const host = document.getElementById("post-poll-options");
  if (!host) return;
  host.innerHTML = "";
  const normalized = Array.isArray(options) ? options.map((item) => String(item || "")).slice(0, 10) : [];
  const minimum = Math.max(2, normalized.length);
  for (let i = 0; i < minimum; i += 1) {
    addPollOptionInput(normalized[i] || "");
  }
}
function getPostTypeLabel(type) {
  const value = String(type || "none").toLowerCase();
  if (value === "none") return "";
  if (value === "update") return "Update";
  if (value === "resource") return "Resource";
  if (value === "poll") return "Poll";
  return "";
}
function getPostTypeClass(type) {
  const value = String(type || "none").toLowerCase();
  if (value === "none") return "";
  if (value === "update") return "post-type-badge post-type-badge--update";
  if (value === "resource") return "post-type-badge post-type-badge--resource";
  if (value === "poll") return "post-type-badge post-type-badge--poll";
  return "";
}
function pollPreviewHtml(post) {
  if (String(post.postType || "").toLowerCase() !== "poll") {
    return "";
  }
  const options = Array.isArray(post.pollOptions) ? post.pollOptions.filter(Boolean).slice(0, 10) : [];
  if (options.length < 2) {
    return "";
  }
  const rawCounts = Array.isArray(post.pollVoteCounts) ? post.pollVoteCounts : [];
  const counts = options.map((_, index) => Math.max(0, Number(rawCounts[index] || 0)));
  const totalFromCounts = counts.reduce((sum, item) => sum + item, 0);
  const totalVotes = Math.max(0, Number(post.pollVoteTotal || totalFromCounts));
  const selectedIndex = Number.isInteger(post.userPollVoteIndex) ? post.userPollVoteIndex : -1;
  return `
    <section class="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
      <div class="flex items-center justify-between gap-2">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Poll</p>
        <p class="text-[11px] text-slate-500">${totalVotes} vote${totalVotes === 1 ? "" : "s"}</p>
      </div>
      <div class="mt-2 space-y-1.5">
        ${options
          .map((option, index) => {
            const count = counts[index] || 0;
            const percentage = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
            const selectedClass = selectedIndex === index ? " poll-option-btn--selected" : "";
            return `
              <button
                type="button"
                class="poll-option-btn${selectedClass}"
                data-action="poll-vote"
                data-post-id="${post.id}"
                data-option-index="${index}"
                aria-label="Vote for ${escapeHtml(option)}"
              >
                <span class="poll-option-fill" style="width:${percentage}%"></span>
                <span class="poll-option-content">
                  <span class="poll-option-label">${escapeHtml(option)}</span>
                  <span class="poll-option-meta">${percentage}%</span>
                </span>
              </button>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}
function formatRichText(text) {
  const escaped = escapeHtml(text);
  const mentionDecorated = escaped.replace(/(^|\s)(@[a-zA-Z0-9_]{1,16})/g, "$1<span class=\"mention\">$2</span>");
  return mentionDecorated.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="post-link">$1</a>'
  );
}
function getFirstUrlFromText(text) {
  const match = String(text || "").match(/https?:\/\/\S+/i);
  return match ? match[0] : "";
}
function mediaPreviewHtml(post) {
  const explicitMedia = sanitizeText(post.mediaUrl || "");
  const media = explicitMedia || "";
  const imageCandidate = /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i.test(media);
  const imageHtml = media && imageCandidate
    ? `
      <figure class="mt-2 overflow-hidden rounded-lg border border-slate-200">
        <img src="${escapeHtml(media)}" alt="Post attachment" class="post-media-image w-full bg-slate-100 object-contain object-center" style="max-height:36rem;" />
      </figure>
    `
    : "";
  if (imageHtml) {
    return imageHtml;
  }
  return "";
}
function bindPostMediaFallbacks(scope = document) {
  const images = scope.querySelectorAll("img.post-media-image");
  for (const image of images) {
    if (image.dataset.fallbackBound === "true") {
      continue;
    }
    image.dataset.fallbackBound = "true";
    image.addEventListener("error", () => {
      const figure = image.closest("figure");
      figure?.remove();
    });
  }
}
function updateNewPostsPill(visible, count = 0) {
  const pill = document.getElementById("feed-new-posts-pill");
  if (!pill) return;
  if (!visible) {
    pill.classList.add("hidden");
    return;
  }
  pill.textContent = count > 1 ? `${count} new posts available. Jump to top` : "New post available. Jump to top";
  pill.classList.remove("hidden");
}
function unsubscribeComment(postId) {
  const unsub = commentSubscriptions.get(postId);
  if (unsub) {
    unsub();
    commentSubscriptions.delete(postId);
  }
}
function clearAllCommentSubscriptions() {
  for (const postId of commentSubscriptions.keys()) {
    unsubscribeComment(postId);
  }
  openCommentPosts.clear();
  expandedCommentPosts.clear();
  commentsByPost.clear();
}
function pruneCommentSubscriptions(visiblePostIds) {
  for (const postId of [...commentSubscriptions.keys()]) {
    if (!visiblePostIds.has(postId)) {
      unsubscribeComment(postId);
      openCommentPosts.delete(postId);
      expandedCommentPosts.delete(postId);
      commentsByPost.delete(postId);
    }
  }
}
function getProcessedFeedPosts(posts) {
  let next = [...posts];
  const query = feedSearchQuery.trim().toLowerCase();
  if (query) {
    next = next.filter((post) => {
      const haystack = `${post.content || ""} ${post.authorName || ""} ${post.authorHandle || ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }
  if (feedTagFilter !== "all") {
    next = next.filter((post) => extractTagsFromPost(post).includes(feedTagFilter));
  }
  if (feedSortMode === "popular") {
    next.sort((a, b) => {
      const likeDelta = Number(b.likeCount || 0) - Number(a.likeCount || 0);
      if (likeDelta !== 0) return likeDelta;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return next;
  }
  if (feedSortMode === "discussed") {
    next.sort((a, b) => {
      const commentDelta = Number(b.commentCount || 0) - Number(a.commentCount || 0);
      if (commentDelta !== 0) return commentDelta;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return next;
  }
  next.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return next;
}
function extractTagsFromPost(post) {
  const textTags = String(post?.content || "").toLowerCase().match(/#[a-z0-9_]{1,30}/g) || [];
  const systemTags = [];
  const postType = String(post?.postType || "none").toLowerCase();
  if (postType === "update" || postType === "resource" || postType === "poll") {
    systemTags.push(`type:${postType}`);
  }
  if (sanitizeText(post?.mediaUrl || "")) {
    systemTags.push("has:media");
  }
  if (getFirstUrlFromText(post?.content || "")) {
    systemTags.push("has:link");
  }
  return [...new Set([...textTags, ...systemTags])];
}
function applyFeedTagOptions(posts = []) {
  const tagSelect = document.getElementById("feed-tag-select");
  if (!tagSelect) {
    return;
  }
  const tags = [...new Set((posts || []).flatMap((post) => extractTagsFromPost(post)))].sort((a, b) => a.localeCompare(b));
  const normalizedCurrent = String(feedTagFilter || "all").toLowerCase();
  const nextTag = normalizedCurrent !== "all" && tags.includes(normalizedCurrent) ? normalizedCurrent : "all";
  tagSelect.innerHTML = `
    <option value="all">All Tags</option>
    ${tags
      .map((tag) => {
        if (tag.startsWith("type:")) {
          const typeLabel = tag.replace("type:", "");
          return `<option value="${escapeHtml(tag)}">${escapeHtml(`Type: ${typeLabel.charAt(0).toUpperCase()}${typeLabel.slice(1)}`)}</option>`;
        }
        if (tag === "has:media") {
          return `<option value="${escapeHtml(tag)}">Has Media</option>`;
        }
        if (tag === "has:link") {
          return `<option value="${escapeHtml(tag)}">Has Link</option>`;
        }
        return `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`;
      })
      .join("")}
  `;
  feedTagFilter = nextTag;
  localStorage.setItem(FEED_TAG_KEY, nextTag);
  tagSelect.value = nextTag;
}
function setFeedScope(scope) {
  const next = scope === "everyone" ? "everyone" : "following";
  if (activeFeedScope === next) {
    return;
  }
  activeFeedScope = next;
  localStorage.setItem(FEED_SCOPE_KEY, next);
  loadFeed();
  applyFeedToolbarState();
}
function setCompactFeed(enabled) {
  compactFeedEnabled = Boolean(enabled);
  localStorage.setItem(FEED_COMPACT_KEY, String(compactFeedEnabled));
  renderFeed();
  applyFeedToolbarState();
}
function applyFeedToolbarState() {
  const followingBtn = document.getElementById("feed-scope-following");
  const everyoneBtn = document.getElementById("feed-scope-everyone");
  const compactToggle = document.getElementById("feed-compact-toggle");
  if (followingBtn && everyoneBtn) {
    const followingActive = activeFeedScope === "following";
    followingBtn.className = `rounded-full px-3 py-1 text-xs font-semibold ${followingActive ? "bg-brand text-white" : "text-slate-700"}`;
    everyoneBtn.className = `rounded-full px-3 py-1 text-xs font-semibold ${!followingActive ? "bg-brand text-white" : "text-slate-700"}`;
  }
  if (compactToggle) {
    compactToggle.checked = compactFeedEnabled;
  }
}
function postActionsHtml(post, isOwner) {
  if (!isOwner) {
    return "";
  }
  return `
    <button class="post-btn" data-action="edit" data-post-id="${post.id}">Edit</button>
    <button class="post-btn" data-action="delete" data-post-id="${post.id}">Delete</button>
  `;
}
function postContentHtml(post) {
  if (editingPostId !== post.id) {
    return `
      <p class="post-content">${formatRichText(post.content)}</p>
      ${pollPreviewHtml(post)}
      ${mediaPreviewHtml(post)}
    `;
  }
  return `
    <textarea class="w-full rounded-lg border border-slate-300 p-2 text-sm" rows="4" data-edit-input="${post.id}">${escapeHtml(post.content)}</textarea>
    <div class="mt-2 flex gap-2">
      <button class="post-btn" data-action="save-edit" data-post-id="${post.id}">Save</button>
      <button class="post-btn" data-action="cancel-edit" data-post-id="${post.id}">Cancel</button>
    </div>
  `;
}
function commentPanelHtml(post) {
  if (!openCommentPosts.has(post.id)) {
    return "";
  }
  const comments = commentsByPost.get(post.id) || [];
  const expanded = expandedCommentPosts.has(post.id);
  const visibleComments = expanded ? comments : comments.slice(0, 2);
  return `
    <section class="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div class="mb-2 max-h-56 overflow-y-auto space-y-2" id="comment-list-${post.id}">
        ${
          visibleComments.length
            ? visibleComments
                .map(
                  (comment) => `
              <article class="rounded-md border border-slate-200 bg-white p-2">
                <div class="flex items-start gap-2">
                  <img
                    src="${escapeHtml(getAvatarUrlByUserId(comment.authorId))}"
                    alt="${escapeHtml(comment.authorName || "Member")} avatar"
                    class="mt-0.5 h-8 w-8 rounded-full border border-slate-200 bg-white object-cover object-center"
                  />
                  <div class="min-w-0">
                    <p class="text-xs font-semibold text-slate-700">${escapeHtml(comment.authorName)} <span class="font-normal text-slate-500">${escapeHtml(comment.authorHandle)}</span></p>
                    <p class="mt-1 whitespace-pre-wrap text-sm text-slate-700">${formatRichText(comment.content)}</p>
                    <p class="mt-1 text-[11px] text-slate-500">${formatRelativeTime(comment.createdAt)}</p>
                  </div>
                </div>
              </article>
            `
                )
                .join("")
            : "<p class='text-xs text-slate-500'>No comments yet.</p>"
        }
      </div>
      ${
        comments.length > 2
          ? `<div class="mb-2">
              <button class="post-btn" data-action="${expanded ? "comment-collapse" : "comment-expand"}" data-post-id="${post.id}">
                ${expanded ? "Show less comments" : `View all comments (${comments.length})`}
              </button>
            </div>`
          : ""
      }
      <div class="flex gap-2">
        <input
          type="text"
          maxlength="220"
          class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          placeholder="Write a comment"
          data-comment-input="${post.id}"
        />
        <button class="post-btn" data-action="comment-submit" data-post-id="${post.id}">Send</button>
      </div>
    </section>
  `;
}
function postCardHtml(post, currentUserId) {
  const isOwner = post.authorId === currentUserId;
  const likeButtonClass = post.isLiked ? "post-btn post-btn--liked" : "post-btn";
  const commentCount = Number(post.commentCount || 0);
  const badgeClass = getPostTypeClass(post.postType);
  const badgeLabel = getPostTypeLabel(post.postType);
  const badgeHtml = badgeLabel ? `<span class="${badgeClass}">${badgeLabel}</span>` : "";
  return `
    <article class="post-card ${isOwner ? "post-card--own" : ""}" data-post-id="${post.id}">
      <header class="post-meta">
        <div class="flex items-start gap-3">
          <img
            src="${escapeHtml(getAvatarUrlByUserId(post.authorId))}"
            alt="${escapeHtml(post.authorName || "Member")} avatar"
            class="h-10 w-10 rounded-full border border-slate-200 bg-white object-cover object-center"
          />
          <div>
            <div class="flex items-center gap-2">
              <button class="post-author hover:underline" data-action="open-profile" data-user-id="${post.authorId}">${escapeHtml(post.authorName)}</button>
              ${badgeHtml}
            </div>
            <p class="post-handle">${escapeHtml(post.authorHandle)} · ${formatRelativeTime(post.createdAt)}</p>
          </div>
        </div>
      </header>
      ${postContentHtml(post)}
      <footer class="post-actions">
        <button class="${likeButtonClass}" data-action="toggle-like" data-post-id="${post.id}">&#10084; ${post.likeCount}</button>
        <button class="post-btn" data-action="comment-toggle" data-post-id="${post.id}">&#128172; ${commentCount}</button>
        ${postActionsHtml(post, isOwner)}
      </footer>
      ${commentPanelHtml(post)}
    </article>
  `;
}
export function renderFeed() {
  const state = getState();
  const list = document.getElementById("feed-list");
  const loadMoreBtn = document.getElementById("feed-load-more");
  applyFeedTagOptions(state.feed);
  const processedFeed = getProcessedFeedPosts(state.feed);
  const visiblePostIds = new Set(processedFeed.map((post) => post.id));
  pruneCommentSubscriptions(visiblePostIds);
  list.classList.toggle("feed-list--compact", compactFeedEnabled);
  if (state.pending.feed && !state.feed.length) {
    list.innerHTML = `
      <div class="feed-skeleton-card"></div>
      <div class="feed-skeleton-card"></div>
      <div class="feed-skeleton-card"></div>
    `;
  } else if (!processedFeed.length) {
    list.innerHTML = `
      <div class="glass-card p-5 text-sm text-slate-600">
        <p>${feedSearchQuery ? "No posts match your search. Try different keywords." : "No posts yet in this view. Start with one of these prompts."}</p>
        ${
          feedSearchQuery
            ? ""
            : `<div class="mt-3 flex flex-wrap gap-2">
                <button class="post-btn" data-action="fill-prompt" data-prompt="What are you building today and where are you stuck?">Ask For Help</button>
                <button class="post-btn" data-action="fill-prompt" data-prompt="Quick progress update: today I shipped...">Share Progress</button>
                <button class="post-btn" data-action="fill-prompt" data-prompt="Bug fix journal: issue, root cause, and fix in 3 lines.">Share Bug Fix</button>
              </div>`
        }
      </div>
    `;
  } else {
    list.innerHTML = processedFeed.map((post) => postCardHtml(post, state.session?.uid)).join("");
  }
  bindPostMediaFallbacks(list);
  loadMoreBtn.classList.add("hidden");
  void hydrateAvatarCache(state.feed);
}
async function handleCreatePost() {
  const input = document.getElementById("post-input");
  const typeSelect = document.getElementById("post-type-select");
  const mediaInput = document.getElementById("post-media-input");
  const pollFields = document.getElementById("post-poll-fields");
  const createButton = document.getElementById("create-post-btn");
  const validation = validatePostContent(input.value);
  if (!validation.ok) {
    showToast(validation.error, "error");
    return;
  }
  setButtonBusy(createButton, "Publishing...", true);
  try {
    const type = String(typeSelect?.value || "none");
    const mediaUrl = String(mediaInput?.value || "").trim();
    const pollOptions = type === "poll"
      ? [...document.querySelectorAll("#post-poll-options [data-poll-option]")]
          .map((el) => String(el.value || "").trim())
          .filter(Boolean)
      : [];
    if (type === "poll" && pollOptions.length < 2) {
      showToast("Poll requires at least 2 options.", "error");
      return;
    }
    const ownPostCountBefore = getState().feed.filter((item) => item.authorId === getState().session?.uid).length;
    const post = await postService.createPost(validation.value, type, mediaUrl, pollOptions);
    upsertFeedPost({
      ...post,
      createdAt: post.createdAt || new Date().toISOString(),
      isLiked: false
    });
    input.value = "";
    if (typeSelect) {
      typeSelect.value = "none";
    }
    if (mediaInput) {
      mediaInput.value = "";
    }
    setPollOptionInputs([]);
    pollFields?.classList.add("hidden");
    clearPostDraft();
    updatePostCharCount();
    updatePostMetaFieldsVisibility();
    showToast("Post published.", "success");
    if (ownPostCountBefore === 0) {
      showToast("Milestone unlocked: first post.", "success");
    }
    renderFeed();
  } catch (error) {
    showToast(error.message || "Could not publish post.", "error");
  } finally {
    setButtonBusy(createButton, "", false);
  }
}
function patchPostInStore(postId, patch) {
  const state = getState();
  const nextFeed = state.feed.map((post) => (post.id === postId ? { ...post, ...patch } : post));
  setState({ feed: nextFeed });
}
async function handleLike(postId) {
  const state = getState();
  if (!state.session) {
    showToast("Please log in first.", "error");
    return;
  }
  const target = state.feed.find((post) => post.id === postId);
  if (!target) {
    return;
  }
  const optimistic = toggleLikeSnapshot({ likes: target.likeCount, isLiked: target.isLiked });
  patchPostInStore(postId, { likeCount: optimistic.likes, isLiked: optimistic.isLiked });
  try {
    const response = await postService.toggleLike(postId, state.session.uid);
    patchPostInStore(postId, { likeCount: response.likeCount, isLiked: response.liked });
  } catch (error) {
    patchPostInStore(postId, { likeCount: target.likeCount, isLiked: target.isLiked });
    showToast(error.message || "Like update failed.", "error");
  }
  renderFeed();
}
async function handleDelete(postId) {
  try {
    await postService.deletePost(postId);
    removeFeedPost(postId);
    unsubscribeComment(postId);
    openCommentPosts.delete(postId);
    expandedCommentPosts.delete(postId);
    commentsByPost.delete(postId);
    showToast("Post deleted.", "success");
    renderFeed();
  } catch (error) {
    showToast(error.message || "Delete failed.", "error");
  }
}
async function handleSaveEdit(postId) {
  const input = document.querySelector(`[data-edit-input="${postId}"]`);
  const validation = validatePostContent(input?.value || "");
  if (!validation.ok) {
    showToast(validation.error, "error");
    return;
  }
  try {
    const updated = await postService.updatePost(postId, validation.value);
    editingPostId = null;
    upsertFeedPost({
      ...updated,
      isLiked: getState().feed.find((item) => item.id === postId)?.isLiked || false
    });
    showToast("Post updated.", "success");
  } catch (error) {
    showToast(error.message || "Update failed.", "error");
  }
  renderFeed();
}
function openComments(postId) {
  if (commentSubscriptions.has(postId)) {
    return;
  }
  const unsubscribe = subscribeToComments(postId, (comments) => {
    commentsByPost.set(postId, comments);
    renderFeed();
  });
  commentSubscriptions.set(postId, unsubscribe);
}
function toggleComments(postId) {
  if (openCommentPosts.has(postId)) {
    openCommentPosts.delete(postId);
    expandedCommentPosts.delete(postId);
    unsubscribeComment(postId);
    commentsByPost.delete(postId);
  } else {
    openCommentPosts.add(postId);
    openComments(postId);
  }
  renderFeed();
}
async function handleCommentSubmit(postId) {
  const input = document.querySelector(`[data-comment-input="${postId}"]`);
  const validation = validateCommentContent(input?.value || "");
  if (!validation.ok) {
    showToast(validation.error, "error");
    return;
  }
  try {
    await postService.addComment(postId, validation.value);
    input.value = "";
    showToast("Comment added.", "success");
  } catch (error) {
    showToast(error.message || "Could not add comment.", "error");
  }
}
async function handlePollVote(postId, optionIndex) {
  const state = getState();
  if (!state.session) {
    showToast("Please log in first.", "error");
    return;
  }
  try {
    const result = await postService.votePoll(postId, optionIndex);
    patchPostInStore(postId, {
      pollVoteCounts: Array.isArray(result.pollVoteCounts) ? result.pollVoteCounts : [],
      pollVoteTotal: Math.max(0, Number(result.pollVoteTotal || 0)),
      userPollVoteIndex: Number.isInteger(result.userPollVoteIndex) ? result.userPollVoteIndex : -1
    });
    renderFeed();
  } catch (error) {
    showToast(error.message || "Poll vote failed.", "error");
  }
}
async function handleFeedListClick(event) {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) {
    return;
  }
  const action = actionTarget.dataset.action;
  const postId = actionTarget.dataset.postId;
  const userId = actionTarget.dataset.userId;
  if (action === "fill-prompt") {
    const input = document.getElementById("post-input");
    input.value = String(actionTarget.dataset.prompt || "");
    input.focus();
    savePostDraft();
    updatePostCharCount();
    return;
  }
  if (action === "toggle-like") {
    await handleLike(postId);
    return;
  }
  if (action === "comment-toggle") {
    toggleComments(postId);
    return;
  }
  if (action === "comment-submit") {
    await handleCommentSubmit(postId);
    return;
  }
  if (action === "poll-vote") {
    const optionIndex = Number(actionTarget.dataset.optionIndex);
    await handlePollVote(postId, optionIndex);
    return;
  }
  if (action === "comment-expand") {
    expandedCommentPosts.add(postId);
    renderFeed();
    return;
  }
  if (action === "comment-collapse") {
    expandedCommentPosts.delete(postId);
    renderFeed();
    return;
  }
  if (action === "delete") {
    await handleDelete(postId);
    return;
  }
  if (action === "edit") {
    editingPostId = postId;
    renderFeed();
    return;
  }
  if (action === "cancel-edit") {
    editingPostId = null;
    renderFeed();
    return;
  }
  if (action === "save-edit") {
    await handleSaveEdit(postId);
    return;
  }
  if (action === "open-profile") {
    openProfileCallback(userId);
  }
}
export function stopFeedRealtime() {
  if (unsubscribeRealtimeFeed) {
    unsubscribeRealtimeFeed();
    unsubscribeRealtimeFeed = null;
  }
  if (allFeedRefreshTimer) {
    clearInterval(allFeedRefreshTimer);
    allFeedRefreshTimer = null;
  }
  hasPrimedFeedNotificationSnapshot = false;
  knownFeedPostIds.clear();
  pendingIncomingCount = 0;
  updateNewPostsPill(false);
  clearAllCommentSubscriptions();
}
async function loadEveryoneFeedOnce(emitNotification = false) {
  const state = getState();
  if (!state.session) return;
  try {
    profilePrivacyCache.clear();
    const result = await listPostsPage(80, null, state.session.uid);
    const basePosts = result.posts || [];
    const posts = await filterEveryoneScopePosts(basePosts, state.session.uid);
    if (emitNotification && hasPrimedFeedNotificationSnapshot) {
      const incoming = posts.filter((post) => !knownFeedPostIds.has(post.id) && post.authorId !== state.session.uid);
      notifyIncomingFeedPosts(incoming, `${incoming.length} new posts in Everyone feed.`);
    }
    syncKnownFeedPostIds(posts);
    hasPrimedFeedNotificationSnapshot = true;
    replaceFeed(posts, null, false);
  } finally {
    setPending("feed", false);
    renderFeed();
  }
}
export async function loadFeed() {
  const state = getState();
  if (!state.session) {
    return;
  }
  stopFeedRealtime();
  setPending("feed", true);
  renderFeed();
  if (activeFeedScope === "everyone") {
    await loadEveryoneFeedOnce(false);
    allFeedRefreshTimer = setInterval(() => {
      loadEveryoneFeedOnce(true);
    }, 20000);
    return;
  }
  unsubscribeRealtimeFeed = subscribeToFeed(state.session.uid, (posts) => {
    if (hasPrimedFeedNotificationSnapshot) {
      const incoming = posts.filter((post) => !knownFeedPostIds.has(post.id) && post.authorId !== state.session.uid);
      notifyIncomingFeedPosts(incoming, `${incoming.length} new posts from people you follow.`);
    }
    syncKnownFeedPostIds(posts);
    hasPrimedFeedNotificationSnapshot = true;
    setPending("feed", false);
    replaceFeed(posts, null, false);
    renderFeed();
  }, 40);
}
export function initFeedModule({ onOpenProfile }) {
  openProfileCallback = onOpenProfile;
  const createButton = document.getElementById("create-post-btn");
  const list = document.getElementById("feed-list");
  const newPostsPill = document.getElementById("feed-new-posts-pill");
  const searchInput = document.getElementById("feed-search-input");
  const sortSelect = document.getElementById("feed-sort-select");
  const tagSelect = document.getElementById("feed-tag-select");
  const searchToggleButton = document.getElementById("feed-search-toggle");
  const filterToggleButton = document.getElementById("feed-filter-toggle");
  const searchPanel = document.getElementById("feed-search-panel");
  const filterPanel = document.getElementById("feed-filter-panel");
  const scopeFollowingButton = document.getElementById("feed-scope-following");
  const scopeEveryoneButton = document.getElementById("feed-scope-everyone");
  const compactToggle = document.getElementById("feed-compact-toggle");
  const postInput = document.getElementById("post-input");
  const postTypeSelect = document.getElementById("post-type-select");
  const postMediaInput = document.getElementById("post-media-input");
  const pollFields = document.getElementById("post-poll-fields");
  const pollOptionsHost = document.getElementById("post-poll-options");
  const pollAddButton = document.getElementById("post-poll-add-btn");
  createButton.addEventListener("click", handleCreatePost);
  postInput?.addEventListener("input", () => {
    updatePostCharCount();
    updatePostMetaFieldsVisibility();
    savePostDraft();
  });
  postTypeSelect?.addEventListener("change", savePostDraft);
  postTypeSelect?.addEventListener("change", () => {
    updatePostMetaFieldsVisibility();
  });
  postMediaInput?.addEventListener("input", savePostDraft);
  pollOptionsHost?.addEventListener("input", savePostDraft);
  pollAddButton?.addEventListener("click", () => {
    addPollOptionInput("");
    savePostDraft();
  });
  list.addEventListener("click", (event) => {
    handleFeedListClick(event);
  });
  newPostsPill?.addEventListener("click", () => {
    updateNewPostsPill(false);
    pendingIncomingCount = 0;
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  let searchPanelOpen = localStorage.getItem(FEED_SEARCH_PANEL_KEY) === "true";
  let filterPanelOpen = localStorage.getItem(FEED_FILTER_PANEL_KEY) === "true";
  const applyFeedFilterPanelState = () => {
    searchPanel?.classList.toggle("hidden", !searchPanelOpen);
    filterPanel?.classList.toggle("hidden", !filterPanelOpen);
    searchToggleButton?.classList.toggle("feed-tool-icon--active", searchPanelOpen);
    filterToggleButton?.classList.toggle("feed-tool-icon--active", filterPanelOpen);
  };
  searchToggleButton?.addEventListener("click", () => {
    searchPanelOpen = !searchPanelOpen;
    localStorage.setItem(FEED_SEARCH_PANEL_KEY, String(searchPanelOpen));
    applyFeedFilterPanelState();
    if (searchPanelOpen) {
      searchInput?.focus();
    }
  });
  filterToggleButton?.addEventListener("click", () => {
    filterPanelOpen = !filterPanelOpen;
    localStorage.setItem(FEED_FILTER_PANEL_KEY, String(filterPanelOpen));
    applyFeedFilterPanelState();
  });
  searchInput?.addEventListener("input", () => {
    feedSearchQuery = searchInput.value || "";
    renderFeed();
  });
  sortSelect?.addEventListener("change", () => {
    feedSortMode = sortSelect.value || "latest";
    renderFeed();
  });
  tagSelect?.addEventListener("change", () => {
    feedTagFilter = String(tagSelect.value || "all").toLowerCase();
    localStorage.setItem(FEED_TAG_KEY, feedTagFilter);
    renderFeed();
  });
  scopeFollowingButton?.addEventListener("click", () => setFeedScope("following"));
  scopeEveryoneButton?.addEventListener("click", () => setFeedScope("everyone"));
  compactToggle?.addEventListener("change", () => setCompactFeed(compactToggle.checked));
  if (sortSelect) {
    sortSelect.value = feedSortMode;
  }
  if (tagSelect) {
    tagSelect.value = feedTagFilter;
  }
  if ((searchInput?.value || "").trim()) {
    searchPanelOpen = true;
  }
  if ((sortSelect?.value || "latest") !== "latest" || (tagSelect?.value || "all") !== "all") {
    filterPanelOpen = true;
  }
  applyFeedFilterPanelState();
  applyFeedToolbarState();
  setPollOptionInputs([]);
  restorePostDraft();
  updatePostMetaFieldsVisibility();
  window.addEventListener("scroll", () => {
    sessionStorage.setItem(FEED_SCROLL_KEY, String(window.scrollY || 0));
    if ((window.scrollY || 0) < 220) {
      updateNewPostsPill(false);
      pendingIncomingCount = 0;
    }
  });
  const savedY = Number(sessionStorage.getItem(FEED_SCROLL_KEY) || 0);
  if (savedY > 0) {
    window.requestAnimationFrame(() => window.scrollTo({ top: savedY, behavior: "auto" }));
  }
}
