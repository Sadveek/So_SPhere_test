function createToastElement(message, tone) {
  const el = document.createElement("div");
  el.className = `toast ${tone ? `toast--${tone}` : ""}`.trim();
  el.textContent = message;
  return el;
}

const NOTIFICATION_KEY = "socialsphere.notifications.v1";
const NOTIFICATION_ENABLED_KEY = "socialsphere.notifications.enabled.v1";
const NOTIFICATION_TYPE_KEY = "socialsphere.notifications.type.v1";
let notifications = [];
let loadingToastState = null;

function loadNotifications() {
  try {
    const raw = localStorage.getItem(NOTIFICATION_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      notifications = [];
      return;
    }
    const byKey = new Map();
    for (const item of parsed) {
      const message = String(item?.message || "").trim();
      if (!message) {
        continue;
      }
      const category = item?.category === "messages" || item?.category === "followers" ? item.category : "followers";
      const dedupeKey = `${category}:${message.toLowerCase()}`;
      const createdAt = String(item?.createdAt || "");
      const existing = byKey.get(dedupeKey);
      if (!existing || new Date(createdAt).getTime() > new Date(existing.createdAt || 0).getTime()) {
        byKey.set(dedupeKey, {
          id: String(item?.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
          message,
          category,
          createdAt: createdAt || new Date().toISOString(),
          read: Boolean(item?.read),
          count: 1
        });
      }
    }
    notifications = [...byKey.values()];
  } catch {
    notifications = [];
  }
}

function saveNotifications() {
  localStorage.setItem(NOTIFICATION_KEY, JSON.stringify(notifications));
}

export function getNotificationsEnabled() {
  const raw = localStorage.getItem(NOTIFICATION_ENABLED_KEY);
  if (raw === null) {
    return true;
  }
  return raw === "true";
}

export function setNotificationsEnabled(enabled) {
  localStorage.setItem(NOTIFICATION_ENABLED_KEY, String(Boolean(enabled)));
}

export function getNotificationTypePreference() {
  const raw = localStorage.getItem(NOTIFICATION_TYPE_KEY);
  if (raw === "messages" || raw === "followers" || raw === "all") {
    return raw;
  }
  return "messages";
}

export function setNotificationTypePreference(value) {
  const next = value === "messages" || value === "followers" || value === "all" ? value : "messages";
  localStorage.setItem(NOTIFICATION_TYPE_KEY, next);
}

function canReceiveNotification(category) {
  const pref = getNotificationTypePreference();
  if (pref === "all") {
    return true;
  }
  if (pref === "messages") {
    return category === "messages";
  }
  if (pref === "followers") {
    return category === "followers";
  }
  return true;
}

export function shouldNotify(category = "followers") {
  return getNotificationsEnabled() && canReceiveNotification(category);
}

function formatNotificationTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
}

function renderNotifications() {
  const dot = document.getElementById("notifications-bell-dot");
  const list = document.getElementById("notifications-list");
  if (!dot || !list) {
    return;
  }

  const unreadCount = notifications.filter((item) => !item.read).length;
  dot.classList.toggle("hidden", unreadCount === 0);

  const sorted = [...notifications].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  if (!sorted.length) {
    list.innerHTML = "<p class='text-xs text-slate-500'>No notifications yet.</p>";
    return;
  }

  list.innerHTML = sorted
    .map(
      (item) => `
        <article class="rounded-md border border-slate-200 bg-slate-50 p-2">
          <p class="text-sm text-slate-800">${item.read ? "" : "<span class='mr-1 inline-block h-1.5 w-1.5 rounded-full bg-red-500'></span>"}${item.message}${item.count > 1 ? ` <span class='text-xs text-slate-500'>(x${item.count})</span>` : ""}</p>
          <p class="mt-1 text-[11px] text-slate-500">${formatNotificationTime(item.createdAt)}</p>
        </article>
      `
    )
    .join("");
}

