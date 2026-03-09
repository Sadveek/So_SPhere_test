
import { initAuthModule } from "./modules/auth.js";
import { initFeedModule, loadFeed, renderFeed, stopFeedRealtime } from "./modules/feed.js";
import { initMessagesModule } from "./modules/messages.js";
import { initProfileModule } from "./modules/profile.js";
import {
  getNotificationTypePreference,
  getNotificationsEnabled,
  initNotificationCenter,
  setNotificationTypePreference,
  setNotificationsEnabled
} from "./modules/ui.js";
import { getState, setActiveView } from "./state/store.js";

const THEME_STORAGE_KEY = "socialsphere-theme";
const FONT_STORAGE_KEY = "socialsphere-font";
const SCALE_STORAGE_KEY = "socialsphere-ui-scale";
const NAV_ICONS_ONLY_KEY = "socialsphere.nav.iconsOnly.v1";
const NETWORK_COLLAPSED_KEY = "socialsphere.network.collapsed.v1";
const COMPACT_NOTIFICATION_BREAKPOINT = 1200;
const MOBILE_NAV_BREAKPOINT = 900;
let networkPanelCollapsed = localStorage.getItem(NETWORK_COLLAPSED_KEY) === "true";
let navActivateTimer = null;
const THEME_SPHERE_SPIN_THRESHOLD = 85;
const THEME_SPHERE_TOGGLE_COOLDOWN_MS = 1700;
const THEME_SPHERE_IDLE_SPEED_DPS = 20;

function applyNetworkPanelState(activeView) {
  const sidebar = document.getElementById("app-sidebar");
  const appLayout = document.getElementById("app-layout");
  const networkToggleButton = document.getElementById("network-toggle-btn");
  const isFeedView = activeView === "feed";
  const showNetworkPanel = isFeedView && !networkPanelCollapsed;

  sidebar?.classList.toggle("hidden", !showNetworkPanel);
  appLayout?.classList.toggle("layout-single", !isFeedView);
  appLayout?.classList.toggle("network-collapsed", isFeedView && networkPanelCollapsed);

  if (networkToggleButton) {
    networkToggleButton.classList.toggle("feed-tool-icon--active", !networkPanelCollapsed);
    networkToggleButton.setAttribute("aria-label", networkPanelCollapsed ? "Show network panel" : "Hide network panel");
    networkToggleButton.setAttribute("title", networkPanelCollapsed ? "Show network panel" : "Hide network panel");
    networkToggleButton.setAttribute("aria-pressed", String(!networkPanelCollapsed));
  }
}

function setNavState(activeView) {
  const feedButton = document.getElementById("nav-feed");
  const messagesButton = document.getElementById("nav-messages");
  const usersButton = document.getElementById("nav-users");
  const profileButton = document.getElementById("nav-profile");
  const settingsButton = document.getElementById("nav-settings");
  const feedView = document.getElementById("feed-view");
  const messagesView = document.getElementById("messages-view");
  const usersView = document.getElementById("users-view");
  const profileView = document.getElementById("profile-view");
  const settingsView = document.getElementById("settings-view");

  feedButton.classList.toggle("nav-btn--active", activeView === "feed");
  messagesButton.classList.toggle("nav-btn--active", activeView === "messages");
  usersButton.classList.toggle("nav-btn--active", activeView === "users");
  profileButton.classList.toggle("nav-btn--active", activeView === "profile");
  settingsButton.classList.toggle("nav-btn--active", activeView === "settings");

  const activeButton = [feedButton, messagesButton, usersButton, profileButton, settingsButton]
    .find((button) => button?.classList.contains("nav-btn--active"));
  if (activeButton) {
    activeButton.classList.remove("nav-btn--activating");
    // Force reflow so repeated clicks retrigger the activation animation.
    void activeButton.offsetWidth;
    activeButton.classList.add("nav-btn--activating");
    if (navActivateTimer) {
      clearTimeout(navActivateTimer);
    }
    navActivateTimer = setTimeout(() => {
      activeButton.classList.remove("nav-btn--activating");
    }, 240);
  }

  feedView.classList.toggle("hidden", activeView !== "feed");
  messagesView.classList.toggle("hidden", activeView !== "messages");
  usersView.classList.toggle("hidden", activeView !== "users");
  profileView.classList.toggle("hidden", activeView !== "profile");
  settingsView.classList.toggle("hidden", activeView !== "settings");
  applyNetworkPanelState(activeView);
}

function applyTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.body.dataset.theme = nextTheme;
  localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  document.querySelectorAll(".theme-sphere").forEach((sphere) => {
    sphere.dataset.theme = nextTheme;
  });
}

