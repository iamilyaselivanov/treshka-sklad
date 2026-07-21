"use client";

import { useMemo, useState } from "react";

type Screen = "home" | "stock" | "repairs" | "more";
type Modal = null | "scan" | "issue" | "defect" | "work" | "product";

const products = [
  { name: "Припой ПОС-61", sku: "MAT-0018", qty: "1 240 г", place: "Стеллаж A · 03", tone: "blue" },
  { name: "Провод AWG24", sku: "MAT-0034", qty: "86 м", place: "Стеллаж B · 11", tone: "violet" },
  { name: "Усилитель ACASOM 20W", sku: "CMP-0091", qty: "3 шт", place: "Шкаф 2 · 06", tone: "orange", low: true },
  { name: "Аттенюатор 10 дБ", sku: "CMP-0142", qty: "18 шт", place: "Шкаф 2 · 08", tone: "green" },
  { name: "Флюс RMA-223", sku: "MAT-0007", qty: "620 г", place: "Стеллаж A · 01", tone: "pink" },
];

const repairs = [
  { id: "DF-0248", item: "Антенна № 000966", stage: "Дефектовка", status: "Нужно заполнить", color: "amber" },
  { id: "RW-0241", item: "Модуль связи № 001245", stage: "В работе", status: "Пост № 2", color: "blue" },
  { id: "RW-0239", item: "Антенна № 000821", stage: "Готово", status: "Акт закрыт", color: "green" },
];

export default function Home() {
  const [screen, setScreen] = useState<Screen>("home");
  const [modal, setModal] = useState<Modal>(null);
  const [query, setQuery] = useState("");
  const [step, setStep] = useState(0);
  const [toast, setToast] = useState("");
  const filtered = useMemo(() => products.filter(p => (p.name + p.sku).toLowerCase().includes(query.toLowerCase())), [query]);

  const notify = (text: string) => { setToast(text); setTimeout(() => setToast(""), 2600); };
  const open = (m: Modal) => { setStep(0); setModal(m); };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brandmark">С</div><div><b>СКЛАД.ОК</b><span>Основной склад</span></div></div>
        <button className="avatar" onClick={() => notify("Профиль: Алексей Морозов · Кладовщик")}>АМ</button>
      </header>

      <section className="content">
        {screen === "home" && <HomeScreen open={open} />}
        {screen === "stock" && <StockScreen query={query} setQuery={setQuery} products={filtered} open={open} />}
        {screen === "repairs" && <RepairsScreen open={open} />}
        {screen === "more" && <MoreScreen notify={notify} />}
      </section>

      <nav className="bottom-nav">
        <Nav active={screen === "home"} icon="⌂" text="Главная" onClick={() => setScreen("home")} />
        <Nav active={screen === "stock"} icon="▦" text="Остатки" onClick={() => setScreen("stock")} />
        <button className="scan-main" onClick={() => open("scan")} aria-label="Сканировать QR"><span>⌗</span></button>
        <Nav active={screen === "repairs"} icon="◫" text="Ремонты" onClick={() => setScreen("repairs")} />
        <Nav active={screen === "more"} icon="•••" text="Ещё" onClick={() => setScreen("more")} />
      </nav>

      {modal && <Overlay modal={modal} step={step} setStep={setStep} close={() => setModal(null)} open={open} notify={notify} />}
      {toast && <div className="toast">✓ {toast}</div>}
    </main>
  );
}

function HomeScreen({ open }: { open: (m: Modal) => void }) {
  return <>
    <div className="hello"><div><span>Вторник, 21 июля</span><h1>Доброе утро, Алексей</h1></div><div className="sync"><i /> Синхронизировано</div></div>
    <div className="stats">
      <div><span>Позиций на складе</span><strong>1 284</strong><small>↑ 24 за неделю</small></div>
      <div><span>Требуют внимания</span><strong className="orange">7</strong><small>Ниже минимума</small></div>
      <div><span>У внешних получателей</span><strong>32</strong><small>3 возврата сегодня</small></div>
    </div>
    <h2>Быстрые действия</h2>
    <div className="actions">
      <button onClick={() => open("scan")}><b className="action-icon blue">⌗</b><span><strong>Сканировать QR</strong><small>Найти товар или изделие</small></span><em>›</em></button>
      <button onClick={() => open("issue")}><b className="action-icon violet">↗</b><span><strong>Выдать со склада</strong><small>На пост, сотруднику или на сторону</small></span><em>›</em></button>
      <button onClick={() => open("defect")}><b className="action-icon orange">＋</b><span><strong>Новая дефектовка</strong><small>Принять изделие в ремонт</small></span><em>›</em></button>
    </div>
    <div className="section-head"><h2>Сегодня</h2><button>Все операции</button></div>
    <div className="timeline">
      <Movement time="10:42" icon="↗" tone="violet" title="Выдача на пост № 2" detail="Провод AWG24 · 12 м" person="Сергей Петров" />
      <Movement time="09:18" icon="↓" tone="green" title="Приход от Радиокомплект" detail="8 позиций · накладная № 1842" person="Принял Алексей Морозов" />
      <Movement time="08:55" icon="↙" tone="blue" title="Возврат с поста № 1" detail="Аттенюатор 10 дБ · 2 шт" person="Иван Орлов" />
    </div>
  </>;
}

