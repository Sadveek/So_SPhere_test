import {
  onSessionChanged,
  signInUser,
  signOutUser,
  signUpUser,
  getOrCreateProfile,
  updateUserProfile
} from "../services/firebase.js";
import { setButtonBusy, showToast, hideSection, showSection } from "./ui.js";
import { resetForLogout, setProfile, setSession } from "../state/store.js";
import { AVATAR_OPTIONS, pickRandomAvatar } from "../utils/avatars.js";
import { sanitizeText, validateProfilePatch } from "../utils/validators.js";

let isSignUpMode = false;
let unsubscribeSession = null;
let sessionHandler = () => { };
let onboardingProfile = null;
let onboardingSession = null;
let selectedOnboardingAvatar = "";

const authService = {
  signIn: (email, password) => signInUser(email, password),
  signOut: () => signOutUser(),
  signUp: (email, password) => signUpUser(email, password)
};

function updateAuthUi() {
  const submit = document.getElementById("auth-submit");
  const toggle = document.getElementById("auth-toggle");

  submit.textContent = isSignUpMode ? "Create Account" : "Log In";
  toggle.textContent = isSignUpMode ? "Already have an account? Log in" : "Need an account? Sign up";
}

function setAuthenticatedView(isAuthenticated) {
  if (isAuthenticated) {
    hideSection("auth-view");
    showSection("app-view");
    return;
  }

  showSection("auth-view");
  hideSection("app-view");
}

function updateHeaderIdentity(profile, session) {
  const chip = document.getElementById("current-user-chip");
  const avatar = document.getElementById("current-user-avatar");
  if (!chip || !avatar) {
    return;
  }
  chip.textContent = profile?.handle || session?.displayName || "Guest";
  avatar.src = profile?.avatarUrl || AVATAR_OPTIONS[0] || "";
}

function isOnboardingRequired(profile) { return profile?.onboardingCompleted !== true; }

function setOnboardingVisible(visible) {
  const modal = document.getElementById("onboarding-modal");
  if (!modal) {
    return;
  }
  modal.classList.toggle("hidden", !visible);
}

function renderOnboardingAvatarOptions() {
  const host = document.getElementById("onboarding-avatar-grid");
  if (!host) {
    return;
  }

  host.innerHTML = AVATAR_OPTIONS
    .map((avatar) => {
      const selected = avatar === selectedOnboardingAvatar;
      return `
        <button
          type="button"
          class="rounded-lg border p-1 ${selected ? "border-brand ring-2 ring-brand/40" : "border-slate-300"}"
          data-action="pick-onboarding-avatar"
          data-avatar="${avatar}">
          <img src="${avatar}" alt="Avatar option" class="h-14 w-14 rounded-full object-cover object-center" />
        </button>
      `;
    })
    .join("");

  const preview = document.getElementById("onboarding-avatar-preview");
  if (preview) {
    preview.src = selectedOnboardingAvatar || AVATAR_OPTIONS[0] || "";
  }
}

function openOnboarding(profile, session) {
  onboardingProfile = profile;
  onboardingSession = session;
  selectedOnboardingAvatar = sanitizeText(profile.avatarUrl);

  document.getElementById("onboarding-display-name").value = profile.displayName || "";
  document.getElementById("onboarding-handle").textContent = profile.handle || "@member";

  renderOnboardingAvatarOptions();
  setOnboardingVisible(true);
}

function closeOnboarding() {
  onboardingProfile = null;
  onboardingSession = null;
  selectedOnboardingAvatar = "";
  setOnboardingVisible(false);
}

async function handleOnboardingDone(event) {
  event.preventDefault();

  if (!onboardingSession || !onboardingProfile) {
    closeOnboarding();
    return;
  }

  const button = document.getElementById("onboarding-done-btn");
  const displayName = sanitizeText(document.getElementById("onboarding-display-name").value).slice(0, 16);
  const avatarUrl = selectedOnboardingAvatar || pickRandomAvatar();

  const validation = validateProfilePatch({
    displayName,
    handle: onboardingProfile.handle,
    bio: onboardingProfile.bio || "",
    avatarUrl,
    onboardingCompleted: true
  });

  if (!validation.ok) {
    showToast(validation.error, "error");
    return;
  }

  try {
    setButtonBusy(button, "Saving...", true);
    const updated = await updateUserProfile(onboardingSession.uid, validation.value);

    setProfile(updated);
    setSession({
      ...onboardingSession,
      displayName: updated.displayName
    });

    const userChip = document.getElementById("current-user-chip");
    userChip.textContent = updated.handle || updated.displayName;
    showToast("Profile setup complete.", "success");
    closeOnboarding();
  } catch (error) {
    showToast(error.message || "Could not complete profile setup.", "error");
  } finally {
    setButtonBusy(button, "", false);
  }
}