function initializeThemeSpheres() {
  const spheres = document.querySelectorAll(".theme-sphere");
  if (!spheres.length) {
    return;
  }

  let lastFrameAt = performance.now();
  let themeToggleLastAt = 0;
  const sphereStates = [];

  for (const sphere of spheres) {
    let pointerId = null;
    let lastX = 0;
    let rotateY = 0;
    let spunDistance = 0;
    let isDragging = false;

    const setRotation = (value) => {
      rotateY = value;
      sphere.style.setProperty("--sphere-ry", `${rotateY}deg`);
    };

    sphereStates.push({
      tick: (deltaSeconds) => {
        if (isDragging) {
          return;
        }
        setRotation(rotateY + THEME_SPHERE_IDLE_SPEED_DPS * deltaSeconds);
      }
    });

    const resetGesture = () => {
      const activePointerId = pointerId;
      pointerId = null;
      spunDistance = 0;
      isDragging = false;
      sphere.classList.remove("is-dragging");
      if (activePointerId !== null) {
        try {
          sphere.releasePointerCapture?.(activePointerId);
        } catch {
          // Ignore if pointer capture is unavailable.
        }
      }
    };

    sphere.addEventListener("pointerdown", (event) => {
      pointerId = event.pointerId;
      lastX = event.clientX;
      spunDistance = 0;
      isDragging = true;
      sphere.classList.add("is-dragging");
      sphere.setPointerCapture?.(pointerId);
    });

    sphere.addEventListener("pointermove", (event) => {
      if (pointerId !== event.pointerId) {
        return;
      }
      const dx = event.clientX - lastX;
      lastX = event.clientX;
      spunDistance += Math.abs(dx);
      setRotation(rotateY + dx * 1.2);

      const now = Date.now();
      if (spunDistance >= THEME_SPHERE_SPIN_THRESHOLD && now - themeToggleLastAt >= THEME_SPHERE_TOGGLE_COOLDOWN_MS) {
        const nextTheme = document.body.dataset.theme === "dark" ? "light" : "dark";
        applyTheme(nextTheme);
        const toggle = document.getElementById("settings-theme-toggle");
        if (toggle) {
          toggle.checked = nextTheme === "dark";
        }
        themeToggleLastAt = now;
        spunDistance = 0;
      }
    });

    sphere.addEventListener("pointerup", (event) => {
      if (pointerId !== event.pointerId) {
        return;
      }
      resetGesture();
    });

    sphere.addEventListener("pointercancel", () => {
      resetGesture();
    });
  }

  const animateIdleSpin = () => {
    const now = performance.now();
    const deltaSeconds = Math.min(0.05, (now - lastFrameAt) / 1000);
    lastFrameAt = now;
    for (const state of sphereStates) {
      state.tick(deltaSeconds);
    }
    window.requestAnimationFrame(animateIdleSpin);
  };
  window.requestAnimationFrame(animateIdleSpin);
}

function applyFont(font) {
  const allowed = new Set(["poppins", "georgia", "trebuchet", "verdana", "times"]);
  const nextFont = allowed.has(font) ? font : "poppins";
  document.body.dataset.font = nextFont;
  localStorage.setItem(FONT_STORAGE_KEY, nextFont);
}

function applyUiScale(scale) {
  const allowed = new Set(["100", "125", "150"]);
  const nextScale = allowed.has(scale) ? scale : "100";
  const rootFontSizePx = (16 * Number(nextScale)) / 100;
  document.documentElement.style.fontSize = `${rootFontSizePx}px`;
  localStorage.setItem(SCALE_STORAGE_KEY, nextScale);
}

function applyNavIconsOnly(enabled) {
  const next = Boolean(enabled);
  document.body.classList.toggle("nav-icons-only", next);
  localStorage.setItem(NAV_ICONS_ONLY_KEY, String(next));
}

function applyResponsiveNavMode() {
  const isSmallScreen = window.matchMedia(`(max-width: ${MOBILE_NAV_BREAKPOINT}px)`).matches;
  document.body.classList.toggle("nav-icons-auto", isSmallScreen);
}

function syncNavigationIconSettingAvailability() {
  const navIconsToggle = document.getElementById("settings-nav-icons-toggle");
  const navIconsSettingCard = document.getElementById("settings-nav-icons-setting");
  if (!navIconsToggle) {
    return;
  }
  const isSmallScreen = window.matchMedia(`(max-width: ${MOBILE_NAV_BREAKPOINT}px)`).matches;
  navIconsSettingCard?.classList.toggle("hidden", isSmallScreen);
  navIconsToggle.disabled = isSmallScreen;
}

function initializeThemeToggle() {
  const themeToggle = document.getElementById("settings-theme-toggle");
  const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  const initialTheme = storedTheme === "dark" ? "dark" : "light";

  applyTheme(initialTheme);
  themeToggle.checked = initialTheme === "dark";

  themeToggle.addEventListener("change", () => {
    applyTheme(themeToggle.checked ? "dark" : "light");
  });
}

function initializeFontSettings() {
  const toggleButton = document.getElementById("settings-font-toggle-btn");
  const panel = document.getElementById("settings-font-panel");
  const radios = document.querySelectorAll('input[name="settings-font"]');
  const storedFont = localStorage.getItem(FONT_STORAGE_KEY) || "poppins";

  applyFont(storedFont);
  radios.forEach((radio) => {
    radio.checked = radio.value === document.body.dataset.font;
  });

  toggleButton.addEventListener("click", () => {
    panel.classList.toggle("hidden");
  });

  radios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        applyFont(radio.value);
      }
    });
  });
}

