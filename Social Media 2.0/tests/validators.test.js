import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeHandle,
  sanitizeText,
  validateCommentContent,
  validatePostContent,
  validateProfilePatch
} from "../src/js/utils/validators.js";

test("sanitizeText trims and normalizes whitespace", () => {
  assert.equal(sanitizeText("  Hello\n\nworld   "), "Hello world");
});

test("normalizeHandle converts to valid lowercase handle", () => {
  assert.equal(normalizeHandle("@Web RS3!!"), "@webrs3");
});

test("validatePostContent rejects empty values", () => {
  const result = validatePostContent("   ");
  assert.equal(result.ok, false);
  assert.match(result.error, /required/i);
});

test("validatePostContent accepts valid content", () => {
  const result = validatePostContent("Building Firebase rules today.");
  assert.equal(result.ok, true);
  assert.equal(result.value, "Building Firebase rules today.");
});

test("validateCommentContent rejects empty comments", () => {
  const result = validateCommentContent("   ");
  assert.equal(result.ok, false);
  assert.match(result.error, /empty/i);
});

test("validateCommentContent accepts valid comment", () => {
  const result = validateCommentContent("Great update, thanks for sharing!");
  assert.equal(result.ok, true);
  assert.equal(result.value, "Great update, thanks for sharing!");
});

test("validateProfilePatch sanitizes and validates patch", () => {
  const result = validateProfilePatch({
    displayName: "  Sanskar  ",
    handle: "@Sanskar_Dev",
    bio: " Learning web dev ",
    avatarUrl: "https://example.com/avatar.png"
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.displayName, "Sanskar");
  assert.equal(result.value.handle, "@sanskar_dev");
  assert.equal(result.value.bio, "Learning web dev");
});