function StockScreen({ query, setQuery, products, open }: any) {
  return <><div className="page-title"><div><span>УЧЕТ ИМУЩЕСТВА</span><h1>Остатки</h1></div><button className="square" onClick={() => open("scan")}>⌗</button></div>
    <div className="search"><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Название, артикул или QR" /></div>
    <div className="chips"><button className="active">Все · 1 284</button><button>Ниже минимума · 7</button><button>Основной склад</button></div>
    <div className="stock-list">{products.map((p: any) => <button key={p.sku} className="product" onClick={() => open("product")}><span className={`cube ${p.tone}`}>◇</span><span><strong>{p.name}</strong><small>{p.sku} · {p.place}</small></span><span className={p.low ? "qty low" : "qty"}>{p.qty}<small>{p.low ? "Ниже минимума" : "В наличии"}</small></span></button>)}</div>
  </>;
}

function RepairsScreen({ open }: { open: (m: Modal) => void }) {
  return <><div className="page-title"><div><span>РЕМОНТНЫЙ КОНТУР</span><h1>Ремонты</h1></div><button className="primary-small" onClick={() => open("defect")}>＋ Дефектовка</button></div>
    <div className="repair-summary"><div><strong>4</strong><span>На дефектовке</span></div><div><strong>11</strong><span>В работе</span></div><div><strong>6</strong><span>Готовы</span></div></div>
    <div className="chips"><button className="active">Активные</button><button>Завершенные</button><button>Все посты</button></div>
    <div className="repair-list">{repairs.map(r => <button key={r.id} onClick={() => r.stage === "Дефектовка" ? open("defect") : open("work")}><div className="repair-top"><span>{r.id}</span><i className={r.color}>{r.stage}</i></div><strong>{r.item}</strong><small>Поступило сегодня · 09:36</small><div className="repair-foot"><span>Ответственный: А. Морозов</span><b>{r.status} ›</b></div></button>)}</div>
  </>;
}

function MoreScreen({ notify }: { notify: (s: string) => void }) {
  return <><div className="page-title"><div><span>УПРАВЛЕНИЕ</span><h1>Ещё</h1></div></div><div className="menu-card">
    {[['▤','Документы и отчеты','Накладные, акты, движения'],['⌂','Локации и посты','Остатки по местам хранения'],['♙','Получатели','Сотрудники и организации'],['◉','Инвентаризация','Сверка фактических остатков'],['⚙','Настройки','Роли, справочники, уведомления']].map(x => <button key={x[1]} onClick={() => notify(`${x[1]} — раздел откроется в полной версии`)}><b>{x[0]}</b><span><strong>{x[1]}</strong><small>{x[2]}</small></span><em>›</em></button>)}
  </div></>;
}

