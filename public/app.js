const BASE_STORE = 'delis-prototype-v1';
const SPLASH_DURATION = 2000;
const inviteToken = new URLSearchParams(location.search).get('invite');
const LOCAL_PREVIEW = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
const LOCAL_PREVIEW_PAIRS = 'amozhno-local-preview-pairs-v1';
const resetLocalPreview = LOCAL_PREVIEW && new URLSearchParams(location.search).has('reset-preview');
let STORE = BASE_STORE;
try {
  if (inviteToken) {
    let hash = 0;
    for (const char of inviteToken) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    STORE = `${BASE_STORE}:invite:${hash >>> 0}`;
    sessionStorage.setItem('delis-active-store', STORE);
  } else STORE = sessionStorage.getItem('delis-active-store') || BASE_STORE;
} catch { /* Private browsing can restrict session storage. */ }
if (resetLocalPreview) {
  try {
    localStorage.removeItem(BASE_STORE);
    localStorage.removeItem(LOCAL_PREVIEW_PAIRS);
    sessionStorage.removeItem('delis-active-store');
  } catch { /* Keep the preview usable when browser storage is unavailable. */ }
}
const $ = (selector) => document.querySelector(selector);

function syncHostViewport() {
  const host = window.WebApp;
  const density = window.devicePixelRatio || 1;
  const mobileAgent = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const cssWidth = window.visualViewport?.width || document.documentElement.clientWidth || window.innerWidth;
  const cssHeight = window.visualViewport?.height || window.innerHeight;
  const normalizeViewport = (rawWidth, rawHeight, fallbackWidth, fallbackHeight) => {
    let width = Number.parseFloat(rawWidth);
    let height = Number.parseFloat(rawHeight);
    if (!Number.isFinite(width) || width <= 0) width = fallbackWidth;
    if (!Number.isFinite(height) || height <= 0) height = fallbackHeight;
    // Decide the coordinate space from width, then convert width and height
    // together. Converting each dimension independently breaks tall phones.
    if (width > 700 && density > 1) {
      const cssWidth = width / density;
      if (cssWidth >= 280 && cssWidth <= 600) {
        width = cssWidth;
        height /= density;
      }
    }
    return { width, height };
  };
  const cssViewport = normalizeViewport(cssWidth, cssHeight, 375, 667);
  const { width, height } = cssViewport;
  const nativeMobile = Boolean(host && ['ios', 'android'].includes(host.platform) && width <= 700);
  // A desktop browser can expose a mobile-like user agent. Its actual CSS
  // viewport is the reliable signal: wide windows must use the desktop frame.
  const mobileLayout = nativeMobile || width <= 700 || (mobileAgent && width <= 700);
  document.documentElement.classList.toggle('max-mobile', mobileLayout);
  if (!mobileLayout) {
    const desktopScale = Math.min((height - 28) / 667, (width - 32) / 375);
    document.documentElement.style.setProperty('--desktop-app-scale', String(Math.max(1, desktopScale)));
    return;
  }

  const safeProbe = document.createElement('div');
  safeProbe.style.cssText = 'position:fixed;visibility:hidden;inset:auto;bottom:0;padding-bottom:env(safe-area-inset-bottom, 0px)';
  document.body.append(safeProbe);
  const safeBottom = Number.parseFloat(getComputedStyle(safeProbe).paddingBottom) || 0;
  safeProbe.remove();

  let availableWidth = width;
  let availableHeight = height;
  if (typeof host?.getViewportSize === 'function') {
    Promise.resolve(host.getViewportSize()).then((viewport) => {
      const hostViewport = normalizeViewport(viewport?.width, viewport?.height, NaN, NaN);
      const hostWidth = hostViewport.width;
      const hostHeight = hostViewport.height;
      // Trust the bridge when it agrees with the actual CSS viewport. In the
      // MAX web client it can describe a different coordinate space.
      if (Number.isFinite(hostWidth) && Math.abs(hostWidth - width) <= width * 0.2) availableWidth = hostWidth;
      if (Number.isFinite(hostHeight) && Math.abs(hostHeight - height) <= height * 0.2) availableHeight = hostHeight;
      applyFrame();
    }).catch(() => {});
  }

  function applyFrame() {
    const safeHeight = Math.max(1, availableHeight - safeBottom);
    const scale = Math.min(availableWidth / 375, safeHeight / 667);
    if (!Number.isFinite(scale) || scale <= 0) return;
    document.documentElement.style.setProperty('--app-scale', String(scale));
    document.documentElement.style.setProperty('--app-canvas-height', `${safeHeight / scale}px`);
    document.documentElement.style.setProperty('--app-viewport-height', `${safeHeight}px`);
  }

  applyFrame();
}

