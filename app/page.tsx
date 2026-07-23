"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Screen = "home" | "stock" | "repairs" | "issue" | "more" | "users";

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

  const refresh = useCallback(async () => {
    const response = await fetch("/api/auth/status", { cache: "no-store" });
    setStatus(await response.json());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!status) return <AuthShell title="Проверяем доступ…" text="Подключаемся к серверу версии 1.5." />;
  if (status.setupRequired) return <CredentialsForm mode="setup" complete={(user) => setStatus({ setupRequired: false, user })} />;
  if (!status.user) return <CredentialsForm mode="login" complete={(user) => setStatus({ setupRequired: false, user })} />;
  return <WarehouseApp currentUser={status.user} loggedOut={() => setStatus({ setupRequired: false, user: null })} />;
}

function WarehouseApp({ currentUser, loggedOut }: { currentUser: AuthUser; loggedOut: () => void }) {
  const [screen, setScreen] = useState<Screen>("home");
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
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

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brandmark">Т</div>
          <div>
            <b>ТРЁШКА <i>СКЛАД</i></b>
            <span>Версия 1.5 · сервер подключён</span>
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
              <Action icon="＋" title="Добавить первый товар" sub="Создать карточку в серверной базе" click={() => setShowCreate(true)} />
              <Action icon="▦" title="Открыть склад" sub="Поиск и управление номенклатурой" click={() => setScreen("stock")} />
              <Action icon="⌗" title="Сканировать QR" sub="Станет доступно после добавления товара" click={() => notify("Сначала добавьте товар")} />
            </div>
            <div className="section-head"><h2>Последние действия</h2></div>
            <EmptyState title="Журнал пока пуст" text="События появятся после добавления и движения товаров." />
          </>
        )}

        {screen === "stock" && (
          <>
            <Title eyebrow="УЧЁТ ИМУЩЕСТВА" title="Склад" action={<button onClick={() => setShowCreate(true)}>＋ Товар</button>} />
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
                action={products.length === 0 ? <button onClick={() => setShowCreate(true)}>＋ Добавить товар</button> : undefined}
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
                    <button className="delete-product" onClick={() => void removeProduct(product)}>Удалить</button>
                  </article>
                ))}
              </div>
            )}
          </>
        )}

        {screen === "repairs" && (
          <>
            <Title eyebrow="РЕМОНТНЫЙ КОНТУР" title="Ремонты" />
            <EmptyState title="Ремонтов пока нет" text="Новая база не содержит демонстрационных актов и изделий." />
          </>
        )}

        {screen === "issue" && (
          <>
            <Title eyebrow="ДВИЖЕНИЕ ТОВАРОВ" title="Выдача" />
            <EmptyState
              title={products.length ? "Выберите товар на складе" : "Выдавать пока нечего"}
              text={products.length ? "Откройте склад и выберите карточку товара." : "Добавьте товары в серверную базу, затем оформляйте движения."}
              action={<button onClick={() => setScreen("stock")}>Открыть склад</button>}
            />
          </>
        )}

        {screen === "more" && (
          <>
            <Title eyebrow="СИСТЕМА" title="Ещё" />
            <div className="menu-card">
              <Menu icon="◉" title="Инвентаризация" sub="Пока нет товарных остатков" />
              <Menu icon="≡" title="Журнал действий" sub="События начнут записываться после заполнения базы" />
              {(currentUser.role === "owner" || currentUser.role === "admin") && (
                <Menu icon="♙" title="Сотрудники и доступ" sub="Позывные, логины, роли и пароли" click={() => setScreen("users")} />
              )}
              <Menu icon="⚙" title="Настройки" sub="Категории, единицы измерения и минимальные остатки" />
            </div>
          </>
        )}

        {screen === "users" && <UsersScreen currentUser={currentUser} />}
      </section>

      <nav className="bottom-nav">
        <Nav icon="⌂" text="Главная" active={screen === "home"} click={() => setScreen("home")} />
        <Nav icon="▦" text="Склад" active={screen === "stock"} click={() => setScreen("stock")} />
        <Nav icon="◫" text="Ремонты" active={screen === "repairs"} click={() => setScreen("repairs")} />
        <Nav icon="⇄" text="Выдача" active={screen === "issue"} click={() => setScreen("issue")} />
        <Nav icon="•••" text="Ещё" active={screen === "more" || screen === "users"} click={() => setScreen("more")} />
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
}

function AuthShell({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) {
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand"><span>Т</span><div><b>ТРЁШКА СКЛАД</b><small>Версия 1.5</small></div></div>
        <h1>{title}</h1>
        <p>{text}</p>
        {children}
      </section>
    </main>
  );
}

function CredentialsForm({ mode, complete }: { mode: "setup" | "login"; complete: (user: AuthUser) => void }) {
  const [callsign, setCallsign] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const response = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callsign, login, password }),
    });
    const data = (await response.json()) as { user?: AuthUser; error?: string };
    setSaving(false);
    if (!response.ok || !data.user) {
      setError(data.error || "Не удалось войти");
      return;
    }
    complete(data.user);
  }

  return (
    <AuthShell
      title={mode === "setup" ? "Создание владельца" : "Вход в систему"}
      text={mode === "setup" ? "Первый аккаунт получает полный контроль над сотрудниками и ролями." : "Введите логин и постоянный пароль."}
    >
      <form className="auth-form" onSubmit={submit}>
        {mode === "setup" && <label>Позывной<input required minLength={2} value={callsign} onChange={(event) => setCallsign(event.target.value)} autoComplete="nickname" /></label>}
        <label>Логин<input required minLength={3} value={login} onChange={(event) => setLogin(event.target.value)} autoComplete="username" /></label>
        <label>Пароль<input required minLength={8} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "setup" ? "new-password" : "current-password"} /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary" disabled={saving}>{saving ? "Подождите…" : mode === "setup" ? "Создать владельца" : "Войти"}</button>
      </form>
    </AuthShell>
  );
}

type ManagedUser = AuthUser & { status: "active" | "blocked"; createdAt?: string; lastLoginAt?: string | null };

function UsersScreen({ currentUser }: { currentUser: AuthUser }) {
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
              </div>
            )}
          </article>
        ))}
      </div>
      {showForm && <CreateUser currentUser={currentUser} close={() => setShowForm(false)} created={() => { setShowForm(false); void load(); }} />}
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
