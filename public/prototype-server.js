(function () {
  "use strict";
  if (location.protocol === "file:") return;

  const sync = {
    revision: 0,
    lastUploaded: "",
    busy: false,
    ready: false,
    user: null,
    timer: null,
    conflict: false,
    pendingRemote: null,
    lastError: null,
    pendingMediaDeletes: new Set(),
    consecutiveFailures: 0,
    nextAttemptAt: 0,
  };
  const push = {
    registering: false,
    registeredKey: "",
    flushing: false,
    queue: [],
    retryTimer: null,
    retryFailures: 0,
    registrationFailures: 0,
    nextRegistrationAt: 0,
  };
  const PUSH_QUEUE_KEY = "treshka_push_events_v1";

  async function fetchWithTimeout(input, init = {}, timeoutMs = 15_000) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      window.clearTimeout(timer);
    }
  }

  function nativePushRegistration() {
    try {
      if (!window.AndroidPush || typeof window.AndroidPush.registration !== "function") return null;
      const registration = JSON.parse(window.AndroidPush.registration());
      if (!registration || typeof registration !== "object") return null;
      const deviceId = String(registration.deviceId || "");
      const token = String(registration.token || "");
      if (!deviceId || !token) return null;
      return {
        deviceId,
        token,
        platform: "android",
        appVersion: String(registration.appVersion || ""),
      };
    } catch (error) {
      console.warn("native push registration unavailable", error);
      return null;
    }
  }

  async function registerNativePush() {
    if (!sync.user || push.registering) return false;
    if (Date.now() < push.nextRegistrationAt) return false;
    const registration = nativePushRegistration();
    if (!registration) return false;
    const key = `${sync.user.id}:${registration.deviceId}:${registration.token}`;
    if (push.registeredKey === key) return true;
    push.registering = true;
    try {
      const response = await fetchWithTimeout("/api/devices/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registration),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Устройство не зарегистрировано");
      push.registeredKey = key;
      push.registrationFailures = 0;
      push.nextRegistrationAt = 0;
      return true;
    } catch (error) {
      console.warn("push registration failed", error);
      push.registrationFailures += 1;
      push.nextRegistrationAt = Date.now() + Math.min(5 * 60_000, 5_000 * (2 ** Math.min(6, push.registrationFailures - 1)));
      return false;
    } finally {
      push.registering = false;
    }
  }

  function savePushQueue() {
    try {
      localStorage.setItem(PUSH_QUEUE_KEY, JSON.stringify(push.queue.slice(-100)));
    } catch (error) {
      console.warn("push queue was not persisted", error);
    }
  }

  function loadPushQueue() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PUSH_QUEUE_KEY) || "[]");
      push.queue = Array.isArray(parsed)
        ? parsed.filter((entry) => entry && entry.actorUserId === sync.user?.id).slice(-100)
        : [];
    } catch {
      push.queue = [];
    }
    savePushQueue();
  }

  function schedulePushRetry() {
    if (push.retryTimer) return;
    push.retryFailures += 1;
    const delay = Math.min(5 * 60_000, 5_000 * (2 ** Math.min(6, push.retryFailures - 1)));
    push.retryTimer = window.setTimeout(() => {
      push.retryTimer = null;
      void flushPushQueue();
    }, delay);
  }

  async function flushPushQueue() {
    if (!sync.user || push.flushing || !push.queue.length) return;
    push.flushing = true;
    try {
      while (push.queue.length) {
        const event = push.queue[0];
        if (event.actorUserId !== sync.user.id) {
          push.queue.shift();
          savePushQueue();
          continue;
        }
        const response = await fetchWithTimeout("/api/notifications/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event.payload),
        });
        const data = await response.json();
        if (!response.ok) {
          if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            console.warn("push event rejected", data.error || response.status);
            push.queue.shift();
            savePushQueue();
            continue;
          }
          throw new Error(data.error || "Событие push не отправлено");
        }
        push.queue.shift();
        savePushQueue();
      }
      push.retryFailures = 0;
    } catch (error) {
      console.warn("push event delivery deferred", error);
      schedulePushRetry();
    } finally {
      push.flushing = false;
    }
  }

  window.treshkaServerRole = () => sync.user?.role || "";
  window.treshkaEmitPushEvent = function (type, details = {}) {
    if (!sync.user || !type) return "";
    const payload = {
      eventId: crypto.randomUUID(),
      type: String(type),
      post: String(details.post || ""),
      entityNo: String(details.entityNo || ""),
      summary: String(details.summary || ""),
    };
    push.queue.push({ actorUserId: sync.user.id, payload });
    savePushQueue();
    void flushPushQueue();
    return payload.eventId;
  };
  window.onNativePushRegistration = () => { void registerNativePush(); };

  function noteSyncSuccess() {
    sync.consecutiveFailures = 0;
    sync.nextAttemptAt = 0;
  }

  function noteSyncFailure() {
    sync.consecutiveFailures += 1;
    const exponent = Math.min(sync.consecutiveFailures - 1, 6);
    sync.nextAttemptAt = Date.now() + Math.min(60_000, 1_000 * (2 ** exponent));
  }

  function normalizedState() {
    const state = serializeAppState();
    // Аккаунты и пароли хранятся отдельной серверной системой авторизации.
    state.accounts = [];
    state.currentAccountId = null;
    delete state.currentRole;
    delete state.currentUserPost;
    return state;
  }

  function applyServerRole() {
    if (!sync.user) return;
    currentRole = sync.user.role === "owner" || sync.user.role === "admin"
      ? "admin"
      : sync.user.role === "storekeeper"
        ? "kladovshik"
        : "rabotnik";
    if (sync.user.assignment) currentUserPost = sync.user.assignment;
    updateNavForRole();
  }

  function canUploadState() {
    return !!sync.user && ["owner", "admin", "storekeeper"].includes(sync.user.role);
  }

  const localRenderAccounts = window.renderAccounts;

  async function refreshServerAccounts() {
    if (!sync.user || !["owner", "admin"].includes(sync.user.role)) return;
    const response = await fetchWithTimeout("/api/users", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось загрузить аккаунты");
    accounts.length = 0;
    accounts.push(...(data.users || []).map((user) => ({
      id: user.id,
      callsign: user.callsign,
      login: user.login,
      serverRole: user.role,
      role: user.role === "owner" || user.role === "admin" ? "admin" : user.role === "storekeeper" ? "kladovshik" : "rabotnik",
      post: user.assignment || null,
      active: user.status === "active",
    })));
  }

  function installServerAccountControls() {
    window.requestRoleSwitch = () => toast("Роль назначается владельцем и меняется только после входа под другим аккаунтом.");
    window.confirmRoleSwitch = window.requestRoleSwitch;
    window.requestPostSwitch = () => toast("Пост назначается владельцем в аккаунте сотрудника.");
    window.confirmPostSwitch = window.requestPostSwitch;

    window.renderAccounts = async function () {
      try {
        await refreshServerAccounts();
        localRenderAccounts();
      } catch (error) {
        toast("⚠ " + (error.message || "Не удалось загрузить аккаунты"));
      }
    };

    window.createAccount = async function () {
      if (!sync.user || !["owner", "admin"].includes(sync.user.role)) {
        toast("Доступно только владельцу или администратору");
        return false;
      }
      const callsign = $("accountCallsign").value.trim();
      const login = $("accountLogin").value.trim();
      const password = $("accountPassword").value;
      const legacyRole = $("accountRole").value;
      const assignment = legacyRole === "rabotnik" ? $("accountPost").value : "";
      const role = legacyRole === "kladovshik" ? "storekeeper" : legacyRole === "rabotnik" ? "worker" : "admin";
      if (callsign.length < 2) { toast("Укажите позывной"); return false; }
      if (password.length < 8) { toast("Пароль должен содержать минимум 8 символов"); return false; }
      if (role === "worker" && !assignment) { toast("Выберите пост работника"); return false; }
      const response = await fetchWithTimeout("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callsign, login, password, role, assignment }),
      });
      const data = await response.json();
      if (!response.ok) { toast(data.error || "Аккаунт не создан"); return false; }
      toast("✓ Аккаунт создан на сервере");
      await window.renderAccounts();
      return true;
    };

    window.deleteServerAccount = async function (id) {
      const account = accounts.find((entry) => entry.id === id);
      if (!account || !confirm("Удалить аккаунт «" + (account.callsign || account.login) + "»?")) return false;
      const response = await fetchWithTimeout("/api/users?id=" + encodeURIComponent(id), { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) { toast(data.error || "Аккаунт не удалён"); return false; }
      toast("✓ Аккаунт удалён");
      await window.renderAccounts();
      return true;
    };
  }

  function rerenderCurrentView() {
    applyServerRole();
    if (typeof currentTab === "string" && views[currentTab]) {
      render({ fn: views[currentTab] }, false);
    }
  }

  window.treshkaStorePhoto = async function (dataUrl) {
    const response = await fetchWithTimeout("/api/media/images", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Фотография не сохранена");
    return data;
  };

  window.treshkaDeletePhoto = async function (key) {
    if (!key) return false;
    const response = await fetchWithTimeout("/api/media/images?key=" + encodeURIComponent(key), { method: "DELETE" });
    return response.ok;
  };

  async function cleanupPendingMedia() {
    for (const key of Array.from(sync.pendingMediaDeletes)) {
      try {
        if (await window.treshkaDeletePhoto(key)) sync.pendingMediaDeletes.delete(key);
      } catch (error) {
        console.warn("media cleanup deferred", error);
      }
    }
  }

  async function migrateEmbeddedPhotos() {
    const targets = [];
    for (const entry of items) {
      if (typeof entry.photo === "string" && entry.photo.startsWith("data:image/")) {
        targets.push({ entry, photoKey: "photo", mediaKey: "photoMedia" });
      }
    }
    for (const documentEntry of docs) {
      if (documentEntry.kind === "defekt"
        && typeof documentEntry.applicationPhoto === "string"
        && documentEntry.applicationPhoto.startsWith("data:image/")) {
        targets.push({ entry: documentEntry, photoKey: "applicationPhoto", mediaKey: "applicationPhotoMedia" });
      }
    }
    for (const target of targets) {
      const original = target.entry[target.photoKey];
      try {
        const stored = await window.treshkaStorePhoto(original);
        if (target.entry[target.photoKey] === original) {
          target.entry[target.photoKey] = stored.url;
          target.entry[target.mediaKey] = stored;
        }
      } catch (error) {
        console.warn("embedded photo migration deferred", error);
        break;
      }
    }
  }

  function announceConflict(snapshot) {
    sync.conflict = true;
    sync.pendingRemote = snapshot;
    sync.lastError = "Склад изменён на другом устройстве";
    parent.postMessage({
      type: "treshka-sync-conflict",
      updatedBy: snapshot.updatedBy || "другой пользователь",
      updatedAt: snapshot.updatedAt || null,
    }, location.origin);
  }

  function applyRemoteSnapshot(snapshot, showToast) {
    if (!snapshot || !snapshot.state || !applyAppState(snapshot.state)) {
      throw new Error("Сервер вернул несовместимые данные");
    }
    sync.revision = Number(snapshot.revision || 0);
    sync.lastUploaded = JSON.stringify(normalizedState());
    sync.lastError = null;
    rerenderCurrentView();
    if (showToast) toast("✓ Получены свежие данные склада");
  }

  async function fetchSnapshot() {
    const response = await fetchWithTimeout("/api/state", { cache: "no-store" });
    const data = await response.json();
    if (response.status === 401 || !data.user) {
      parent.postMessage({ type: "treshka-auth-required" }, location.origin);
      throw new Error("Требуется повторный вход");
    }
    if (!response.ok) throw new Error(data.error || "Не удалось получить склад");
    noteSyncSuccess();
    return data;
  }

  async function uploadIfChanged() {
    if (!sync.ready || sync.busy || sync.conflict || !canUploadState()) return false;
    const state = normalizedState();
    const payload = JSON.stringify(state);
    if (payload === sync.lastUploaded) return true;
    sync.busy = true;
    try {
      const response = await fetchWithTimeout("/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, expectedRevision: sync.revision }),
      });
      const data = await response.json();
      if (response.status === 409 && data.conflict) {
        announceConflict(await fetchSnapshot());
        return false;
      }
      if (!response.ok) throw new Error(data.error || "Ошибка сохранения");
      sync.revision = data.revision;
      sync.lastUploaded = payload;
      sync.lastError = null;
      noteSyncSuccess();
      void cleanupPendingMedia();
      return true;
    } catch (error) {
      console.error("server state upload failed", error);
      sync.lastError = error.message || "Ошибка сохранения";
      noteSyncFailure();
      toast("⚠ Сервер не сохранил изменения. Повторяем автоматически.");
      return false;
    } finally {
      sync.busy = false;
    }
  }

  async function pollServer() {
    if (!sync.ready || sync.busy || sync.conflict) return;
    sync.busy = true;
    try {
      const snapshot = await fetchSnapshot();
      const localPayload = JSON.stringify(normalizedState());
      const remoteRevision = Number(snapshot.revision || 0);
      if (remoteRevision <= sync.revision) {
        // Worker is a server-authoritative read-only role. Reapply the current
        // snapshot if local UI code changed state that it is not allowed to PUT.
        if (!canUploadState() && localPayload !== sync.lastUploaded && snapshot.state) {
          applyRemoteSnapshot(snapshot, false);
        }
        return;
      }
      if (canUploadState() && localPayload !== sync.lastUploaded) {
        announceConflict(snapshot);
        return;
      }
      applyRemoteSnapshot(snapshot, true);
      noteSyncSuccess();
    } catch (error) {
      console.error("server state poll failed", error);
      sync.lastError = error.message || "Ошибка синхронизации";
      noteSyncFailure();
    } finally {
      sync.busy = false;
    }
  }

  async function synchronize() {
    if (!sync.ready || sync.busy || sync.conflict) return;
    if (Date.now() < sync.nextAttemptAt) return;
    // Re-read the native token even after a successful registration: FCM can
    // rotate it while the app is open.
    void registerNativePush();
    if (push.queue.length) void flushPushQueue();
    if (!canUploadState()) {
      await pollServer();
      return;
    }
    const localPayload = JSON.stringify(normalizedState());
    if (localPayload !== sync.lastUploaded) await uploadIfChanged();
    else await pollServer();
  }

  async function resolveConflict(strategy) {
    if (!sync.conflict || !sync.pendingRemote) return false;
    if (strategy === "local" && !canUploadState()) {
      toast("Только владелец, администратор или кладовщик может сохранить локальную версию.");
      return false;
    }
    const snapshot = sync.pendingRemote;
    if (strategy === "server") {
      try {
        // Validate and apply first. If the snapshot is incompatible, the
        // conflict remains visible and the local state is not acknowledged as
        // resolved.
        applyRemoteSnapshot(snapshot, false);
      } catch (error) {
        sync.lastError = error.message || "Сервер вернул несовместимые данные";
        toast("⚠ Серверная версия повреждена. Локальные данные сохранены.");
        return false;
      }
      sync.pendingMediaDeletes.clear();
      sync.conflict = false;
      sync.pendingRemote = null;
      toast("✓ Загружена серверная версия");
    } else {
      sync.conflict = false;
      sync.pendingRemote = null;
      sync.revision = Number(snapshot.revision || 0);
      sync.lastUploaded = "";
      toast("Сохраняем ваши изменения поверх новой ревизии…");
      const uploaded = await uploadIfChanged();
      if (!uploaded) {
        // A fresh 409 installs a newer pending snapshot itself. For transport
        // errors restore the original conflict so pull cannot overwrite the
        // unsent local state and the user can retry explicitly.
        if (!sync.conflict) {
          sync.conflict = true;
          sync.pendingRemote = snapshot;
        }
        return false;
      }
    }
    parent.postMessage({ type: "treshka-sync-resolved" }, location.origin);
    return true;
  }

  async function initialize() {
    try {
      const data = await fetchSnapshot();
      sync.user = data.user;
      loadPushQueue();
      installServerAccountControls();
      sync.revision = data.revision || 0;
      if (data.state) {
        if (!applyAppState(data.state)) throw new Error("Сервер вернул несовместимые данные");
      } else {
        // Новая база: карточек товаров нет. Посты и полный функционал остаются.
        items.length = 0;
        posts.forEach((post) => { post.stock = []; });
        stockTransfers.length = 0;
        inventoryActs.length = 0;
      }
      applyServerRole();
      sync.lastUploaded = data.state || !canUploadState() ? JSON.stringify(normalizedState()) : "";
      sync.ready = true;
      go("sklad");
      if (!data.state && canUploadState()) await uploadIfChanged();
      else if (canUploadState()) void migrateEmbeddedPhotos();
      void registerNativePush();
      void flushPushQueue();
      sync.timer = window.setInterval(synchronize, 2500);
      window.addEventListener("beforeunload", () => { void uploadIfChanged(); });
    } catch (error) {
      console.error("server initialization failed", error);
      toast("⚠ Нет связи с сервером. Изменения сохраняются на устройстве.");
      sync.ready = true;
      sync.lastError = error.message || "Нет связи с сервером";
      noteSyncFailure();
      sync.timer = window.setInterval(synchronize, 3000);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.data?.type !== "treshka-sync-resolve") return;
    if (event.data.strategy === "server" || event.data.strategy === "local") {
      void resolveConflict(event.data.strategy);
    }
  });

  window.treshkaServerSync = {
    status: () => ({
      ready: sync.ready,
      busy: sync.busy,
      revision: sync.revision,
      payloadBytes: sync.lastUploaded.length,
      conflict: sync.conflict,
      lastError: sync.lastError,
    }),
    flush: synchronize,
    resolveConflict,
    queueMediaDelete: (key) => {
      if (/^images\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/.test(String(key || ""))) {
        sync.pendingMediaDeletes.add(key);
      }
    },
  };

  void initialize();
})();
