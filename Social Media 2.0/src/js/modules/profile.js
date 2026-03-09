import {
  acceptFollowRequest,
  doesUserFollowTarget,
  getFollowCounts,
  getRelationshipMap,
  getUserProfile,
  listFollowingProfiles,
  listIncomingFollowRequests,
  listPostsByAuthor,
  listSuggestedUsers,
  rejectFollowRequest,
  subscribeFollowsByFollower,
  sendFollowRequest,
  unfollowUser,
  updateUserProfile
} from "../services/firebase.js";
import {
  getState,
  setProfile,
  setProfilePosts,
  setActiveView,
  setSuggestedUsers,
  setViewingProfile
} from "../state/store.js";
import { formatRelativeTime } from "../utils/time.js";
import { AVATAR_OPTIONS } from "../utils/avatars.js";
import { validateProfilePatch } from "../utils/validators.js";
import { pushNotification, shouldNotify, showToast, setButtonBusy, showLoadingToast } from "./ui.js";
let relationshipMap = {};
let incomingRequests = [];
let activeFollowingUsers = [];
let searchKeyword = "";
let userFilterMode = "everyone";
let isEditingOwnProfile = false;
const dismissedSuggestedUserIds = new Set();
let unsubscribeAcceptedFollowNotifications = () => {};
let hasPrimedAcceptedFollowSnapshot = false;
const knownAcceptedFollowIds = new Set();
let selectedProfileAvatar = "";
const profilePostsCache = new Map();
const followsCurrentUserByUid = new Map();
let networkDataLastFetchedAt = 0;
const NETWORK_REFRESH_INTERVAL_MS = 15000;
const MAX_ACTIVE_FOLLOWING_VISIBLE = 6;
const MAX_USERS_FOLLOW_REQUESTS = 200;
const DISMISSED_SUGGESTED_USERS_KEY_PREFIX = "socialsphere.suggested.dismissed.v1";
export const profileService = {
  getProfile: (uid) => getUserProfile(uid),
  updateProfile: (uid, patch) => updateUserProfile(uid, patch)
};
function relationTemplate() {
  return {
    isSelf: false,
    isFollowing: false,
    outgoingPending: false,
    incomingPending: false
  };
}
function relationFor(uid) { return relationshipMap[uid] || relationTemplate(); }
function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function dismissedSuggestedUsersStorageKey(uid) {
  return `${DISMISSED_SUGGESTED_USERS_KEY_PREFIX}.${uid || "guest"}`;
}
function loadDismissedSuggestedUsers(uid) {
  dismissedSuggestedUserIds.clear();
  if (!uid) {
    return;
  }
  try {
    const raw = localStorage.getItem(dismissedSuggestedUsersStorageKey(uid));
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return;
    }
    for (const item of parsed) {
      const userId = String(item || "").trim();
      if (userId) {
        dismissedSuggestedUserIds.add(userId);
      }
    }
  } catch {
    // Ignore malformed local storage values.
  }
}
function saveDismissedSuggestedUsers(uid) {
  if (!uid) {
    return;
  }
  localStorage.setItem(
    dismissedSuggestedUsersStorageKey(uid),
    JSON.stringify([...dismissedSuggestedUserIds])
  );
}
function renderRelationshipButtons(userId) {
  const relation = relationFor(userId);
  if (relation.incomingPending) {
    return `
      <div class="flex gap-1">
        <button class="user-chip" data-action="relation-action" data-rel-action="accept" data-user-id="${userId}">Accept</button>
        <button class="user-chip" data-action="relation-action" data-rel-action="reject" data-user-id="${userId}">Reject</button>
      </div>
    `;
  }
  if (relation.isFollowing) {
    return `<button class="user-chip" data-action="relation-action" data-rel-action="unfollow" data-user-id="${userId}">Unfollow</button>`;
  }
  if (relation.outgoingPending) {
    return `<button class="user-chip" data-action="relation-action" data-rel-action="cancel" data-user-id="${userId}">Requested</button>`;
  }
  return `
    <div class="flex items-center gap-1">
      <button class="user-chip" data-action="relation-action" data-rel-action="request" data-user-id="${userId}">Request</button>
      <button
        class="rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-[11px] font-bold leading-none text-red-600 hover:bg-red-100"
        data-action="relation-action"
        data-rel-action="dismiss"
        data-user-id="${userId}"
        aria-label="Remove user"
        title="Remove user">X</button>
    </div>
  `;
}
function renderSuggestedUsers() {
  const container = document.getElementById("suggested-users");
  const sideContainer = document.getElementById("profile-suggested-users-side");
  if (!container && !sideContainer) {
    return;
  }
  const { suggestedUsers } = getState();
  const eligible = suggestedUsers.filter((user) => {
    if (relationFor(user.uid).isFollowing) {
      return false;
    }
    if (dismissedSuggestedUserIds.has(user.uid)) {
      return false;
    }
    return true;
  });
  const sortByPriority = (a, b) => {
    const aPending = relationFor(a.uid).outgoingPending ? 1 : 0;
    const bPending = relationFor(b.uid).outgoingPending ? 1 : 0;
    if (aPending !== bPending) {
      return bPending - aPending;
    }
    return String(a.displayName || "").localeCompare(String(b.displayName || ""));
  };
  const sortedEligible = [...eligible].sort(sortByPriority);
  const filtered = sortedEligible;
  const sideList = sortedEligible.slice(0, 8);
  const renderInto = (target, list, emptyText) => {
    if (!target) {
      return;
    }
    if (!list.length) {
      target.innerHTML = `<p class='text-xs text-slate-500'>${emptyText}</p>`;
      return;
    }
    target.innerHTML = list
      .map(
        (user) => `
          <div class="user-row">
            <div class="flex min-w-0 items-center gap-2">
              <img
                src="${escapeHtml(user.avatarUrl || AVATAR_OPTIONS[0] || "")}"
                alt="${escapeHtml(user.displayName || "Member")} avatar"
                class="h-10 w-10 rounded-full border border-slate-200 bg-white object-cover object-center" />
              <div class="min-w-0">
                <p class="truncate text-sm font-semibold text-slate-800">${escapeHtml(user.displayName)}</p>
                <p class="truncate text-xs text-slate-500">${escapeHtml(user.handle || "@member")}</p>
              </div>
            </div>
            <div class="flex items-center gap-1">
              <button class="user-chip" data-action="open-profile" data-user-id="${user.uid}">View</button>
              ${renderRelationshipButtons(user.uid)}
            </div>
          </div>
        `
      )
      .join("");
  };
  renderInto(container, filtered, "No suggested users right now.");
  renderInto(sideContainer, sideList, "No suggestions yet.");
}
function updateUserFilterButtons() {
  const filters = [
    { id: "user-filter-everyone", mode: "everyone" },
    { id: "user-filter-followers", mode: "followers" },
    { id: "user-filter-following", mode: "following" },
    { id: "user-filter-requests", mode: "requests" }
  ];
  for (const item of filters) {
    const button = document.getElementById(item.id);
    if (!button) {
      continue;
    }
    const active = userFilterMode === item.mode;
    button.classList.toggle("border-brand/40", active);
    button.classList.toggle("bg-teal-50", active);
    button.classList.toggle("text-brand", active);
    button.classList.toggle("border-slate-300", !active);
    button.classList.toggle("bg-white", !active);
    button.classList.toggle("text-slate-700", !active);
  }
}
function getUsersDirectorySource() {
  const state = getState();
  const currentUid = state.session?.uid || "";
  const byUid = new Map();
  for (const user of state.suggestedUsers || []) {
    if (user?.uid && user.uid !== currentUid) {
      byUid.set(user.uid, user);
    }
  }
  for (const user of activeFollowingUsers) {
    if (user?.uid && user.uid !== currentUid && !byUid.has(user.uid)) {
      byUid.set(user.uid, user);
    }
  }
  for (const item of incomingRequests) {
    const user = item?.profile;
    if (user?.uid && user.uid !== currentUid && !byUid.has(user.uid)) {
      byUid.set(user.uid, user);
    }
  }
  return [...byUid.values()];
}
async function refreshFollowerFlags(users) {
  const currentUid = getState().session?.uid || "";
  if (!currentUid) {
    followsCurrentUserByUid.clear();
    return;
  }
  const checks = users
    .filter((user) => user?.uid && user.uid !== currentUid && !followsCurrentUserByUid.has(user.uid))
    .map(async (user) => {
      try {
        const doesFollow = await doesUserFollowTarget(user.uid, currentUid);
        followsCurrentUserByUid.set(user.uid, Boolean(doesFollow));
      } catch {
        followsCurrentUserByUid.set(user.uid, false);
      }
    });
  await Promise.all(checks);
}
function renderUsersDirectory() {
  const container = document.getElementById("users-search-results");
  if (!container) {
    return;
  }
  const source = getUsersDirectorySource();
  const incomingRequestUidSet = new Set(incomingRequests.map((item) => item?.fromUid).filter(Boolean));
  const filtered = source
    .filter((user) => {
      if (!user?.uid) {
        return false;
      }
      if (userFilterMode === "following" && !relationFor(user.uid).isFollowing) {
        return false;
      }
      if (userFilterMode === "followers" && !followsCurrentUserByUid.get(user.uid)) {
        return false;
      }
      if (userFilterMode === "requests" && !incomingRequestUidSet.has(user.uid)) {
        return false;
      }
      if (!searchKeyword) {
        return true;
      }
      const haystack = `${user.displayName || ""} ${user.handle || ""}`.toLowerCase();
      return haystack.includes(searchKeyword);
    })
    .sort((a, b) => String(a.displayName || "").localeCompare(String(b.displayName || "")));
  if (!filtered.length) {
    container.className = "mt-3";
    container.innerHTML = "<p class='text-xs text-slate-500'>No users found for this filter.</p>";
    return;
  }
  container.className = "mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3";
  container.innerHTML = filtered
    .map(
      (user) => `
        <article class="rounded-xl border border-slate-200 bg-white/80 p-3 shadow-sm">
          <div class="flex min-w-0 items-start gap-3">
            <img
              src="${escapeHtml(user.avatarUrl || AVATAR_OPTIONS[0] || "")}"
              alt="${escapeHtml(user.displayName || "Member")} avatar"
              class="h-16 w-16 rounded-full border border-slate-200 bg-white object-cover object-center" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-xl font-semibold text-slate-800">${escapeHtml(user.displayName || "Member")}</p>
              <p class="truncate text-sm text-slate-500">${escapeHtml(user.handle || "@member")}</p>
              <p class="mt-1 text-sm text-slate-500">${user.isPrivate === false ? "Public account" : "Private account"}</p>
            </div>
          </div>
          <div class="mt-3 grid grid-cols-2 gap-2">
            <button class="user-chip w-full justify-center" data-action="message-user" data-user-id="${user.uid}">Message</button>
            <button class="user-chip w-full justify-center" data-action="relation-action" data-rel-action="${
              relationFor(user.uid).incomingPending
                ? "accept"
                : relationFor(user.uid).isFollowing
                  ? "unfollow"
                  : relationFor(user.uid).outgoingPending
                    ? "cancel"
                    : "request"
            }" data-user-id="${user.uid}">${
              relationFor(user.uid).incomingPending
                ? "Accept"
                : relationFor(user.uid).isFollowing
                  ? "Unfollow"
                  : relationFor(user.uid).outgoingPending
                    ? "Requested"
                    : "Follow"
            }</button>
          </div>
        </article>
      `
    )
    .join("");
}
function renderIncomingRequests() {
  const container = document.getElementById("incoming-requests");
  const feedContainer = document.getElementById("sidebar-incoming-requests");
  if (!container && !feedContainer) {
    return;
  }
  const html = incomingRequests.length
    ? incomingRequests
        .map(
          (item) => `
            <article class="rounded-lg border border-slate-200 bg-white p-2">
              <p class="text-sm font-semibold text-slate-800">${escapeHtml(item.profile.displayName)}</p>
              <p class="text-xs text-slate-500">${escapeHtml(item.profile.handle || "@member")}</p>
              <div class="mt-2 flex gap-2">
                <button class="user-chip" data-action="incoming-accept" data-user-id="${item.fromUid}">Accept</button>
                <button class="user-chip" data-action="incoming-reject" data-user-id="${item.fromUid}">Reject</button>
              </div>
            </article>
          `
        )
        .join("")
    : "<p class='text-xs text-slate-500'>No incoming requests.</p>";
  if (container) {
    container.innerHTML = html;
  }
  if (feedContainer) {
    feedContainer.innerHTML = html;
  }
}
function renderActiveFollowing() {
  const container = document.getElementById("active-following-users");
  const sidebarContainer = document.getElementById("sidebar-active-following");
  if (!container && !sidebarContainer) {
    return;
  }
  const visibleFollowingUsers = activeFollowingUsers.slice(0, MAX_ACTIVE_FOLLOWING_VISIBLE);
  const remainingCount = Math.max(0, activeFollowingUsers.length - visibleFollowingUsers.length);
  const html = visibleFollowingUsers.length
    ? `${visibleFollowingUsers
        .map(
          (user) => `
            <article class="rounded-lg border border-slate-200 bg-white p-2">
              <div class="flex items-center justify-between gap-2">
                <div class="flex min-w-0 items-center gap-2">
                  <img
                    src="${escapeHtml(user.avatarUrl || AVATAR_OPTIONS[0] || "")}"
                    alt="${escapeHtml(user.displayName || "Member")} avatar"
                    class="h-9 w-9 rounded-full border border-slate-200 bg-white object-cover object-center" />
                  <div class="min-w-0">
                    <p class="truncate text-sm font-semibold text-slate-800">${escapeHtml(user.displayName || "Member")}</p>
                    <p class="truncate text-xs text-slate-500">${escapeHtml(user.handle || "@member")}</p>
                  </div>
                </div>
                <button class="user-chip" data-action="open-profile" data-user-id="${user.uid}">View</button>
              </div>
            </article>
          `
        )
        .join("")}
      ${remainingCount > 0 ? `<p class='text-xs text-slate-500'>+${remainingCount} more following</p>` : ""}`
    : "<p class='text-xs text-slate-500'>No active following yet.</p>";
  if (container) {
    container.innerHTML = html;
  }
  if (sidebarContainer) {
    sidebarContainer.innerHTML = html;
  }
}
function renderProfilePosts() {
  const { profilePosts } = getState();
  const container = document.getElementById("profile-posts");
  const postCountEl = document.getElementById("profile-post-count");
  if (postCountEl) {
    postCountEl.textContent = String(profilePosts.length);
  }
  if (!profilePosts.length) {
    container.innerHTML = "<p class='text-xs text-slate-500'>No posts from this profile yet.</p>";
    return;
  }
  container.innerHTML = profilePosts
    .map(
      (post) => `
        <article class="rounded-lg border border-slate-200 bg-white p-3">
          <p class="text-xs text-slate-500">${formatRelativeTime(post.createdAt)}</p>
          <p class="mt-1 whitespace-pre-wrap text-sm text-slate-700">${escapeHtml(post.content)}</p>
          <p class="mt-2 text-xs text-slate-500">♥ ${post.likeCount} · 💬 ${post.commentCount || 0}</p>
        </article>
      `
    )
    .join("");
}
function fillProfileForm(profile, isOwnProfile) {
  document.getElementById("profile-display-name").value = profile.displayName || "";
  document.getElementById("profile-handle").value = profile.handle || "";
  selectedProfileAvatar = profile.avatarUrl || AVATAR_OPTIONS[0] || "";
  document.getElementById("profile-avatar").value = selectedProfileAvatar;
  document.getElementById("profile-bio").value = profile.bio || "";
  document.getElementById("profile-private-toggle").checked = profile.isPrivate !== false;
  document.getElementById("profile-display-name").disabled = !isOwnProfile;
  document.getElementById("profile-handle").disabled = true;
  document.getElementById("profile-bio").disabled = !isOwnProfile;
  document.getElementById("profile-private-toggle").disabled = !isOwnProfile;
  renderProfileAvatarPicker(selectedProfileAvatar, isOwnProfile);
  const saveButton = document.getElementById("profile-save-btn");
  saveButton.classList.toggle("hidden", !isOwnProfile);
}
function renderProfileAvatarPicker(selectedAvatar, isOwnProfile) {
  const picker = document.getElementById("profile-avatar-picker");
  const preview = document.getElementById("profile-avatar-preview");
  if (!picker || !preview) {
    return;
  }
  const active = selectedAvatar || AVATAR_OPTIONS[0] || "";
  const customSelected = Boolean(active) && !AVATAR_OPTIONS.includes(active);
  preview.src = active;
  preview.onerror = () => {
    preview.src = AVATAR_OPTIONS[0] || "";
  };
  const defaultTiles = AVATAR_OPTIONS
    .map((avatar) => {
      const selected = avatar === active;
      return `
        <button
          type="button"
          ${isOwnProfile ? "" : "disabled"}
          class="rounded-lg border p-1 ${selected ? "border-brand ring-2 ring-brand/40" : "border-slate-300"} ${isOwnProfile ? "" : "opacity-60"}"
          data-action="pick-profile-avatar"
          data-avatar="${avatar}">
          <img src="${avatar}" alt="Avatar option" class="h-10 w-10 rounded-full object-cover object-center" />
        </button>
      `;
    });
  const customTile = `
    <button
      type="button"
      ${isOwnProfile ? "" : "disabled"}
      class="flex h-12 w-12 items-center justify-center rounded-lg border text-slate-700 ${
        customSelected ? "border-brand ring-2 ring-brand/40" : "border-slate-300"
      } ${isOwnProfile ? "hover:bg-slate-100" : "opacity-60"}"
      data-action="pick-custom-profile-avatar"
      aria-label="Set avatar from image URL"
      title="Set avatar from image URL">
      <span class="text-lg font-bold leading-none">+</span>
    </button>
  `;
  picker.innerHTML = [...defaultTiles, customTile].join("");
}
function isLikelyImageUrl(value) {
  return /^https?:\/\/\S+\.(gif|png|jpe?g|webp|avif|svg)(\?.*)?(#.*)?$/i.test(String(value || ""));
}
function promptCustomAvatarUrl(initialValue) {
  const seededValue = /^https?:\/\//i.test(String(initialValue || "")) ? initialValue : "";
  const raw = window.prompt("Paste image/GIF URL for profile picture", seededValue);
  if (raw === null) {
    return null;
  }
  const url = String(raw || "").trim();
  if (!url) {
    showToast("Image URL cannot be empty.", "error");
    return undefined;
  }
  if (!/^https?:\/\//i.test(url)) {
    showToast("Use a valid http(s) image URL.", "error");
    return undefined;
  }
  if (!isLikelyImageUrl(url)) {
    showToast("URL must point directly to an image or GIF file.", "error");
    return undefined;
  }
  return url;
}
function fillProfileReadOnly(profile) {
  const avatar = profile.avatarUrl || AVATAR_OPTIONS[0] || "";
  const displayNameEl = document.getElementById("profile-view-display-name");
  const handleEl = document.getElementById("profile-view-handle");
  const compactName = String(profile.displayName || "").trim().length > 12;
  document.getElementById("profile-view-avatar").src = avatar;
  displayNameEl.textContent = profile.displayName || "Not set";
  handleEl.textContent = profile.handle || "@member";
  displayNameEl.classList.toggle("text-3xl", !compactName);
  displayNameEl.classList.toggle("text-2xl", compactName);
  handleEl.classList.toggle("text-base", !compactName);
  handleEl.classList.toggle("text-sm", compactName);
  document.getElementById("profile-view-privacy").textContent =
    profile.isPrivate === false ? "Public account" : "Private account";
  document.getElementById("profile-view-bio").textContent =
    profile.bio || "No bio yet.";
}
function applyProfileEditMode(isOwnProfile) {
  const editButton = document.getElementById("profile-edit-toggle");
  const readOnlySection = document.getElementById("profile-readonly");
  const form = document.getElementById("profile-form");
  const postsSection = document.getElementById("profile-posts-section");
  if (!isOwnProfile) {
    isEditingOwnProfile = false;
    editButton.classList.add("hidden");
    readOnlySection.classList.remove("hidden");
    form.classList.add("hidden");
    postsSection?.classList.remove("hidden");
    return;
  }
  editButton.classList.remove("hidden");
  editButton.textContent = isEditingOwnProfile ? "Cancel Edit" : "Edit Profile";
  readOnlySection.classList.toggle("hidden", isEditingOwnProfile);
  form.classList.toggle("hidden", !isEditingOwnProfile);
  postsSection?.classList.toggle("hidden", isEditingOwnProfile);
}
function applyProfileFollowAction(viewed, isOwnProfile) {
  const peerActions = document.getElementById("profile-peer-actions");
  const actionButton = document.getElementById("profile-follow-action");
  const messageButton = document.getElementById("profile-message-action");
  if (isOwnProfile) {
    peerActions?.classList.add("hidden");
    messageButton.dataset.userId = "";
    actionButton.dataset.userId = "";
    actionButton.dataset.relAction = "";
    actionButton.textContent = "";
    return;
  }
  const relation = relationFor(viewed.uid);
  peerActions?.classList.remove("hidden");
  messageButton.dataset.userId = viewed.uid;
  actionButton.dataset.userId = viewed.uid;
  if (relation.incomingPending) {
    actionButton.dataset.relAction = "accept";
    actionButton.textContent = "Accept Request";
    return;
  }
  if (relation.isFollowing) {
    actionButton.dataset.relAction = "unfollow";
    actionButton.textContent = "Unfollow";
    return;
  }
  if (relation.outgoingPending) {
    actionButton.dataset.relAction = "cancel";
    actionButton.textContent = "Cancel Request";
    return;
  }
  actionButton.dataset.relAction = "request";
  actionButton.textContent = "Follow";
}
async function refreshFollowCounts(uid) {
  if (!uid) {
    return;
  }
  const followersEl = document.getElementById("profile-followers-count");
  const followingEl = document.getElementById("profile-following-count");
  followersEl.textContent = "...";
  followingEl.textContent = "...";
  try {
    const counts = await getFollowCounts(uid);
    followersEl.textContent = String(counts.followers);
    followingEl.textContent = String(counts.following);
  } catch {
    followersEl.textContent = "0";
    followingEl.textContent = "0";
  }
}
function renderProfileView() {
  const state = getState();
  const session = state.session;
  const ownProfile = state.profile;
  const viewed = state.viewingProfile || ownProfile;
  if (!session || !viewed) {
    return;
  }
  const isOwnProfile = viewed.uid === session.uid;
  document.getElementById("profile-title").textContent = isOwnProfile
    ? "My Profile"
    : `${viewed.displayName || "Member"} Profile`;
  document.getElementById("profile-reset-view").classList.toggle("hidden", isOwnProfile);
  if (!isOwnProfile) {
    isEditingOwnProfile = false;
  }
  fillProfileForm(viewed, isOwnProfile);
  fillProfileReadOnly(viewed);
  applyProfileEditMode(isOwnProfile);
  applyProfileFollowAction(viewed, isOwnProfile);
  renderProfilePosts();
  refreshFollowCounts(viewed.uid);
}
function switchToProfileView() {
  const feedButton = document.getElementById("nav-feed");
  const messagesButton = document.getElementById("nav-messages");
  const usersButton = document.getElementById("nav-users");
  const profileButton = document.getElementById("nav-profile");
  const settingsButton = document.getElementById("nav-settings");
  const feedView = document.getElementById("feed-view");
  const messagesView = document.getElementById("messages-view");
  const usersView = document.getElementById("users-view");
  const profileView = document.getElementById("profile-view");
  const settingsView = document.getElementById("settings-view");
  const sidebar = document.getElementById("app-sidebar");
  const appLayout = document.getElementById("app-layout");
  setActiveView("profile");
  feedButton?.classList.remove("nav-btn--active");
  messagesButton?.classList.remove("nav-btn--active");
  usersButton?.classList.remove("nav-btn--active");
  profileButton?.classList.add("nav-btn--active");
  settingsButton?.classList.remove("nav-btn--active");
  feedView?.classList.add("hidden");
  messagesView?.classList.add("hidden");
  usersView?.classList.add("hidden");
  profileView?.classList.remove("hidden");
  settingsView?.classList.add("hidden");
  sidebar?.classList.add("hidden");
  appLayout?.classList.add("layout-single");
  window.scrollTo({ top: 0, behavior: "auto" });
}
function applyProfilePostsIfStillViewing(uid, posts) {
  const viewedUid = getState().viewingProfile?.uid || getState().profile?.uid;
  if (viewedUid !== uid) {
    return;
  }
  setProfilePosts(posts);
  renderProfilePosts();
}
async function refreshProfilePosts(uid, force = false) {
  const state = getState();
  if (!force && profilePostsCache.has(uid)) {
    applyProfilePostsIfStillViewing(uid, profilePostsCache.get(uid));
    return;
  }
  const posts = await listPostsByAuthor(uid, 12, state.session?.uid);
  profilePostsCache.set(uid, posts);
  applyProfilePostsIfStillViewing(uid, posts);
}
async function refreshNetworkData(force = false) {
  const state = getState();
  if (!state.session) {
    return;
  }
  const now = Date.now();
  if (!force && now - networkDataLastFetchedAt < NETWORK_REFRESH_INTERVAL_MS) {
    renderSuggestedUsers();
    updateUserFilterButtons();
    renderUsersDirectory();
    renderIncomingRequests();
    renderProfileView();
    return;
  }
  networkDataLastFetchedAt = now;
  let users = [];
  try {
    users = await listSuggestedUsers(state.session.uid, 25);
    setSuggestedUsers(users);
  } catch {
    users = [];
    setSuggestedUsers([]);
  }
  const ids = users.map((item) => item.uid);
  const viewedUid = state.viewingProfile?.uid;
  if (viewedUid && viewedUid !== state.session.uid && !ids.includes(viewedUid)) {
    ids.push(viewedUid);
  }
  try {
    relationshipMap = await getRelationshipMap(state.session.uid, ids);
  } catch {
    relationshipMap = {};
  }
  try {
    incomingRequests = await listIncomingFollowRequests(state.session.uid, MAX_USERS_FOLLOW_REQUESTS);
  } catch {
    incomingRequests = [];
  }
  try {
    activeFollowingUsers = await listFollowingProfiles(state.session.uid, 24);
  } catch {
    activeFollowingUsers = [];
  }
  await refreshFollowerFlags(getUsersDirectorySource());
  renderSuggestedUsers();
  updateUserFilterButtons();
  renderUsersDirectory();
  renderActiveFollowing();
  renderIncomingRequests();
  renderProfileView();
}
async function openProfile(uid) {
  const stopLoading = showLoadingToast("Loading");
  try {
    const loadedProfile = await profileService.getProfile(uid);
    setViewingProfile(loadedProfile);
    renderProfileView();
  } catch (error) {
    stopLoading();
    showToast(error.message || "Could not open profile.", "error");
    return;
  }
  Promise.allSettled([refreshProfilePosts(uid), refreshNetworkData()])
    .then((results) => {
      const failed = results.some((item) => item.status === "rejected");
      if (failed) {
        showToast("Profile opened with limited network data.", "error");
      }
    })
    .finally(() => {
      stopLoading();
    });
}
async function runRelationAction(targetUid, action) {
  const state = getState();
  const sessionUid = state.session?.uid;
  if (!sessionUid) {
    showToast("Please log in first.", "error");
    return;
  }
  try {
    if (action === "dismiss") {
      dismissedSuggestedUserIds.add(targetUid);
      saveDismissedSuggestedUsers(sessionUid);
      renderSuggestedUsers();
      return;
    } else if (action === "request") {
      const response = await sendFollowRequest(sessionUid, targetUid);
      showToast(response?.status === "accepted" ? "Now following user." : "Follow request sent.", "success");
    } else if (action === "unfollow") {
      await unfollowUser(sessionUid, targetUid);
      showToast("Unfollowed user.", "success");
    } else if (action === "cancel") {
      await unfollowUser(sessionUid, targetUid);
      showToast("Follow request cancelled.", "success");
    } else if (action === "accept") {
      await acceptFollowRequest(sessionUid, targetUid);
      showToast("Follow request accepted.", "success");
    } else if (action === "reject") {
      await rejectFollowRequest(sessionUid, targetUid);
      showToast("Follow request rejected.", "success");
    }
    await refreshNetworkData(true);
  } catch (error) {
    showToast(error.message || "Could not update follow relation.", "error");
  }
}
async function handleProfileSave(event) {
  event.preventDefault();
  const state = getState();
  const viewed = state.viewingProfile || state.profile;
  if (!state.session || !viewed || viewed.uid !== state.session.uid) {
    showToast("Only your own profile can be edited.", "error");
    return;
  }
  const patch = {
    displayName: document.getElementById("profile-display-name").value,
    handle: viewed.handle,
    avatarUrl: selectedProfileAvatar || viewed.avatarUrl || AVATAR_OPTIONS[0] || "",
    bio: document.getElementById("profile-bio").value,
    isPrivate: document.getElementById("profile-private-toggle").checked
  };
  const validation = validateProfilePatch(patch);
  if (!validation.ok) {
    showToast(validation.error, "error");
    return;
  }
  const saveButton = document.getElementById("profile-save-btn");
  try {
    setButtonBusy(saveButton, "Saving...", true);
    const updated = await profileService.updateProfile(state.session.uid, validation.value);
    setProfile(updated);
    setViewingProfile(updated);
    isEditingOwnProfile = false;
    document.getElementById("current-user-chip").textContent = updated.handle;
    const headerAvatar = document.getElementById("current-user-avatar");
    if (headerAvatar) {
      headerAvatar.src = updated.avatarUrl || AVATAR_OPTIONS[0] || "";
    }
    showToast("Profile updated.", "success");
    await refreshProfilePosts(state.session.uid, true);
    await refreshNetworkData(true);
    switchToProfileView();
  } catch (error) {
    showToast(error.message || "Could not save profile.", "error");
  } finally {
    setButtonBusy(saveButton, "", false);
  }
}
function bindProfileEvents() {
  const profileForm = document.getElementById("profile-form");
  const resetButton = document.getElementById("profile-reset-view");
  const suggestedContainer = document.getElementById("suggested-users");
  const sideSuggestedContainer = document.getElementById("profile-suggested-users-side");
  const usersSearchResults = document.getElementById("users-search-results");
  const activeFollowingContainer = document.getElementById("active-following-users");
  const sidebarActiveFollowingContainer = document.getElementById("sidebar-active-following");
  const incomingContainer = document.getElementById("incoming-requests");
  const feedIncomingContainer = document.getElementById("sidebar-incoming-requests");
  const searchInput = document.getElementById("user-search-input");
  const filterEveryoneButton = document.getElementById("user-filter-everyone");
  const filterFollowersButton = document.getElementById("user-filter-followers");
  const filterFollowingButton = document.getElementById("user-filter-following");
  const filterRequestsButton = document.getElementById("user-filter-requests");
  const profileActionButton = document.getElementById("profile-follow-action");
  const profileMessageButton = document.getElementById("profile-message-action");
  const profileEditToggle = document.getElementById("profile-edit-toggle");
  const avatarPicker = document.getElementById("profile-avatar-picker");
  profileForm.addEventListener("submit", handleProfileSave);
  resetButton.addEventListener("click", () => {
    const state = getState();
    if (!state.profile) {
      return;
    }
    setViewingProfile(state.profile);
    isEditingOwnProfile = false;
    renderProfileView();
    Promise.allSettled([refreshProfilePosts(state.profile.uid), refreshNetworkData()]);
  });
  profileEditToggle.addEventListener("click", () => {
    const state = getState();
    const viewed = state.viewingProfile || state.profile;
    if (!state.session || !viewed || viewed.uid !== state.session.uid) {
      return;
    }
    isEditingOwnProfile = !isEditingOwnProfile;
    renderProfileView();
  });
  const handleSuggestedClick = async (event) => {
    const actionEl = event.target.closest("[data-action]");
    if (!actionEl) {
      return;
    }
    const action = actionEl.dataset.action;
    const userId = actionEl.dataset.userId;
    if (action === "open-profile") {
      switchToProfileView();
      await openProfile(userId);
      return;
    }
    if (action === "message-user") {
      window.dispatchEvent(
        new CustomEvent("open-message-user", {
          detail: { uid: userId }
        })
      );
      return;
    }
    if (action === "relation-action") {
      await runRelationAction(userId, actionEl.dataset.relAction);
    }
  };
  suggestedContainer?.addEventListener("click", handleSuggestedClick);
  sideSuggestedContainer?.addEventListener("click", handleSuggestedClick);
  usersSearchResults?.addEventListener("click", handleSuggestedClick);
  activeFollowingContainer?.addEventListener("click", handleSuggestedClick);
  sidebarActiveFollowingContainer?.addEventListener("click", handleSuggestedClick);
  const handleIncomingClick = async (event) => {
    const actionEl = event.target.closest("[data-action]");
    if (!actionEl) {
      return;
    }
    const action = actionEl.dataset.action;
    const userId = actionEl.dataset.userId;
    if (action === "incoming-accept") {
      await runRelationAction(userId, "accept");
      return;
    }
    if (action === "incoming-reject") {
      await runRelationAction(userId, "reject");
    }
  };
  incomingContainer?.addEventListener("click", handleIncomingClick);
  feedIncomingContainer?.addEventListener("click", handleIncomingClick);
  searchInput?.addEventListener("input", () => {
    searchKeyword = searchInput.value.trim().toLowerCase();
    renderUsersDirectory();
  });
  filterEveryoneButton?.addEventListener("click", () => {
    userFilterMode = "everyone";
    updateUserFilterButtons();
    renderUsersDirectory();
  });
  filterFollowersButton?.addEventListener("click", () => {
    userFilterMode = "followers";
    updateUserFilterButtons();
    renderUsersDirectory();
  });
  filterFollowingButton?.addEventListener("click", () => {
    userFilterMode = "following";
    updateUserFilterButtons();
    renderUsersDirectory();
  });
  filterRequestsButton?.addEventListener("click", () => {
    userFilterMode = "requests";
    updateUserFilterButtons();
    renderUsersDirectory();
  });
  profileActionButton.addEventListener("click", async () => {
    const userId = profileActionButton.dataset.userId;
    const action = profileActionButton.dataset.relAction;
    if (!userId || !action) {
      return;
    }
    await runRelationAction(userId, action);
  });
  profileMessageButton.addEventListener("click", () => {
    const userId = profileMessageButton.dataset.userId;
    if (!userId) {
      return;
    }
    window.dispatchEvent(
      new CustomEvent("open-message-user", {
        detail: { uid: userId }
      })
    );
  });
  avatarPicker.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action='pick-profile-avatar']");
    if (button) {
      const avatar = String(button.dataset.avatar || "");
      selectedProfileAvatar = avatar;
      document.getElementById("profile-avatar").value = avatar;
      renderProfileAvatarPicker(avatar, true);
      return;
    }
    const customButton = event.target.closest("[data-action='pick-custom-profile-avatar']");
    if (customButton) {
      const customUrl = promptCustomAvatarUrl(selectedProfileAvatar);
      if (!customUrl) {
        return;
      }
      selectedProfileAvatar = customUrl;
      document.getElementById("profile-avatar").value = customUrl;
      renderProfileAvatarPicker(customUrl, true);
    }
  });
}
export async function initializeProfileForSession() {
  const state = getState();
  if (!state.profile || !state.session) {
    return;
  }
  loadDismissedSuggestedUsers(state.session.uid);
  setViewingProfile(state.profile);
  await refreshProfilePosts(state.profile.uid, true);
  await refreshNetworkData(true);
  renderProfileView();
  unsubscribeAcceptedFollowNotifications();
  unsubscribeAcceptedFollowNotifications = subscribeFollowsByFollower(state.session.uid, async (follows) => {
    let shouldRefreshNetwork = false;
    if (hasPrimedAcceptedFollowSnapshot) {
      const newItems = follows.filter((item) => !knownAcceptedFollowIds.has(item.id));
      shouldRefreshNetwork = newItems.length > 0;
      for (const item of newItems) {
        if (!item.followingUid || item.followingUid === state.session.uid) {
          continue;
        }
        try {
          const profile = await getUserProfile(item.followingUid);
          const text = `${profile.displayName} accepted your follow request.`;
          if (shouldNotify("followers")) {
            showToast(text, "success");
          }
          pushNotification(text, "followers");
        } catch {
          const text = "A follow request was accepted.";
          if (shouldNotify("followers")) {
            showToast(text, "success");
          }
          pushNotification(text, "followers");
        }
      }
    }
    knownAcceptedFollowIds.clear();
    for (const item of follows) {
      knownAcceptedFollowIds.add(item.id);
    }
    hasPrimedAcceptedFollowSnapshot = true;
    if (shouldRefreshNetwork) {
      await refreshNetworkData(true);
    }
  });
}
export function initProfileModule() {
  bindProfileEvents();
  updateUserFilterButtons();
  renderUsersDirectory();
  renderSuggestedUsers();
  renderActiveFollowing();
  renderIncomingRequests();
  renderProfileView();
  return {
    openProfile,
    renderProfileView,
    loadSuggestions: refreshNetworkData,
    initializeProfileForSession,
    cleanupProfileModule: () => {
      unsubscribeAcceptedFollowNotifications();
      unsubscribeAcceptedFollowNotifications = () => {};
      hasPrimedAcceptedFollowSnapshot = false;
      knownAcceptedFollowIds.clear();
      profilePostsCache.clear();
      networkDataLastFetchedAt = 0;
      searchKeyword = "";
      userFilterMode = "everyone";
      dismissedSuggestedUserIds.clear();
      followsCurrentUserByUid.clear();
    }
  };
}