async function handleAuthSubmit(event) {
  event.preventDefault();

  const submit = document.getElementById("auth-submit");
  const email = document.getElementById("auth-email").value;
  const password = document.getElementById("auth-password").value;

  try {
    setButtonBusy(submit, isSignUpMode ? "Creating..." : "Signing in...", true);

    if (isSignUpMode) {
      await authService.signUp(email, password);
      showToast("Account created successfully.", "success");
    } else {
      await authService.signIn(email, password);
      showToast("Logged in successfully.", "success");
    }
  } catch (error) {
    showToast(error.message || "Authentication failed.", "error");
  } finally {
    setButtonBusy(submit, "", false);
  }
}

function bindAuthEvents() {
  const form = document.getElementById("auth-form");
  const toggle = document.getElementById("auth-toggle");
  const logoutButton = document.getElementById("logout-btn");
  const settingsLogoutButton = document.getElementById("settings-logout-btn");

  form.addEventListener("submit", handleAuthSubmit);

  toggle.addEventListener("click", () => {
    isSignUpMode = !isSignUpMode;
    updateAuthUi();
  });

  const handleLogout = async () => {
    try {
      await authService.signOut();
      showToast("Logged out.", "success");
      window.location.reload();
    } catch (error) {
      showToast(error.message || "Logout failed.", "error");
    }
  };

  logoutButton?.addEventListener("click", handleLogout);
  settingsLogoutButton?.addEventListener("click", handleLogout);
}

function bindOnboardingEvents() {
  const form = document.getElementById("onboarding-form");
  const grid = document.getElementById("onboarding-avatar-grid");

  form?.addEventListener("submit", handleOnboardingDone);
  grid?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action='pick-onboarding-avatar']");
    if (!button) {
      return;
    }
    selectedOnboardingAvatar = String(button.dataset.avatar || "");
    renderOnboardingAvatarOptions();
  });
}

function bindPasswordVisibilityToggle() {
  const passwordInput = document.getElementById("auth-password");
  const toggleButton = document.getElementById("auth-password-toggle");
  const showIcon = document.getElementById("auth-password-icon-show");
  const hideIcon = document.getElementById("auth-password-icon-hide");
  if (!passwordInput || !toggleButton || !showIcon || !hideIcon) {
    return;
  }

  toggleButton.addEventListener("click", () => {
    const revealing = passwordInput.type === "password";
    passwordInput.type = revealing ? "text" : "password";
    showIcon.classList.toggle("hidden", revealing);
    hideIcon.classList.toggle("hidden", !revealing);
    toggleButton.setAttribute("aria-label", revealing ? "Hide password" : "Show password");
    toggleButton.setAttribute("title", revealing ? "Hide password" : "Show password");
  });
}

export function initAuthModule(onSessionResolved) {
  sessionHandler = onSessionResolved;

  updateAuthUi();
  bindAuthEvents();
  bindOnboardingEvents();
  bindPasswordVisibilityToggle();

  if (unsubscribeSession) {
    unsubscribeSession();
  }

  unsubscribeSession = onSessionChanged(async (session) => {
    if (!session) {
      resetForLogout();
      setAuthenticatedView(false);
      closeOnboarding();
      updateHeaderIdentity(null, null);
      sessionHandler(null);
      return;
    }

    const profile = await getOrCreateProfile(session.uid, session.email);
    setSession(session);
    setProfile(profile);

    updateHeaderIdentity(profile, session);

    setAuthenticatedView(true);
    sessionHandler(session);

    if (isOnboardingRequired(profile)) {
      openOnboarding(profile, session);
    } else {
      closeOnboarding();
    }
  });
}

export { authService };
