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
    lastServerStateJson: "",
    lastServerEtag: "",
    partial: false,
    mediaMigrationPromise: null,
  };
  const push = {
    registering: false,
    registeredKey: "",
    flushing: false,
    queue: [],
    retryTimer: null,
    retryAt: 0,
    registrationFailures: 0,
    nextRegistrationAt: 0,
  };
  const PUSH_QUEUE_KEY = "treshka_push_events_v1";
  const MAX_PUSH_QUEUE = 500;
  const PUSH_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

  function installServerPrivilegeGuards() {
    window.requestRoleSwitch = () => toast("Роль назначается владельцем и меняется только после входа под другим аккаунтом.");
    window.confirmRoleSwitch = window.requestRoleSwitch;
    window.requestPostSwitch = () => toast("Пост назначается владельцем в аккаунте сотрудника.");
    window.confirmPostSwitch = window.requestPostSwitch;
  }

  // Cached prototype state and its legacy PIN are never an authorization
  // source for the server-connected application.
  currentRole = "rabotnik";
  window.treshkaServerRole = () => sync.user?.role || null;
  installServerPrivilegeGuards();
  if (typeof updateNavForRole === "function") updateNavForRole();

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
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Устройство не зарегистрировано");
      if (data.evictedOldest) {
        console.warn("oldest push device was evicted for this account");
        if (typeof window.toast === "function") {
          window.toast("ℹ Старое устройство отключено от push-уведомлений из-за лимита устройств.");
        }
      }
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

  function reportDroppedPushEvents(count, reason) {
    if (!count) return;
    console.warn(`${count} push event(s) removed: ${reason}`);
    if (typeof window.toast === "function") {
      window.toast(`⚠ ${count} старых уведомлений удалено из локальной очереди: ${reason}`);
    }
  }

  function pruneExpiredPushEvents() {
    const cutoff = Date.now() - PUSH_EVENT_TTL_MS;
    const before = push.queue.length;
    push.queue = push.queue.filter((entry) => Number(entry.createdAt || Date.now()) >= cutoff);
    reportDroppedPushEvents(before - push.queue.length, "истёк срок хранения 7 дней");
  }

  function savePushQueue() {
    try {
      pruneExpiredPushEvents();
      localStorage.setItem(PUSH_QUEUE_KEY, JSON.stringify(push.queue));
    } catch (error) {
      console.warn("push queue was not persisted", error);
    }
  }

  function loadPushQueue() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PUSH_QUEUE_KEY) || "[]");
      const loadedAt = Date.now();
      push.queue = Array.isArray(parsed)
        ? parsed
          .filter((entry) => entry && entry.actorUserId && entry.payload)
          .map((entry) => ({ ...entry, createdAt: Number(entry.createdAt || loadedAt) }))
        : [];
      pruneExpiredPushEvents();
      if (push.queue.length > MAX_PUSH_QUEUE) {
        const overflow = push.queue.length - MAX_PUSH_QUEUE;
        push.queue.splice(0, overflow);
        reportDroppedPushEvents(overflow, "превышен безопасный предел очереди");
        savePushQueue();
      }
    } catch {
      push.queue = [];
    }
  }

  function schedulePushRetry(delay) {
    if (!Number.isFinite(delay)) return;
    const retryAt = Date.now() + Math.max(250, delay);
    if (push.retryTimer && push.retryAt <= retryAt) return;
    if (push.retryTimer) window.clearTimeout(push.retryTimer);
    push.retryAt = retryAt;
    push.retryTimer = window.setTimeout(() => {
      push.retryTimer = null;
      push.retryAt = 0;
      void flushPushQueue();
    }, Math.max(250, retryAt - Date.now()));
  }

  function nextPushIndex() {
    if (!sync.user) return -1;
    const now = Date.now();
    return push.queue.findIndex((entry) =>
      entry.actorUserId === sync.user.id && Number(entry.nextAttemptAt || 0) <= now);
  }

  function scheduleNextQueuedPush() {
    if (!sync.user) return;
    const next = push.queue
      .filter((entry) => entry.actorUserId === sync.user.id)
      .map((entry) => Number(entry.nextAttemptAt || 0))
      .sort((left, right) => left - right)[0];
    if (Number.isFinite(next)) schedulePushRetry(Math.max(250, next - Date.now()));
  }

  function deferPushEvent(eventIndex, event, reason) {
    event.attempts = Number(event.attempts || 0) + 1;
    const delay = Math.min(5 * 60_000, 5_000 * (2 ** Math.min(6, event.attempts - 1)));
    event.nextAttemptAt = Date.now() + delay;
    push.queue.splice(eventIndex, 1);
    push.queue.push(event);
    savePushQueue();
    console.warn("push event delivery deferred", reason);
  }

  async function flushPushQueue() {
    if (!sync.user || push.flushing || !push.queue.length) return;
    push.flushing = true;
    try {
      while (true) {
        const eventIndex = nextPushIndex();
        if (eventIndex < 0) break;
        const event = push.queue[eventIndex];
        let response;
        try {
          response = await fetchWithTimeout("/api/notifications/events", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(event.payload),
          });
        } catch (error) {
          deferPushEvent(eventIndex, event, error);
          continue;
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            console.warn("push event rejected", data.error || response.status);
            push.queue.splice(eventIndex, 1);
            savePushQueue();
            continue;
          }
          deferPushEvent(eventIndex, event, data.error || response.status);
          continue;
        }
        push.queue.splice(eventIndex, 1);
        savePushQueue();
      }
    } catch (error) {
      console.warn("push event delivery deferred", error);
      schedulePushRetry(5_000);
    } finally {
      push.flushing = false;
      scheduleNextQueuedPush();
    }
  }

  window.treshkaEmitPushEvent = function (type, details = {}) {
    if (!sync.user || !type) return "";
    pruneExpiredPushEvents();
    if (push.queue.length >= MAX_PUSH_QUEUE) {
      console.error("push event was not queued: local queue is full");
      if (typeof window.toast === "function") {
        window.toast("⚠ Очередь уведомлений заполнена. Новое событие не поставлено в очередь; проверьте связь с сервером.");
      }
      return "";
    }
    const payload = {
      eventId: crypto.randomUUID(),
      type: String(type),
      post: String(details.post || ""),
      entityNo: String(details.entityNo || ""),
      summary: String(details.summary || ""),
    };
    push.queue.push({
      actorUserId: sync.user.id,
      payload,
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: Date.now(),
    });
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
    // Keep the complete local journal available for the UI/export, but upload
    // a rolling server window. These arrays are operational feeds, unlike
    // inventoryActs, and replacing them here does not mutate application data.
    state.auditLog = Array.isArray(state.auditLog) ? state.auditLog.slice(0, 2_000) : [];
    state.notifications = Array.isArray(state.notifications) ? state.notifications.slice(0, 2_000) : [];
    // Аккаунты и пароли хранятся отдельной серверной системой авторизации.
    state.accounts = [];
    state.currentAccountId = null;
    delete state.currentRole;
    delete state.currentUserPost;
    delete state.savedAt;
    return state;
  }

  function applyServerRole() {
    if (!sync.user) return;
    const nextRole = typeof window.mapServerRoleToClientRole === "function"
      ? window.mapServerRoleToClientRole(sync.user.role)
      : "rabotnik";
    const roleChanged = currentRole !== nextRole;
    currentRole = nextRole;
    if (sync.user.assignment) currentUserPost = sync.user.assignment;
    updateNavForRole();
    if (roleChanged && typeof window.onTreshkaServerRoleChanged === "function") {
      window.onTreshkaServerRoleChanged(sync.user.role);
    }
  }

  function canUploadState() {
    return !!sync.user
      && !sync.partial
      && ["owner", "admin", "storekeeper"].includes(sync.user.role);
  }

  function adoptServerUser(user) {
    const previousAuthorization = sync.user
      ? `${sync.user.id}|${sync.user.role}|${sync.user.assignment || ""}`
      : "";
    const nextAuthorization = user
      ? `${user.id}|${user.role}|${user.assignment || ""}`
      : "";
    const authorizationChanged = previousAuthorization !== nextAuthorization;
    const changed = !sync.user || sync.user.id !== user.id;
    sync.user = user;
    applyServerRole();
    if (changed) {
      push.registeredKey = "";
      loadPushQueue();
      installServerAccountControls();
    }
    return authorizationChanged;
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
    installServerPrivilegeGuards();

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
      const data = await response.json().catch(() => ({}));
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
    if (sync.mediaMigrationPromise) return sync.mediaMigrationPromise;
    sync.mediaMigrationPromise = (async () => {
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
          } else if (stored.key) {
            sync.pendingMediaDeletes.add(stored.key);
          }
        } catch (error) {
          console.warn("embedded photo migration deferred", error);
          break;
        }
      }
    })();
    try {
      return await sync.mediaMigrationPromise;
    } finally {
      sync.mediaMigrationPromise = null;
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
    sync.partial = Boolean(snapshot.partial);
    // Never retain references to the live application graph. applyAppState()
    // intentionally reuses nested objects, so a reference cache would be
    // mutated by later local edits and could no longer represent server truth.
    sync.lastServerStateJson = JSON.stringify(snapshot.state);
    sync.lastUploaded = JSON.stringify(normalizedState());
    sync.lastError = null;
    rerenderCurrentView();
    if (showToast) toast("✓ Получены свежие данные склада");
  }

  async function fetchSnapshot({ forceFull = false } = {}) {
    const headers = {};
    if (!forceFull && sync.lastServerEtag) headers["if-none-match"] = sync.lastServerEtag;
    const response = await fetchWithTimeout("/api/state", { cache: "no-store", headers });
    if (response.status === 304) {
      if (!sync.lastServerStateJson) {
        throw new Error("Сервер не вернул снимок для пустого клиентского кэша");
      }
      noteSyncSuccess();
      return {
        revision: sync.revision,
        state: JSON.parse(sync.lastServerStateJson),
        user: sync.user,
        partial: sync.partial,
        authorizationChanged: false,
        unchanged: true,
      };
    }
    const data = await response.json();
    if (response.status === 401 || !data.user) {
      parent.postMessage({ type: "treshka-auth-required" }, location.origin);
      throw new Error("Требуется повторный вход");
    }
    if (!response.ok) throw new Error(data.error || "Не удалось получить склад");
    // The first request may fail while the device is offline. Adopt the user on
    // every later successful fetch before deciding whether local changes may be
    // uploaded; otherwise an owner is misclassified as read-only and poll can
    // overwrite their offline work.
    const previousPartial = sync.partial;
    data.authorizationChanged = adoptServerUser(data.user);
    data.partialChanged = Boolean(data.partial) !== previousPartial;
    if (data.state == null) sync.partial = Boolean(data.partial);
    sync.lastServerStateJson = data.state == null ? "" : JSON.stringify(data.state);
    sync.lastServerEtag = response.headers.get("etag") || "";
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
        body: JSON.stringify({ state, expectedRevision: sync.revision, partial: sync.partial }),
      });
      const data = await response.json();
      if (response.status === 409 && data.conflict) {
        announceConflict(await fetchSnapshot());
        return false;
      }
      if (
        response.status >= 400 && response.status < 500
        && response.status !== 408 && response.status !== 429
      ) {
        if (response.status === 413) {
          sync.lastError = data.error || "Снимок склада слишком велик";
          noteSyncFailure();
          // A size error cannot heal on the next 2.5-second tick. Give embedded
          // photo migration time to replace Base64 payloads with R2 URLs and
          // avoid uploading megabytes in a tight loop.
          sync.nextAttemptAt = Math.max(sync.nextAttemptAt, Date.now() + 30_000);
          void migrateEmbeddedPhotos();
          toast("⚠ " + sync.lastError + ". Удалите лишние локальные уведомления или архивные данные.");
          return false;
        }
        const snapshot = await fetchSnapshot();
        applyRemoteSnapshot(snapshot, false);
        sync.lastError = data.error || "Сервер отклонил изменение";
        toast("⚠ " + sync.lastError + ". Локальное изменение отменено.");
        return false;
      }
      if (!response.ok) throw new Error(data.error || "Ошибка сохранения");
      sync.revision = data.revision;
      sync.lastUploaded = payload;
      sync.lastServerStateJson = payload;
      sync.lastServerEtag = response.headers.get("etag") || "";
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
      if (
        snapshot.state
        && (snapshot.authorizationChanged || snapshot.partialChanged)
      ) {
        applyRemoteSnapshot(snapshot, false);
        noteSyncSuccess();
        return;
      }
      if (!snapshot.state && snapshot.partialChanged) {
        // Authorization scope changed while the response had no warehouse
        // graph. Never bless the local (possibly projected) graph as uploaded:
        // force one unconditional fetch before deciding what may be pushed.
        sync.lastUploaded = "";
        sync.lastServerStateJson = "";
        sync.lastServerEtag = "";
        const fullSnapshot = await fetchSnapshot({ forceFull: true });
        if (fullSnapshot.state) {
          applyRemoteSnapshot(fullSnapshot, false);
          noteSyncSuccess();
          return;
        }
        sync.revision = Number(fullSnapshot.revision || sync.revision);
        rerenderCurrentView();
        return;
      }
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
    if (push.queue.some((entry) => entry.actorUserId === sync.user?.id)) void flushPushQueue();
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
      sync.revision = data.revision || 0;
      sync.partial = Boolean(data.partial);
      if (data.state) {
        if (!applyAppState(data.state)) throw new Error("Сервер вернул несовместимые данные");
      } else {
        // Новая база: карточек товаров нет. Посты и полный функционал остаются.
        items.length = 0;
        posts.forEach((post) => { post.stock = []; });
        stockTransfers.length = 0;
        inventoryActs.length = 0;
      }
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

  async function stateHistoryRequest(path = "", init = {}) {
    const response = await fetchWithTimeout("/api/state/history" + path, {
      cache: "no-store",
      ...init,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "Не удалось выполнить операцию с историей ревизий");
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async function restoreStateRevision(revision) {
    if (sync.user?.role !== "owner") {
      throw new Error("Восстанавливать ревизии может только владелец");
    }
    const restored = await stateHistoryRequest("", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: Number(revision),
        expectedRevision: sync.revision,
      }),
    });
    // Re-read the canonical state immediately. The archived payload may have
    // contained references to product cards that the server deliberately
    // discarded while rebuilding the deletion guard index.
    sync.lastServerEtag = "";
    const snapshot = await fetchSnapshot({ forceFull: true });
    if (!snapshot.state) throw new Error("Сервер не вернул восстановленное состояние");
    applyRemoteSnapshot(snapshot, false);
    return restored;
  }

  window.treshkaStateHistory = {
    canView: () => !!sync.user && ["owner", "admin"].includes(sync.user.role),
    canRestore: () => sync.user?.role === "owner",
    list: () => stateHistoryRequest(),
    get: (revision) => stateHistoryRequest("?revision=" + encodeURIComponent(Number(revision))),
    restore: restoreStateRevision,
  };

  window.treshkaServerSync = {
    status: () => ({
      ready: sync.ready,
      busy: sync.busy,
      revision: sync.revision,
      payloadBytes: sync.lastUploaded.length,
      conflict: sync.conflict,
      partial: sync.partial,
      lastError: sync.lastError,
      consecutiveFailures: sync.consecutiveFailures,
      nextAttemptAt: sync.nextAttemptAt,
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
