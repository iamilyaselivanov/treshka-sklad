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
  };

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

  const localRenderAccounts = window.renderAccounts;

  async function refreshServerAccounts() {
    if (!sync.user || !["owner", "admin"].includes(sync.user.role)) return;
    const response = await fetch("/api/users", { cache: "no-store" });
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
      const response = await fetch("/api/users", {
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
      const response = await fetch("/api/users?id=" + encodeURIComponent(id), { method: "DELETE" });
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
    const response = await fetch("/api/media/images", {
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
    const response = await fetch("/api/media/images?key=" + encodeURIComponent(key), { method: "DELETE" });
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
    const response = await fetch("/api/state", { cache: "no-store" });
    const data = await response.json();
    if (response.status === 401 || !data.user) {
      parent.postMessage({ type: "treshka-auth-required" }, location.origin);
      throw new Error("Требуется повторный вход");
    }
    if (!response.ok) throw new Error(data.error || "Не удалось получить склад");
    return data;
  }

  async function uploadIfChanged() {
    if (!sync.ready || sync.busy || sync.conflict) return;
    const state = normalizedState();
    const payload = JSON.stringify(state);
    if (payload === sync.lastUploaded) return;
    sync.busy = true;
    try {
      const response = await fetch("/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, expectedRevision: sync.revision }),
      });
      const data = await response.json();
      if (response.status === 409 && data.conflict) {
        announceConflict(await fetchSnapshot());
        return;
      }
      if (!response.ok) throw new Error(data.error || "Ошибка сохранения");
      sync.revision = data.revision;
      sync.lastUploaded = payload;
      sync.lastError = null;
      void cleanupPendingMedia();
    } catch (error) {
      console.error("server state upload failed", error);
      sync.lastError = error.message || "Ошибка сохранения";
      toast("⚠ Сервер не сохранил изменения. Повторяем автоматически.");
    } finally {
      sync.busy = false;
    }
  }

  async function pollServer() {
    if (!sync.ready || sync.busy || sync.conflict) return;
    sync.busy = true;
    try {
      const snapshot = await fetchSnapshot();
      if (Number(snapshot.revision || 0) <= sync.revision) return;
      const localPayload = JSON.stringify(normalizedState());
      if (localPayload !== sync.lastUploaded) {
        announceConflict(snapshot);
        return;
      }
      applyRemoteSnapshot(snapshot, true);
    } catch (error) {
      console.error("server state poll failed", error);
      sync.lastError = error.message || "Ошибка синхронизации";
    } finally {
      sync.busy = false;
    }
  }

  async function synchronize() {
    if (!sync.ready || sync.busy || sync.conflict) return;
    const localPayload = JSON.stringify(normalizedState());
    if (localPayload !== sync.lastUploaded) await uploadIfChanged();
    else await pollServer();
  }

  async function resolveConflict(strategy) {
    if (!sync.conflict || !sync.pendingRemote) return;
    const snapshot = sync.pendingRemote;
    if (strategy === "server") {
      // Снимок применяется ДО снятия флага конфликта. Раньше состояние
      // сбрасывалось первым, а applyRemoteSnapshot мог бросить исключение на
      // несовместимых данных: конфликт при этом уже считался разрешённым,
      // баннер исчезал, а sync.revision уже равнялся серверной ревизии — и
      // следующий же тик синхронизации отправлял ЛОКАЛЬНОЕ состояние с
      // expectedRevision = серверной. Сервер его принимал, и выбранная
      // пользователем серверная версия молча затиралась.
      const previousRevision = sync.revision;
      try {
        applyRemoteSnapshot(snapshot, false);
      } catch (error) {
        console.error("conflict resolution (server) failed", error);
        sync.revision = previousRevision;
        sync.lastError = error.message || "Не удалось применить серверную версию";
        toast("⚠ Не удалось применить серверную версию. Конфликт не разрешён.");
        return;
      }
      // Удаления медиа отменяются только после успешного применения: иначе при
      // ошибке ключи терялись, а объекты в R2 оставались навсегда.
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
      await uploadIfChanged();
    }
    parent.postMessage({ type: "treshka-sync-resolved" }, location.origin);
  }

  async function initialize() {
    try {
      const data = await fetchSnapshot();
      sync.user = data.user;
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
      sync.lastUploaded = data.state ? JSON.stringify(normalizedState()) : "";
      sync.ready = true;
      go("sklad");
      if (!data.state) await uploadIfChanged();
      else void migrateEmbeddedPhotos();
      sync.timer = window.setInterval(synchronize, 2500);
      window.addEventListener("beforeunload", () => { void uploadIfChanged(); });
    } catch (error) {
      console.error("server initialization failed", error);
      toast("⚠ Нет связи с сервером. Изменения сохраняются на устройстве.");
      sync.ready = true;
      sync.lastError = error.message || "Нет связи с сервером";
      sync.timer = window.setInterval(synchronize, 3000);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.data?.type !== "treshka-sync-resolve") return;
    if (event.data.strategy === "server" || event.data.strategy === "local") {
      // Без catch отказ разрешения конфликта уходил в unhandled rejection:
      // пользователь видел только застывший баннер без причины.
      resolveConflict(event.data.strategy).catch((error) => {
        console.error("conflict resolution failed", error);
        sync.lastError = error.message || "Не удалось разрешить конфликт";
        toast("⚠ Не удалось разрешить конфликт. Попробуйте ещё раз.");
      });
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
