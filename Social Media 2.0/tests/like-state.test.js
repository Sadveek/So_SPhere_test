import test from "node:test";
import assert from "node:assert/strict";

import { toggleLikeSnapshot } from "../src/js/utils/likeMath.js";

test("toggleLikeSnapshot increments likes when unliked", () => {
  const next = toggleLikeSnapshot({ likes: 2, isLiked: false });
  assert.deepEqual(next, { likes: 3, isLiked: true });
});

test("toggleLikeSnapshot decrements likes when liked", () => {
  const next = toggleLikeSnapshot({ likes: 2, isLiked: true });
  assert.deepEqual(next, { likes: 1, isLiked: false });
});

test("toggleLikeSnapshot never returns negative likes", () => {
  const next = toggleLikeSnapshot({ likes: 0, isLiked: true });
  assert.deepEqual(next, { likes: 0, isLiked: false });
});

