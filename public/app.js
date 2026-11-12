'use strict';
/* Vega-M kiosk client. Vanilla JS, no external resources — the touchscreen PC
   may have no internet access. */

const API = '/api';
const IDLE_MS = 60 * 1000;
const SEARCH_LIMIT = 300;

const $ = (sel) => document.querySelector(sel);

const views = {
  home: $('#view-home'),
  price: $('#view-price'),
  schedule: $('#view-schedule'),
  doctors: $('#view-doctors'),
  legal: $('#view-legal'),
  info: $('#view-info'),
};
const titles = {
  home: 'Вега-М', price: 'Прайс-лист', schedule: 'Расписание',
  doctors: 'Врачи', legal: 'Юридическая информация', info: 'Информация для пациентов',
};

const state = {
  view: 'home',
  price: { items: null, catalog: null, group: null, query: '' },
  schedule: { items: null, date: null, days: [] },
  doctors: { items: null },
  loaded: { price: false, schedule: false, doctors: false },
};

let lastTouch = Date.now();

/* ------------------------------------------------------------------ utils */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const money = (v) => Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 0 });

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/* ------------------------------------------------------------------ feeds */

async function ensureFeed(name, force) {
  if (state.loaded[name] && !force) return;
  const data = await fetchJSON(`${API}/${name}`);
  const items = data.items || [];
  if (name === 'price') state.price.items = items;
  if (name === 'schedule') {
    state.schedule.items = items;
    state.schedule.days = [...new Set(items.map((r) => r.D))].sort();
    // при обновлении не сбрасываем выбранный день, если он ещё есть
    if (!state.schedule.date || !state.schedule.days.includes(state.schedule.date)) {
      state.schedule.date = state.schedule.days[0] || null;
    }
  }
  if (name === 'doctors') state.doctors.items = items;
  state.loaded[name] = true;
  checkFreshness(name, data);
}

const freshness = {};

function checkFreshness(name, data) {
  freshness[name] = data.source;
  const stale = Object.keys(freshness).some((k) => freshness[k] && freshness[k] !== 'db');
  const status = $('#status');
  status.hidden = !stale;
  status.textContent = 'Данные временно не обновляются — показаны последние загруженные сведения';
}

/* ------------------------------------------------------------------- clock */

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля',
  'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const WEEKDAYS_SHORT = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];

function tickClock() {
  const now = new Date();
  $('#clockTime').textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  $('#clockDate').textContent =
    `${WEEKDAYS[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]}`;
}
tickClock();
setInterval(tickClock, 1000);

/* -------------------------------------------------------------- navigation */

function setView(name) {
  state.view = name;
  // вход в прайс всегда начинается со списка прайс-листов,
  // а не с каталога/услуги, где посетитель был в прошлый раз
  if (name === 'price') {
    state.price.catalog = null;
    state.price.group = null;
    state.price.query = '';
  }
  for (const [key, el] of Object.entries(views)) el.classList.toggle('active', key === name);
  $('#title').textContent = titles[name];
  $('#title').hidden = name === 'home';
  $('#topbarAddr').hidden = name !== 'home';   // адрес — только на главном
  $('#backBtn').hidden = name === 'home';
  $('#homeBtn').hidden = name === 'home';      // нижняя кнопка возврата — только в разделах
  closeKeyboard();
  closeModal();
  closeDoc();
  updateBack();
}

function updateBack() {
  const p = state.price;
  const inside = state.view === 'price' && (p.query || p.group || p.catalog);
  $('#backBtn').hidden = state.view === 'home' && !inside;
}

function goBack() {
  if (docOpen()) { closeDoc(); return; }
  if (state.view !== 'price') { setView('home'); return; }
  const p = state.price;
  if (p.query) { p.query = ''; renderPrice(); return; }
  if (p.group) {
    p.group = null;
    // каталог из одного раздела — сразу на список прайс-листов, без пустого экрана
    if (groupsOf(p.catalog).length === 1) p.catalog = null;
    renderPrice(); return;
  }
  if (p.catalog) { p.catalog = null; renderPrice(); return; }
  setView('home');
}

