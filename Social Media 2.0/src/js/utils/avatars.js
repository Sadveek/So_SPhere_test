export const AVATAR_OPTIONS = [
  "avatar_icons/cyclops.png",
  "avatar_icons/cyclops (1).png",
  "avatar_icons/cyclops (2).png",
  "avatar_icons/monster.png",
  "avatar_icons/monster (1).png",
  "avatar_icons/monster (2).png",
  "avatar_icons/monster (3).png",
  "avatar_icons/monster (4).png",
  "avatar_icons/monster (5).png",
  "avatar_icons/monster (6).png"
];

export function pickRandomAvatar() {
  if (!AVATAR_OPTIONS.length) return "";
  return AVATAR_OPTIONS[Math.floor(Math.random() * AVATAR_OPTIONS.length)];
}

export function pickAvatarForUser(seedValue) {
  if (!AVATAR_OPTIONS.length) return "";
  const seed = String(seedValue || "member");
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_OPTIONS[hash % AVATAR_OPTIONS.length];
}
