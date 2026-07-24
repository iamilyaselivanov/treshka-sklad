"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Screen = "home" | "stock" | "posts" | "documents" | "more" | "users" | "security" | "audit";

type AuthUser = {
  id: string;
  callsign: string;
  login: string;
  role: "owner" | "admin" | "storekeeper" | "worker";
  assignment: string;
};

type Product = {
  id: string;
  name: string;
  sku: string;
  category: string;
  quantity: number;
  unit: string;
  location: string;
  minimum: number;
  createdAt: string;
};

const EMPTY_FORM = {
  name: "",
  sku: "",
  category: "",
  quantity: "0",
  unit: "шт",
  location: "",
  minimum: "0",
};

export default function Home() {
  const [status, setStatus] = useState<{ setupRequired: boolean; user: AuthUser | null } | null>(null);
  const [statusError, setStatusError] = useState("");
  const [recovering, setRecovering] = useState(false);

  const refresh = useCallback(async () => {
    setStatusError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch("/api/auth/status", { cache: "no-store", signal: controller.signal });
      const data = (await response.json()) as { setupRequired?: boolean; user?: AuthUser | null; error?: string };
      if (!response.ok || typeof data.setupRequired !== "boolean") {
        throw new Error(data.error || "Сервер вернул некорректный ответ");
      }
      setStatus({ setupRequired: data.setupRequired, user: data.user ?? null });
    } catch (error) {
      setStatusError(
        error instanceof DOMException && error.name === "AbortError"
          ? "Сервер не ответил за 15 секунд."
          : error instanceof Error ? error.message : "Нет связи с сервером.",
      );
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    // Initial server synchronization is intentionally performed once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  if (!status && statusError) {
    return (
      <AuthShell title="Нет связи с сервером" text={`${statusError} Проверьте интернет и повторите.`}>
        <button className="secondary" type="button" onClick={() => void refresh()}>Повторить подключение</button>
      </AuthShell>
    );
  }
  if (!status) return <AuthShell title="Проверяем доступ…" text="Подключаемся к серверу версии 1.6." />;
  if (status.setupRequired) {
    return (
      <CredentialsForm
        mode="setup"
        complete={(user) => setStatus({ setupRequired: false, user })}
        ownerExists={() => setStatus({ setupRequired: false, user: null })}
      />
    );
  }
  if (!status.user) {
    return (
      <CredentialsForm
        mode={recovering ? "recover" : "login"}
        complete={(user) => setStatus({ setupRequired: false, user })}
        recover={() => setRecovering(true)}
        cancel={() => setRecovering(false)}
      />
    );
  }
  return <WarehouseApp currentUser={status.user} loggedOut={() => setStatus({ setupRequired: false, user: null })} />;
}

function WarehouseApp({ currentUser, loggedOut }: { currentUser: AuthUser; loggedOut: () => void }) {
  const prototypeFrame = useRef<HTMLIFrameElement>(null);
  const [syncConflict, setSyncConflict] = useState<{ updatedBy: string } | null>(null);
  const [useFullSystem] = useState(true);
  const [screen, setScreen] = useState<Screen>("home");
  const [products, setProducts] = useState<Product[]>([]);
  const [posts, setPosts] = useState<WorkPost[]>([]);
  const [documents, setDocuments] = useState<WarehouseDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [showDocumentCreate, setShowDocumentCreate] = useState<"defect" | "work" | null>(null);
  const [documentKind, setDocumentKind] = useState<"defect" | "work">("defect");
  const [toast, setToast] = useState("");

  const loadProducts = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/products", { cache: "no-store" });
      if (!response.ok) throw new Error("Не удалось получить данные склада");
      const data = (await response.json()) as { products: Product[] };
      setProducts(data.products);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ошибка сервера");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadReferenceData = useCallback(async () => {
    try {
      const [postsResponse, documentsResponse] = await Promise.all([
        fetch("/api/posts", { cache: "no-store" }),
        fetch("/api/documents", { cache: "no-store" }),
      ]);
      if (!postsResponse.ok || !documentsResponse.ok) throw new Error("Не удалось получить посты и документы");
      const postsData = (await postsResponse.json()) as { posts: WorkPost[] };
      const documentsData = (await documentsResponse.json()) as { documents: WarehouseDocument[] };
      setPosts(postsData.posts);
      setDocuments(documentsData.documents);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ошибка сервера");
    }
  }, []);

  useEffect(() => {
    if (useFullSystem) return;
    // Initial server synchronization is intentionally performed once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadProducts();
    void loadReferenceData();
  }, [loadProducts, loadReferenceData, useFullSystem]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "treshka-auth-required") loggedOut();
      if (event.data?.type === "treshka-sync-conflict") {
        setSyncConflict({ updatedBy: String(event.data.updatedBy || "другой пользователь") });
      }
      if (event.data?.type === "treshka-sync-resolved") setSyncConflict(null);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [loggedOut]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ru");
    if (!needle) return products;
    return products.filter((product) =>
      [product.name, product.sku, product.category, product.location]
        .join(" ")
        .toLocaleLowerCase("ru")
        .includes(needle),
    );
  }, [products, query]);

  const totalUnits = products.reduce((sum, product) => sum + product.quantity, 0);
  const lowCount = products.filter((product) => product.quantity <= product.minimum).length;
  const canManageProducts = currentUser.role !== "worker";

  if (useFullSystem) {
    return (
      <main className="prototype-host">
        <div className="prototype-account">
          <span><b>{currentUser.callsign}</b> · {roleLabel(currentUser.role)}</span>
          <button onClick={() => void logout()}>Выйти</button>
        </div>
        {syncConflict && (
          <div className="prototype-sync-conflict" role="alert">
            <span>Склад изменил {syncConflict.updatedBy}. Какую версию оставить?</span>
            <button onClick={() => resolveSyncConflict("server")}>Серверную</button>
            <button className="local" onClick={() => resolveSyncConflict("local")}>Мою</button>
          </div>
        )}
        <iframe ref={prototypeFrame} title="ТРЁШКА СКЛАД" src="/prototype.html?server=1&build=1.6-sync2" />
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brandmark">Т</div>
          <div>
            <b>ТРЁШКА <i>СКЛАД</i></b>
            <span>Версия 1.6 · сервер подключён</span>
          </div>
        </div>
        <div className="account-box">
          <button className="avatar" onClick={() => notify(`${currentUser.callsign} · ${roleLabel(currentUser.role)}`)}>
            {currentUser.callsign.slice(0, 2).toUpperCase()}
          </button>
          <button className="logout" onClick={() => void logout()}>Выйти</button>
        </div>
      </header>

      <section className="content">
        {screen === "home" && (
          <>
            <div className="eyebrow">НОВАЯ БАЗА</div>
            <div className="hello">
              <h1>Склад готов к заполнению</h1>
              <span><i /> Данные сохраняются на сервере</span>
            </div>
            <div className="stats">
              <div><small>Позиций на складе</small><b>{products.length}</b><em>База заведена с нуля</em></div>
              <div><small>Требуют внимания</small><b className={lowCount ? "warn" : ""}>{lowCount}</b><em>Остаток ниже минимума</em></div>
              <div><small>Всего единиц</small><b>{totalUnits}</b><em>По всем позициям</em></div>
            </div>
            <h2>Быстрые действия</h2>
            <div className="actions">
              {canManageProducts && <Action icon="＋" title="Добавить первый товар" sub="Создать карточку в серверной базе" click={() => setShowCreate(true)} />}
              <Action icon="▦" title="Открыть склад" sub="Поиск и управление номенклатурой" click={() => setScreen("stock")} />
              <Action icon="⌗" title="Сканировать QR" sub="Станет доступно после добавления товара" click={() => notify("Сначала добавьте товар")} />
            </div>
            <div className="section-head"><h2>Последние действия</h2></div>
            <EmptyState title="Журнал пока пуст" text="События появятся после добавления и движения товаров." />
          </>
        )}

        {screen === "stock" && (
          <>
            <Title eyebrow="УЧЁТ ИМУЩЕСТВА" title="Склад" action={canManageProducts ? <button onClick={() => setShowCreate(true)}>＋ Товар</button> : undefined} />
            <div className="search">
              <span>⌕</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по товарам, артикулам и категориям" />
            </div>
            {loading ? (
              <EmptyState title="Загружаем склад" text="Получаем актуальные данные с сервера." />
            ) : error ? (
              <EmptyState title="Сервер временно недоступен" text={error} action={<button onClick={() => void loadProducts()}>Повторить</button>} />
            ) : filtered.length === 0 ? (
              <EmptyState
                title={products.length === 0 ? "На складе пока нет товаров" : "Ничего не найдено"}
                text={products.length === 0 ? "Добавьте первую карточку — она сохранится в серверной базе." : "Измените поисковый запрос."}
                action={products.length === 0 && canManageProducts ? <button onClick={() => setShowCreate(true)}>＋ Добавить товар</button> : undefined}
              />
            ) : (
              <div className="product-list">
                {filtered.map((product) => (
                  <article className="server-product" key={product.id}>
                    <i>{product.category.slice(0, 2).toUpperCase() || "ТВ"}</i>
                    <span>
                      <b>{product.name}</b>
                      <small>{product.category || "Без категории"} · {product.sku}</small>
                      <em>{product.location || "Место не указано"}</em>
                    </span>
                    <strong className={product.quantity <= product.minimum ? "red" : ""}>
                      {product.quantity} {product.unit}
                      <small>{product.quantity <= product.minimum ? "Ниже минимума" : "В наличии"}</small>
                    </strong>
                    {canManageProducts && <button className="delete-product" onClick={() => void removeProduct(product)}>Удалить</button>}
                  </article>
                ))}
              </div>
            )}
          </>
        )}

        {screen === "posts" && (
          <>
            <Title eyebrow="РАБОЧИЕ УЧАСТКИ" title="Посты" />
            <div className="product-list">
              {posts.map((post) => (
                <article className="server-product" key={post.id}>
                  <i>П</i>
                  <span><b>{post.name}</b><small>{post.description}</small></span>
                  <strong><small>Товаров на посту</small>0</strong>
                </article>
              ))}
            </div>
          </>
        )}

        {screen === "documents" && (
          <>
            <Title
              eyebrow="ДОКУМЕНТООБОРОТ"
              title="Документы"
              action={<button onClick={() => setShowDocumentCreate(documentKind)}>＋ Акт</button>}
            />
            <div className="segmented">
              <button className={documentKind === "defect" ? "active" : ""} onClick={() => setDocumentKind("defect")}>Акты дефектовки</button>
              <button className={documentKind === "work" ? "active" : ""} onClick={() => setDocumentKind("work")}>Акты выполненных работ</button>
            </div>
            {documents.filter((document) => document.kind === documentKind).length === 0 ? (
              <EmptyState
                title={documentKind === "defect" ? "Актов дефектовки пока нет" : "Актов выполненных работ пока нет"}
                text="Новая база документов пуста. Создайте первый акт — он сохранится на сервере."
                action={<button onClick={() => setShowDocumentCreate(documentKind)}>＋ Создать акт</button>}
              />
            ) : (
              <div className="product-list">
                {documents.filter((document) => document.kind === documentKind).map((document) => (
                  <article className="server-product" key={document.id}>
                    <i>{document.kind === "defect" ? "ДФ" : "АВР"}</i>
                    <span>
                      <b>{document.number} · {document.item}</b>
                      <small>{document.post} · {document.date}{document.serial ? ` · № ${document.serial}` : ""}</small>
                      <em>{document.description || "Описание не указано"}</em>
                    </span>
                    <strong>{document.status}</strong>
                  </article>
                ))}
              </div>
            )}
          </>
        )}

        {screen === "more" && (
          <>
            <Title eyebrow="СИСТЕМА" title="Ещё" />
            <div className="menu-card">
              <Menu icon="◉" title="Инвентаризация" sub="Пока нет товарных остатков" />
              {(currentUser.role === "owner" || currentUser.role === "admin") && (
                <Menu icon="≡" title="Журнал действий" sub="Входы, аккаунты, товары и безопасность" click={() => setScreen("audit")} />
              )}
              {(currentUser.role === "owner" || currentUser.role === "admin") && (
                <Menu icon="♙" title="Сотрудники и доступ" sub="Позывные, логины, роли и пароли" click={() => setScreen("users")} />
              )}
              <Menu icon="⚙" title="Безопасность" sub="Изменить свой постоянный пароль" click={() => setScreen("security")} />
            </div>
          </>
        )}

        {screen === "users" && <UsersScreen currentUser={currentUser} ownershipTransferred={loggedOut} />}
        {screen === "security" && <SecurityScreen currentUser={currentUser} passwordChanged={loggedOut} />}
        {screen === "audit" && <AuditScreen />}
      </section>

      <nav className="bottom-nav" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
        <Nav icon="⌂" text="Главная" active={screen === "home"} click={() => setScreen("home")} />
        <Nav icon="▦" text="Склад" active={screen === "stock"} click={() => setScreen("stock")} />
        <Nav icon="▤" text="Посты" active={screen === "posts"} click={() => setScreen("posts")} />
        <Nav icon="≡" text="Документы" active={screen === "documents"} click={() => setScreen("documents")} />
        <Nav icon="•••" text="Ещё" active={["more", "users", "security", "audit"].includes(screen)} click={() => setScreen("more")} />
      </nav>

      {showCreate && (
        <CreateProduct
          close={() => setShowCreate(false)}
          created={(product) => {
            setProducts((current) => [product, ...current]);
            setShowCreate(false);
            setScreen("stock");
            notify("Товар сохранён на сервере");
          }}
        />
      )}
      {showDocumentCreate && (
        <CreateWarehouseDocument
          kind={showDocumentCreate}
          posts={posts}
          currentUser={currentUser}
          close={() => setShowDocumentCreate(null)}
          created={(document) => {
            setDocuments((current) => [document, ...current]);
            setShowDocumentCreate(null);
            setDocumentKind(document.kind);
            setScreen("documents");
            notify("Документ сохранён на сервере");
          }}
        />
      )}
      {toast && <div className="toast">✓ {toast}</div>}
    </main>
  );

  async function removeProduct(product: Product) {
    if (!window.confirm(`Удалить карточку «${product.name}»?`)) return;
    const response = await fetch(`/api/products?id=${encodeURIComponent(product.id)}`, { method: "DELETE" });
    if (!response.ok) {
      notify("Не удалось удалить товар");
      return;
    }
    setProducts((current) => current.filter((item) => item.id !== product.id));
    notify("Карточка удалена");
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    loggedOut();
  }

  function resolveSyncConflict(strategy: "server" | "local") {
    prototypeFrame.current?.contentWindow?.postMessage(
      { type: "treshka-sync-resolve", strategy },
      window.location.origin,
    );
  }
}