$('#backBtn').addEventListener('click', goBack);
$('#homeBtn').addEventListener('click', () => setView('home'));

/* ------------------------------------------------ юридические документы */

const DOC_IDLE_MS = 5 * 60 * 1000;
const docOpen = () => !$('#docview').hidden;

function openDoc(url, title) {
  $('#docviewTitle').textContent = title || 'Документ';
  // встроенный просмотрщик Chrome: без панели инструментов, по ширине окна
  $('#docviewFrame').src = `${url}#toolbar=0&navpanes=0&view=FitH`;
  $('#docview').hidden = false;
}

function closeDoc() {
  if ($('#docview').hidden) return;
  $('#docview').hidden = true;
  $('#docviewFrame').src = 'about:blank';
}

document.querySelectorAll('.doc-btn').forEach((btn) => {
  btn.addEventListener('click', () => openDoc(btn.dataset.doc, btn.dataset.title));
});
$('#docviewClose').addEventListener('click', closeDoc);

document.querySelectorAll('.tile').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = btn.dataset.goto;
    setView(target);
    if (target === 'info' || target === 'legal') return;   // статические справки, сеть не нужна
    try {
      await ensureFeed(target);
      if (target === 'schedule') await ensureFeed('doctors').catch(() => {});
      if (target === 'price') renderPrice();
      if (target === 'schedule') renderSchedule();
      if (target === 'doctors') renderDoctors();
    } catch (err) {
      showError(err);
    }
  });
});

/* «волна» от точки касания — отклик на нажатие любых кнопок */
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.tile, .cta, .home-btn, .booking-home, .bw-btn, .chip, .spec-chip, .date-chip, .doc-card, .back, .acc summary');
  if (!el) return;
  const r = el.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 1.1;
  const s = document.createElement('span');
  s.className = 'ripple';
  s.style.width = s.style.height = size + 'px';
  s.style.left = (e.clientX - r.left - size / 2) + 'px';
  s.style.top = (e.clientY - r.top - size / 2) + 'px';
  el.appendChild(s);
  setTimeout(() => s.remove(), 620);
}, { passive: true });

function showError(err) {
  const status = $('#status');
  status.hidden = false;
  status.textContent = 'Нет связи с сервером данных. Попробуйте обновить раздел через минуту.';
  console.error(err);
}

/* ------------------------------------------------------------------- price */

function priceItems() { return state.price.items || []; }

function catalogs() {
  const map = new Map();
  for (const it of priceItems()) {
    const key = it.ROOT_GROUP_ID;
    if (!map.has(key)) map.set(key, { id: key, name: it.ROOT_GROUP, count: 0, groups: new Set() });
    const c = map.get(key);
    c.count++;
    c.groups.add(it.GROUP_ID);
  }
  return [...map.values()];
}