try { syncHostViewport(); } catch { document.documentElement.classList.remove('max-mobile'); }
window.addEventListener('resize', syncHostViewport);
window.addEventListener('load', syncHostViewport);
// The desktop in-app browser first exposes a narrow bootstrap viewport and
// expands it after deferred scripts load, without emitting resize.
window.setTimeout(syncHostViewport, 250);
function maxInitData() {
  const value = window.WebApp?.initData;
  return typeof value === 'string' && value.length > 0 ? value : '';
}
function maxInitDataHeader() {
  const value = maxInitData();
  if (!value) return '';
  // MAX may supply characters which a browser does not allow in HTTP header
  // values. Transfer the signed payload losslessly in a header-safe form.
  try {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return `b64:${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  } catch { return ''; }
}
let state = { profile: null, circles: [], activeCircleId: null, diary: [], marks: {}, privateNotes: {}, introAccepted: false, rulesSeen: false, memberToken: null, invitationToken: null };
let screen = 'splash';
let incomingInvite = null;
let questions = { child: [], adult: [] };
let questionsReady = false;
let lastShownDay = '';
let openingQuestion = false;
let conversationDialog = null;
let questionDialog = null;
let deleteDialog = false;
let shareDialog = '';
let flashMessage = '';
let flashTimer = null;

// Numbers refer to the source deck. Every question is included in the rotation.
const questionTiers = {
  child: [
    [2, 3, 4, 5, 6, 8, 13, 15, 16, 23, 24, 26, 30, 31, 33, 34, 38, 39, 40, 42, 43],
    [1, 9, 10, 11, 12, 17, 18, 19, 22, 27, 28, 29, 36, 37, 44, 45],
    [7, 14, 20, 21, 25, 32, 35, 41],
  ],
  adult: [
    [1, 2, 4, 7, 8, 9, 10, 11, 12, 17, 18, 23, 24, 25, 30, 31, 32, 35, 36, 40, 41, 43],
    [3, 5, 16, 19, 20, 21, 26, 27, 28, 29, 33, 34, 37, 38, 39, 42, 45],
    [6, 13, 14, 15, 22, 44],
  ],
};

let saved = null;
try {
  saved = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (saved && typeof saved === 'object') state = { ...state, ...saved };
} catch { /* start with a clean in-memory prototype */ }
if (!Array.isArray(state.circles)) state.circles = [];
state.circles = state.circles.slice(0, 1);
// Existing profiles completed onboarding before these two screens were introduced.
if (state.profile?.name && !Object.hasOwn(saved || {}, 'introAccepted')) state.introAccepted = true;
if (state.profile?.name && !Object.hasOwn(saved || {}, 'rulesSeen')) state.rulesSeen = true;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const roleName = (role) => role === 'child' ? 'Ребёнок' : 'Взрослый';
function pluralForm(number, one, few, many) {
  const mod100 = Math.abs(number) % 100, mod10 = mod100 % 10;
  return mod100 >= 11 && mod100 <= 14 ? many : mod10 === 1 ? one : mod10 >= 2 && mod10 <= 4 ? few : many;
}
const dateLabel = (value) => value ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value)) : '';
function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { toast('Браузер не смог сохранить данные'); } }
function toast(message) {
  if (!message) return;
  flashMessage = String(message);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashMessage = ''; render(); }, 5000);
  render();
}
function go(next) {
  const pair = circle();
  if (['home', 'days', 'diary', 'after-mark'].includes(next) && pair?.status !== 'active') next = pair ? 'waiting' : 'invite-how';
  if (next === 'home' && questionsReady) {
    const prompt = dailyQuestion(pair);
    if (prompt && prompt.asker?.id !== state.profile?.id) next = 'days';
    else if (prompt && pair?.marks?.[prompt.key]) next = 'after-mark';
  }
  screen = next;
  history.replaceState({}, '', location.pathname + location.search);
  render();
}
function circle() { return state.circles.find((item) => item.id === state.activeCircleId) || state.circles[0] || null; }
function dayCount(start, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (!start) return 0;
  const ordinal = (date) => {
    const fields = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(({ type, value }) => [type, Number(value)]));
    return Date.UTC(fields.year, fields.month - 1, fields.day);
  };
  return Math.max(1, Math.floor((ordinal(new Date()) - ordinal(new Date(start))) / 86400000) + 1);
}
function shuffledIndex(length, seed, position) {
  if (!length) return 0;
  let value = 2166136261;
  for (const char of seed) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  const indices = Array.from({ length }, (_, index) => index);
  for (let i = length - 1; i > 0; i--) {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    const j = (value >>> 0) % (i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices[position % length];
}
function legacyQuestionForDay(pair, day) {
  if (!pair || pair.status !== 'active' || !questionsReady) return null;
  const round = day - 1, people = pair.members || [];
  if (people.length !== 2) return null;
  const asker = people[round % 2] || people[0], target = people.find((person) => person.id !== asker?.id) || people[1];
  const deck = asker?.role === 'child' ? questions.child : questions.adult;
  const index = shuffledIndex(deck.length, `${pair.id}:${asker?.role}`, Math.floor(round / 2));
  return { day, asker, target, text: deck[index], key: `${pair.id}:${day}` };
}
function plannedOrder(pair, role) {
  const shuffle = (values, stage) => values.map((_, position) =>
    values[shuffledIndex(values.length, `${pair.id}:${role}:${stage}`, position)]);
  const [easy, personal, deep] = questionTiers[role];
  const first = shuffle(easy, 'easy');
  const bridge = shuffle([...first.slice(7), ...shuffle(personal, 'personal')], 'bridge');
  return [...first.slice(0, 7), ...bridge.slice(0, 14),
    ...shuffle([...bridge.slice(14), ...shuffle(deep, 'deep')], 'later')].map((number) => number - 1);
}
function questionSequence(pair, throughDay) {
  if (!pair || pair.status !== 'active' || !questionsReady || pair.members?.length !== 2) return [];
  if ((pair.planVersion || 1) < 2) return Array.from({ length: throughDay }, (_, index) => legacyQuestionForDay(pair, index + 1));
  const used = { child: new Set(), adult: new Set() };
  const orders = Object.fromEntries(['child', 'adult'].map((role) => [role, plannedOrder(pair, role)]));
  return Array.from({ length: throughDay }, (_, index) => {
    const day = index + 1, asker = pair.members[index % 2];
    const target = pair.members[1 - index % 2], role = asker.role, order = orders[role];
    if (used[role].size >= order.length) used[role].clear();
    const choose = () => order.find((number) => !used[role].has(number));
    let number = choose();
    used[role].add(number);
    if (pair.questionDays?.[day]?.replaced) {
      if (used[role].size >= order.length) used[role].clear();
      number = choose();
      used[role].add(number);
    }
    return { day, asker, target, text: questions[role][number], key: `${pair.id}:${day}` };
  });
}
function questionForDay(pair, day) { return questionSequence(pair, day).at(-1) || null; }
function dailyQuestion(pair) { return questionForDay(pair, dayCount(pair?.startedAt, pair?.timeZone)); }
function pairQuestions(pair) {
  if (pair?.status !== 'active' || !questionsReady) return [];
  return questionSequence(pair, dayCount(pair.startedAt, pair.timeZone))
    .filter((entry) => (pair.planVersion || 1) < 2 || pair.questionDays?.[entry.day]).reverse();
}
function markAvailable(pair, day) { return Boolean(pair?.questionDays?.[day] && !pair?.questionDays?.[day]?.skippedAt); }
function logo(options = {}) {
  const withPartner = options?.partner === true;
  return `<header class="brand${withPartner ? ' brand-with-partner' : ''}"><img class="brand-365-logo" src="assets/delis-ui-decorations/365-k-sebe-logo.png" alt="365 к себе">${withPartner ? '<img class="brand-fund-logo" src="assets/delis-ui-decorations/fond-zashchity-detey-yugra-trimmed.png" alt="Фонд защиты детей Югры">' : ''}<img class="brand-title" src="assets/delis-ui-decorations/a-mozhno-sprosit-wordmark.png" alt="а можно спросить?"></header>`;
}
function nav(active) {
  if (circle()?.status !== 'active' && active === 'settings') return '';
  if (circle()?.status !== 'active' && active === 'about') return `<nav class="bottom-nav" aria-label="Навигация"><span></span><span></span><button class="nav-item" data-action="go" data-screen="settings" aria-label="Настройки"><img src="assets/delis-ui-decorations/figma-nav-settings-more.svg" alt=""/></button></nav>`;
  const icons = active === 'home'
    ? ['figma-nav-home.svg', 'figma-nav-diary.svg', 'figma-nav-more.svg']
    : active === 'diary'
      ? ['figma-nav-days-home.svg', 'figma-nav-days-diary.svg', 'figma-nav-days-more.svg']
      : ['figma-nav-settings-home.svg', 'figma-nav-settings-diary.svg', 'figma-nav-settings-more.svg'];
  return `<nav class="bottom-nav" aria-label="Навигация">
    <button class="nav-item" data-action="go" data-screen="home" aria-label="Главная"><img src="assets/delis-ui-decorations/${icons[0]}" alt=""/></button>
    <button class="nav-item" data-action="go" data-screen="days" aria-label="Дневник"><img src="assets/delis-ui-decorations/${icons[1]}" alt=""/></button>
    <button class="nav-item" data-action="go" data-screen="settings" aria-label="Ещё"><img src="assets/delis-ui-decorations/${icons[2]}" alt=""/></button>
  </nav>`;
}
function tip(title, text = '', sprout = 'figma-sprout.png') { return `<aside class="tip"><img src="assets/delis-ui-decorations/${sprout}" alt=""/><span class="tip-divider"></span><span class="tip-copy"><strong>${title}</strong>${text ? `<span>${text}</span>` : ''}</span></aside>`; }
function card(content, deco = 'corner', className = '') {
  const art = deco === 'corner'
    ? '<img class="card-corner" src="assets/delis-ui-decorations/figma-home-corner.png" alt="" />'
    : deco === 'plant'
      ? '<img class="card-ground" src="assets/delis-ui-decorations/figma-home-hill.png" alt="" /><img class="card-plant" src="assets/delis-ui-decorations/figma-home-branch.png" alt="" /><img class="card-corner" src="assets/delis-ui-decorations/figma-home-corner.png" alt="" />'
      : deco === 'brush' ? '<img class="card-brush" src="design_assets/delish-elements/04-terracotta-swish.png" alt="" />' : '';
  return `<article class="paper-card ${deco === 'plant' ? 'plant-card' : ''} ${className}">${art}${content}</article>`;
}
function qCard(title, subtitle = '', deco = 'corner', className = '') { return card(`<p class="card-question">${title}</p>${subtitle ? `<p class="card-subtitle">${subtitle}</p>` : ''}`, deco, className); }
function shell(inner) { return `<section class="screen">${inner}${flashMessage ? `<p class="flash-message" role="status">${esc(flashMessage)}</p>` : ''}${dialogMarkup()}</section>`; }

function draw() {
  const pair = circle();
  if (screen === 'splash') return shell(`<img class="splash-partner-logo" src="assets/delis-ui-decorations/fond-zashchity-detey-yugra-trimmed.png" alt="Фонд защиты детей Югры"/><div class="splash-brand">${logo()}</div><img class="splash-ground" src="assets/delis-ui-decorations/figma-splash-hill.png" alt=""/><img class="splash-sprig" src="assets/delis-ui-decorations/figma-splash-branch.png" alt=""/><img class="splash-sprout" src="assets/delis-ui-decorations/figma-splash-sprout.png" alt=""/>`);
  if (screen === 'onboarding') return shell(`${logo('figma-onboarding-wordmark.png')}<main class="onboarding-content onboarding-purpose"><h1>Ближе — через разговор</h1><p class="onboarding-first">«А можно спросить?» помогает родителям и подросткам узнавать друг друга с новой стороны. Один вопрос в день — повод поговорить о том, на что обычно не хватает времени или слов.</p><p class="onboarding-second">Здесь можно делиться мыслями и историями без правильных ответов и оценок. Приложение не хранит ваши ответы — разговор остаётся между вами.</p><label class="onboarding-ack"><input id="intro-ack" type="checkbox"><span>Я понял(а)</span></label><button class="button button-primary onboarding-button" data-action="accept-intro">Продолжить</button></main>`);
  if (screen === 'how-it-works') return shell(`${logo()}<main class="onboarding-content onboarding-rules"><h1>Как это работает</h1><div class="rules-copy"><p>Создайте приглашение и дождитесь, когда близкий человек присоединится. Пока приглашение не принято, перейти к вопросам нельзя.</p><p>Каждый день вопрос получает один участник — тот, кому нужно задать его близкому. Сегодня вопрос для ребенка получает взрослый, завтра — наоборот.</p><p>Вопрос можно отправить карточкой и обсудить в удобное время. После разговора можно отметить его и перейти в раздел «Наши вопросы». Там будут собраны вопросы обоих участников из их дневников.</p><p>Можно не отвечать или пропустить вопрос. Ответы приложение не сохраняет.</p></div><button class="button button-primary onboarding-button" data-action="finish-rules">Продолжить</button></main>`);
  if (screen === 'name') return shell(`${logo()}<form id="name-form" class="setup-content"><article class="paper-card name-card"><p class="card-question">Как к тебе<br>обращаться?</p><input class="text-field" id="profile-name" name="name" value="${esc(state.profile?.name || '')}" maxlength="40" autocomplete="given-name" aria-label="Как к тебе обращаться" /><img class="name-brush" src="design_assets/delish-elements/04-terracotta-swish.png" alt=""/></article>${tip('Имя можно изменить позже', 'Будем обращаться к тебе именно так.')}<button class="button button-primary bottom-action" type="submit">Продолжить</button></form>`);
  if (screen === 'role') {
    if (incomingInvite) return shell(`${logo()}<main class="flow-content">${card('<p class="card-question">Почти готово</p><p class="card-subtitle">Роль уже определена приглашением. Осталось присоединиться.</p>', 'plain')}${tip('Никаких лишних настроек')}<button class="button button-primary bottom-action" data-action="accept-invite">Присоединиться</button></main>`);
    const role = state.profile?.role || '';
    return shell(`${logo()}<form id="role-form" class="setup-content">${card(`<p class="card-question role-question">Кто ты в семье?</p><div class="role-options"><label class="role-choice ${role === 'child' ? 'selected' : ''}"><input type="radio" name="role" value="child" ${role === 'child' ? 'checked' : ''}><span>Ребёнок</span></label><label class="role-choice ${role === 'adult' ? 'selected' : ''}"><input type="radio" name="role" value="adult" ${role === 'adult' ? 'checked' : ''}><span>Взрослый</span></label></div><div class="role-vine-frame"><img src="assets/delis-ui-decorations/role-vine-exact.png" alt=""/></div>`, 'plain', 'role-card')}${tip('Кого выбрать?', 'Родитель, бабушка или дедушка — взрослый.')}<button class="button button-primary bottom-action" type="submit">Продолжить</button></form>`);
  }
  if (screen === 'invite-how') {
    const role = state.profile?.role || 'adult';
    const other = role === 'child' ? 'взрослого' : 'ребёнка';
    const title = role === 'child' ? 'Как пригласить<br>взрослого?' : 'Как пригласить<br>ребёнка?';
    return shell(`${logo()}<main class="flow-content"><article class="paper-card invite-how-card"><p class="card-question">${title}</p><p class="invite-how-copy">Теперь надо пригласить ${other} по ссылке.<br>Ссылка будет на следующем экране</p><div class="invite-wave-frame invite-wave-bottom"><img src="assets/delis-ui-decorations/terracotta-brushstroke.png" alt=""/></div><div class="invite-wave-frame invite-wave-top"><img src="assets/delis-ui-decorations/terracotta-brushstroke.png" alt=""/></div></article>${tip('Можно пригласить только одного')}<button class="button button-primary bottom-action" data-action="create-circle">Понятно</button></main>`);
  }
  if (screen === 'invite-ready') {
    return shell(`${logo()}<main class="flow-content invite-ready-content">${card('<p class="card-question">Приглашение<br>готово</p><img class="invite-corner" src="design_assets/delish-elements/02-card-corner.png" alt=""/>', 'corner', 'invite-ready-card')}${tip('Только для этой связи', 'Ссылка и код приглашают одного члена семьи.')}<button class="button button-primary bottom-action" data-action="share-invite">Поделиться приглашением</button><button class="invite-reset-link" data-action="reset">Удалить мои данные</button></main>`);
  }
  if (screen === 'waiting') return shell(`${logo()}<main class="flow-content">${card('<p class="card-question">Приглашение готово</p><p class="card-subtitle">Ссылка ждёт, когда близкий человек присоединится.</p><div class="waiting-plant-frame"><img src="assets/delis-ui-decorations/waiting-plant-exact.png" alt=""/></div>', 'plain', 'waiting-card')}${tip('Ссылка действует 7 дней', 'Её можно отправить повторно в настройках.')}<button class="button button-primary bottom-action" data-action="go" data-screen="settings">Настройки</button></main>`);
  if (screen === 'connected') return shell(`${logo()}<main class="flow-content">${card('<p class="card-question">Приглашение<br>принято</p><div class="connected-ground-frame"><img src="assets/delis-ui-decorations/connected-ground-exact.png" alt=""/></div><div class="connected-plant-frame"><div class="connected-plant-rotated"><img src="assets/delis-ui-decorations/connected-plant-exact.png" alt=""/></div></div>', 'plain', 'connected-card')}${tip('Без отчётов', 'Ответы не сохраняются, отметка о разговоре необязательна.')}<button class="button button-primary bottom-action" data-action="go" data-screen="home">К вопросу дня</button></main>`);
  if (screen === 'home') {
    if (pair?.status !== 'active') return drawWaiting();
    const daily = dailyQuestion(pair);
    if (!daily?.text) return shell(`${logo()}`);
    if (pair.questionDays?.[daily.day]?.skippedAt)
      return shell(`${logo()}<main class="home-content">${card('<p class="card-question">Сегодня без вопроса</p>', 'plant')}
        <p class="day-state">Новый вопрос появится завтра.</p>${tip('Без спешки', 'К разговору можно вернуться в другой день.')}</main>${nav('home')}`);
    const size = daily.text.length > 95 ? 19 : daily.text.length > 70 ? 22 : 25;
    return shell(`${logo()}<main class="home-content">${card(`<p class="card-question" id="daily-question" style="font-size:${size}px">${esc(daily.text)}</p>`, 'plant')}
      <div class="question-actions"><button class="send-button" data-action="send-question">Отправить вопрос</button><button class="mark-button" data-action="mark-conversation">Отметить разговор</button></div>
      <div class="question-choices">${pair.questionDays?.[daily.day]?.replaced ? '' : '<button data-action="replace-question">Другой вопрос</button>'}<button data-action="skip-question">Пропустить</button></div>
      ${tip('Небольшая подсказка', 'Просто послушайте.')}</main>${nav('home')}`);
  }
  if (screen === 'after-mark') return shell(`${logo()}<main class="flow-content">${card('<p class="card-question success-title">Спасибо за разговор</p><p class="success-copy">Завтра будет ещё один вопрос — ещё один повод узнать друг друга.</p><img class="after-talk-ground" src="assets/delis-ui-decorations/figma-aftertalk-hill.png" alt=""/><img class="after-talk-branch" src="assets/delis-ui-decorations/figma-aftertalk-branch.png" alt=""/><img class="after-talk-sprout" src="assets/delis-ui-decorations/figma-aftertalk-sprout.png" alt=""/>', 'plain', 'success-card')}<button class="button button-primary bottom-action" data-action="go" data-screen="days">В дневник</button></main>`);
  if (screen === 'days') {
    const days = pair?.status === 'active' ? dayCount(pair.startedAt, pair.timeZone) : 0;
    const dialogs = Object.keys(pair?.marks || {}).length;
    const today = dailyQuestion(pair);
    const otherTurn = today?.asker?.id !== state.profile?.id;
    return shell(`${logo()}<main class="days-content">${card(`<p class="days-number">${days}</p><p class="days-label">${pluralForm(days, 'день', 'дня', 'дней')} вместе</p><img class="days-brush" src="assets/delis-ui-decorations/terracotta-brushstroke.png" alt=""/><p class="dialogs-number">${dialogs}</p><p class="dialogs-label">${pluralForm(dialogs, 'разговор отмечен', 'разговора отмечено', 'разговоров отмечено')}</p><div class="days-plant-frame"><img src="assets/delis-ui-decorations/days-upright-exact.png" alt=""/></div>`, 'corner', 'days-card')}${otherTurn ? tip(`Сегодня вопрос у ${esc(today.asker.name)}`, 'Ваш следующий ход — завтра.') : tip('Ответы не сохраняются', 'В дневнике только отметки и открытые вопросы.')}<button class="button button-primary bottom-action" data-action="go" data-screen="diary">Наши вопросы</button></main>${nav('diary')}`);
  }
  if (screen === 'diary') {
    const rows = pairQuestions(pair).map((entry) => `<div class="archive-row"><span>${esc(entry.text)}</span><small>${pair.questionDays?.[entry.day]?.skippedAt ? 'Пропущен' : pair.marks?.[entry.key] ? 'Разговор отмечен' : 'Вопрос открыт'}</small>${state.privateNotes?.[entry.day]?.text ? `<em class="private-note">Только вам: ${esc(state.privateNotes[entry.day].text)}</em>` : ''}</div>`).join('')
      || '<p class="archive-empty">Здесь появятся вопросы, которые вы открыли.</p>';
    return shell(`${logo()}<main class="diary-content">${card(`<p class="archive-title">Наши вопросы</p><div class="archive-rows" tabindex="0" aria-label="Вопросы обоих участников">${rows}</div>`, 'corner', 'archive-card')}${tip('Только сами вопросы', 'Ответы не сохраняются. Личные заметки видны только вам.')}</main>${nav('diary')}`);
  }
  if (screen === 'settings') {
    return shell(`${logo()}<main class="settings-content">${card(`<p class="settings-title">Профиль и настройки</p><button class="settings-row" data-action="edit-name"><span>Как к тебе обращаться</span><small>Изменить имя</small></button>${pair?.status === 'pending' ? '<button class="settings-row invite-row" data-action="share-invite-link">Пригласительная ссылка</button>' : '<div class="settings-row invite-row" aria-label="Приглашение принято">Приглашение принято</div>'}<button class="settings-delete" data-action="reset">Удалить мои данные</button>`, 'plain', 'settings-card') }<button class="button button-primary bottom-action" data-action="about">О приложении</button>${tip('Спасибо, что ты с нами', '', 'figma-settings-sprout.png')}</main>${nav('settings')}`);
  }
  if (screen === 'about') return shell(`${logo({ partner: true })}<h1 class="about-title">О приложении</h1><main class="about-scroll" tabindex="0"><p>«А можно спросить?» — приложение для родителей и подростков, которое помогает узнавать друг друга с новой стороны.</p><p>В приложении собраны вопросы, разработанные совместно с семейными психологами. Родители задают вопросы подросткам, а подростки — родителям. Приложение случайным образом выбирает и передаёт вопросы другой стороне, открывая возможность в живом диалоге поделиться своими мыслями, чувствами, взглядами и историями.</p><p>Ответы могут удивить, помочь увидеть привычные вещи иначе и стать началом разговора, на который раньше не находилось повода.</p><p>Задавай вопросы. Делись ответами. Узнавай близкого человека лучше.</p><p>Совместный проект «365: к себе» и Регионального отделения «Фонда защиты детей» в Югре.</p></main><img class="about-characters" src="assets/delis-ui-decorations/figma-privacy-art.png" alt=""/>${nav('about')}`);
  return shell(`${logo()}${nav('home')}`);
}
function dialogMarkup() {
  if (shareDialog) return `<div class="action-sheet invite-link-sheet"><section><h2>Ссылка приглашения</h2><p>Нажмите на ссылку, скопируйте её и отправьте близкому человеку.</p><textarea id="invite-link" readonly aria-label="Ссылка приглашения">${esc(shareDialog)}</textarea><button class="sheet-link" data-action="close-dialog">Готово</button></section></div>`;
  if (typeof deleteDialog !== 'undefined' && deleteDialog) return `<div class="action-sheet"><section><h2>Удалить мои данные?</h2><p>Имя, доступ к этой паре и данные на этом устройстве будут удалены. У близкого человека его данные останутся.</p><button class="button button-primary" data-action="confirm-reset">Удалить мои данные</button><button class="sheet-link" data-action="close-dialog">Отмена</button></section></div>`;
  if (typeof questionDialog !== 'undefined' && questionDialog) return `<div class="action-sheet"><section><h2>${questionDialog.type === 'replace' ? 'Другой вопрос?' : 'Пропустить вопрос?'}</h2><p>${questionDialog.type === 'replace' ? 'Можно заменить вопрос один раз. Первый вопрос не сохранится в дневнике.' : 'Сегодня будет без вопроса. Новый появится завтра.'}</p><button class="button button-primary" data-action="confirm-question-choice">${questionDialog.type === 'replace' ? 'Показать другой' : 'Пропустить'}</button><button class="sheet-link" data-action="close-dialog">Оставить как есть</button></section></div>`;
  if (typeof conversationDialog === 'undefined' || !conversationDialog) return '';
  if (conversationDialog.stage === 'note') return `<div class="action-sheet"><section><h2>Поговорили</h2><label>Личная заметка <small>необязательно, видна только вам</small><textarea id="private-note" maxlength="1000" placeholder="Что хочется запомнить?"></textarea></label><button class="button button-primary" data-action="save-conversation">Сохранить</button><button class="sheet-link" data-action="close-dialog">Отмена</button></section></div>`;
  if (conversationDialog.stage === 'not-yet') return `<div class="action-sheet"><section><h2>Ничего страшного</h2><p>Вопрос останется доступным — к нему можно вернуться позже.</p><button class="button button-primary" data-action="close-dialog">Вернуться к вопросу</button></section></div>`;
  return `<div class="action-sheet"><section><h2>Удалось поговорить?</h2><button class="button button-primary" data-action="conversation-talked">Да, поговорили</button><button class="sheet-link" data-action="conversation-not-yet">Сегодня не получилось</button><button class="sheet-link" data-action="close-dialog">Пока не отмечать</button></section></div>`;
}
function drawWaiting() { screen = 'waiting'; return draw(); }
function render() {
  if (typeof window.__amozhnoBooted === 'function') window.__amozhnoBooted();
  $('#app').innerHTML = draw(); $('#app').dataset.screen = screen; $('#app').scrollTop = 0;
  if (screen === 'home') void ensureQuestionOpened();
  if (screen === 'diary') void loadPrivateNotes();
}

function b64url(value) { return btoa(unescape(encodeURIComponent(JSON.stringify(value)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function validInvite(value) { return value && /^[a-zA-Z0-9-]{8,100}$/.test(value.id) && /^[A-Za-z0-9_-]{20,100}$/.test(value.token); }
function inviteUrl(item) { const payload = { id: item.id, token: state.invitationToken }; return `${location.origin}${location.pathname}?invite=${b64url(payload)}`; }

function previewPairs() {
  try { return JSON.parse(localStorage.getItem(LOCAL_PREVIEW_PAIRS) || '{}'); }
  catch { return {}; }
}
function savePreviewPairs(pairs) { localStorage.setItem(LOCAL_PREVIEW_PAIRS, JSON.stringify(pairs)); }
function previewPair(id) {
  const pair = previewPairs()[id];
  if (!pair) throw new Error('Приглашение не найдено');
  return pair;
}
function previewSavePair(pair) {
  const pairs = previewPairs(); pairs[pair.id] = pair; savePreviewPairs(pairs); return pair;
}
function previewId() { return crypto.randomUUID?.() || `preview-${Date.now()}`; }
async function previewRequest(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};
  if (path === '/api/max/restore') return { linked: false };
  if (path === '/api/pairs' && method === 'POST') {
    const pair = {
      id: body.id || previewId(), status: 'pending', timeZone: body.timeZone,
      startedAt: new Date().toISOString(), members: [body.member], questionDays: {}, marks: {}, notes: {}, planVersion: 2,
      invitationToken: `preview_${previewId().replace(/-/g, '')}`
    };
    previewSavePair(pair);
    return { pair, memberToken: `preview-member-${body.member.id}`, invitationToken: pair.invitationToken };
  }
  const match = path.match(/^\/api\/pairs\/([^/]+)(?:\/(.*))?$/);
  if (!match) throw new Error('Локальный предпросмотр не поддерживает этот запрос');
  const id = decodeURIComponent(match[1]), actionPath = match[2] || '', pair = previewPair(id);
  if (!actionPath && method === 'GET') return pair;
  if (actionPath === 'invite' && method === 'POST') {
    pair.invitationToken ||= `preview_${previewId().replace(/-/g, '')}`;
    previewSavePair(pair); return { invitationToken: pair.invitationToken, pair };
  }
  if (actionPath === 'invite-role' && method === 'GET') return { role: 'child' };
  if (actionPath === 'accept' && method === 'POST') {
    if (body.invitationToken !== pair.invitationToken) throw new Error('Ссылка приглашения недействительна');
    if (pair.members.length < 2) pair.members.push(body.member);
    pair.status = 'active'; pair.startedAt = new Date().toISOString();
    previewSavePair(pair); return { pair, memberToken: `preview-member-${body.member.id}` };
  }
  if (actionPath === 'question' && method === 'POST') {
    const day = dayCount(pair.startedAt, pair.timeZone);
    pair.questionDays ||= {}; pair.questionDays[day] ||= {};
    if (body.choice === 'skip') pair.questionDays[day].skippedAt = new Date().toISOString();
    if (body.choice === 'replace') pair.questionDays[day].replaced = true;
    if (body.choice === 'open') pair.questionDays[day].openedAt = new Date().toISOString();
    previewSavePair(pair); return pair;
  }
  if (actionPath === 'marks' && method === 'POST') {
    const key = `${pair.id}:${body.day}`; pair.marks ||= {}; pair.marks[key] = { markedAt: new Date().toISOString() };
    previewSavePair(pair); return pair;
  }
  if (actionPath === 'notes' && method === 'GET') return { notes: pair.notes || {} };
  const note = actionPath.match(/^notes\/(\d+)$/);
  if (note && method === 'PUT') {
    pair.notes ||= {}; pair.notes[note[1]] = { text: String(body.text || ''), updatedAt: new Date().toISOString() };
    previewSavePair(pair); return { note: pair.notes[note[1]] };
  }
  const member = actionPath.match(/^members\/([^/]+)$/);
  if (member && method === 'PATCH') {
    pair.members = pair.members.map((item) => item.id === decodeURIComponent(member[1]) ? { ...item, name: body.name } : item);
    previewSavePair(pair); return pair;
  }
  if (member && method === 'DELETE') {
    const pairs = previewPairs(); delete pairs[id]; savePreviewPairs(pairs); return { deleted: true };
  }
  throw new Error('Локальный предпросмотр не поддерживает этот запрос');
}
async function request(path, options = {}) {
  if (LOCAL_PREVIEW) return previewRequest(path, options);
  const initData = maxInitDataHeader();
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(state.memberToken ? { Authorization: `Bearer ${state.memberToken}` } : {}), ...(initData ? { 'X-MAX-Init-Data': initData } : {}), ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить действие');
  return data;
}
async function restoreMaxMember() {
  if (!maxInitData()) return false;
  try {
    const result = await request('/api/max/restore', { method: 'POST' });
    if (!result.linked) return false;
    state.profile = result.member;
    state.memberToken = result.memberToken;
    state.introAccepted = true;
    state.rulesSeen = true;
    updatePair(result.pair);
    return true;
  } catch (error) {
    // A regular browser has no MAX identity; it remains usable for local testing.
    return false;
  }
}
function updatePair(pair) {
  if (pair.status === 'active') state.invitationToken = null;
  state.circles = [pair]; state.activeCircleId = pair.id; save();
}
async function ensureQuestionOpened() {
  const pair = circle(), prompt = dailyQuestion(pair);
  if (openingQuestion || !prompt || prompt.asker.id !== state.profile?.id || pair.questionDays?.[prompt.day]) return;
  openingQuestion = true;
  try {
    updatePair(await request(`/api/pairs/${pair.id}/question`, { method: 'POST', body: JSON.stringify({ choice: 'open' }) }));
    if (screen === 'home') render();
  } catch (error) { toast(error.message); }
  finally { openingQuestion = false; }
}
async function createCircle() {
  if (circle()) { go('invite-ready'); return; }
  try {
    const id = crypto.randomUUID?.() || `link-${Date.now()}`;
    const result = await request('/api/pairs', { method: 'POST', body: JSON.stringify({ id, member: state.profile, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
    state.memberToken = result.memberToken; state.invitationToken = result.invitationToken; updatePair(result.pair);
    go('invite-ready');
  } catch (error) { toast(error.message); }
}
function parseInvite() {
  const value = new URLSearchParams(location.search).get('invite');
  if (!value) return null;
  try {
    const restored = value.replace(/-/g, '+').replace(/_/g, '/');
    const data = JSON.parse(decodeURIComponent(escape(atob(restored))));
    return validInvite(data) ? data : null;
  } catch { return null; }
}
async function acceptInvite(name, role) {
  if (!incomingInvite || state.circles.length) return;
  const source = incomingInvite;
  const me = { id: `member-${Date.now()}`, name: String(name).trim(), role };
  try {
    const result = await request(`/api/pairs/${encodeURIComponent(source.id)}/accept`, { method: 'POST', body: JSON.stringify({ member: me, invitationToken: source.token }) });
    state.profile = me; state.memberToken = result.memberToken; updatePair(result.pair); incomingInvite = null;
    history.replaceState({}, '', location.pathname); go('connected');
  } catch (error) { toast(error.message); }
}
async function loadPrivateNotes() {
  const pair = circle();
  if (!pair || !state.memberToken) return;
  try {
    const nextNotes = (await request(`/api/pairs/${pair.id}/notes`)).notes || {};
    if (JSON.stringify(nextNotes) !== JSON.stringify(state.privateNotes || {})) {
      state.privateNotes = nextNotes;
      save();
      render();
    }
  } catch {}
}
async function share(url) {
  try { await navigator.clipboard?.writeText(url); } catch {}
  // Always show the actual URL. Browser-provided sharing can complete without
  // a visible sheet, which makes an invitation look as if it was never made.
  shareDialog = url;
  render();
}

async function shareQuestionCard() {
  const questionCard = $('.home-content .paper-card');
  if (!questionCard || !window.html2canvas) { toast('Не удалось подготовить карточку'); return; }
  try {
    await document.fonts?.ready;
    const canvas = await window.html2canvas(questionCard, {
      backgroundColor: null,
      scale: 3,
      useCORS: true,
      logging: false,
    });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('empty image');
    const file = new File([blob], 'delis-vopros.png', { type: 'image/png' });
    try {
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
    } catch (error) { if (error?.name === 'AbortError') return; }
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    toast('Не удалось подготовить карточку');
  }
}

async function action(button) {
  const type = button.dataset.action, pair = circle();
  if (type === 'go') { go(button.dataset.screen); return; }
  if (type === 'accept-intro') { if (!$('#intro-ack')?.checked) return; state.introAccepted = true; save(); go('how-it-works'); return; }
  if (type === 'finish-rules') { state.rulesSeen = true; save(); go('name'); return; }
  if (type === 'create-circle') { await createCircle(); return; }
  if (type === 'accept-invite') { await acceptInvite(state.profile.name, state.profile.role); return; }
  if (type === 'mark-conversation') {
    const prompt = dailyQuestion(pair);
    if (!prompt || prompt.asker.id !== state.profile?.id) return;
    conversationDialog = { day: prompt.day, stage: 'outcome' }; render(); return;
  }
  if (type === 'conversation-talked') { conversationDialog.stage = 'note'; render(); return; }
  if (type === 'conversation-not-yet') { conversationDialog.stage = 'not-yet'; render(); return; }
  if (type === 'close-dialog') { conversationDialog = null; questionDialog = null; deleteDialog = false; shareDialog = ''; render(); return; }
  if (type === 'save-conversation') {
    const prompt = dailyQuestion(pair), text = $('#private-note')?.value || '';
    if (!prompt) return;
    try {
      updatePair(await request(`/api/pairs/${pair.id}/marks`, { method: 'POST', body: JSON.stringify({ day: prompt.day }) }));
      if (text.trim()) {
        const result = await request(`/api/pairs/${pair.id}/notes/${prompt.day}`, { method: 'PUT', body: JSON.stringify({ text }) });
        state.privateNotes[prompt.day] = result.note;
      }
      conversationDialog = null;
      go('after-mark');
    } catch (error) { toast(error.message); }
    return;
  }
  if (type === 'replace-question' || type === 'skip-question') {
    const prompt = dailyQuestion(pair);
    if (!prompt || prompt.asker.id !== state.profile?.id || pair.marks?.[prompt.key]) return;
    questionDialog = { type: type === 'replace-question' ? 'replace' : 'skip' }; render(); return;
  }
  if (type === 'confirm-question-choice') {
    const prompt = dailyQuestion(pair);
    if (!prompt || !questionDialog) return;
    try {
      updatePair(await request(`/api/pairs/${pair.id}/question`, { method: 'POST',
        body: JSON.stringify({ choice: questionDialog.type }) }));
      questionDialog = null;
      render();
    } catch (error) { toast(error.message); }
    return;
  }
  if (type === 'share-invite') {
    if (!pair) return;
    try {
      if (!state.invitationToken) {
        const result = await request(`/api/pairs/${pair.id}/invite`, { method: 'POST' });
        state.invitationToken = result.invitationToken; updatePair(result.pair);
      }
      const url = inviteUrl(pair);
      await share(url);
    } catch (error) { toast(error.message); }
    return;
  }
  if (type === 'share-invite-link') {
    if (!pair || pair.status !== 'pending') return;
    try {
      if (!state.invitationToken) {
        const result = await request(`/api/pairs/${pair.id}/invite`, { method: 'POST' });
        state.invitationToken = result.invitationToken; updatePair(result.pair);
      }
      await share(inviteUrl(pair));
    } catch (error) { toast(error.message); }
    return;
  }
  if (type === 'send-question') {
    const prompt = dailyQuestion(pair);
    if (prompt?.asker?.id === state.profile?.id && !pair.questionDays?.[prompt.day]?.skippedAt) await shareQuestionCard();
    return;
  }
  if (type === 'edit-name') { go('name'); return; }
  if (type === 'about') { go('about'); return; }
  if (type === 'reset') {
    deleteDialog = true;
    render();
    return;
  }
  if (type === 'confirm-reset') {
    try { if (pair) await request(`/api/pairs/${pair.id}/members/${state.profile.id}`, { method: 'DELETE' }); }
    catch (error) { toast(error.message); return; }
    localStorage.removeItem(STORE);
    try { sessionStorage.removeItem('delis-active-store'); } catch { /* Private browsing can restrict session storage. */ }
    state = { profile: null, circles: [], activeCircleId: null, diary: [], marks: {}, introAccepted: false, rulesSeen: false, memberToken: null, invitationToken: null };
    deleteDialog = false;
    go('onboarding');
  }
}

$('#app').addEventListener('click', (event) => { const button = event.target.closest('button[data-action]'); if (button) action(button); });
$('#app').addEventListener('change', (event) => { if (event.target.matches('.role-choice input')) document.querySelectorAll('.role-choice').forEach((el) => el.classList.toggle('selected', el.querySelector('input').checked)); });
$('#app').addEventListener('submit', (event) => {
  if (event.target.id === 'name-form') {
    event.preventDefault(); const name = new FormData(event.target).get('name')?.toString().trim(); if (!name) return;
    state.profile = { id: state.profile?.id || `member-${Date.now()}`, name, role: state.profile?.role || '' }; save();
    if (circle()) {
      request(`/api/pairs/${circle().id}/members/${state.profile.id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
        .then(updatePair).then(() => go('settings')).catch((error) => toast(error.message));
    } else go('role');
  }
  if (event.target.id === 'role-form') {
    event.preventDefault(); const role = String(new FormData(event.target).get('role') || ''); if (!['child', 'adult'].includes(role)) return;
    state.profile.role = role; save();
    if (incomingInvite) acceptInvite(state.profile.name, role);
    else if (!state.circles.length) go('invite-how');
    else go('settings');
  }
});

