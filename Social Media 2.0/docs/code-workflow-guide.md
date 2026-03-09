# My Code Workflow Guide (SocialSphere)

This is the workflow I follow when I work on this project so I can stay consistent, avoid regressions, and debug faster.

## 1. How I think about the codebase

I treat the project in layers:

- `index.html`: UI shell and DOM targets
- `src/css/styles.css`: custom visual style layer
- `src/js/app.js`: app bootstrap + wiring between features
- `src/js/modules/*`: feature logic (auth, feed, messages, profile, ui)
- `src/js/services/firebase.js`: Firebase data/auth/realtime operations
- `src/js/state/store.js`: app state container
- `src/js/utils/*`: shared helpers (validation, time, avatars, math)

Rule I follow: I keep UI behavior in modules, and I keep database/auth logic in services.

## 2. My startup flow (what runs first)

When the app loads, this is the sequence I expect:

1. `index.html` loads the page structure and scripts.
2. `src/js/app.js` initializes the app.
3. Auth state is checked.
4. Based on auth result, I show auth view or main app view.
5. Feature modules attach listeners and render initial UI.

If something breaks early, I start debugging from `app.js` and auth state handling first.

## 3. My feature development workflow

When I add or change a feature, I do it in this order:

1. UI target:
   Add/update the needed DOM structure in `index.html`.
2. Styling:
   Add classes in HTML, then style in `src/css/styles.css` only if Tailwind utility classes are not enough.
3. Module logic:
   Implement event handlers and rendering in the relevant file in `src/js/modules/`.
4. Service integration:
   Add or update Firebase operations in `src/js/services/firebase.js`.
5. State sync:
   Ensure `src/js/state/store.js` stays in sync with UI and service responses.
6. Validation and helpers:
   Reuse utilities from `src/js/utils/` instead of duplicating logic.
7. Smoke test:
   Run the app, perform create/read/update/delete paths, and confirm no console errors.

## 4. My debugging workflow

When I debug a bug, I use this path:

1. Reproduce once with exact steps.
2. Identify layer:
   UI issue, module logic issue, state issue, or Firebase issue.
3. Add temporary logs around the failing path.
4. Verify input and output at each boundary:
   DOM -> module -> service -> state -> render.
5. Fix the narrowest point that caused the bug.
6. Re-test the original scenario and one related edge case.

I avoid large rewrites during debugging unless the root cause proves the structure is wrong.

## 5. My code quality checklist before I finish

Before I consider a task done, I check:

- No duplicate logic if a util/service already exists.
- No direct Firebase calls scattered in UI-only modules.
- No broken selectors or missing element IDs in `index.html`.
- State updates are deterministic (no hidden side effects).
- Console is clean (no warnings/errors from my changes).
- Existing behavior still works for auth, feed, profile, and messages.

## 6. My practical rules for this project

- I keep functions small and single-purpose.
- I keep naming explicit (`verb + entity` style where possible).
- I prefer extending existing modules over creating random new files.
- I update docs when behavior or workflow changes.
- I make one logical change at a time so rollback is easy.

## 7. Quick map I use during work

- Auth flow: `modules/auth.js` + `services/firebase.js`
- Feed/posts/likes/comments: `modules/feed.js` + `services/firebase.js`
- Profile/view/edit: `modules/profile.js` + `services/firebase.js`
- Messages: `modules/messages.js` + `services/firebase.js`
- Shared UI controls/theme/nav: `modules/ui.js`
- App orchestration: `app.js`

This map helps me jump straight to the right file without guessing.
