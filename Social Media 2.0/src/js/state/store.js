const listeners = new Set();

const state = {
  session: null,
  profile: null,
  activeView: "feed",
  feed: [],
  feedCursor: null,
  hasMoreFeed: true,
  suggestedUsers: [],
  profilePosts: [],
  viewingProfile: null,
  pending: {
    feed: false,
    profile: false,
    auth: false
  }
};

function emit() {
  for (const listener of listeners) {
    listener(getState());
  }
}

export function getState() {
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setState(patch) {
  Object.assign(state, patch);
  emit();
}

function setKeyAndEmit(key, value) { state[key] = value; emit(); }

export function setSession(session) { setKeyAndEmit("session", session); }

export function setProfile(profile) { setKeyAndEmit("profile", profile); }

export function setActiveView(activeView) { setKeyAndEmit("activeView", activeView); }

export function setPending(key, value) {
  state.pending[key] = value;
  emit();
}

export function replaceFeed(posts, cursor, hasMoreFeed) {
  state.feed = posts;
  state.feedCursor = cursor;
  state.hasMoreFeed = hasMoreFeed;
  emit();
}

export function appendFeed(posts, cursor, hasMoreFeed) {
  state.feed = [...state.feed, ...posts];
  state.feedCursor = cursor;
  state.hasMoreFeed = hasMoreFeed;
  emit();
}

export function upsertFeedPost(post) {
  const index = state.feed.findIndex((item) => item.id === post.id);
  if (index === -1) {
    state.feed = [post, ...state.feed];
  } else {
    const next = [...state.feed];
    next[index] = { ...next[index], ...post };
    state.feed = next;
  }
  emit();
}

export function removeFeedPost(postId) {
  state.feed = state.feed.filter((post) => post.id !== postId);
  state.profilePosts = state.profilePosts.filter((post) => post.id !== postId);
  emit();
}

export function setSuggestedUsers(users) { setKeyAndEmit("suggestedUsers", users); }

export function setProfilePosts(posts) { setKeyAndEmit("profilePosts", posts); }

export function setViewingProfile(profile) { setKeyAndEmit("viewingProfile", profile); }

export function resetForLogout() {
  state.session = null;
  state.profile = null;
  state.feed = [];
  state.feedCursor = null;
  state.hasMoreFeed = true;
  state.suggestedUsers = [];
  state.profilePosts = [];
  state.viewingProfile = null;
  state.activeView = "feed";
  state.pending = {
    feed: false,
    profile: false,
    auth: false
  };
  emit();
}