function groupsOf(catalogId) {
  const map = new Map();
  for (const it of priceItems()) {
    if (it.ROOT_GROUP_ID !== catalogId) continue;
    if (!map.has(it.GROUP_ID)) map.set(it.GROUP_ID, { id: it.GROUP_ID, name: it.GROUP_NAME, count: 0 });
    map.get(it.GROUP_ID).count++;
  }
  return [...map.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
}

function renderPrice() {
  const p = state.price;
  const box = $('#priceList');
  const crumbs = $('#priceCrumbs');
  const searchText = $('#searchText');
  const searchBox = $('#searchBox');

  searchText.textContent = p.query ? p.query : 'Поиск услуги';
  searchBox.classList.toggle('filled', !!p.query);

  const chips = [];
  const cat = catalogs().find((c) => c.id === p.catalog);
  const grp = cat && p.group ? groupsOf(cat.id).find((g) => g.id === p.group) : null;
  // у каталога с единственным одноимённым разделом промежуточный уровень не нужен
  const grpChip = grp && grp.name !== cat.name;
  if (cat && !p.query) chips.push(`<button class="chip ${grpChip ? '' : 'current'}" data-cat="${esc(cat.id)}">${esc(cat.name)}</button>`);
  if (grpChip) chips.push(`<button class="chip current" data-grp="${esc(grp.id)}">${esc(grp.name)}</button>`);
  crumbs.innerHTML = chips.join('');
  crumbs.querySelectorAll('[data-cat]').forEach((el) => el.addEventListener('click', () => {
    const id = Number(el.dataset.cat);
    p.catalog = groupsOf(id).length === 1 ? null : id;
    p.group = null; p.query = ''; renderPrice();
  }));
  crumbs.querySelectorAll('[data-grp]').forEach((el) => el.addEventListener('click', () => {
    p.group = null; renderPrice();
  }));

  updateBack();

  if (p.query) return renderSearchResults(box, p.query);
  if (!p.catalog) return renderCatalogList(box);
  if (!p.group) return renderGroupList(box, p.catalog);
  return renderServiceList(box, p.catalog, p.group);
}

const DOC_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 8h6M9 12h6M9 16h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const LAB_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6M10 3v6.2L5.6 17a2.6 2.6 0 0 0 2.2 4h8.4a2.6 2.6 0 0 0 2.2-4L14 9.2V3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.6 14h8.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const GIFT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7.5" width="18" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 12h18M12 7.5v13" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5S9.4 7.4 8.5 6.3a1.7 1.7 0 0 1 2.6-2c.9 1 1 3.2.9 3.2Zm0 0s2.6-.1 3.5-1.2a1.7 1.7 0 0 0-2.6-2c-.9 1-1 3.2-.9 3.2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

function renderCatalogList(box) {
  const cats = catalogs();
  box.innerHTML = '<div class="section-head">Прайс-листы</div>' + cats.map((c, i) => `
    <button class="catalog" data-id="${esc(c.id)}">
      <span class="catalog-icon">${/сертификат/i.test(c.name) ? GIFT_ICON : (i === 0 ? DOC_ICON : LAB_ICON)}</span>
      <span class="catalog-main">
        <span class="catalog-name">${esc(c.name)}</span>
        <small>${c.groups.size} ${plural(c.groups.size, 'раздел', 'раздела', 'разделов')}</small>
      </span>
      <span class="count">${c.count} ${plural(c.count, 'услуга', 'услуги', 'услуг')}</span>
    </button>`).join('');
  box.querySelectorAll('[data-id]').forEach((el) => el.addEventListener('click', () => {
    state.price.catalog = Number(el.dataset.id);
    // у каталога с единственным разделом промежуточный экран не нужен
    const only = groupsOf(state.price.catalog);
    state.price.group = only.length === 1 ? only[0].id : null;
    renderPrice();
  }));
}

function renderGroupList(box, catalogId) {
  const groups = groupsOf(catalogId);
  box.innerHTML = '<div class="section-head">Разделы</div>' + groups.map((g) => `
    <button class="group-row" data-id="${esc(g.id)}">
      <span>${esc(tidy(g.name))}</span><span class="count">${g.count}</span>
    </button>`).join('');
  box.querySelectorAll('[data-id]').forEach((el) => el.addEventListener('click', () => {
    state.price.group = Number(el.dataset.id);
    renderPrice();
  }));
  box.scrollTop = 0;
}

function renderServiceList(box, catalogId, groupId) {
  const rows = priceItems().filter((it) => it.ROOT_GROUP_ID === catalogId && it.GROUP_ID === groupId);
  const group = groupsOf(catalogId).find((g) => g.id === groupId);
  const certs = !!(group && /сертификат/i.test(group.name));
  const note = certs
    ? '<div class="price-note">Сертификат можно купить в регистратуре. Сумма действует 12 месяцев с даты покупки — потратить можно целиком или частями.</div>'
    : '';
  // у сертификатов в Archimed коды услуг — просто порядковые номера («1», «2», «3»)
  const list = certs ? rows.map((it) => ({ ...it, CODE: null })) : rows;
  box.innerHTML = note + serviceRows(list);
  box.scrollTop = 0;
}

function serviceRows(rows) {
  if (!rows.length) return '<div class="empty">Ничего не найдено</div>';
  return rows.map((it) => `
    <div class="item">
      <div class="name">${esc(tidy(it.NAME))}${it.CODE ? `<span class="code">${esc(it.CODE)}</span>` : ''}</div>
      <div class="price">${money(it.PRICE)} <small>₽</small></div>
    </div>`).join('');
}

function renderSearchResults(box, query) {
  const q = norm(query);
  const found = [];
  for (const it of priceItems()) {
    if (norm(it.NAME).includes(q) || norm(it.ALTNAME).includes(q)) {
      found.push(it);
      if (found.length >= SEARCH_LIMIT) break;
    }
  }
  box.innerHTML = `<div class="section-head">Найдено: ${found.length}${found.length >= SEARCH_LIMIT ? '+' : ''}</div>`
    + serviceRows(found);
  box.scrollTop = 0;
}

/* ---------------------------------------------------------------- schedule */

function renderSchedule() {
  const s = state.schedule;
  const strip = $('#dateStrip');
  const rows = s.items || [];

  if (!s.days.length) {
    strip.innerHTML = '';
    $('#scheduleList').innerHTML = '<div class="empty">Расписание пока не опубликовано</div>';
    return;
  }

  if (!s.date || !s.days.includes(s.date)) s.date = s.days[0];

  strip.innerHTML = s.days.map((d) => {
    const dt = new Date(d + 'T00:00:00');
    const n = rows.filter((r) => r.D === d).length;
    const sel = d === s.date ? ' sel' : '';
    return `<button class="date-chip${sel}" data-d="${esc(d)}">
      <span class="wd">${WEEKDAYS_SHORT[dt.getDay()]}</span>
      <span class="dm">${dt.getDate()}.${String(dt.getMonth() + 1).padStart(2, '0')}</span>
      <span class="cnt">${n ? n + ' ' + plural(n, 'приём', 'приёма', 'приёмов') : '—'}</span>
    </button>`;
  }).join('');

  strip.querySelectorAll('[data-d]').forEach((el) => el.addEventListener('click', () => {
    s.date = el.dataset.d;
    renderSchedule();
  }));

  const day = rows.filter((r) => r.D === s.date);
  const box = $('#scheduleList');
  if (!day.length) {
    box.innerHTML = '<div class="empty">В этот день приёма нет</div>';
    return;
  }

  // Специальности врача: в каждом островке он показывается со своей сменой.
  const specsOf = new Map();
  for (const d of state.doctors.items || []) {
    const sp = tidy(d.SPECIALTY);
    if (!sp) continue;
    if (!specsOf.has(d.DOCTOR_ID)) specsOf.set(d.DOCTOR_ID, []);
    if (!specsOf.get(d.DOCTOR_ID).includes(sp)) specsOf.get(d.DOCTOR_ID).push(sp);
  }

  const islands = new Map();
  for (const r of day) {
    const list = specsOf.get(r.DOCTOR_ID) || [tidy(r.SPECIALTY) || 'Другое'];
    for (const sp of list) {
      if (!islands.has(sp)) islands.set(sp, []);
      islands.get(sp).push(r);
    }
  }

  const shiftCard = (r) => `
    <div class="shift">
      <div class="time">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3.2 2.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        <span>${esc(r.T1)}–${esc(r.T2)}</span>
      </div>
      <div class="who">
        <div class="doc">${esc(tidy(r.DOCTOR_NAME))}</div>
      </div>
      <div class="room">${esc(r.ROOM_NUMBER || r.ROOM_NAME || '')}${r.ROOM_FLOOR ? `<br>${esc(r.ROOM_FLOOR)}` : ''}</div>
    </div>`;

  box.innerHTML = [...islands.keys()]
    .sort((a, b) => a.localeCompare(b, 'ru'))
    .map((spec) => {
      const list = islands.get(spec).slice().sort((a, b) =>
        a.T1.localeCompare(b.T1) || tidy(a.DOCTOR_NAME).localeCompare(tidy(b.DOCTOR_NAME), 'ru'));
      return `<section class="island">
        <h2 class="island-head"><span>${esc(spec)}</span><span class="island-count">${list.length}</span></h2>
        ${list.map(shiftCard).join('')}
      </section>`;
    }).join('');
  box.scrollTop = 0;
}

/* ----------------------------------------------------------------- doctors */

// Версия фото в URL: сервер отдаёт PHOTO_KEY (дата + размер снимка), поэтому
// заменённое фото получает новый адрес и не застревает в кэше браузера на сутки.
function photoVersion(d) {
  return d.PHOTO_KEY ? `?v=${encodeURIComponent(d.PHOTO_KEY)}` : '';
}

function renderDoctors() {
  const grid = $('#doctorsGrid');
  // Источник истины — справочник врачей Archimed (вьюха уже отсекает служебные
  // роли). Показываем всех, у кого есть хоть одна смена: HAS_SCHEDULE считает
  // сервер по вьюхе расписания. IS_PUBLISHED_WEB — это только «публиковать
  // расписание на сайте», по нему не фильтруем.
  const all = state.doctors.items || [];
  // mssql отдаёт CAST(... AS bit) как boolean, поэтому проверяем на истинность
  const list = all.some((d) => 'HAS_SCHEDULE' in d)
    ? all.filter((d) => !!d.HAS_SCHEDULE)
    : all;   // старый снимок без поля — не прячем никого

  // Главный врач — по роли из Archimed (IS_CHIEF). Ставим его первым островком:
  // в общем списке по специальностям такой карточки не найти, иначе её ищут
  // глазами по всем островкам.
  const CHIEF = 'Главный врач';
  const chiefDocs = [];
  for (const d of list) {
    if (d.IS_CHIEF && !chiefDocs.some((x) => x.DOCTOR_ID === d.DOCTOR_ID)) chiefDocs.push(d);
  }

  // Один врач может иметь несколько специальностей — в каждом островке он свой.
  const islands = new Map();
  if (chiefDocs.length) islands.set(CHIEF, chiefDocs);
  for (const d of list) {
    const key = tidy(d.SPECIALTY) || 'Другие';
    if (!islands.has(key)) islands.set(key, []);
    islands.get(key).push(d);
  }
  const order = [...islands.keys()].sort((a, b) =>
    a === CHIEF ? -1 : b === CHIEF ? 1 : a.localeCompare(b, 'ru'));

  const cards = new Map();
  const parts = [];
  for (const spec of order) {
    const docs = islands.get(spec).slice().sort((a, b) =>
      (b.IS_PRIMARY - a.IS_PRIMARY) || tidy(a.FULLNAME).localeCompare(tidy(b.FULLNAME), 'ru'));
    const body = docs.map((d) => {
      const key = d.DOCTOR_ID + '-' + (d.SPECIALTY_ID || 0);
      cards.set(key, d);
      const photo = d.HAS_PHOTO
        ? `<img loading="lazy" src="${API}/photo/${d.DOCTOR_ID}${photoVersion(d)}" alt="">`
        : `<span class="initials">${esc(initials(d.FULLNAME))}</span>`;
      return `<div class="doc-card" role="button" tabindex="0" data-key="${key}">
        <div class="doc-photo">${photo}</div>
        <div class="doc-body">
          <div class="doc-name">${esc(tidy(d.FULLNAME))}</div>
          <div class="doc-spec">${esc(tidy(d.SPECIALTY))}</div>
          ${d.IS_CHIEF ? '<div class="chief-tag">Главный врач</div>' : ''}
        </div>
      </div>`;
    }).join('');
    parts.push(`<section class="island">
      <h2 class="island-head"><span>${esc(spec)}</span><span class="island-count">${docs.length}</span></h2>
      <div class="island-grid">${body}</div>
    </section>`);
  }

  grid.innerHTML = parts.join('');

  const strip = $('#specStrip');
  strip.innerHTML = order
    .map((spec) => `<button class="spec-chip" data-spec="${esc(spec)}">${esc(spec)}</button>`)
    .join('');
  strip.querySelectorAll('[data-spec]').forEach((chip) => chip.addEventListener('click', () => {
    const target = [...grid.querySelectorAll('.island')]
      .find((el) => el.querySelector('.island-head span').textContent === chip.dataset.spec);
    if (!target) return;
    const top = target.getBoundingClientRect().top - grid.getBoundingClientRect().top + grid.scrollTop - 8;
    grid.scrollTo({ top, behavior: 'smooth' });
  }));

  grid.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => {
      const card = img.closest('.doc-card');
      const doc = cards.get(card.dataset.key);
      img.parentElement.innerHTML = `<span class="initials">${esc(initials(doc && doc.FULLNAME))}</span>`;
    }, { once: true });
  });

  grid.querySelectorAll('[data-key]').forEach((el) => el.addEventListener('click', () => {
    const doc = cards.get(el.dataset.key);
    if (doc) openDoctor(doc);
  }));

  grid.scrollTop = 0;
}