function AuthShell({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) {
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand"><span>Т</span><div><b>ТРЁШКА СКЛАД</b><small>Версия 1.6</small></div></div>
        <h1>{title}</h1>
        <p>{text}</p>
        {children}
      </section>
    </main>
  );
}

function CredentialsForm({
  mode,
  complete,
  recover,
  cancel,
  ownerExists,
}: {
  mode: "setup" | "login" | "recover";
  complete: (user: AuthUser) => void;
  recover?: () => void;
  cancel?: () => void;
  ownerExists?: () => void;
}) {
  const [callsign, setCallsign] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [securityCode, setSecurityCode] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 45_000);
    try {
      const endpoint = mode === "recover" ? "recover-owner" : mode;
      const response = await fetch(`/api/auth/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          callsign,
          login,
          password,
          newPassword: password,
          setupCode: mode === "setup" ? securityCode : undefined,
          recoveryCode: mode === "recover" ? securityCode : undefined,
        }),
      });
      const data = (await response.json()) as { user?: AuthUser; error?: string };
      if (mode === "setup" && response.status === 409 && ownerExists) {
        ownerExists();
        return;
      }
      if (!response.ok || !data.user) {
        setError(data.error || "Не удалось войти");
        return;
      }
      complete(data.user);
    } catch (requestError) {
      setError(
        requestError instanceof DOMException && requestError.name === "AbortError"
          ? "Сервер не ответил за 45 секунд. Повторите попытку."
          : "Нет связи с сервером. Проверьте интернет и повторите попытку.",
      );
    } finally {
      window.clearTimeout(timeout);
      setSaving(false);
    }
  }

  return (
    <AuthShell
      title={mode === "setup" ? "Создание владельца" : mode === "recover" ? "Восстановление владельца" : "Вход в систему"}
      text={
        mode === "setup"
          ? "Первый аккаунт получает полный контроль. Понадобится код первичной настройки."
          : mode === "recover"
            ? "Введите логин владельца, резервный код и новый постоянный пароль."
            : "Введите логин и постоянный пароль."
      }
    >
      <form className="auth-form" onSubmit={submit}>
        {(mode === "setup" || mode === "recover") && <label>Позывной<input required minLength={2} value={callsign} onChange={(event) => setCallsign(event.target.value)} autoComplete="nickname" /></label>}
        <label>Логин<input required minLength={3} value={login} onChange={(event) => setLogin(event.target.value)} autoComplete="username" /></label>
        <label>{mode === "recover" ? "Новый пароль" : "Пароль"}<input required minLength={8} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
        {mode !== "login" && (
          <label>{mode === "setup" ? "Код первичной настройки" : "Резервный код владельца"}<input required value={securityCode} onChange={(event) => setSecurityCode(event.target.value)} autoComplete="off" /></label>
        )}
        {error && <p className="form-error">{error}</p>}
        <button className="primary" disabled={saving}>{saving ? "Подождите…" : mode === "setup" ? "Создать владельца" : mode === "recover" ? "Восстановить доступ" : "Войти"}</button>
        {mode === "login" && <button className="secondary" type="button" onClick={recover}>Восстановить владельца</button>}
        {mode === "recover" && <button className="secondary" type="button" onClick={cancel}>Вернуться ко входу</button>}
      </form>
    </AuthShell>
  );
}

type ManagedUser = AuthUser & { status: "active" | "blocked"; createdAt?: string; lastLoginAt?: string | null };

function UsersScreen({ currentUser, ownershipTransferred }: { currentUser: AuthUser; ownershipTransferred: () => void }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/users", { cache: "no-store" });
    const data = (await response.json()) as { users?: ManagedUser[]; error?: string };
    if (!response.ok) setError(data.error || "Не удалось загрузить сотрудников");
    else setUsers(data.users ?? []);
  }, []);

  useEffect(() => {
    // Initial server synchronization is intentionally performed once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function toggle(user: ManagedUser) {
    const response = await fetch("/api/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: user.id, status: user.status === "active" ? "blocked" : "active" }),
    });
    if (response.ok) void load();
  }

  async function resetPassword(user: ManagedUser) {
    const password = window.prompt(`Новый постоянный пароль для «${user.callsign}» (минимум 8 символов):`);
    if (!password) return;
    const response = await fetch("/api/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: user.id, password }),
    });
    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      window.alert(data.error || "Не удалось изменить пароль");
    } else {
      window.alert("Пароль изменён. Активные сеансы сотрудника завершены.");
    }
  }

  async function transferOwner(user: ManagedUser) {
    if (!window.confirm(`Передать полный контроль аккаунту «${user.callsign}»? Ваш аккаунт станет администратором.`)) return;
    const currentPassword = window.prompt("Введите ваш текущий пароль для подтверждения:");
    if (!currentPassword) return;
    const response = await fetch("/api/users/transfer-owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetUserId: user.id, currentPassword }),
    });
    const data = (await response.json()) as { error?: string };
    if (!response.ok) {
      window.alert(data.error || "Не удалось передать права владельца");
      return;
    }
    window.alert("Права владельца переданы. Все сеансы завершены — войдите заново.");
    ownershipTransferred();
  }

  return (
    <>
      <Title eyebrow="УПРАВЛЕНИЕ ДОСТУПОМ" title="Сотрудники" action={<button onClick={() => setShowForm(true)}>＋ Аккаунт</button>} />
      <p className="hint">В приложении отображаются позывные. Логины используются только для входа.</p>
      {error && <p className="form-error">{error}</p>}
      <div className="users-list">
        {users.map((user) => (
          <article className="user-card" key={user.id}>
            <div className="user-badge">{user.callsign.slice(0, 2).toUpperCase()}</div>
            <span><b>{user.callsign}</b><small>@{user.login} · {roleLabel(user.role)}</small><em>{user.assignment || "Без назначения"}</em></span>
            <i className={user.status}>{user.status === "active" ? "Активен" : "Заблокирован"}</i>
            {user.role !== "owner" && !(currentUser.role === "admin" && user.role === "admin") && (
              <div className="user-actions">
                <button onClick={() => void resetPassword(user)}>Новый пароль</button>
                <button onClick={() => void toggle(user)}>{user.status === "active" ? "Заблокировать" : "Включить"}</button>
                {currentUser.role === "owner" && user.status === "active" && (
                  <button onClick={() => void transferOwner(user)}>Сделать владельцем</button>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
      {showForm && <CreateUser currentUser={currentUser} close={() => setShowForm(false)} created={() => { setShowForm(false); void load(); }} />}
    </>
  );
}

function SecurityScreen({ currentUser, passwordChanged }: { currentUser: AuthUser; passwordChanged: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const response = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = (await response.json()) as { error?: string };
    setSaving(false);
    if (!response.ok) {
      setError(data.error || "Не удалось изменить пароль");
      return;
    }
    window.alert("Пароль изменён. Войдите с новым паролем.");
    passwordChanged();
  }

  return (
    <>
      <Title eyebrow="БЕЗОПАСНОСТЬ" title="Мой доступ" />
      <div className="user-card">
        <div className="user-badge">{currentUser.callsign.slice(0, 2).toUpperCase()}</div>
        <span><b>{currentUser.callsign}</b><small>@{currentUser.login} · {roleLabel(currentUser.role)}</small></span>
      </div>
      <form className="auth-form security-form" onSubmit={submit}>
        <label>Текущий пароль<input required minLength={8} type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
        <label>Новый постоянный пароль<input required minLength={8} type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary" disabled={saving}>{saving ? "Сохраняем…" : "Изменить пароль"}</button>
      </form>
      {currentUser.role === "owner" && <p className="hint">Передача владельца находится в разделе «Сотрудники и доступ».</p>}
    </>
  );
}

type AuditEntry = {
  id: string;
  callsign: string;
  action: string;
  details: string;
  createdAt: string;
};

type WorkPost = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
};

type WarehouseDocument = {
  id: string;
  number: string;
  kind: "defect" | "work";
  status: string;
  date: string;
  post: string;
  item: string;
  serial: string;
  description: string;
  createdAt: string;
};

function AuditScreen() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/audit", { cache: "no-store" });
      const data = (await response.json()) as { entries?: AuditEntry[]; error?: string };
      if (!response.ok) setError(data.error || "Не удалось загрузить журнал");
      else setEntries(data.entries ?? []);
    })();
  }, []);

  return (
    <>
      <Title eyebrow="КОНТРОЛЬ" title="Журнал действий" />
      {error ? <p className="form-error">{error}</p> : entries.length === 0 ? (
        <EmptyState title="Журнал пока пуст" text="Здесь появятся входы, изменения аккаунтов и операции с товарами." />
      ) : (
        <div className="users-list">
          {entries.map((entry) => (
            <article className="user-card audit-card" key={entry.id}>
              <div className="user-badge">≡</div>
              <span>
                <b>{entry.action}</b>
                <small>{entry.callsign} · {new Date(entry.createdAt).toLocaleString("ru-RU")}</small>
                <em>{entry.details || "Без дополнительных данных"}</em>
              </span>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

function CreateUser({ currentUser, close, created }: { currentUser: AuthUser; close: () => void; created: () => void }) {
  const [form, setForm] = useState({ callsign: "", login: "", password: "", role: "worker", assignment: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    const response = await fetch("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = (await response.json()) as { error?: string };
    setSaving(false);
    if (!response.ok) {
      setError(data.error || "Не удалось создать аккаунт");
      return;
    }
    created();
  }

  const field = (name: keyof typeof form, value: string) => setForm((current) => ({ ...current, [name]: value }));
  return (
    <div className="overlay shade">
      <section className="sheet">
        <header><button onClick={close}>←</button><h2>Новый сотрудник</h2><button onClick={close}>×</button></header>
        <form className="sheet-body create-product-form" onSubmit={submit}>
          <label>Позывной<input required minLength={2} value={form.callsign} onChange={(event) => field("callsign", event.target.value)} /></label>
          <label>Логин<input required minLength={3} value={form.login} onChange={(event) => field("login", event.target.value)} autoComplete="off" /></label>
          <label>Постоянный пароль<input required minLength={8} type="password" value={form.password} onChange={(event) => field("password", event.target.value)} autoComplete="new-password" /></label>
          <label>Роль<select value={form.role} onChange={(event) => field("role", event.target.value)}>
            {currentUser.role === "owner" && <option value="admin">Администратор</option>}
            <option value="storekeeper">Кладовщик</option>
            <option value="worker">Работник</option>
          </select></label>
          <label>Склад или пост<input value={form.assignment} onChange={(event) => field("assignment", event.target.value)} placeholder="Например, основной склад или пост № 2" /></label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary" disabled={saving}>{saving ? "Создаём…" : "Создать аккаунт"}</button>
        </form>
      </section>
    </div>
  );
}

function CreateWarehouseDocument({
  kind,
  posts,
  currentUser,
  close,
  created,
}: {
  kind: "defect" | "work";
  posts: WorkPost[];
  currentUser: AuthUser;
  close: () => void;
  created: (document: WarehouseDocument) => void;
}) {
  const allowedPosts = currentUser.role === "worker"
    ? posts.filter((post) => post.name.toLocaleLowerCase("ru") === currentUser.assignment.trim().toLocaleLowerCase("ru"))
    : posts;
  const [form, setForm] = useState({
    number: "",
    date: new Date().toISOString().slice(0, 10),
    post: allowedPosts[0]?.name ?? "",
    item: "",
    serial: "",
    description: "",
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, kind }),
      });
      const data = (await response.json()) as { document?: WarehouseDocument; error?: string };
      if (!response.ok || !data.document) throw new Error(data.error || "Не удалось сохранить документ");
      created(data.document);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ошибка сервера");
    } finally {
      setSaving(false);
    }
  }

  const field = (name: keyof typeof form, value: string) => setForm((current) => ({ ...current, [name]: value }));
  return (
    <div className="overlay shade">
      <section className="sheet">
        <header>
          <button onClick={close}>←</button>
          <h2>{kind === "defect" ? "Новый акт дефектовки" : "Новый акт выполненных работ"}</h2>
          <button onClick={close}>×</button>
        </header>
        <form className="sheet-body create-product-form" onSubmit={submit}>
          <label>Номер акта<input required value={form.number} onChange={(event) => field("number", event.target.value)} placeholder={kind === "defect" ? "ДФ-001" : "АВР-001"} /></label>
          <label>Дата<input required type="date" value={form.date} onChange={(event) => field("date", event.target.value)} /></label>
          <label>Пост<select required value={form.post} onChange={(event) => field("post", event.target.value)}>
            {allowedPosts.map((post) => <option key={post.id} value={post.name}>{post.name}</option>)}
          </select></label>
          <label>Изделие или работа<input required value={form.item} onChange={(event) => field("item", event.target.value)} placeholder="Наименование" /></label>
          <label>Серийный номер<input value={form.serial} onChange={(event) => field("serial", event.target.value)} placeholder="Если имеется" /></label>
          <label>{kind === "defect" ? "Выявленные неисправности" : "Выполненные работы"}<textarea value={form.description} onChange={(event) => field("description", event.target.value)} /></label>
          {allowedPosts.length === 0 && <p className="form-error">Для этого работника не назначен существующий пост</p>}
          {error && <p className="form-error">{error}</p>}
          <button className="primary" disabled={saving || allowedPosts.length === 0}>{saving ? "Сохраняем…" : "Создать документ"}</button>
        </form>
      </section>
    </div>
  );
}

function roleLabel(role: AuthUser["role"]) {
  return { owner: "Владелец", admin: "Администратор", storekeeper: "Кладовщик", worker: "Работник" }[role];
}

function CreateProduct({ close, created }: { close: () => void; created: (product: Product) => void }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          quantity: Number(form.quantity),
          minimum: Number(form.minimum),
        }),
      });
      const data = (await response.json()) as { product?: Product; error?: string };
      if (!response.ok || !data.product) throw new Error(data.error || "Не удалось сохранить товар");
      created(data.product);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ошибка сервера");
    } finally {
      setSaving(false);
    }
  }

  const field = (name: keyof typeof EMPTY_FORM, value: string) => setForm((current) => ({ ...current, [name]: value }));

  return (
    <div className="overlay shade">
      <section className="sheet">
        <header><button onClick={close}>←</button><h2>Новая карточка товара</h2><button onClick={close}>×</button></header>
        <form className="sheet-body create-product-form" onSubmit={submit}>
          <label>Название<input required value={form.name} onChange={(event) => field("name", event.target.value)} placeholder="Например, крепёж М6" /></label>
          <label>Артикул<input required value={form.sku} onChange={(event) => field("sku", event.target.value)} placeholder="Уникальный код" /></label>
          <label>Категория<input value={form.category} onChange={(event) => field("category", event.target.value)} placeholder="Расходные материалы" /></label>
          <div className="form-row">
            <label>Количество<input min="0" step="0.01" type="number" required value={form.quantity} onChange={(event) => field("quantity", event.target.value)} /></label>
            <label>Единица<input required value={form.unit} onChange={(event) => field("unit", event.target.value)} /></label>
          </div>
          <label>Место хранения<input value={form.location} onChange={(event) => field("location", event.target.value)} placeholder="Стеллаж, шкаф или ячейка" /></label>
          <label>Минимальный остаток<input min="0" step="0.01" type="number" value={form.minimum} onChange={(event) => field("minimum", event.target.value)} /></label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary" disabled={saving}>{saving ? "Сохраняем…" : "Сохранить на сервере"}</button>
        </form>
      </section>
    </div>
  );
}

function EmptyState({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) {
  return <div className="empty-state"><div>□</div><h3>{title}</h3><p>{text}</p>{action}</div>;
}

function Title({ eyebrow, title, action }: { eyebrow: string; title: string; action?: React.ReactNode }) {
  return <div className="title"><div><span>{eyebrow}</span><h1>{title}</h1></div>{action}</div>;
}

function Nav({ icon, text, active, click }: { icon: string; text: string; active: boolean; click: () => void }) {
  return <button className={active ? "active" : ""} onClick={click}><b>{icon}</b><span>{text}</span></button>;
}

function Action({ icon, title, sub, click }: { icon: string; title: string; sub: string; click: () => void }) {
  return <button onClick={click}><i>{icon}</i><span><b>{title}</b><small>{sub}</small></span><em>›</em></button>;
}

function Menu({ icon, title, sub, click }: { icon: string; title: string; sub: string; click?: () => void }) {
  return <button onClick={click}><i>{icon}</i><span><b>{title}</b><small>{sub}</small></span><em>›</em></button>;
}
