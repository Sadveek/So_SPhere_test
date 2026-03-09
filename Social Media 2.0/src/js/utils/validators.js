const MAX_POST_LENGTH = 200;
const MAX_BIO_LENGTH = 160;
const MAX_COMMENT_LENGTH = 220;
const MAX_DISPLAY_NAME_LENGTH = 16;
const MAX_HANDLE_LENGTH = 16;

export function sanitizeText(value) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function capitalizeDisplayName(value) {
  const clean = sanitizeText(value)
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
  if (!clean) {
    return "";
  }
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

export function normalizeHandle(value) {
  const raw = sanitizeText(value).toLowerCase().replace(/^@+/, "");
  const cleaned = raw.replace(/[^a-z0-9_]/g, "");
  return cleaned ? `@${cleaned.slice(0, MAX_HANDLE_LENGTH)}` : "";
}

export function validatePostContent(input) {
  const value = sanitizeText(input);
  if (!value) {
    return { ok: false, error: "Post content is required." };
  }
  if (value.length > MAX_POST_LENGTH) {
    return { ok: false, error: `Post cannot exceed ${MAX_POST_LENGTH} characters.` };
  }
  return { ok: true, value };
}

export function validateCommentContent(input) {
  const value = sanitizeText(input);
  if (!value) {
    return { ok: false, error: "Comment cannot be empty." };
  }
  if (value.length > MAX_COMMENT_LENGTH) {
    return { ok: false, error: `Comment cannot exceed ${MAX_COMMENT_LENGTH} characters.` };
  }
  return { ok: true, value };
}

export function validateProfilePatch(patch) {
  const displayName = capitalizeDisplayName(patch.displayName);
  const bio = sanitizeText(patch.bio).slice(0, MAX_BIO_LENGTH);
  const avatarUrl = sanitizeText(patch.avatarUrl).slice(0, 300);
  const handle = normalizeHandle(patch.handle || displayName);

  if (!displayName) {
    return { ok: false, error: "Display name is required and only letters, numbers, and spaces are allowed." };
  }
  if (!handle) {
    return { ok: false, error: "A valid handle is required." };
  }

  if (
    avatarUrl
    && !/^https?:\/\//i.test(avatarUrl)
    && !avatarUrl.startsWith("/")
    && !avatarUrl.startsWith("./")
    && !avatarUrl.startsWith("avatar_icons/")
  ) {
    return { ok: false, error: "Avatar must be an http(s) URL or a local app path." };
  }

  return {
    ok: true,
    value: {
      displayName,
      handle,
      bio,
      isPrivate: patch.isPrivate !== false,
      avatarUrl,
      ...(typeof patch.onboardingCompleted === "boolean"
        ? { onboardingCompleted: patch.onboardingCompleted }
        : {})
    }
  };
}

export { MAX_POST_LENGTH, MAX_BIO_LENGTH, MAX_COMMENT_LENGTH };