async function loadQuestions() {
  try {
    const response = await fetch('./%D0%91%D1%83%D0%B4%D0%B5%D0%BC%20%D0%B1%D0%BB%D0%B8%D0%B6%D0%B5%20%D0%B2%D0%BE%D0%BF%D1%80%D0%BE%D1%81%D1%8B.md');
    if (!response.ok) throw new Error('question deck unavailable');
    const source = await response.text(), [childPart, adultPart = ''] = source.split('## Родитель спрашивает подростка');
    const parse = (text) => [...text.matchAll(/^\s*\d+\.\s*(.+)$/gm)].map((match) => match[1].trim());
    questions.child = parse(childPart); questions.adult = parse(adultPart);
    if (questions.child.length !== 45 || questions.adult.length !== 45) throw new Error('wrong question count');
    for (const role of ['child', 'adult']) {
      const indices = questionTiers[role].flat();
      if (indices.length !== questions[role].length || new Set(indices).size !== indices.length
        || indices.some((index) => index < 1 || index > questions[role].length))
        throw new Error('invalid question plan');
    }
    questionsReady = true;
  } catch { questionsReady = false; }
  if (screen === 'home') go('home');
}
async function start() {
  incomingInvite = parseInvite();
  render();
  await restoreMaxMember();
  if (incomingInvite && !circle()) {
    try {
      const invite = await request(`/api/pairs/${encodeURIComponent(incomingInvite.id)}/invite-role`);
      state.profile ||= { id: `member-${Date.now()}`, name: '', role: '' };
      state.profile.role = invite.role;
      save();
    } catch { incomingInvite = null; }
  }
  const next = !state.introAccepted ? 'onboarding' : !state.rulesSeen ? 'how-it-works'
    : !state.profile?.name ? 'name' : !state.profile.role ? 'role'
      : incomingInvite && !circle() ? 'role'
        : !circle() ? 'invite-how' : circle().status === 'pending' ? 'waiting' : 'home';
  setTimeout(() => go(next), SPLASH_DURATION);
}
loadQuestions();
start();
async function refreshPair() {
  const pair = circle();
  if (!pair) return;
  try {
    const current = await request(`/api/pairs/${pair.id}`);
    const changed = JSON.stringify(current) !== JSON.stringify(pair);
    if (!changed) return;
    updatePair(current);
    if (pair.status === 'pending' && current.status === 'active') go('connected');
    else if (pair.status === 'active' && current.status !== 'active' && ['home', 'days', 'diary', 'after-mark'].includes(screen)) go('waiting');
    else if (['waiting', 'settings', 'days', 'diary', 'home', 'after-mark'].includes(screen)) render();
  } catch (error) {
    if (error.message === 'Invitation not found') {
      state.circles = []; state.activeCircleId = null; state.memberToken = null; state.invitationToken = null;
      save(); go('invite-how');
    }
    /* A transient connection issue should not erase local state. */
  }
}
setInterval(refreshPair, 3000);
setInterval(() => {
  const pair = circle();
  const today = pair?.status === 'active' ? dayCount(pair.startedAt, pair.timeZone) : 0;
  if (lastShownDay && lastShownDay !== today && pair?.status === 'active') go('home');
  else if (screen === 'home' && pair?.status === 'active') render();
  lastShownDay = today;
}, 30000);

