import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  setDoc,
  updateDoc,
  deleteDoc,
  runTransaction,
  serverTimestamp,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { capitalizeDisplayName, normalizeHandle, sanitizeText } from "../utils/validators.js";
const cfg = window.SOCIALSPHERE_CONFIG?.firebase || {};
const firebaseConfigured = Boolean(cfg.apiKey && cfg.projectId && cfg.authDomain && cfg.appId);
if (!firebaseConfigured) {
  throw new Error("Firebase config is missing. Set window.SOCIALSPHERE_CONFIG.firebase in src/js/config.js.");
}
const app = getApps().length ? getApps()[0] : initializeApp(cfg);
const auth = getAuth(app);
const db = getFirestore(app);
function nowIso() {
  return new Date().toISOString();
}
function normalizeAvatarPath(value) {
  const raw = sanitizeText(value);
  if (raw.startsWith("/avatar_icons/")) {
    return raw.slice(1);
  }
  return raw;
}
function toMillis(value) {
  if (!value) {
    return 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value.toDate === "function") {
    return value.toDate().getTime();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 0;
  }
  return parsed.getTime();
}
function splitIntoChunks(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}
function sortPostsDescending(a, b) {
  const delta = toMillis(b.createdAt) - toMillis(a.createdAt);
  if (delta !== 0) {
    return delta;
  }
  return String(b.id).localeCompare(String(a.id));
}
function followDocId(followerUid, followingUid) {
  return `${followerUid}_${followingUid}`;
}
function requestDocId(fromUid, toUid) {
  return `${fromUid}_${toUid}`;
}
function conversationIdFor(uidA, uidB) {
  const [left, right] = [uidA, uidB].sort();
  return `${left}__${right}`;
}
function messageStateDocId(conversationId, uid) {
  return `${conversationId}_${uid}`;
}
function normalizeConversationDoc(snap) {
  const data = snap.data();
  return {
    id: snap.id,
    participantIds: Array.isArray(data.participantIds) ? data.participantIds : [],
    createdAt: data.createdAt || nowIso(),
    updatedAt: data.updatedAt || data.createdAt || nowIso(),
    lastMessageText: data.lastMessageText || "",
    lastMessageAt: data.lastMessageAt || data.updatedAt || data.createdAt || nowIso(),
    lastMessageSenderId: data.lastMessageSenderId || ""
  };
}
function normalizeMessageDoc(snap) {
  const data = snap.data();
  return {
    id: snap.id,
    conversationId: data.conversationId || "",
    senderId: data.senderId || "",
    text: data.text || "",
    createdAt: data.createdAt || nowIso()
  };
}
function normalizeConversationStateDoc(snap) {
  const data = snap.data();
  return {
    id: snap.id,
    conversationId: data.conversationId || "",
    userId: data.userId || "",
    hidden: Boolean(data.hidden),
    accepted: Boolean(data.accepted),
    lastSeenAt: data.lastSeenAt || null,
    updatedAt: data.updatedAt || nowIso()
  };
}
function toAuthErrorMessage(error, fallback) {
  const code = String(error?.code || "");
  if (code === "auth/email-already-in-use") {
    return "This email already has an account. Please log in instead.";
  }
  if (code === "auth/invalid-email") {
    return "Please enter a valid email address.";
  }
  if (code === "auth/weak-password") {
    return "Password is too weak. Use at least 6 characters.";
  }
  if (code === "auth/invalid-credential" || code === "auth/user-not-found" || code === "auth/wrong-password") {
    return "Invalid email or password.";
  }
  if (code === "auth/too-many-requests") {
    return "Too many attempts. Please try again later.";
  }
  if (code === "auth/network-request-failed") {
    return "Network error. Check your internet connection and try again.";
  }
  return error?.message || fallback;
}
function buildDefaultProfile(uid, email) {
  const left = String(email || "member").split("@")[0] || "member";
  const displayName = left
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 16) || "Social User";
  return {
    uid,
    displayName: capitalizeDisplayName(displayName),
    handle: normalizeHandle(left) || "@social_user",
    bio: "",
    isPrivate: true,
    avatarUrl: "",
    onboardingCompleted: false,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}