function openDoctor(d) {
  const specs = [...new Set((state.doctors.items || [])
    .filter((x) => x.DOCTOR_ID === d.DOCTOR_ID)
    .map((x) => tidy(x.SPECIALTY))
    .filter(Boolean))];
  $('#modalName').textContent = tidy(d.FULLNAME);
  $('#modalSpec').textContent = specs.join(' · ') || tidy(d.SPECIALTY);
  $('#modalChief').hidden = !d.IS_CHIEF;
  // Биография в Archimed размечена переводами строк (Образование / Стаж /
  // Стоимость приёма / телефоны — каждая с новой строки). Разметку сохраняем:
  // раньше /\s{2,}/ → ' ' склеивал всё в один абзац. Чистим только хвостовые
  // пробелы и пустые строки, внутри строки сжимаем повторные пробелы.
  const bio = String(d.BIO || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  // Обращение к врачу (у выездного нарколога — свои телефоны) выделяем на фоне
  // остального текста биографии. Текст экранируется, подставляется только наша
  // разметка, поэтому innerHTML здесь безопасен.
  $('#modalBio').innerHTML = esc(bio).replace(
    'Для получения услуг по наркологии, пожалуйста, обращайтесь:',
    '<span class="bio-lead">Для получения услуг по наркологии, пожалуйста, обращайтесь:</span>'
  );
  $('#modalPhoto').innerHTML = d.HAS_PHOTO
    ? `<img src="${API}/photo/${d.DOCTOR_ID}${photoVersion(d)}" alt="">`
    : `<span class="initials">${esc(initials(d.FULLNAME))}</span>`;
  $('#modal').hidden = false;
}

function closeModal() { $('#modal').hidden = true; }

/* -------------------------------------------------------------- запись */

const WIDGET_URL = 'https://widget.archimed-soft.ru/widget/5419681901a9d13534c34fae0731eaeb';
const BOOKING_IDLE_MS = 90 * 1000;       // бездействие в записи — полторы минуты
const BOOKING_WARN_MS = 10 * 1000;       // столько остаётся на реакцию, когда окно появилось
let bookingStarted = false;

function bookingOpen() { return !$('#booking').hidden; }

function openBooking() {
  $('#booking').hidden = false;
  if (bookingStarted) return;
  bookingStarted = true;
  const frame = $('#bookingFrame');
  const fallback = $('#bookingFallback');
  const timer = setTimeout(() => { fallback.hidden = false; }, 8000);
  frame.addEventListener('load', () => {
    if (frame.src === 'about:blank') return;
    clearTimeout(timer);
    fallback.hidden = true;
  }, { once: false });
  frame.src = WIDGET_URL;
}

function closeBooking() {
  $('#booking').hidden = true;
  hideBookingWarn();
}

/* Предупреждение за 10 с до автосброса: внутри iframe Archimed наши события не
   видны, поэтому нажатий по форме недостаточно — посетителю показываем кнопку. */
let warnSec = -1;
function showBookingWarn(sec) {
  const box = $('#bookingWarn');
  if (box.hidden) box.hidden = false;
  if (sec !== warnSec) { warnSec = sec; $('#bwSec').textContent = sec; }
}
function hideBookingWarn() {
  if (!$('#bookingWarn').hidden) $('#bookingWarn').hidden = true;
  warnSec = -1;
}

$('#bookBtn').addEventListener('click', openBooking);
$('#bookingClose').addEventListener('click', () => { closeBooking(); setView('home'); });
$('#bookingHome').addEventListener('click', () => { closeBooking(); setView('home'); });
// тап по предупреждению продлевает запись (lastTouch обновит общий pointerdown)
$('#bookingWarn').addEventListener('pointerdown', hideBookingWarn);

$('#modalClose').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

/* ---------------------------------------------------------------- keyboard */

const LAYOUTS = {
  ru: [
    ['й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'щ', 'з', 'х', 'ъ'],
    ['ф', 'ы', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ж', 'э'],
    ['я', 'ч', 'с', 'м', 'и', 'т', 'ь', 'б', 'ю', 'ё'],
  ],
  en: [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
  ],
};
let kbLang = 'ru';

function buildKeyboard() {
  const rows = LAYOUTS[kbLang].map((row) => `
    <div class="kb-row">${row.map((ch) => `<button class="kb-key" data-k="${ch}">${ch}</button>`).join('')}</div>`);
  rows.push(`<div class="kb-row">
      <button class="kb-key wide" data-k=" ">пробел</button>
      <button class="kb-key back" data-k="back">⌫</button>
    </div>`);
  $('#kbRows').innerHTML = rows.join('');
  $('#kbRows').querySelectorAll('[data-k]').forEach((el) => el.addEventListener('click', () => {
    const k = el.dataset.k;
    if (k === 'back') state.price.query = state.price.query.slice(0, -1);
    else if (state.price.query.length < 70) state.price.query += k;
    renderKeyboardValue();
    renderPrice();
  }));
  document.querySelector('[data-kb="lang"]').textContent = kbLang === 'ru' ? 'EN' : 'РУ';
}

function renderKeyboardValue() {
  $('#kbValue').textContent = state.price.query;
}

function openKeyboard() {
  buildKeyboard();
  renderKeyboardValue();
  $('#kb').hidden = false;
}

function closeKeyboard() {
  if (!$('#kb').hidden) $('#kb').hidden = true;
}

$('#searchBox').addEventListener('click', () => {
  openKeyboard();
});

document.querySelector('[data-kb="clear"]').addEventListener('click', () => {
  state.price.query = '';
  renderKeyboardValue();
  renderPrice();
});

document.querySelector('[data-kb="lang"]').addEventListener('click', () => {
  kbLang = kbLang === 'ru' ? 'en' : 'ru';
  buildKeyboard();
});

document.querySelector('[data-kb="done"]').addEventListener('click', () => {
  closeKeyboard();
  renderPrice();
});

/* ------------------------------------------------------------ idle reset */

function touch() { lastTouch = Date.now(); }
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, touch, { passive: true }));

setInterval(() => {
  const idle = Date.now() - lastTouch;
  if (docOpen()) {
    // юридический документ читают не торопясь — держим экран до 5 минут
    if (idle < DOC_IDLE_MS) return;
    closeDoc();
  } else if (bookingOpen()) {
    // Внутри iframe виджета наши события не видны: нажатия по форме Archimed
    // сюда не приходят. Поэтому перед сбросом даём 10 секунд и кнопку
    // «Продолжить запись», чтобы данные не пропали молча.
    const left = BOOKING_IDLE_MS - idle;
    if (left > 0) {
      if (left <= BOOKING_WARN_MS) showBookingWarn(Math.ceil(left / 1000));
      else hideBookingWarn();
      return;
    }
    closeBooking();
  } else if (idle < IDLE_MS) {
    return;
  }
  if (!$('#modal').hidden || !$('#kb').hidden || state.view !== 'home') {
    state.price = { items: state.price.items, catalog: null, group: null, query: '' };
    setView('home');
  }
}, 1000);

/* ------------------------------------------------------------------- boot */

setView('home');

// Warm the other feeds in the background so the first tap is instant.
setTimeout(async () => {
  for (const name of ['schedule', 'doctors', 'price']) {
    try { await ensureFeed(name); } catch { /* retried on demand */ }
  }
}, 800);

/* Киоск открыт сутками, поэтому данные периодически перезапрашиваем сами:
   иначе переименованные разделы и новые цены не появятся без перезагрузки.
   Интервалы не чаще серверного TTL лент. */
const FEED_REFRESH_MS = { price: 10 * 60 * 1000, schedule: 2 * 60 * 1000, doctors: 30 * 60 * 1000 };

async function reloadFeed(name) {
  const scroller = views[name] && views[name].querySelector('.list, .doctors-grid');
  const scrollTop = scroller ? scroller.scrollTop : 0;

  try {
    await ensureFeed(name, true);
  } catch {
    return;   // нет связи — остаёмся на последних данных
  }

  if (name === 'price') {
    // каталог или раздел мог исчезнуть из прайса — не показываем пустоту
    if (state.price.catalog && !catalogs().some((c) => c.id === state.price.catalog)) {
      state.price.catalog = null;
      state.price.group = null;
    }
    if (state.price.group && !groupsOf(state.price.catalog).some((g) => g.id === state.price.group)) {
      state.price.group = null;
    }
  }

  if (state.view !== name) return;
  if (name === 'price') renderPrice();
  else if (name === 'schedule') renderSchedule();
  else renderDoctors();
  if (scroller) scroller.scrollTop = scrollTop;   // не дёргаем список под пальцем
}

for (const [name, ms] of Object.entries(FEED_REFRESH_MS)) {
  setInterval(() => reloadFeed(name), ms);
}

// Если на сервере выложили новую версию статики — перезагружаемся сами,
// чтобы киоск не жил со старым кэшем.
const ASSET_VERSION = (document.querySelector('script[src*="app.js?v="]') || { src: '' })
  .src.match(/[?&]v=(\d+)/);
const MY_VERSION = ASSET_VERSION ? ASSET_VERSION[1] : null;

async function checkVersion() {
  if (!MY_VERSION) return;
  // Не перезагружаемся посреди записи или чтения документа: посетитель потеряет
  // заполненную форму (ФИО, дата рождения, почта). Проверим на следующем цикле.
  if (bookingOpen() || docOpen()) return;
  try {
    const info = await fetchJSON(`${API}/version`);
    if (info.v && info.v !== MY_VERSION) window.location.reload();
  } catch { /* сервер недоступен — ничего не делаем */ }
}
setInterval(checkVersion, 5 * 60 * 1000);
setTimeout(checkVersion, 60 * 1000);