function initializeUiScaleSettings() {
  const uiScaleSelect = document.getElementById("settings-ui-scale");
  const storedScale = localStorage.getItem(SCALE_STORAGE_KEY) || "100";

  applyUiScale(storedScale);
  uiScaleSelect.value = storedScale;

  uiScaleSelect.addEventListener("change", () => {
    applyUiScale(uiScaleSelect.value);
  });
}

function initializeNotificationSettings() {
  const notificationsToggle = document.getElementById("settings-notifications-toggle");
  const preferencesSection = document.getElementById("settings-notification-preferences");
  const typeSelect = document.getElementById("settings-notification-type");
  if (!notificationsToggle) {
    return;
  }

  const syncVisibility = () => {
    preferencesSection?.classList.toggle("hidden", !notificationsToggle.checked);
  };

  notificationsToggle.checked = getNotificationsEnabled();
  if (typeSelect) {
    typeSelect.value = getNotificationTypePreference();
  }
  syncVisibility();

  notificationsToggle.addEventListener("change", () => {
    setNotificationsEnabled(notificationsToggle.checked);
    syncVisibility();
  });

  typeSelect?.addEventListener("change", () => {
    setNotificationTypePreference(typeSelect.value);
  });
}

function initializeNavigationIconSettings() {
  const navIconsToggle = document.getElementById("settings-nav-icons-toggle");
  if (!navIconsToggle) {
    return;
  }

  const storedPreference = localStorage.getItem(NAV_ICONS_ONLY_KEY);
  const isSmallScreen = window.matchMedia(`(max-width: ${MOBILE_NAV_BREAKPOINT}px)`).matches;
  const iconsOnlyEnabled = storedPreference === null ? isSmallScreen : storedPreference === "true";
  applyNavIconsOnly(iconsOnlyEnabled);
  navIconsToggle.checked = iconsOnlyEnabled;
  syncNavigationIconSettingAvailability();

  navIconsToggle.addEventListener("change", () => {
    applyNavIconsOnly(navIconsToggle.checked);
  });
}

function updateNotificationPlacement() {
  // Notifications now live in the top nav row across viewports.
}

function navigateToView(view) {
  setActiveView(view);
  setNavState(view);
  window.scrollTo({ top: 0, behavior: "auto" });
}

function bindNavigation(profileApi) {
  const feedButton = document.getElementById("nav-feed");
  const messagesButton = document.getElementById("nav-messages");
  const usersButton = document.getElementById("nav-users");
  const profileButton = document.getElementById("nav-profile");
  const settingsButton = document.getElementById("nav-settings");

  feedButton.addEventListener("click", () => {
    navigateToView("feed");
  });

  messagesButton.addEventListener("click", () => {
    navigateToView("messages");
  });

  usersButton.addEventListener("click", () => {
    navigateToView("users");
  });

  profileButton.addEventListener("click", async () => {
    navigateToView("profile");

    const state = getState();
    if (state.profile) {
      await profileApi.openProfile(state.profile.uid);
    }
  });

  settingsButton.addEventListener("click", () => {
    navigateToView("settings");
  });
}

async function bootstrapAuthenticatedState(profileApi, messagesApi) {
  setActiveView("feed");
  setNavState("feed");
  await loadFeed();
  await messagesApi.initializeMessagesForSession();
  await profileApi.initializeProfileForSession();
  renderFeed();
}

function initModules() {
  const profileApi = initProfileModule();
  const messagesApi = initMessagesModule();
  initNotificationCenter();
  initializeThemeToggle();
  initializeThemeSpheres();
  initializeFontSettings();
  initializeUiScaleSettings();
  initializeNotificationSettings();
  initializeNavigationIconSettings();
  applyResponsiveNavMode();
  updateNotificationPlacement();
  window.addEventListener("resize", () => {
    updateNotificationPlacement();
    applyResponsiveNavMode();
    syncNavigationIconSettingAvailability();
  });

  initFeedModule({
    onOpenProfile: async (uid) => {
      navigateToView("profile");
      await profileApi.openProfile(uid);
    }
  });

  const networkToggleButton = document.getElementById("network-toggle-btn");
  networkToggleButton?.addEventListener("click", () => {
    networkPanelCollapsed = !networkPanelCollapsed;
    localStorage.setItem(NETWORK_COLLAPSED_KEY, String(networkPanelCollapsed));
    applyNetworkPanelState(getState().activeView || "feed");
  });

  bindNavigation(profileApi);

  initAuthModule(async (session) => {
    if (!session) {
      stopFeedRealtime();
      messagesApi.cleanupMessagesModule();
      profileApi.cleanupProfileModule();
      return;
    }
    await bootstrapAuthenticatedState(profileApi, messagesApi);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initModules();
});
