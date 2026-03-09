export function toggleLikeSnapshot(snapshot) {
  const nextLiked = !snapshot.isLiked;
  const delta = nextLiked ? 1 : -1;
  const nextLikes = Math.max(0, Number(snapshot.likes || 0) + delta);

  return {
    likes: nextLikes,
    isLiked: nextLiked
  };
}