function Overlay({ modal, step, setStep, close, open, notify }: any) {
  if (modal === "scan") return <div className="overlay dark"><button className="close light" onClick={close}>×</button><div className="scanner"><span /><span /><span /><span /><div className="fake-qr">▦<br/>▣▦</div></div><h2>Наведите камеру на QR-код</h2><p>Код будет распознан автоматически</p><button className="flash">☼ Включить фонарик</button><button className="demo" onClick={() => open("product")}>Демо: распознать товар</button></div>;
  if (modal === "product") return <Sheet title="Карточка товара" close={close}><div className="product-hero"><div className="big-cube">◇</div><span>КОМПОНЕНТ</span><h2>Усилитель ACASOM 20W</h2><p>CMP-0091</p></div><div className="balance"><span>Доступно на основном складе</span><strong>3 шт</strong><small>Минимальный остаток: 5 шт</small></div><div className="info-grid"><span>Место хранения<b>Шкаф 2 · ячейка 06</b></span><span>Последний приход<b>18 июля 2026</b></span><span>Поставщик<b>Радиокомплект</b></span><span>QR-код<b>QR-CMP-0091</b></span></div><button className="primary" onClick={() => open("issue")}>Выдать товар</button><button className="secondary" onClick={() => notify("QR-код подготовлен к печати")}>Показать QR-код</button></Sheet>;
  if (modal === "issue") return <Sheet title="Выдача со склада" close={close}><div className="steps"><i className="on">1</i><span/><i className={step>0?'on':''}>2</i><span/><i className={step>1?'on':''}>3</i></div>{step === 0 ? <><h2>Куда выдаем?</h2><p className="muted">Выберите тип получателя</p><Choice icon="⌂" title="На ремонтный пост" detail="Временное перемещение" onClick={() => setStep(1)} /><Choice icon="♙" title="Сотруднику" detail="Под личную ответственность" onClick={() => setStep(1)} /><Choice icon="◎" title="Стороннему получателю" detail="Организации или физическому лицу" onClick={() => setStep(1)} /></> : step === 1 ? <><h2>Получатель и основание</h2><label>Получатель<select><option>ООО «Техносфера»</option><option>Пост № 2 — Сергей Петров</option></select></label><label>Тип выдачи<select><option>Временная, с возвратом</option><option>Безвозвратная</option></select></label><label>Плановая дата возврата<input type="date" defaultValue="2026-07-28" /></label><button className="primary" onClick={() => setStep(2)}>Добавить товары</button></> : <><h2>Состав выдачи</h2><div className="line-item"><span><b>Аттенюатор 10 дБ</b><small>CMP-0142</small></span><strong>2 шт</strong></div><div className="line-item"><span><b>Провод AWG24</b><small>MAT-0034</small></span><strong>7 м</strong></div><button className="add-line">＋ Добавить сканированием</button><div className="total"><span>Итого</span><b>2 позиции</b></div><button className="primary" onClick={() => {close(); notify("Накладная № OUT-0254 создана")}}>Оформить выдачу</button></>}</Sheet>;
  if (modal === "defect") return <Sheet title="Акт дефектовки" close={close}><div className="doc-number">DF-0248 <span>{step === 0 ? "Черновик" : "Заполнено"}</span></div>{step === 0 ? <><label>Изделие / серийный номер<input defaultValue="Антенна № 000966" /></label><label>Откуда поступило<select><option>Участок эксплуатации № 4</option></select></label><label>Описание неисправности<textarea defaultValue="Не включается, отсутствует выходной сигнал" /></label><label>Выявленные дефекты<textarea placeholder="Опишите результаты осмотра" /></label><label>Заключение<select><option>Ремонтопригодно</option><option>Не подлежит ремонту</option></select></label><button className="attach">＋ Добавить фото дефекта</button><button className="primary" onClick={() => setStep(1)}>Сохранить и закрыть дефектовку</button></> : <div className="success"><div>✓</div><h2>Дефектовка закрыта</h2><p>Теперь можно создать акт выполненных работ. Данные изделия и дефекты перенесутся автоматически.</p><button className="primary" onClick={() => open("work")}>Создать акт работ</button><button className="secondary" onClick={close}>Вернуться к ремонтам</button></div>}</Sheet>;
  return <Sheet title="Акт выполненных работ" close={close}><div className="doc-number">RW-0249 <span>Черновик</span></div><div className="linked">Связан с дефектовкой <b>DF-0248</b><small>Антенна № 000966</small></div><label>Выполненные работы<textarea defaultValue="Замена усилителя сигнала, восстановление кабельной линии, пайка соединений" /></label><h3>Израсходованные материалы</h3><div className="line-item"><span><b>Флюс RMA-223</b><small>Со склада поста № 2</small></span><strong>10 г</strong></div><div className="line-item"><span><b>Припой ПОС-61</b><small>Со склада поста № 2</small></span><strong>20 г</strong></div><div className="line-item"><span><b>Усилитель ACASOM 20W</b><small>Серийный учет</small></span><strong>1 шт</strong></div><button className="add-line">＋ Добавить материал</button><label>Результат<select><option>Отремонтировано, исправно</option><option>Требуется дополнительная диагностика</option></select></label><button className="primary" onClick={() => {close(); notify("Акт RW-0249 закрыт, материалы списаны")}}>Закрыть акт и списать материалы</button></Sheet>;
}

function Sheet({ title, close, children }: any) { return <div className="overlay sheet-wrap"><div className="sheet"><div className="sheet-head"><button onClick={close}>←</button><h1>{title}</h1><button onClick={close}>×</button></div><div className="sheet-body">{children}</div></div></div> }
function Choice({ icon,title,detail,onClick }: any) { return <button className="choice" onClick={onClick}><b>{icon}</b><span><strong>{title}</strong><small>{detail}</small></span><em>›</em></button> }
function Nav({ active,icon,text,onClick }: any) { return <button onClick={onClick} className={active?'active':''}><b>{icon}</b><span>{text}</span></button> }
function Movement({ time,icon,tone,title,detail,person }: any) { return <div className="movement"><time>{time}</time><b className={tone}>{icon}</b><span><strong>{title}</strong><small>{detail}</small><em>{person}</em></span></div> }
