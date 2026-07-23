"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Screen = "home" | "stock" | "repairs" | "issue" | "more";

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
            <span>Версия 1.4 · сервер подключён</span>
          </div>
        </div>
        <button className="avatar" onClick={() => notify("Серверная версия активна")}>АМ</button>
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
              <Menu icon="⚙" title="Настройки" sub="Категории, единицы измерения и минимальные остатки" />
            </div>
          </>
        )}
      </section>

      <nav className="bottom-nav">
        <Nav icon="⌂" text="Главная" active={screen === "home"} click={() => setScreen("home")} />
        <Nav icon="▦" text="Склад" active={screen === "stock"} click={() => setScreen("stock")} />
        <Nav icon="◫" text="Ремонты" active={screen === "repairs"} click={() => setScreen("repairs")} />
        <Nav icon="⇄" text="Выдача" active={screen === "issue"} click={() => setScreen("issue")} />
        <Nav icon="•••" text="Ещё" active={screen === "more"} click={() => setScreen("more")} />
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

function Menu({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return <button><i>{icon}</i><span><b>{title}</b><small>{sub}</small></span><em>›</em></button>;
}