export function pushNotification(message, category = "followers") {
  if (!message) {
    return;
  }
  if (!shouldNotify(category)) {
    return;
  }

  const dedupeKey = `${category}:${String(message).trim().toLowerCase()}`;
  const existingIndex = notifications.findIndex((item) => {
    const itemKey = `${item.category || "followers"}:${String(item.message || "").trim().toLowerCase()}`;
    return itemKey === dedupeKey;
  });

  if (existingIndex !== -1) {
    const existing = notifications[existingIndex];
    notifications[existingIndex] = {
      ...existing,
      createdAt: new Date().toISOString(),
      read: false,
      count: 1
    };
    saveNotifications();
    renderNotifications();
    return;
  }

  notifications.push({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    message,
    category,
    createdAt: new Date().toISOString(),
    read: false,
    count: 1
  });

  if (notifications.length > 120) {
    notifications = notifications.slice(-120);
  }

  saveNotifications();
  renderNotifications();
}

export function initNotificationCenter() {
  loadNotifications();
  renderNotifications();

  const bellButton = document.getElementById("notifications-bell-btn");
  const panel = document.getElementById("notifications-panel");
  const clearButton = document.getElementById("notifications-clear-btn");
  if (!bellButton || !panel) {
    return;
  }

  bellButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const isHidden = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !isHidden);

    if (isHidden) {
      notifications = notifications.map((item) => ({ ...item, read: true }));
      saveNotifications();
      renderNotifications();
    }
  });

  clearButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    notifications = [];
    saveNotifications();
    renderNotifications();
  });

  document.addEventListener("click", (event) => {
    if (!panel.contains(event.target) && !bellButton.contains(event.target)) {
      panel.classList.add("hidden");
    }
  });
}

export function showToast(message, tone = "success") {
  const container = document.getElementById("toast-container");
  if (!container) {
    return;
  }

  const toast = createToastElement(message, tone);
  let removeTimer;
  const dismiss = () => {
    if (!toast.isConnected) {
      return;
    }
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-6px)";
    toast.style.transition = "all 220ms ease";
    setTimeout(() => toast.remove(), 220);
  };
  toast.addEventListener("click", dismiss);
  toast.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      dismiss();
    }
  });
  toast.setAttribute("tabindex", "0");
  toast.setAttribute("role", "status");
  container.appendChild(toast);

  removeTimer = setTimeout(dismiss, 2800);
  toast.addEventListener("mouseenter", () => {
    if (removeTimer) {
      clearTimeout(removeTimer);
      removeTimer = null;
    }
  });
  toast.addEventListener("mouseleave", () => {
    if (!toast.isConnected) {
      return;
    }
    removeTimer = setTimeout(dismiss, 1400);
  });
}

export function showLoadingToast(baseMessage = "Loading") {
  const container = document.getElementById("toast-container");
  if (!container) {
    return () => {};
  }

  if (loadingToastState?.timer) {
    clearInterval(loadingToastState.timer);
  }
  if (loadingToastState?.el?.isConnected) {
    loadingToastState.el.remove();
  }

  let dots = 1;
  const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const toast = createToastElement(`${baseMessage}.`, "");
  container.appendChild(toast);

  const timer = setInterval(() => {
    dots = dots >= 5 ? 1 : dots + 1;
    toast.textContent = `${baseMessage}${".".repeat(dots)}`;
  }, 320);

  loadingToastState = { token, el: toast, timer };

  return () => {
    if (!loadingToastState || loadingToastState.token !== token) {
      return;
    }

    clearInterval(loadingToastState.timer);
    loadingToastState.el.style.opacity = "0";
    loadingToastState.el.style.transform = "translateY(-6px)";
    loadingToastState.el.style.transition = "all 180ms ease";
    const el = loadingToastState.el;
    loadingToastState = null;
    setTimeout(() => el.remove(), 180);
  };
}

export function setButtonBusy(button, busyText, isBusy) {
  if (!button) {
    return;
  }

  if (!button.dataset.idleText) {
    button.dataset.idleText = button.textContent;
  }

  button.disabled = isBusy;
  button.textContent = isBusy ? busyText : button.dataset.idleText;
}

export function showSection(sectionId) {
  document.getElementById(sectionId)?.classList.remove("hidden");
}

export function hideSection(sectionId) {
  document.getElementById(sectionId)?.classList.add("hidden");
}
