import {
  doesUserFollowTarget,
  getUserProfile,
  listMutualFollowProfiles,
  markConversationSeen,
  sendDirectMessage,
  setConversationHidden,
  setConversationRequestAccepted,
  subscribeConversationsForUser,
  subscribeConversationStates,
  subscribeMessagesForConversation,
  subscribeUserConversationStates
} from "../services/firebase.js";
import { getState } from "../state/store.js";
import { AVATAR_OPTIONS } from "../utils/avatars.js";
import { formatRelativeTime } from "../utils/time.js";
import { sanitizeText } from "../utils/validators.js";
import { pushNotification, setButtonBusy, shouldNotify, showToast } from "./ui.js";
let currentTab = "inbox";
let activeConversationId = "";
let activeConversationKey = "";
let activeOtherUid = "";
let activeConversationIsRequest = false;
let draftTargetUid = "";
let conversations = [];
let ownStatesByConversation = new Map();
let activeConversationStates = [];
let activeMessages = [];
let unsubscribeConversations = () => {};
let unsubscribeOwnStates = () => {};
let unsubscribeMessages = () => {};
let unsubscribeActiveConversationStates = () => {};
const profileCache = new Map();
const followsCurrentUserCache = new Map();
const classificationCache = new Map();
let hasPrimedConversationNotificationSnapshot = false;
const lastConversationMessageAtMap = new Map();
let mutualFollowProfiles = [];
let mutualFollowFetchedAt = 0;
const MUTUAL_REFRESH_INTERVAL_MS = 20000;
function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function defaultAvatar() { return AVATAR_OPTIONS[0] || ""; }
function getAvatarForUid(uid) {
  const state = getState();
  if (uid && state.profile?.uid === uid) {
    return state.profile.avatarUrl || defaultAvatar();
  }
  return profileCache.get(uid)?.avatarUrl || defaultAvatar();
}
function toMillis(value) {
  if (!value) return 0;
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}
function getCurrentUserId() { return getState().session?.uid || ""; }
function conversationIdFor(uidA, uidB) {
  const [left, right] = [uidA, uidB].sort();
  return `${left}__${right}`;
}
function getOtherUid(conversation, currentUid) { return (conversation.participantIds || []).find((uid) => uid !== currentUid) || ""; }
function getOwnState(conversationId) {
  return ownStatesByConversation.get(conversationId) || {
    hidden: false,
    accepted: false,
    lastSeenAt: null
  };
}
function isUnread(conversation, currentUid) {
  const ownState = getOwnState(conversation.id);
  if (conversation.lastMessageSenderId === currentUid) {
    return false;
  }
  const lastSeen = toMillis(ownState.lastSeenAt);
  const lastMessageAt = toMillis(conversation.lastMessageAt);
  return lastMessageAt > lastSeen;
}
function updateGlobalUnreadDot() {
  const currentUid = getCurrentUserId();
  const dot = document.getElementById("nav-messages-dot");
  if (!currentUid || !dot) return;
  const hasUnread = conversations.some((conversation) => {
    const ownState = getOwnState(conversation.id);
    if (ownState.hidden) {
      return false;
    }
    return isUnread(conversation, currentUid);
  });
  dot.classList.toggle("hidden", !hasUnread);
}
async function ensureProfile(uid) {
  if (!uid) return null;
  if (profileCache.has(uid)) {
    return profileCache.get(uid);
  }
  const profile = await getUserProfile(uid);
  profileCache.set(uid, profile);
  return profile;
}
async function doesOtherFollowMe(otherUid, currentUid) {
  const key = `${otherUid}_${currentUid}`;
  if (followsCurrentUserCache.has(key)) {
    return followsCurrentUserCache.get(key);
  }
  const follows = await doesUserFollowTarget(otherUid, currentUid);
  followsCurrentUserCache.set(key, follows);
  return follows;
}
async function classifyConversation(conversation, currentUid) {
  const ownState = getOwnState(conversation.id);
  const otherUid = getOtherUid(conversation, currentUid);
  const cacheKey = `${conversation.id}_${conversation.lastMessageSenderId}_${toMillis(conversation.lastMessageAt)}`;
  if (classificationCache.has(cacheKey)) {
    return classificationCache.get(cacheKey);
  }
  const otherFollowsMe = await doesOtherFollowMe(otherUid, currentUid);
  const iSentLast = conversation.lastMessageSenderId === currentUid;
  const isRequest = !otherFollowsMe && !ownState.accepted && !iSentLast;
  classificationCache.set(cacheKey, isRequest);
  return isRequest;
}
async function refreshMutualFollowProfiles(force = false) {
  const uid = getCurrentUserId();
  if (!uid) {
    mutualFollowProfiles = [];
    mutualFollowFetchedAt = 0;
    return;
  }
  const now = Date.now();
  if (!force && now - mutualFollowFetchedAt < MUTUAL_REFRESH_INTERVAL_MS) {
    return;
  }
  mutualFollowFetchedAt = now;
  try {
    mutualFollowProfiles = await listMutualFollowProfiles(uid, 50);
  } catch {
    mutualFollowProfiles = [];
  }
}
async function computeVisibleConversations() {
  const currentUid = getCurrentUserId();
  const visible = [];
  const existingByOtherUid = new Set();
  for (const conversation of conversations) {
    const ownState = getOwnState(conversation.id);
    if (ownState.hidden) {
      continue;
    }
    const otherUid = getOtherUid(conversation, currentUid);
    const profile = await ensureProfile(otherUid);
    const isRequest = await classifyConversation(conversation, currentUid);
    visible.push({
      ...conversation,
      listKey: `conversation:${conversation.id}`,
      otherUid,
      profile,
      hasConversation: true,
      isRequest,
      unread: isUnread(conversation, currentUid)
    });
    existingByOtherUid.add(otherUid);
  }
  for (const profile of mutualFollowProfiles) {
    const otherUid = profile?.uid || "";
    if (!otherUid || otherUid === currentUid || existingByOtherUid.has(otherUid)) {
      continue;
    }
    visible.push({
      id: conversationIdFor(currentUid, otherUid),
      listKey: `mutual:${otherUid}`,
      participantIds: [currentUid, otherUid].sort(),
      createdAt: null,
      updatedAt: null,
      lastMessageText: "",
      lastMessageAt: 0,
      lastMessageSenderId: "",
      otherUid,
      profile,
      hasConversation: false,
      isRequest: false,
      unread: false
    });
  }
  return visible.sort((a, b) => toMillis(b.lastMessageAt) - toMillis(a.lastMessageAt));
}
function renderThreadStatus() {
  const statusEl = document.getElementById("messages-chat-status");
  const currentUid = getCurrentUserId();
  if (!statusEl || !currentUid || !activeMessages.length) {
    statusEl.textContent = "";
    return;
  }
  const last = activeMessages[activeMessages.length - 1];
  if (last.senderId !== currentUid) {
    statusEl.textContent = "Received";
    return;
  }
  const recipientState = activeConversationStates.find((item) => item.userId === activeOtherUid);
  const seenAt = toMillis(recipientState?.lastSeenAt);
  const sentAt = toMillis(last.createdAt);
  statusEl.textContent = seenAt >= sentAt ? "Seen" : "Sent";
}
function renderActiveThread() {
  const empty = document.getElementById("messages-chat-empty");
  const content = document.getElementById("messages-chat-content");
  const title = document.getElementById("messages-chat-title");
  const handle = document.getElementById("messages-chat-handle");
  const avatar = document.getElementById("messages-chat-avatar");
  const requestActions = document.getElementById("messages-request-actions");
  const input = document.getElementById("messages-input");
  const thread = document.getElementById("messages-chat-thread");
  const currentUid = getCurrentUserId();
  if (!activeOtherUid) {
    empty.classList.remove("hidden");
    content.classList.add("hidden");
    requestActions.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  content.classList.remove("hidden");
  const profile = profileCache.get(activeOtherUid);
  title.textContent = profile ? profile.displayName : "Conversation";
  handle.textContent = profile?.handle || "";
  if (avatar) {
    avatar.src = getAvatarForUid(activeOtherUid);
    avatar.alt = `${profile?.displayName || "Member"} avatar`;
  }
  const canShowRequestActions = Boolean(activeConversationId && activeConversationIsRequest);
  requestActions.classList.toggle("hidden", !canShowRequestActions);
  input.disabled = false;
  if (!activeMessages.length) {
    thread.innerHTML = "<p class='text-xs text-slate-500'>No messages yet.</p>";
    thread.scrollTop = thread.scrollHeight;
    renderThreadStatus();
    return;
  }
  const groupedMessages = [];
  for (const message of activeMessages) {
    const prev = groupedMessages[groupedMessages.length - 1];
    if (prev && prev.senderId === message.senderId) {
      prev.items.push(message);
    } else {
      groupedMessages.push({
        senderId: message.senderId,
        items: [message]
      });
    }
  }
  thread.innerHTML = groupedMessages
    .map((group) => {
      const mine = group.senderId === currentUid;
      const senderAvatar = getAvatarForUid(group.senderId);
      const lastMessage = group.items[group.items.length - 1];
      const bubblesHtml = group.items
        .map((message) => `
          <div class="w-fit max-w-full rounded-2xl ${mine ? "bg-teal-600 text-white" : "border border-slate-200 bg-slate-100 text-slate-800"} px-3.5 py-2.5 text-sm shadow-sm">
            <p class="whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed">${escapeHtml(message.text)}</p>
          </div>
        `)
        .join("");
      return `
        <div class="space-y-1.5">
          <div class="flex ${mine ? "justify-end" : "justify-start"} items-end gap-2">
            ${mine ? "" : `<img src="${escapeHtml(senderAvatar)}" alt="Sender avatar" class="h-8 w-8 shrink-0 rounded-full border border-slate-200 bg-white object-cover object-center" />`}
            <div class="flex min-w-0 max-w-[72%] flex-col gap-1.5 ${mine ? "items-end" : "items-start"}">
              ${bubblesHtml}
            </div>
            ${mine ? `<img src="${escapeHtml(senderAvatar)}" alt="Your avatar" class="h-8 w-8 shrink-0 rounded-full border border-slate-200 bg-white object-cover object-center" />` : ""}
          </div>
          <p class="px-1 text-[11px] text-slate-500 ${mine ? "text-right" : "text-left"}">${formatRelativeTime(lastMessage.createdAt)}</p>
        </div>
      `;
    })
    .join("");
  thread.scrollTop = thread.scrollHeight;
  renderThreadStatus();
}
async function openConversation(item) {
  unsubscribeMessages();
  unsubscribeActiveConversationStates();
  activeConversationId = item.id || "";
  activeConversationKey = item.listKey || item.id || "";
  activeOtherUid = item.otherUid || draftTargetUid || "";
  activeConversationIsRequest = Boolean(item.isRequest);
  activeMessages = [];
  activeConversationStates = [];
  renderActiveThread();
  if (!activeConversationId) {
    return;
  }
  const currentUid = getCurrentUserId();
  if (item.hasConversation !== false) {
    await markConversationSeen(activeConversationId, currentUid);
  }
  unsubscribeMessages = subscribeMessagesForConversation(activeConversationId, (messages) => {
    activeMessages = messages;
    renderActiveThread();
  });
  unsubscribeActiveConversationStates = subscribeConversationStates(activeConversationId, (states) => {
    activeConversationStates = states;
    renderThreadStatus();
  });
}
async function renderConversationList() {
  const container = document.getElementById("messages-list");
  const list = await computeVisibleConversations();
  const showingRequests = currentTab === "requests";
  const filtered = list.filter((item) => (showingRequests ? item.isRequest : !item.isRequest));
  if (!filtered.length) {
    container.innerHTML = `<p class="text-xs text-slate-500">${showingRequests ? "No message requests." : "No messages yet."}</p>`;
    return;
  }
  container.innerHTML = filtered
    .map((item) => {
      const itemKey = item.listKey || item.id;
      const active = itemKey === activeConversationKey;
      const avatarUrl = item.profile?.avatarUrl || defaultAvatar();
      return `
        <button class="w-full rounded-lg border ${active ? "border-brand bg-teal-50" : "border-slate-200 bg-white/70"} px-3 py-2 text-left"
          data-action="open-conversation" data-conversation-key="${itemKey}">
          <div class="flex items-start gap-2">
            <div class="flex min-w-0 flex-1 items-start gap-2">
              <img
                src="${escapeHtml(avatarUrl)}"
                alt="${escapeHtml(item.profile?.displayName || "Member")} avatar"
                class="h-9 w-9 rounded-full border border-slate-200 bg-white object-cover object-center"
              />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <p class="truncate text-sm font-semibold text-slate-800">${escapeHtml(item.profile?.displayName || "Member")}</p>
                  ${item.unread ? "<span class='h-2 w-2 shrink-0 rounded-full bg-red-500'></span>" : ""}
                </div>
                <div class="mt-0.5 flex items-center justify-between gap-2">
                  <p class="truncate text-[11px] text-slate-500">${escapeHtml(item.profile?.handle || "@member")}</p>
                  <p class="shrink-0 text-[11px] text-slate-500">${item.lastMessageAt ? formatRelativeTime(item.lastMessageAt) : "Ready to chat"}</p>
                </div>
              </div>
            </div>
          </div>
        </button>
      `;
    })
    .join("");
}
async function sendCurrentMessage(event) {
  event.preventDefault();
  const input = document.getElementById("messages-input");
  const sendButton = document.getElementById("messages-send-btn");
  const text = sanitizeText(input.value).slice(0, 1000);
  const currentUid = getCurrentUserId();
  const targetUid = activeOtherUid || draftTargetUid;
  if (!text) {
    return;
  }
  if (!currentUid || !targetUid) {
    showToast("Select a user to message first.", "error");
    return;
  }
  try {
    setButtonBusy(sendButton, "Sending...", true);
    const result = await sendDirectMessage(currentUid, targetUid, text);
    input.value = "";
    draftTargetUid = "";
    activeConversationId = result.conversationId;
    activeConversationKey = `conversation:${result.conversationId}`;
    await markConversationSeen(result.conversationId, currentUid);
  } catch (error) {
    showToast(error.message || "Could not send message.", "error");
  } finally {
    setButtonBusy(sendButton, "", false);
  }
}
function bindEvents() {
  const inboxButton = document.getElementById("messages-tab-inbox");
  const requestButton = document.getElementById("messages-tab-requests");
  const list = document.getElementById("messages-list");
  const form = document.getElementById("messages-form");
  const acceptButton = document.getElementById("messages-accept-request");
  const ignoreButton = document.getElementById("messages-ignore-request");
  const clearActiveThread = () => {
    activeConversationId = "";
    activeConversationKey = "";
    activeOtherUid = "";
    activeConversationIsRequest = false;
    activeMessages = [];
    activeConversationStates = [];
    draftTargetUid = "";
    unsubscribeMessages();
    unsubscribeActiveConversationStates();
    unsubscribeMessages = () => {};
    unsubscribeActiveConversationStates = () => {};
    renderActiveThread();
  };
  const setTabButtonState = (tab) => {
    const inboxActive = tab === "inbox";
    inboxButton.classList.toggle("bg-brand", inboxActive);
    inboxButton.classList.toggle("text-white", inboxActive);
    requestButton.classList.toggle("bg-brand", !inboxActive);
    requestButton.classList.toggle("text-white", !inboxActive);
  };
  const switchMessagesTab = async (tab) => {
    currentTab = tab;
    clearActiveThread();
    setTabButtonState(tab);
    await renderConversationList();
  };
  inboxButton.addEventListener("click", async () => {
    await switchMessagesTab("inbox");
  });
  requestButton.addEventListener("click", async () => {
    await switchMessagesTab("requests");
  });
  list.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action='open-conversation']");
    if (!button) return;
    const conversationKey = button.dataset.conversationKey;
    const item = (await computeVisibleConversations()).find((entry) => (entry.listKey || entry.id) === conversationKey);
    if (!item) return;
    await openConversation(item);
    await renderConversationList();
  });
  form.addEventListener("submit", sendCurrentMessage);
  acceptButton.addEventListener("click", async () => {
    const uid = getCurrentUserId();
    if (!activeConversationId || !uid) return;
    await setConversationRequestAccepted(activeConversationId, uid, true);
    classificationCache.clear();
    activeConversationIsRequest = false;
    currentTab = "inbox";
    setTabButtonState("inbox");
    await renderConversationList();
    renderActiveThread();
  });
  ignoreButton.addEventListener("click", async () => {
    const uid = getCurrentUserId();
    if (!activeConversationId || !uid) return;
    await setConversationHidden(activeConversationId, uid, true);
    activeConversationId = "";
    activeOtherUid = "";
    activeConversationIsRequest = false;
    activeMessages = [];
    renderActiveThread();
    await renderConversationList();
  });
  window.addEventListener("open-message-user", async (event) => {
    const uid = event.detail?.uid;
    const currentUid = getCurrentUserId();
    if (!uid || !currentUid || uid === currentUid) return;
    const navButton = document.getElementById("nav-messages");
    navButton?.click();
    draftTargetUid = uid;
    await ensureProfile(uid);
    const existing = (await computeVisibleConversations()).find((item) => item.otherUid === uid);
    if (existing) {
      await openConversation(existing);
      await renderConversationList();
      return;
    }
    activeConversationId = "";
    activeOtherUid = uid;
    activeMessages = [];
    activeConversationIsRequest = false;
    renderActiveThread();
  });
}
export async function initializeMessagesForSession() {
  const uid = getCurrentUserId();
  if (!uid) return;
  unsubscribeConversations();
  unsubscribeOwnStates();
  unsubscribeConversations = subscribeConversationsForUser(uid, async (nextConversations) => {
    if (hasPrimedConversationNotificationSnapshot) {
      for (const conversation of nextConversations) {
        const lastAt = toMillis(conversation.lastMessageAt);
        const prevAt = lastConversationMessageAtMap.get(conversation.id) || 0;
        if (lastAt > prevAt && conversation.lastMessageSenderId && conversation.lastMessageSenderId !== uid) {
          const otherUid = getOtherUid(conversation, uid);
          await ensureProfile(otherUid);
          const profile = profileCache.get(otherUid);
          const text = `New message from ${profile?.displayName || "a user"}.`;
          if (shouldNotify("messages")) {
            showToast(text, "success");
          }
          pushNotification(text, "messages");
        }
      }
    }
    conversations = nextConversations;
    await refreshMutualFollowProfiles();
    lastConversationMessageAtMap.clear();
    for (const conversation of nextConversations) {
      lastConversationMessageAtMap.set(conversation.id, toMillis(conversation.lastMessageAt));
    }
    hasPrimedConversationNotificationSnapshot = true;
    classificationCache.clear();
    updateGlobalUnreadDot();
    await renderConversationList();
    if (activeConversationId || activeConversationKey) {
      const active = (await computeVisibleConversations()).find(
        (item) => (item.listKey || item.id) === activeConversationKey
      );
      if (!active) {
        activeConversationId = "";
        activeConversationKey = "";
        activeOtherUid = "";
        activeMessages = [];
        activeConversationIsRequest = false;
        renderActiveThread();
      }
    }
  });
  unsubscribeOwnStates = subscribeUserConversationStates(uid, async (states) => {
    ownStatesByConversation = new Map(states.map((item) => [item.conversationId, item]));
    classificationCache.clear();
    updateGlobalUnreadDot();
    await renderConversationList();
  });
  await refreshMutualFollowProfiles(true);
  await renderConversationList();
  renderActiveThread();
}
export function cleanupMessagesModule() {
  unsubscribeConversations();
  unsubscribeOwnStates();
  unsubscribeMessages();
  unsubscribeActiveConversationStates();
  unsubscribeConversations = () => {};
  unsubscribeOwnStates = () => {};
  unsubscribeMessages = () => {};
  unsubscribeActiveConversationStates = () => {};
  conversations = [];
  ownStatesByConversation = new Map();
  activeConversationStates = [];
  activeMessages = [];
  activeConversationId = "";
  activeConversationKey = "";
  activeOtherUid = "";
  activeConversationIsRequest = false;
  draftTargetUid = "";
  hasPrimedConversationNotificationSnapshot = false;
  lastConversationMessageAtMap.clear();
  mutualFollowProfiles = [];
  mutualFollowFetchedAt = 0;
  classificationCache.clear();
  followsCurrentUserCache.clear();
  const dot = document.getElementById("nav-messages-dot");
  dot?.classList.add("hidden");
}
export function initMessagesModule() {
  bindEvents();
  return {
    initializeMessagesForSession,
    cleanupMessagesModule
  };
}