function normalizeProfile(uid, raw) {
  const normalizedAvatar = normalizeAvatarPath(raw.avatarUrl || "");
  const hasExplicitOnboardingFlag = typeof raw.onboardingCompleted === "boolean";
  const onboardingCompleted = hasExplicitOnboardingFlag
    ? raw.onboardingCompleted === true
    : Boolean(normalizedAvatar);
  return {
    uid,
    displayName: capitalizeDisplayName(raw.displayName || "Social User"),
    handle: raw.handle || "@social_user",
    bio: raw.bio || "",
    isPrivate: raw.isPrivate !== false,
    avatarUrl: normalizedAvatar,
    onboardingCompleted,
    createdAt: raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || nowIso()
  };
}
function makeSession(user, profile) {
  return {
    uid: user.uid,
    email: user.email || "",
    displayName: profile?.displayName || user.displayName || user.email || "Member"
  };
}
function normalizePostDoc(snap, isLiked = false) {
  const data = snap.data();
  return {
    id: snap.id,
    authorId: data.authorId,
    authorName: data.authorName,
    authorHandle: data.authorHandle,
    content: data.content,
    postType: data.postType || "none",
    mediaUrl: data.mediaUrl || "",
    pollOptions: Array.isArray(data.pollOptions) ? data.pollOptions : [],
    pollVoteCounts: Array.isArray(data.pollVoteCounts)
      ? data.pollVoteCounts.map((item) => Math.max(0, Number(item || 0)))
      : [],
    pollVoteTotal: Math.max(0, Number(data.pollVoteTotal || 0)),
    likeCount: Number(data.likeCount || 0),
    commentCount: Number(data.commentCount || 0),
    visibility: data.visibility || "public",
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    isLiked,
    userPollVoteIndex: Number.isInteger(data.userPollVoteIndex) ? data.userPollVoteIndex : -1
  };
}
function normalizeCommentDoc(snap) {
  const data = snap.data();
  return {
    id: snap.id,
    postId: data.postId,
    authorId: data.authorId,
    authorName: data.authorName,
    authorHandle: data.authorHandle,
    content: data.content,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  };
}
async function getLikeStateForPostsFirebase(userId, postIds) {
  if (!userId || postIds.length === 0) {
    return new Set();
  }
  const liked = new Set();
  const chunks = splitIntoChunks(postIds, 10);
  for (const chunk of chunks) {
    const likesRef = collection(db, "postLikes");
    const likesQuery = query(likesRef, where("userId", "==", userId), where("postId", "in", chunk));
    const likesSnapshot = await getDocs(likesQuery);
    likesSnapshot.forEach((item) => liked.add(item.data().postId));
  }
  return liked;
}
async function getPollVoteStateForPostsFirebase(userId, postIds) {
  if (!userId || postIds.length === 0) {
    return new Map();
  }
  const voted = new Map();
  const chunks = splitIntoChunks(postIds, 10);
  for (const chunk of chunks) {
    const votesRef = collection(db, "postPollVotes");
    const votesQuery = query(votesRef, where("userId", "==", userId), where("postId", "in", chunk));
    const votesSnapshot = await getDocs(votesQuery);
    votesSnapshot.forEach((item) => {
      const data = item.data();
      const index = Number(data.optionIndex);
      if (Number.isInteger(index) && index >= 0) {
        voted.set(data.postId, index);
      }
    });
  }
  return voted;
}
function ensureOwnPost(post, userId) {
  if (!post || post.authorId !== userId) {
    throw new Error("You can only edit or delete your own posts.");
  }
}
function relationStateTemplate(targetUid, currentUid) {
  return {
    targetUid,
    isSelf: targetUid === currentUid,
    isFollowing: false,
    outgoingPending: false,
    incomingPending: false
  };
}
export function onSessionChanged(callback) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) {
      callback(null);
      return;
    }
    const profile = await getOrCreateProfile(user.uid, user.email);
    callback(makeSession(user, profile));
  });
}
export async function signInUser(email, password) {
  const normalizedEmail = sanitizeText(email).toLowerCase();
  if (!normalizedEmail || !password) {
    throw new Error("Email and password are required.");
  }
  try {
    const credential = await signInWithEmailAndPassword(auth, normalizedEmail, password);
    const profile = await getOrCreateProfile(credential.user.uid, credential.user.email);
    return makeSession(credential.user, profile);
  } catch (error) {
    throw new Error(toAuthErrorMessage(error, "Login failed."));
  }
}
export async function signUpUser(email, password) {
  const normalizedEmail = sanitizeText(email).toLowerCase();
  if (!normalizedEmail || password.length < 6) {
    throw new Error("Email and password (6+ chars) are required.");
  }
  try {
    const credential = await createUserWithEmailAndPassword(auth, normalizedEmail, password);
    const profile = await getOrCreateProfile(credential.user.uid, credential.user.email);
    return makeSession(credential.user, profile);
  } catch (error) {
    throw new Error(toAuthErrorMessage(error, "Sign up failed."));
  }
}
export async function signOutUser() {
  await signOut(auth);
}
export async function getOrCreateProfile(uid, email) {
  const profileRef = doc(db, "users", uid);
  const profileSnapshot = await getDoc(profileRef);
  if (profileSnapshot.exists()) {
    return normalizeProfile(uid, profileSnapshot.data());
  }
  const profile = buildDefaultProfile(uid, email);
  await setDoc(profileRef, {
    ...profile,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return profile;
}
export async function getUserProfile(uid) {
  const profileRef = doc(db, "users", uid);
  const snap = await getDoc(profileRef);
  if (!snap.exists()) {
    return normalizeProfile(uid, buildDefaultProfile(uid, "member@example.com"));
  }
  return normalizeProfile(uid, snap.data());
}
export async function updateUserProfile(uid, patch) {
  const next = {
    displayName: capitalizeDisplayName(sanitizeText(patch.displayName).slice(0, 16)),
    handle: normalizeHandle(patch.handle),
    bio: sanitizeText(patch.bio).slice(0, 160),
    isPrivate: patch.isPrivate !== false,
    avatarUrl: normalizeAvatarPath(sanitizeText(patch.avatarUrl).slice(0, 300)),
    ...(typeof patch.onboardingCompleted === "boolean" ? { onboardingCompleted: patch.onboardingCompleted } : {})
  };
  const profileRef = doc(db, "users", uid);
  await setDoc(
    profileRef,
    {
      ...next,
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
  const updated = await getDoc(profileRef);
  return normalizeProfile(uid, updated.data());
}
export async function listPostsPage(pageSize = 10, cursor = null, userId = null) {
    const postsRef = collection(db, "posts");
    let postsQuery = query(postsRef, orderBy("createdAt", "desc"), limit(pageSize));
    if (cursor) {
      postsQuery = query(postsRef, orderBy("createdAt", "desc"), startAfter(cursor), limit(pageSize));
    }
    const snapshot = await getDocs(postsQuery);
    const docs = snapshot.docs;
    const ids = docs.map((item) => item.id);
    const [likedPostIds, pollVoteState] = await Promise.all([
      getLikeStateForPostsFirebase(userId, ids),
      getPollVoteStateForPostsFirebase(userId, ids)
    ]);
    const posts = docs.map((item) => ({
      ...normalizePostDoc(item, likedPostIds.has(item.id)),
      userPollVoteIndex: pollVoteState.has(item.id) ? pollVoteState.get(item.id) : -1
    }));
    return {
      posts,
      cursor: docs.length > 0 ? docs[docs.length - 1] : null,
      hasMore: docs.length === pageSize
    };
  }
export function subscribeToFeed(userId, callback, pageSize = 30) {
  if (!userId) {
    callback([]);
    return () => {};
  }
    let stopped = false;
    let likedPostIds = new Set();
    let pollVoteState = new Map();
    let followsUnsub = () => {};
    let likesUnsub = () => {};
    let votesUnsub = () => {};
    const postUnsubs = [];
    const chunkPostMaps = new Map();
    const publish = () => {
      if (stopped) {
        return;
      }
      const merged = new Map();
      for (const map of chunkPostMaps.values()) {
        for (const post of map.values()) {
          merged.set(post.id, {
            ...post,
            isLiked: likedPostIds.has(post.id),
            userPollVoteIndex: pollVoteState.has(post.id) ? pollVoteState.get(post.id) : -1
          });
        }
      }
      const posts = Array.from(merged.values()).sort(sortPostsDescending).slice(0, pageSize);
      callback(posts);
    };
    const clearPostSubscriptions = () => {
      while (postUnsubs.length) {
        const unsub = postUnsubs.pop();
        unsub();
      }
      chunkPostMaps.clear();
    };
    const subscribePostsByAuthors = (authorIds) => {
      clearPostSubscriptions();
      const uniqueAuthors = [...new Set(authorIds.filter(Boolean))];
      if (!uniqueAuthors.length) {
        publish();
        return;
      }
      const chunks = splitIntoChunks(uniqueAuthors, 10);
      for (const chunk of chunks) {
        const chunkKey = chunk.join(",");
        const postsRef = collection(db, "posts");
        const postsQuery = query(postsRef, where("authorId", "in", chunk), orderBy("createdAt", "desc"), limit(pageSize));
        const unsub = onSnapshot(postsQuery, (snapshot) => {
          const map = new Map();
          snapshot.forEach((item) => {
            map.set(item.id, normalizePostDoc(item, likedPostIds.has(item.id)));
          });
          chunkPostMaps.set(chunkKey, map);
          publish();
        });
        postUnsubs.push(unsub);
      }
    };
    const followsRef = collection(db, "follows");
    const followsQuery = query(followsRef, where("followerUid", "==", userId));
    followsUnsub = onSnapshot(followsQuery, (snapshot) => {
      const authorIds = [userId];
      snapshot.forEach((item) => {
        const data = item.data();
        authorIds.push(data.followingUid);
      });
      subscribePostsByAuthors(authorIds);
    });
    const likesRef = collection(db, "postLikes");
    const likesQuery = query(likesRef, where("userId", "==", userId));
    likesUnsub = onSnapshot(likesQuery, (snapshot) => {
      likedPostIds = new Set();
      snapshot.forEach((item) => likedPostIds.add(item.data().postId));
      publish();
    });
    const votesRef = collection(db, "postPollVotes");
    const votesQuery = query(votesRef, where("userId", "==", userId));
    votesUnsub = onSnapshot(votesQuery, (snapshot) => {
      pollVoteState = new Map();
      snapshot.forEach((item) => {
        const data = item.data();
        const index = Number(data.optionIndex);
        if (Number.isInteger(index) && index >= 0) {
          pollVoteState.set(data.postId, index);
        }
      });
      publish();
    });
    return () => {
      stopped = true;
      followsUnsub();
      likesUnsub();
      votesUnsub();
      clearPostSubscriptions();
    };
  }
export async function listPostsByAuthor(authorId, pageSize = 10, userId = null) {
    const postsRef = collection(db, "posts");
    const postsQuery = query(
      postsRef,
      where("authorId", "==", authorId),
      orderBy("createdAt", "desc"),
      limit(pageSize)
    );
    const snapshot = await getDocs(postsQuery);
    const docs = snapshot.docs;
    const ids = docs.map((item) => item.id);
    const [likedPostIds, pollVoteState] = await Promise.all([
      getLikeStateForPostsFirebase(userId, ids),
      getPollVoteStateForPostsFirebase(userId, ids)
    ]);
    return docs.map((item) => ({
      ...normalizePostDoc(item, likedPostIds.has(item.id)),
      userPollVoteIndex: pollVoteState.has(item.id) ? pollVoteState.get(item.id) : -1
    }));
  }
export async function createPostRecord({ authorId, authorName, authorHandle, content, postType = "none", mediaUrl = "", pollOptions = [] }) {
  const safeContent = sanitizeText(content);
  const safePostType = sanitizeText(postType).toLowerCase();
  const allowedTypes = new Set(["none", "resource", "poll", "update"]);
  const finalPostType = allowedTypes.has(safePostType) ? safePostType : "none";
  const safeMediaUrl = sanitizeText(mediaUrl).slice(0, 500);
  const safePollOptions = Array.isArray(pollOptions)
    ? pollOptions.map((item) => sanitizeText(item).slice(0, 40)).filter(Boolean).slice(0, 10)
    : [];
  if (!safeContent) {
    throw new Error("Post content is required.");
  }
  if (finalPostType === "poll" && safePollOptions.length < 2) {
    throw new Error("Poll requires at least 2 options.");
  }
    const ref = doc(collection(db, "posts"));
    await setDoc(ref, {
      authorId,
      authorName,
      authorHandle,
      content: safeContent,
      postType: finalPostType,
      mediaUrl: safeMediaUrl,
      pollOptions: safePollOptions,
      pollVoteCounts: finalPostType === "poll" ? safePollOptions.map(() => 0) : [],
      pollVoteTotal: 0,
      likeCount: 0,
      commentCount: 0,
      visibility: "public",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    const snap = await getDoc(ref);
    return normalizePostDoc(snap, false);
  }
export async function updatePostRecord(postId, content, userId) {
  const safeContent = sanitizeText(content);
  if (!safeContent) {
    throw new Error("Post content is required.");
  }
    const postRef = doc(db, "posts", postId);
    const snapshot = await getDoc(postRef);
    if (!snapshot.exists()) {
      throw new Error("Post not found.");
    }
    if (snapshot.data().authorId !== userId) {
      throw new Error("You can only edit your own posts.");
    }
    await updateDoc(postRef, {
      content: safeContent,
      updatedAt: serverTimestamp()
    });
    const updated = await getDoc(postRef);
    return normalizePostDoc(updated, false);
  }
export async function deletePostRecord(postId, userId) {
    const postRef = doc(db, "posts", postId);
    const snapshot = await getDoc(postRef);
    if (!snapshot.exists()) {
      throw new Error("Post not found.");
    }
    if (snapshot.data().authorId !== userId) {
      throw new Error("You can only delete your own posts.");
    }
    await deleteDoc(postRef);
    return;
  }
export async function toggleLikeRecord(postId, userId) {
  if (!userId) {
    throw new Error("Authentication required.");
  }
    const postRef = doc(db, "posts", postId);
    const likeRef = doc(db, "postLikes", `${postId}_${userId}`);
    return runTransaction(db, async (transaction) => {
      const postSnap = await transaction.get(postRef);
      if (!postSnap.exists()) {
        throw new Error("Post not found.");
      }
      const postData = postSnap.data();
      const likeSnap = await transaction.get(likeRef);
      const liked = likeSnap.exists();
      const current = Number(postData.likeCount || 0);
      const nextLikeCount = liked ? Math.max(0, current - 1) : current + 1;
      if (liked) {
        transaction.delete(likeRef);
      } else {
        transaction.set(likeRef, {
          postId,
          userId,
          createdAt: serverTimestamp()
        });
      }
      transaction.update(postRef, {
        likeCount: nextLikeCount,
        updatedAt: serverTimestamp()
      });
      return {
        liked: !liked,
        likeCount: nextLikeCount
      };
    });
  }
export async function votePollOptionRecord(postId, userId, optionIndex) {
  if (!userId) {
    throw new Error("Authentication required.");
  }
  const voteIndex = Number(optionIndex);
  if (!Number.isInteger(voteIndex) || voteIndex < 0) {
    throw new Error("Invalid poll option.");
  }
    const postRef = doc(db, "posts", postId);
    const voteRef = doc(db, "postPollVotes", `${postId}_${userId}`);
    return runTransaction(db, async (transaction) => {
      const postSnap = await transaction.get(postRef);
      if (!postSnap.exists()) {
        throw new Error("Post not found.");
      }
      const postData = postSnap.data();
      if (String(postData.postType || "") !== "poll") {
        throw new Error("This post is not a poll.");
      }
      const options = Array.isArray(postData.pollOptions) ? postData.pollOptions : [];
      if (voteIndex >= options.length) {
        throw new Error("Invalid poll option.");
      }
      const voteSnap = await transaction.get(voteRef);
      const previous = voteSnap.exists() ? Number(voteSnap.data().optionIndex) : -1;
      let counts = Array.isArray(postData.pollVoteCounts)
        ? postData.pollVoteCounts.map((item) => Math.max(0, Number(item || 0)))
        : [];
      counts = options.map((_, index) => Math.max(0, Number(counts[index] || 0)));
      let total = Math.max(0, Number(postData.pollVoteTotal || 0));
      if (previous === voteIndex) {
        return {
          userPollVoteIndex: voteIndex,
          pollVoteCounts: counts,
          pollVoteTotal: total
        };
      }
      if (previous >= 0 && previous < counts.length) {
        counts[previous] = Math.max(0, counts[previous] - 1);
      } else {
        total += 1;
      }
      counts[voteIndex] = Math.max(0, Number(counts[voteIndex] || 0)) + 1;
      transaction.set(
        voteRef,
        {
          postId,
          userId,
          optionIndex: voteIndex,
          createdAt: voteSnap.exists() ? voteSnap.data().createdAt : serverTimestamp(),
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
      transaction.update(postRef, {
        pollVoteCounts: counts,
        pollVoteTotal: total,
        updatedAt: serverTimestamp()
      });
      return {
        userPollVoteIndex: voteIndex,
        pollVoteCounts: counts,
        pollVoteTotal: total
      };
    });
  }
export function subscribeToComments(postId, callback, pageSize = 80) {
  if (!postId) {
    callback([]);
    return () => {};
  }
    const commentsRef = collection(db, "comments");
    const commentsQuery = query(
      commentsRef,
      where("postId", "==", postId),
      orderBy("createdAt", "asc"),
      limit(pageSize)
    );
    return onSnapshot(commentsQuery, (snapshot) => {
      const comments = snapshot.docs.map(normalizeCommentDoc);
      callback(comments);
    });
  }
export async function createCommentRecord({ postId, authorId, authorName, authorHandle, content }) {
  const safeContent = sanitizeText(content).slice(0, 220);
  if (!safeContent) {
    throw new Error("Comment cannot be empty.");
  }
    const postRef = doc(db, "posts", postId);
    const commentRef = doc(collection(db, "comments"));
    await runTransaction(db, async (transaction) => {
      const postSnap = await transaction.get(postRef);
      if (!postSnap.exists()) {
        throw new Error("Post not found.");
      }
      const currentCount = Number(postSnap.data().commentCount || 0);
      transaction.set(commentRef, {
        postId,
        authorId,
        authorName,
        authorHandle,
        content: safeContent,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      transaction.update(postRef, {
        commentCount: currentCount + 1,
        updatedAt: serverTimestamp()
      });
    });
    const snap = await getDoc(commentRef);
    return normalizeCommentDoc(snap);
  }
export async function listSuggestedUsers(userId, maxUsers = 10) {
    const usersRef = collection(db, "users");
    const usersQuery = query(usersRef, orderBy("updatedAt", "desc"), limit(maxUsers + 10));
    const snapshot = await getDocs(usersQuery);
    const result = [];
    snapshot.forEach((item) => {
      if (item.id !== userId && result.length < maxUsers) {
        const normalized = normalizeProfile(item.id, item.data());
        if (!normalized.onboardingCompleted) {
          return;
        }
        result.push(normalized);
      }
    });
    return result;
  }
export async function getRelationshipMap(currentUid, targetUids) {
  const unique = [...new Set(targetUids.filter(Boolean))];
  const map = {};
  for (const targetUid of unique) {
    map[targetUid] = relationStateTemplate(targetUid, currentUid);
  }
  if (!currentUid || !unique.length) {
    return map;
  }
    await Promise.all(
      unique.map(async (targetUid) => {
        const state = relationStateTemplate(targetUid, currentUid);
        if (state.isSelf) {
          map[targetUid] = state;
          return;
        }
        const [followSnap, outgoingSnap, incomingSnap] = await Promise.all([
          getDoc(doc(db, "follows", followDocId(currentUid, targetUid))),
          getDoc(doc(db, "followRequests", requestDocId(currentUid, targetUid))),
          getDoc(doc(db, "followRequests", requestDocId(targetUid, currentUid)))
        ]);
        state.isFollowing = followSnap.exists();
        state.outgoingPending = outgoingSnap.exists() && outgoingSnap.data()?.status === "pending";
        state.incomingPending = incomingSnap.exists() && incomingSnap.data()?.status === "pending";
        map[targetUid] = state;
      })
    );
    return map;
  }
export async function sendFollowRequest(fromUid, toUid) {
  if (!fromUid || !toUid || fromUid === toUid) {
    throw new Error("Invalid follow request target.");
  }
    const followRef = doc(db, "follows", followDocId(fromUid, toUid));
    const outgoingRef = doc(db, "followRequests", requestDocId(fromUid, toUid));
    const incomingRef = doc(db, "followRequests", requestDocId(toUid, fromUid));
    const targetProfileRef = doc(db, "users", toUid);
    await runTransaction(db, async (transaction) => {
      const [followSnap, outgoingSnap, incomingSnap, targetProfileSnap] = await Promise.all([
        transaction.get(followRef),
        transaction.get(outgoingRef),
        transaction.get(incomingRef),
        transaction.get(targetProfileRef)
      ]);
      if (followSnap.exists()) {
        throw new Error("You already follow this user.");
      }
      if (incomingSnap.exists() && incomingSnap.data()?.status === "pending") {
        throw new Error("This user already requested to follow you. Accept their request.");
      }
      if (outgoingSnap.exists() && outgoingSnap.data()?.status === "pending") {
        return;
      }
      const isTargetPrivate = targetProfileSnap.exists()
        ? targetProfileSnap.data()?.isPrivate !== false
        : true;
      if (!isTargetPrivate) {
        transaction.set(
          followRef,
          {
            followerUid: fromUid,
            followingUid: toUid,
            createdAt: serverTimestamp()
          },
          { merge: true }
        );
        if (outgoingSnap.exists()) {
          transaction.delete(outgoingRef);
        }
        return;
      }
      transaction.set(
        outgoingRef,
        {
          fromUid,
          toUid,
          status: "pending",
          createdAt: outgoingSnap.exists() ? outgoingSnap.data()?.createdAt || serverTimestamp() : serverTimestamp(),
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    });
    const finalFollowSnap = await getDoc(followRef);
    return { status: finalFollowSnap.exists() ? "accepted" : "pending" };
  }
export async function acceptFollowRequest(currentUid, fromUid) {
  if (!currentUid || !fromUid || currentUid === fromUid) {
    throw new Error("Invalid follow request.");
  }
    const reqRef = doc(db, "followRequests", requestDocId(fromUid, currentUid));
    const followRef = doc(db, "follows", followDocId(fromUid, currentUid));
    await runTransaction(db, async (transaction) => {
      const requestSnap = await transaction.get(reqRef);
      if (!requestSnap.exists() || requestSnap.data()?.status !== "pending") {
        throw new Error("Follow request not found.");
      }
      transaction.set(
        followRef,
        {
          followerUid: fromUid,
          followingUid: currentUid,
          createdAt: serverTimestamp()
        },
        { merge: true }
      );
      transaction.delete(reqRef);
    });
    return { status: "accepted" };
  }
export async function rejectFollowRequest(currentUid, fromUid) {
  if (!currentUid || !fromUid || currentUid === fromUid) {
    throw new Error("Invalid follow request.");
  }
    const reqRef = doc(db, "followRequests", requestDocId(fromUid, currentUid));
    const requestSnap = await getDoc(reqRef);
    if (!requestSnap.exists()) {
      throw new Error("Follow request not found.");
    }
    await deleteDoc(reqRef);
    return { status: "rejected" };
  }
export async function unfollowUser(currentUid, targetUid) {
  if (!currentUid || !targetUid || currentUid === targetUid) {
    throw new Error("Invalid user relation.");
  }
    const followRef = doc(db, "follows", followDocId(currentUid, targetUid));
    const reqRef = doc(db, "followRequests", requestDocId(currentUid, targetUid));
    await runTransaction(db, async (transaction) => {
      const [followSnap, reqSnap] = await Promise.all([
        transaction.get(followRef),
        transaction.get(reqRef)
      ]);
      let changed = false;
      if (followSnap.exists()) {
        transaction.delete(followRef);
        changed = true;
      }
      if (reqSnap.exists() && reqSnap.data()?.status === "pending") {
        transaction.delete(reqRef);
        changed = true;
      }
      if (!changed) {
        throw new Error("No active follow relation found.");
      }
    });
    return { status: "removed" };
  }
export async function listIncomingFollowRequests(uid, maxRequests = 12) {
  if (!uid) {
    return [];
  }
    const requestRef = collection(db, "followRequests");
    const requestQuery = query(
      requestRef,
      where("toUid", "==", uid),
      where("status", "==", "pending"),
      limit(maxRequests)
    );
    const snapshot = await getDocs(requestQuery);
    const requests = await Promise.all(
      snapshot.docs.map(async (item) => {
        const data = item.data();
        const profileSnap = await getDoc(doc(db, "users", data.fromUid));
        const profile = profileSnap.exists()
          ? normalizeProfile(data.fromUid, profileSnap.data())
          : buildDefaultProfile(data.fromUid, "member@example.com");
        return {
          fromUid: data.fromUid,
          toUid: data.toUid,
          createdAt: data.createdAt,
          profile
        };
      })
    );
    return requests;
  }
export async function getFollowCounts(uid) {
  if (!uid) {
    return { followers: 0, following: 0 };
  }
  const followsRef = collection(db, "follows");
  const [followersSnapshot, followingSnapshot] = await Promise.all([
    getDocs(query(followsRef, where("followingUid", "==", uid))),
    getDocs(query(followsRef, where("followerUid", "==", uid)))
  ]);
  return { followers: followersSnapshot.size, following: followingSnapshot.size };
}
export async function doesUserFollowTarget(followerUid, followingUid) {
  if (!followerUid || !followingUid || followerUid === followingUid) {
    return false;
  }
  const snap = await getDoc(doc(db, "follows", followDocId(followerUid, followingUid)));
  return snap.exists();
}
export async function listFollowingProfiles(uid, maxProfiles = 24) {
  if (!uid) {
    return [];
  }
  const followsRef = collection(db, "follows");
  const followsQuery = query(followsRef, where("followerUid", "==", uid), limit(maxProfiles));
  const snapshot = await getDocs(followsQuery);
  const followingIds = [...new Set(snapshot.docs.map((item) => item.data()?.followingUid).filter(Boolean))];
  const profiles = await Promise.all(followingIds.map((itemUid) => getUserProfile(itemUid)));
  return profiles.filter((profile) => profile.uid !== uid).slice(0, maxProfiles);
}
export async function listMutualFollowProfiles(uid, maxProfiles = 24) {
  if (!uid) {
    return [];
  }
  const followsRef = collection(db, "follows");
  const outgoingQuery = query(followsRef, where("followerUid", "==", uid), limit(300));
  const incomingQuery = query(followsRef, where("followingUid", "==", uid), limit(300));
  const [outgoingSnap, incomingSnap] = await Promise.all([getDocs(outgoingQuery), getDocs(incomingQuery)]);
  const outgoing = new Set(outgoingSnap.docs.map((item) => item.data()?.followingUid).filter(Boolean));
  const incoming = new Set(incomingSnap.docs.map((item) => item.data()?.followerUid).filter(Boolean));
  const mutualIds = [...outgoing].filter((itemUid) => incoming.has(itemUid)).slice(0, maxProfiles);
  const profiles = await Promise.all(mutualIds.map((itemUid) => getUserProfile(itemUid)));
  return profiles.filter((profile) => profile.uid !== uid);
}
export function subscribeConversationsForUser(uid, callback) {
  if (!uid) {
    callback([]);
    return () => {};
  }
  const conversationsRef = collection(db, "conversations");
  const conversationsQuery = query(conversationsRef, where("participantIds", "array-contains", uid), limit(100));
  return onSnapshot(conversationsQuery, (snapshot) => {
    callback(
      snapshot.docs
        .map((item) => normalizeConversationDoc(item))
        .sort((a, b) => toMillis(b.lastMessageAt || b.updatedAt) - toMillis(a.lastMessageAt || a.updatedAt))
    );
  });
}
export function subscribeMessagesForConversation(conversationId, callback) {
  if (!conversationId) {
    callback([]);
    return () => {};
  }
  const messagesRef = collection(db, "conversations", conversationId, "messages");
  const messagesQuery = query(messagesRef, orderBy("createdAt", "asc"), limit(250));
  return onSnapshot(messagesQuery, (snapshot) => callback(snapshot.docs.map((item) => normalizeMessageDoc(item))));
}
export function subscribeConversationStates(conversationId, callback) {
  if (!conversationId) {
    callback([]);
    return () => {};
  }
  const statesRef = collection(db, "conversationStates");
  const statesQuery = query(statesRef, where("conversationId", "==", conversationId));
  return onSnapshot(statesQuery, (snapshot) => callback(snapshot.docs.map((item) => normalizeConversationStateDoc(item))));
}
export function subscribeUserConversationStates(uid, callback) {
  if (!uid) {
    callback([]);
    return () => {};
  }
  const statesRef = collection(db, "conversationStates");
  const statesQuery = query(statesRef, where("userId", "==", uid), limit(200));
  return onSnapshot(statesQuery, (snapshot) => callback(snapshot.docs.map((item) => normalizeConversationStateDoc(item))));
}
export function subscribeFollowsByFollower(uid, callback) {
  if (!uid) {
    callback([]);
    return () => {};
  }
  const followsRef = collection(db, "follows");
  const followsQuery = query(followsRef, where("followerUid", "==", uid), limit(300));
  return onSnapshot(followsQuery, (snapshot) => callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))));
}
export async function sendDirectMessage(fromUid, toUid, text) {
  const cleanText = sanitizeText(text).slice(0, 1000);
  if (!fromUid || !toUid || fromUid === toUid) {
    throw new Error("Invalid message target.");
  }
  if (!cleanText) {
    throw new Error("Message cannot be empty.");
  }
  const conversationId = conversationIdFor(fromUid, toUid);
  const now = serverTimestamp();
  const conversationRef = doc(db, "conversations", conversationId);
  const messageRef = doc(collection(db, "conversations", conversationId, "messages"));
  const senderStateRef = doc(db, "conversationStates", messageStateDocId(conversationId, fromUid));
  const receiverStateRef = doc(db, "conversationStates", messageStateDocId(conversationId, toUid));
  await setDoc(
    conversationRef,
    {
      participantIds: [fromUid, toUid].sort(),
      createdAt: now,
      updatedAt: now,
      lastMessageText: cleanText,
      lastMessageAt: now,
      lastMessageSenderId: fromUid
    },
    { merge: true }
  );
  await setDoc(
    messageRef,
    { conversationId, senderId: fromUid, text: cleanText, createdAt: now },
    { merge: true }
  );
  await Promise.all([
    setDoc(senderStateRef, { conversationId, userId: fromUid, hidden: false, updatedAt: now }, { merge: true }),
    setDoc(receiverStateRef, { conversationId, userId: toUid, hidden: false, updatedAt: now }, { merge: true })
  ]);
  return { conversationId };
}
async function upsertConversationState(conversationId, uid, patch) {
  await setDoc(
    doc(db, "conversationStates", messageStateDocId(conversationId, uid)),
    { conversationId, userId: uid, ...patch },
    { merge: true }
  );
}
export async function markConversationSeen(conversationId, uid) {
  if (!conversationId || !uid) {
    return;
  }
  const timestamp = serverTimestamp();
  await upsertConversationState(conversationId, uid, {
    hidden: false,
    lastSeenAt: timestamp,
    updatedAt: timestamp
  });
}
export async function setConversationHidden(conversationId, uid, hidden) {
  if (!conversationId || !uid) {
    return;
  }
  await upsertConversationState(conversationId, uid, {
    hidden: Boolean(hidden),
    updatedAt: serverTimestamp()
  });
}
export async function setConversationRequestAccepted(conversationId, uid, accepted) {
  if (!conversationId || !uid) {
    return;
  }
  await upsertConversationState(conversationId, uid, {
    accepted: Boolean(accepted),
    hidden: false,
    updatedAt: serverTimestamp()
  });
}
