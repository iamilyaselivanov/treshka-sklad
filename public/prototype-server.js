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
  };

  function normalizedState() {
    const state = serializeAppState();
    // Аккаунты и пароли хранятся отдельной серверной системой авторизации.
    state.accounts = [];
    state.currentAccountId = null;
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

  async function uploadIfChanged() {
    if (!sync.ready || sync.busy) return;
    const state = normalizedState();
    const payload = JSON.stringify(state);
    if (payload === sync.lastUploaded) return;
    sync.busy = true;
    try {
      const response = await fetch("/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Ошибка сохранения");
      sync.revision = data.revision;
      sync.lastUploaded = payload;
    } catch (error) {
      console.error("server state upload failed", error);
      toast("⚠ Сервер не сохранил изменения. Повторяем автоматически.");
    } finally {
      sync.busy = false;
    }
  }

  async function initialize() {
    try {
      const [authResponse, response] = await Promise.all([
        fetch("/api/auth/status", { cache: "no-store" }),
        fetch("/api/state", { cache: "no-store" }),
      ]);
      const auth = await authResponse.json();
      if (!authResponse.ok || !auth.user) {
        parent.postMessage({ type: "treshka-auth-required" }, location.origin);
        return;
      }
      sync.user = auth.user;
      installServerAccountControls();
      if (["owner", "admin"].includes(sync.user.role)) await refreshServerAccounts();
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось получить склад");
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
      sync.timer = window.setInterval(uploadIfChanged, 1800);
      window.addEventListener("beforeunload", () => { void uploadIfChanged(); });
    } catch (error) {
      console.error("server initialization failed", error);
      toast("⚠ Нет связи с сервером. Изменения сохраняются на устройстве.");
      sync.ready = true;
      sync.timer = window.setInterval(uploadIfChanged, 3000);
    }
  }

  window.treshkaServerSync = {
    status: () => ({
      ready: sync.ready,
      busy: sync.busy,
      revision: sync.revision,
      payloadBytes: sync.lastUploaded.length,
    }),
    flush: uploadIfChanged,
  };

  void initialize();
})();
