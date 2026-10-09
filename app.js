import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithPopup, signInAnonymously, GoogleAuthProvider, signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, onSnapshot, serverTimestamp, runTransaction, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// ---------- Firebase ----------
const firebaseConfig = {
  apiKey: "AIzaSyBjlyxlJroTZzYb6Oc3rHe5SUULxcpe5fI",
  authDomain: "toloot.firebaseapp.com",
  projectId: "toloot",
  storageBucket: "toloot.firebasestorage.app",
  messagingSenderId: "702218699864",
  appId: "1:702218699864:web:ec868e0ff84b444f7e362d",
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---------- Reglas del juego (espejo de firestore.rules) ----------
const COLS = 6;
const DEFAULT_ROWS = 6;
const MAX_PHOTOS = 3;
const MAX_LEVEL = 10;
const MAX_TRADE_ITEMS = 6;
const TIERS = {
  pocket:   { label: "Pocket",   w: 1, h: 1, points: 10 },
  handheld: { label: "Handheld", w: 1, h: 2, points: 30 },
  standard: { label: "Standard", w: 2, h: 2, points: 100 },
  gear:     { label: "Gear",     w: 2, h: 3, points: 200 },   // puntos: supuesto
  heavy:    { label: "Heavy",    w: 3, h: 3, points: 400 },
  oversize: { label: "Oversize", w: 4, h: 5, points: 1200 },
};
const RADAR = [
  { label: "Barrio", km: 5 },
  { label: "Ciudad", km: 15 },
  { label: "Zona", km: 32 },
  { label: "Nacional", km: Infinity },
];
const CATEGORIES = ["Tecno", "Ropa", "Muebles", "Hogar", "Juegos", "Joyas", "Libros", "Deportes", "Herramientas", "Otros"];
const CONDITIONS = ["Nuevo", "Como nuevo", "Usado", "Dañado"];
const PALETTE = ["#e76f51", "#2a9d8f", "#e9c46a", "#457b9d", "#8ab17d", "#b56576", "#6d597a", "#f4a261"];
const STATUS_LABEL = { negotiating: "En mesa", closed: "Cerrado", cancelled: "Cancelado" };
const MEETING_POINTS = [
  { name: "Comisaría", icon: "🚓", term: "comisaría" },
  { name: "Shopping", icon: "🛍️", term: "shopping" },
  { name: "Estación", icon: "🚉", term: "estación de tren" },
];

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const norm = (s = "") => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dimsOf = (tier, rotated) => (rotated
  ? { w: TIERS[tier].h, h: TIERS[tier].w }
  : { w: TIERS[tier].w, h: TIERS[tier].h });
const itemDims = (it) => dimsOf(it.tier, it.rotated);
const itemRef = (id) => doc(db, "items", id);
const tradeRef = (id) => doc(db, "trades", id);
const myUid = () => state.user.uid;
const me = () => state.profiles.get(state.user?.uid);
const myLoc = () => {
  const p = me();
  return p && p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null;
};
const nameOf = (uid) => state.profiles.get(uid)?.name ?? "anónimo";
const levelOf = (uid) => state.profiles.get(uid)?.level ?? 1;
const rowsCount = () => me()?.gridRows ?? DEFAULT_ROWS;
const availableMine = () => state.mine.filter((i) => i.status === "available");
const inOpenTrade = (id) => state.trades.some((t) =>
  t.status === "negotiating" && (t.aItems.includes(id) || t.bItems.includes(id)));
const itemInner = (it) => `${it.photos?.[0] ? `<img src="${esc(it.photos[0])}" alt="">` : ""}<span>${esc(it.title)}</span>`;
const preventScroll = (e) => { if (e.cancelable) e.preventDefault(); };

function haversineKm(a, b) {
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
const distanceTo = (it) => {
  const loc = myLoc();
  return loc && it.lat != null ? haversineKm(loc, it) : null;
};
const fmtDist = (d) => (d == null ? "—" : d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(1)} km`);

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2400);
}
const showErr = (e) => toast("Error: " + (e.code || e.message));

// ---------- Estado ----------
const state = {
  user: null,
  profiles: new Map(),
  market: [],
  mine: [],
  trades: [],
  knownTrades: null,
  category: "Todas",
  search: "",
  radarLevel: 2,
  marketKey: "",
  currentTrade: null,
  currentItems: new Map(),
  messages: [],
  tradeTab: "mesa",
  tradeOpen: null,
};
const drafts = { note: "", chat: "" };
let unsubs = [];
let marketUnsub = null;
let tradeDocUnsub = null;
let tradeMsgsUnsub = null;
let drag = null;
let pickState = null;

// ---------- Modales ----------
function hideModal(m) {
  if (!m) return;
  m.classList.add("hidden");
  if (m.id === "modal-trade") stopTradeWatch();
}
function closeAll() {
  document.querySelectorAll(".modal").forEach(hideModal);
}
document.addEventListener("click", (e) => {
  const offer = e.target.closest("[data-offer]");
  if (offer) return openOffer(offer.dataset.offer);
  const closeBtn = e.target.closest("[data-close]");
  if (closeBtn) return hideModal(closeBtn.closest(".modal"));
  if (e.target.classList.contains("modal")) hideModal(e.target);
});

// ---------- Auth ----------
function showScreen(name) {
  $("#screen-login").classList.toggle("hidden", name !== "login");
  $("#screen-app").classList.toggle("hidden", name !== "app");
}
const loginErr = (e) => { $("#login-error").textContent = e.message; };
$("#btn-google").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch(loginErr);
$("#btn-anon").onclick = () => signInAnonymously(auth).catch(loginErr);
$("#btn-logout").onclick = () => signOut(auth);

onAuthStateChanged(auth, async (user) => {
  unsubs.forEach((u) => u());
  unsubs = [];
  marketUnsub?.();
  marketUnsub = null;
  stopTradeWatch();
  closeAll();
  Object.assign(state, {
    user, profiles: new Map(), market: [], mine: [], trades: [], knownTrades: null, marketKey: "",
  });
  if (!user) { showScreen("login"); return; }
  try { await ensureProfile(user); } catch (e) { showErr(e); }
  listen();
  showScreen("app");
  setView("market");
  renderAll();
});

async function ensureProfile(user) {
  const ref = doc(db, "users", user.uid);
  if ((await getDoc(ref)).exists()) return;
  let name = (user.displayName || "").trim().slice(0, 24);
  if (name.length < 2) name = "Jugador" + user.uid.slice(0, 4);
  await setDoc(ref, {
    name, level: 1, gridRows: DEFAULT_ROWS,
    lat: null, lng: null, locationAt: null,
    createdAt: serverTimestamp(),
  });
}

// ---------- Listeners en tiempo real ----------
function listen() {
  const uid = myUid();
  unsubs.push(onSnapshot(collection(db, "users"), (snap) => {
    state.profiles = new Map(snap.docs.map((d) => [d.id, d.data()]));
    renderAll();
  }, showErr));
  unsubs.push(onSnapshot(query(collection(db, "items"), where("ownerId", "==", uid)), (snap) => {
    state.mine = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  }, showErr));
  unsubs.push(onSnapshot(query(collection(db, "trades"), where("participants", "array-contains", uid)),
    handleTrades, showErr));
}

function handleTrades(snap) {
  const uid = myUid();
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (state.knownTrades) {
    for (const t of list) {
      if (!state.knownTrades.has(t.id) && t.bId === uid && t.status === "negotiating") {
        toast(`📬 @${t.aName} te ofreció un trueque`);
      }
    }
  }
  state.knownTrades = new Set(list.map((t) => t.id));
  state.trades = list.sort((a, b) =>
    (b.updatedAt?.toMillis?.() ?? Date.now()) - (a.updatedAt?.toMillis?.() ?? Date.now()));
  renderTrades();
}

// ---------- Navegación ----------
function setView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".bottom-nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("#fab").classList.toggle("hidden", name !== "inventory");
}

// ---------- MERCADO: radar, filtros y suscripción ----------
// Firestore no hace consultas por radio: filtramos por banda de latitud en la base
// y calculamos la distancia real con Haversine en el cliente.
function ensureMarketSub() {
  if (!me()) return;
  const loc = myLoc();
  if (!loc) state.radarLevel = 4;             // sin ubicación, solo modo nacional
  const key = `${loc ? `${loc.lat},${loc.lng}` : "none"}|${state.radarLevel}`;
  if (key === state.marketKey) return;
  state.marketKey = key;
  marketUnsub?.();

  const level = RADAR[state.radarLevel - 1];
  const constraints = [where("isPublic", "==", true)];
  if (loc && level.km !== Infinity) {
    const dLat = level.km / 111.32;
    constraints.push(where("lat", ">=", loc.lat - dLat), where("lat", "<=", loc.lat + dLat));
  }
  marketUnsub = onSnapshot(query(collection(db, "items"), ...constraints), (snap) => {
    state.market = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderMarket();
  }, showErr);
}

function visibleMarket() {
  const uid = myUid(), loc = myLoc(), lvl = RADAR[state.radarLevel - 1];
  return state.market.filter((it) => {
    if (it.ownerId === uid) return false;
    if (state.category !== "Todas" && it.category !== state.category) return false;
    if (loc && lvl.km !== Infinity && haversineKm(loc, it) > lvl.km) return false;
    return true;
  });
}

function renderMarket() {
  if (!state.user) return;
  const list = visibleMarket();
  const q = norm(state.search);
  $("#feed").classList.toggle("hidden", !!q);
  $("#results").classList.toggle("hidden", !q);
  if (q) renderResults(list, q);
  else renderFeed(list);
}

// Modo 1: Feed TikTok. Poder del vendedor = (suma de puntos base) x (cantidad de publicados)
function renderFeed(list) {
  const stats = new Map();
  for (const it of list) {
    const s = stats.get(it.ownerId) ?? { points: 0, count: 0 };
    s.points += it.basePoints;
    s.count += 1;
    stats.set(it.ownerId, s);
  }
  const power = (uid) => { const s = stats.get(uid); return s ? s.points * s.count : 0; };
  const sorted = [...list].sort((a, b) =>
    power(b.ownerId) - power(a.ownerId) ||
    a.ownerId.localeCompare(b.ownerId) ||
    b.basePoints - a.basePoints);
  $("#feed").innerHTML = sorted.length
    ? sorted.map((it) => cardHTML(it, power(it.ownerId))).join("")
    : `<div class="empty">Nada por acá. Probá con más radio o con otra categoría.</div>`;
}

// Modo 2: Búsqueda tipo Amazon. Score = puntos base x nivel del vendedor
function renderResults(list, q) {
  const hits = list
    .filter((it) => norm(`${it.title} ${it.description} ${it.category}`).includes(q))
    .map((it) => ({ it, score: it.basePoints * levelOf(it.ownerId) }))
    .sort((a, b) => b.score - a.score);
  $("#results").innerHTML = hits.length
    ? hits.map(({ it, score }) => rowHTML(it, score)).join("")
    : `<div class="empty">Sin resultados para “${esc(state.search)}”</div>`;
}

function cardHTML(it, power = null, inSheet = false) {
  const slides = it.photos?.length
    ? it.photos.map((src) => `<div class="slide"><img src="${esc(src)}" alt="" loading="lazy"></div>`).join("")
    : `<div class="slide" style="background:${esc(it.color)}"></div>`;
  const meta = [`@${esc(nameOf(it.ownerId))}`, `Nv ${levelOf(it.ownerId)}`, fmtDist(distanceTo(it))];
  if (power != null) meta.push(`Poder ${power}`);
  const canOffer = it.ownerId !== myUid();
  return `
    <article class="market-card ${inSheet ? "in-sheet" : ""}">
      <div class="carousel">${slides}</div>
      <div class="overlay">
        <div class="card-meta">
          <span class="chip">${esc(it.category)}</span>
          <span class="chip">${TIERS[it.tier].label} · ${it.basePoints} pts</span>
          <span class="chip">${esc(it.condition)}</span>
        </div>
        <h2>${esc(it.title)}</h2>
        <p class="desc">${esc(it.description)}</p>
        <div class="seller">${meta.join(" · ")}</div>
        ${canOffer ? `<button class="btn offer" data-offer="${esc(it.id)}">OFERTAR</button>` : ""}
      </div>
    </article>`;
}

function rowHTML(it, score) {
  const img = it.photos?.[0] ? `<img src="${esc(it.photos[0])}" alt="">` : "";
  return `
    <button class="row" data-id="${esc(it.id)}">
      <div class="thumb" style="background:${esc(it.color)}">${img}</div>
      <div class="row-body">
        <strong>${esc(it.title)}</strong>
        <small>@${esc(nameOf(it.ownerId))} · Nv ${levelOf(it.ownerId)} · ${TIERS[it.tier].label} · ${fmtDist(distanceTo(it))}</small>
      </div>
      <div class="score">${score}</div>
    </button>`;
}

function openDetail(id) {
  const it = state.market.find((i) => i.id === id);
  if (!it) return;
  $("#detail-body").innerHTML = cardHTML(it, null, true) + `<button class="btn ghost" data-close>Cerrar</button>`;
  $("#modal-detail").classList.remove("hidden");
}

function renderCats() {
  $("#cats").innerHTML = ["Todas", ...CATEGORIES].map((c) =>
    `<button class="pill ${c === state.category ? "on" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("");
}

function renderRadar() {
  const hasLoc = !!myLoc();
  const slider = $("#radar");
  slider.disabled = !hasLoc;
  slider.value = state.radarLevel;
  const lvl = RADAR[state.radarLevel - 1];
  $("#radar-label").textContent = !hasLoc
    ? "activá tu ubicación"
    : lvl.km === Infinity ? "sin límite" : `${lvl.label} · < ${lvl.km} km`;
}

// ---------- MOCHILA ----------
const rowsOfGrid = () => rowsCount();

function renderInventory() {
  if (!state.user) return;
  const rows = rowsOfGrid();
  $("#grid-wrap").style.setProperty("--rows", rows);
  const placed = state.mine.filter((i) => i.isPublic);
  const stash = state.mine
    .filter((i) => !i.isPublic)
    .sort((a, b) => (a.status === "traded") - (b.status === "traded"));
  const used = placed.reduce((s, it) => { const d = itemDims(it); return s + d.w * d.h; }, 0);
  $("#grid-count").textContent = `${used}/${COLS * rows} celdas`;
  $("#stash-count").textContent = `(${stash.length})`;

  $("#grid").innerHTML = placed.map((it) => {
    const d = itemDims(it);
    return `<div class="item placed" data-id="${esc(it.id)}"
      style="left:${(it.gridX * 100) / COLS}%;top:${(it.gridY * 100) / rows}%;
             width:${(d.w * 100) / COLS}%;height:${(d.h * 100) / rows}%;
             background:${esc(it.color)}">${itemInner(it)}</div>`;
  }).join("");

  $("#stash").innerHTML = stash.length
    ? stash.map((it) => {
        const traded = it.status === "traded";
        return `<div class="item ${traded ? "traded" : ""}" data-id="${esc(it.id)}" style="background:${esc(it.color)}">
          ${itemInner(it)}
          ${traded ? `<em class="tag">Trocado</em>` : `<button class="del" data-del title="Eliminar">✕</button>`}
        </div>`;
      }).join("")
    : `<div class="empty small">Tu depósito está vacío. Usá el + para cargar productos.</div>`;
}

function collides(item, x, y, d) {
  return state.mine.some((o) => {
    if (o.id === item.id || !o.isPublic) return false;
    const od = itemDims(o);
    return x < o.gridX + od.w && o.gridX < x + d.w && y < o.gridY + od.h && o.gridY < y + d.h;
  });
}

function cellSize() {
  const rect = $("#grid").getBoundingClientRect();
  return { rect, cellW: rect.width / COLS, cellH: rect.height / rowsCount() };
}

async function placeItem(item, gx, gy) {
  const loc = myLoc();
  if (!loc) return toast("Activá 'Mi ubicación' en Mercado antes de publicar");
  await updateDoc(itemRef(item.id), { gridX: gx, gridY: gy, isPublic: true, lat: loc.lat, lng: loc.lng });
  toast("Publicado en el mercado");
}

async function stashItem(item) {
  await updateDoc(itemRef(item.id), { gridX: null, gridY: null, isPublic: false, lat: null, lng: null });
  toast("Devuelto al depósito");
}

async function rotate(item) {
  const rows = rowsCount();
  const next = !item.rotated;
  const d = dimsOf(item.tier, next);
  if (item.gridX + d.w > COLS || item.gridY + d.h > rows || collides(item, item.gridX, item.gridY, d)) {
    return toast("No hay espacio para rotar");
  }
  await updateDoc(itemRef(item.id), { rotated: next });
}

$("#drawer-toggle").onclick = () => $("#drawer").classList.toggle("collapsed");

$("#stash").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-del]");
  if (!btn) return;
  const item = state.mine.find((i) => i.id === btn.closest(".item").dataset.id);
  if (!item) return;
  if (inOpenTrade(item.id)) return toast("Está en una negociación abierta");
  if (!confirm(`¿Eliminar "${item.title}"?`)) return;
  deleteDoc(itemRef(item.id)).catch(showErr);
});

// ---------- Drag & drop (mouse + touch) ----------
function onPointerDown(e) {
  if (drag || e.target.closest("[data-del]")) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const el = e.target.closest(".item");
  const item = el && state.mine.find((i) => i.id === el.dataset.id);
  if (!item || item.status !== "available") return;

  const r = el.getBoundingClientRect();
  drag = {
    el, item,
    touch: e.pointerType !== "mouse",
    sx: e.clientX, sy: e.clientY,
    lastX: e.clientX, lastY: e.clientY,
    fx: (e.clientX - r.left) / r.width,
    fy: (e.clientY - r.top) / r.height,
    ghost: null, left: 0, top: 0, timer: null,
  };
  // En touch hay que mantener presionado ~180 ms; si se mueve antes, es scroll
  if (drag.touch) drag.timer = setTimeout(() => drag && startGhost(drag), 180);

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", cancelDrag);
}
$("#grid").addEventListener("pointerdown", onPointerDown);
$("#stash").addEventListener("pointerdown", onPointerDown);

function onPointerMove(e) {
  const s = drag;
  if (!s) return;
  const dist = Math.hypot(e.clientX - s.sx, e.clientY - s.sy);
  if (!s.ghost) {
    if (s.touch) { if (dist > 10) cancelDrag(); return; }
    if (dist < 6) return;
    startGhost(s);
  }
  s.lastX = e.clientX;
  s.lastY = e.clientY;
  positionGhost(s);
}

function startGhost(s) {
  const { cellW, cellH } = cellSize();
  const d = itemDims(s.item);
  const g = document.createElement("div");
  g.className = "item ghost";
  g.style.width = `${d.w * cellW}px`;
  g.style.height = `${d.h * cellH}px`;
  g.style.background = s.item.color;
  g.innerHTML = itemInner(s.item);
  document.body.append(g);
  s.ghost = g;
  s.el.classList.add("src-dim");
  window.addEventListener("touchmove", preventScroll, { passive: false });
  navigator.vibrate?.(10);
  positionGhost(s);
}

function positionGhost(s) {
  s.left = s.lastX - s.fx * s.ghost.offsetWidth;
  s.top = s.lastY - s.fy * s.ghost.offsetHeight;
  s.ghost.style.transform = `translate(${s.left}px, ${s.top}px)`;
  showPreview(s);
}

function dropTarget(s) {
  const { rect, cellW, cellH } = cellSize();
  const d = itemDims(s.item);
  const gx = Math.round((s.left - rect.left) / cellW);
  const gy = Math.round((s.top - rect.top) / cellH);
  const inside = s.lastX >= rect.left && s.lastX <= rect.right && s.lastY >= rect.top && s.lastY <= rect.bottom;
  const fits = gx >= 0 && gy >= 0 && gx + d.w <= COLS && gy + d.h <= rowsCount()
    && !collides(s.item, gx, gy, d);
  return { gx, gy, d, inside, fits };
}

function showPreview(s) {
  const pv = $("#preview");
  const t = dropTarget(s);
  if (!t.inside) { pv.classList.add("hidden"); return; }
  const rows = rowsCount();
  const gx = clamp(t.gx, 0, COLS - t.d.w);
  const gy = clamp(t.gy, 0, rows - t.d.h);
  Object.assign(pv.style, {
    left: `${(gx * 100) / COLS}%`,
    top: `${(gy * 100) / rows}%`,
    width: `${(t.d.w * 100) / COLS}%`,
    height: `${(t.d.h * 100) / rows}%`,
  });
  pv.className = t.fits ? "ok" : "bad";
}

function detach() {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", cancelDrag);
  window.removeEventListener("touchmove", preventScroll);
}
function finishDrag(s) { clearTimeout(s.timer); detach(); drag = null; }
function cleanupVisuals(s) {
  s.ghost?.remove();
  s.el.classList.remove("src-dim");
  $("#preview").classList.add("hidden");
}
function cancelDrag() {
  const s = drag;
  if (!s) return;
  finishDrag(s);
  cleanupVisuals(s);
}

function onPointerUp() {
  const s = drag;
  if (!s) return;
  finishDrag(s);

  // Sin ghost = toque: rota si está publicado
  if (!s.ghost) {
    if (s.item.isPublic) rotate(s.item).catch(showErr);
    return;
  }

  const t = dropTarget(s);
  cleanupVisuals(s);
  if (t.fits) placeItem(s.item, t.gx, t.gy).catch(showErr);
  else if (t.inside) toast("No entra ahí");
  else if (s.item.isPublic) {
    if (inOpenTrade(s.item.id)) toast("Está en una negociación abierta");
    else stashItem(s.item).catch(showErr);
  }
}

// ---------- Crear producto ----------
function renderFormOptions() {
  const form = $("#form-new");
  form.querySelector('select[name="category"]').innerHTML =
    CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join("");
  form.querySelector('select[name="condition"]').innerHTML =
    CONDITIONS.map((c) => `<option>${esc(c)}</option>`).join("");
}

function openNewForm() {
  const form = $("#form-new");
  form.reset();
  $("#tier-list").innerHTML = Object.entries(TIERS).map(([key, t], i) => `
    <label class="tier">
      <input type="radio" name="tier" value="${key}" ${i === 0 ? "checked" : ""} />
      <span class="tier-box" style="--w:${t.w};--h:${t.h}"></span>
      <strong>${t.label}</strong>
      <small>${t.w}×${t.h} · ${t.points} pts</small>
    </label>`).join("");
  $("#modal-new").classList.remove("hidden");
}
$("#fab").onclick = openNewForm;

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 640 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.7));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Imagen inválida")); };
    img.src = url;
  });
}

$("#form-new").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const fd = new FormData(form);
  const tierKey = fd.get("tier");
  const t = TIERS[tierKey];
  const files = [...form.querySelector('input[name="photos"]').files].slice(0, MAX_PHOTOS);
  const btn = form.querySelector('[type="submit"]');

  btn.disabled = true;
  try {
    const photos = await Promise.all(files.map(compressImage));
    await addDoc(collection(db, "items"), {
      ownerId: myUid(),
      ownerName: me()?.name ?? "Jugador",
      title: String(fd.get("title")).trim(),
      description: String(fd.get("description")).trim(),
      condition: fd.get("condition"),
      category: fd.get("category"),
      tier: tierKey,
      basePoints: t.points,
      w: t.w,
      h: t.h,
      color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
      photos,
      rotated: false,
      gridX: null,
      gridY: null,
      isPublic: false,
      lat: null,
      lng: null,
      status: "available",
      tradeId: null,
      createdAt: serverTimestamp(),
    });
    hideModal($("#modal-new"));
    toast("Guardado en tu depósito");
  } catch (err) {
    showErr(err);
  } finally {
    btn.disabled = false;
  }
});

// ---------- TRUEQUES ----------
function renderTrades() {
  if (!state.user) return;
  const uid = myUid();
  const pending = state.trades.filter((t) => t.bId === uid && t.status === "negotiating").length;
  const badge = $("#trade-badge");
  badge.textContent = pending;
  badge.classList.toggle("hidden", !pending);
  $("#trade-list").innerHTML = state.trades.length
    ? state.trades.map((t) => {
        const incoming = t.bId === uid;
        return `
          <button class="trade-row" data-trade="${esc(t.id)}">
            <div>
              <strong>${incoming ? "Te ofrecen" : "Ofreciste"} · @${esc(incoming ? t.aName : t.bName)}</strong>
              <small>${t.aItems.length} ítem(s) ↔ ${t.bItems.length} ítem(s)</small>
            </div>
            <span class="status s-${t.status}">${STATUS_LABEL[t.status] ?? t.status}</span>
          </button>`;
      }).join("")
    : `<div class="empty">Todavía no hay ofertas. Tocá "OFERTAR" en el mercado para empezar un trueque.</div>`;
}
$("#trade-list").addEventListener("click", (e) => {
  const row = e.target.closest("[data-trade]");
  if (row) openTrade(row.dataset.trade);
});

function openPicker({ title, items, selected, min, max, confirm, onConfirm }) {
  pickState = { items, selected: new Set(selected), min, max, onConfirm };
  $("#pick-title").textContent = title;
  $("#pick-ok").textContent = confirm;
  renderPick();
  $("#modal-pick").classList.remove("hidden");
}

function renderPick() {
  $("#pick-list").innerHTML = pickState.items.length
    ? pickState.items.map((it) => {
        const on = pickState.selected.has(it.id);
        return `
          <button class="pick ${on ? "on" : ""}" data-pick="${esc(it.id)}">
            <span class="swatch" style="background:${esc(it.color)}"></span>
            <span class="pick-body"><strong>${esc(it.title)}</strong><small>${TIERS[it.tier].label} · ${it.basePoints} pts</small></span>
            <span>${on ? "✓" : ""}</span>
          </button>`;
      }).join("")
    : `<div class="empty small">No tenés productos publicados disponibles.</div>`;
}

$("#pick-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pick]");
  if (!b || !pickState) return;
  const id = b.dataset.pick;
  if (pickState.selected.has(id)) pickState.selected.delete(id);
  else {
    if (pickState.selected.size >= pickState.max) return toast(`Máximo ${pickState.max} ítems`);
    pickState.selected.add(id);
  }
  renderPick();
});

$("#pick-ok").onclick = async () => {
  if (!pickState) return;
  const ids = [...pickState.selected];
  if (ids.length < pickState.min) return toast(`Elegí al menos ${pickState.min}`);
  try {
    await pickState.onConfirm(ids);
    hideModal($("#modal-pick"));
  } catch (e) { showErr(e); }
};

// Fase 1: la oferta
function openOffer(targetId) {
  const target = state.market.find((i) => i.id === targetId);
  if (!target) return toast("Ese producto ya no está disponible");
  const uid = myUid();
  if (state.trades.some((t) => t.status === "negotiating" && t.aId === uid && t.bItems.includes(target.id))) {
    return toast("Ya tenés una oferta abierta por este producto");
  }
  const mine = availableMine().filter((i) => i.isPublic);
  if (!mine.length) return toast("Primero publicá algo en tu mochila");

  closeAll();
  openPicker({
    title: `Ofrecé a cambio de "${target.title}"`,
    items: mine, selected: [], min: 1, max: MAX_TRADE_ITEMS, confirm: "Enviar oferta",
    onConfirm: async (ids) => {
      await addDoc(collection(db, "trades"), {
        participants: [uid, target.ownerId],
        aId: uid, aName: me().name,
        bId: target.ownerId, bName: nameOf(target.ownerId),
        aItems: ids,
        bItems: [target.id],
        aAccepted: false, bAccepted: false,
        status: "negotiating",
        note: "", noteBy: uid,
        closedAt: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      toast("Oferta enviada 🤝");
      setView("trades");
    },
  });
}

function editMySide() {
  const t = state.currentTrade;
  if (!t) return;
  const iAmA = t.aId === myUid();
  const pool = availableMine().filter((i) => i.isPublic);
  const current = (iAmA ? t.aItems : t.bItems).filter((id) => pool.some((p) => p.id === id));
  openPicker({
    title: "Tu lado de la mesa",
    items: pool, selected: current, min: 1, max: MAX_TRADE_ITEMS,
    confirm: "Guardar (reinicia aceptaciones)",
    onConfirm: async (ids) => {
      await updateDoc(tradeRef(t.id), {
        [iAmA ? "aItems" : "bItems"]: ids,
        aAccepted: false,
        bAccepted: false,
        updatedAt: serverTimestamp(),
      });
    },
  });
}

async function loadTradeItems(t) {
  const ids = [...new Set([...t.aItems, ...t.bItems])];
  const map = new Map();
  await Promise.all(ids.map(async (id) => {
    const local = state.mine.find((i) => i.id === id) || state.market.find((i) => i.id === id);
    if (local) return map.set(id, local);
    try {
      const s = await getDoc(itemRef(id));
      map.set(id, s.exists() ? { id, ...s.data() } : { id, title: "No disponible", color: "#444", basePoints: 0 });
    } catch {
      map.set(id, { id, title: "No disponible", color: "#444", basePoints: 0 });
    }
  }));
  state.currentItems = map;
}

function openTrade(id) {
  closeAll();
  drafts.note = "";
  drafts.chat = "";
  state.tradeTab = "mesa";
  watchTrade(id);
  $("#modal-trade").classList.remove("hidden");
}

function watchTrade(id) {
  stopTradeWatch();
  state.tradeOpen = id;
  tradeDocUnsub = onSnapshot(tradeRef(id), async (snap) => {
    if (!snap.exists()) return hideModal($("#modal-trade"));
    state.currentTrade = { id: snap.id, ...snap.data() };
    await loadTradeItems(state.currentTrade);
    renderTradeModal();
  }, showErr);
  tradeMsgsUnsub = onSnapshot(
    query(collection(db, "trades", id, "messages"), orderBy("createdAt")),
    (snap) => {
      state.messages = snap.docs.map((d) => d.data());
      renderTradeModal();
    },
    showErr,
  );
}

function stopTradeWatch() {
  tradeDocUnsub?.();
  tradeMsgsUnsub?.();
  tradeDocUnsub = null;
  tradeMsgsUnsub = null;
  state.tradeOpen = null;
  state.currentTrade = null;
  state.currentItems = new Map();
  state.messages = [];
}

// Fase 2: la mesa de negociación
const msgHTML = (m, uid) =>
  `<div class="msg ${m.senderId === uid ? "mine" : ""}">${linkify(esc(m.text))}</div>`;
const linkify = (s) => s.replace(
  /(https:\/\/www\.google\.com\/maps\/[^\s<]+)/g,
  `<a href="$1" target="_blank" rel="noopener">Ver en el mapa</a>`,
);

function renderTradeModal() {
  const t = state.currentTrade;
  if (!t) return;
  const uid = myUid();
  const iAmA = t.aId === uid;
  const mySide = iAmA ? t.aItems : t.bItems;
// ---------- Mesa de negociación: render ----------
function renderTradeModal() {
  const t = state.currentTrade;
  if (!t) return;
  const uid = myUid();
  const iAmA = t.aId === uid;
  const mySide = iAmA ? t.aItems : t.bItems;
  const theirSide = iAmA ? t.bItems : t.aItems;
  const other = iAmA ? t.bName : t.aName;
  const myAcc = iAmA ? t.aAccepted : t.bAccepted;
  const theirAcc = iAmA ? t.bAccepted : t.aAccepted;
  const open = t.status === "negotiating";
  const closed = t.status === "closed";

  const itemOf = (id) => state.currentItems.get(id) ?? { title: "Cargando…", color: "#444", basePoints: 0 };
  const sideHTML = (ids) => ids.map((id) => {
    const it = itemOf(id);
    return `<div class="it">
      <span class="swatch" style="background:${esc(it.color)}"></span>
      <span>${esc(it.title)}<small>${it.basePoints} pts</small></span>
    </div>`;
  }).join("") || `<small>—</small>`;
  const pts = (ids) => ids.reduce((s, id) => s + itemOf(id).basePoints, 0);

  const header = `
    <div class="between">
      <span class="status s-${t.status}">${STATUS_LABEL[t.status]}</span>
      <span class="live">● en vivo</span>
    </div>
    <div class="tabs">
      <button class="tab ${state.tradeTab === "mesa" ? "on" : ""}" data-tab="mesa">Mesa</button>
      <button class="tab ${state.tradeTab === "chat" ? "on" : ""}" data-tab="chat">Chat${closed ? "" : " 🔒"}</button>
    </div>`;

  const acceptHTML = !open ? "" : myAcc
    ? `<div class="accept-label">Aceptaste ✓ · esperando a @${esc(other)}</div>`
    : `<div class="accept">
         <div class="accept-label">Deslizá para ACEPTAR${theirAcc ? ` · @${esc(other)} ya aceptó` : ""}</div>
         <input type="range" min="0" max="100" value="0" data-accept />
       </div>`;

  const mesa = `
    <div class="cols">
      <div class="col">
        <h4>Tú ofreces</h4>${sideHTML(mySide)}
        <div class="total">${pts(mySide)} pts</div>
      </div>
      <div class="col">
        <h4>@${esc(other)} ofrece</h4>${sideHTML(theirSide)}
        <div class="total">${pts(theirSide)} pts</div>
      </div>
    </div>
    ${t.note ? `<div class="note">
      <small>${t.noteBy === uid ? "Tu contraoferta" : `Contraoferta de @${esc(other)}`}</small>${esc(t.note)}
    </div>` : ""}
    ${open ? `
      <button class="btn ghost" data-edit-side>Editar mi lado</button>
      <div class="row-inline">
        <input id="note-input" maxlength="280" placeholder="Pedí un cambio, ej: agregá tu reloj" value="${esc(drafts.note)}" />
        <button class="btn ghost" data-note-send>Enviar</button>
      </div>
      ${acceptHTML}
      <button class="btn ghost danger" data-cancel>${iAmA ? "Cancelar oferta" : "Rechazar trato"}</button>` : ""}
    ${closed ? `<div class="accept-label ok">Trato cerrado · el chat está desbloqueado</div>` : ""}`;

  const chat = closed ? `
    <div class="chat">
      <div class="meet">
        ${MEETING_POINTS.map((m, i) => `<button class="chip-btn" data-meet="${i}">${m.icon} ${m.name}</button>`).join("")}
      </div>
      <div class="msgs" id="msgs">
        ${state.messages.length
          ? state.messages.map((m) => msgHTML(m, uid)).join("")
          : `<div class="empty small">Sin mensajes todavía.</div>`}
      </div>
      <form id="chat-form" class="row-inline">
        <input id="chat-input" maxlength="500" placeholder="Escribí un mensaje…" autocomplete="off" value="${esc(drafts.chat)}" />
        <button class="btn primary" type="submit">Enviar</button>
      </form>
    </div>` : `<div class="locked">🔒 El chat seguro se desbloquea cuando ambos acepten el trato.</div>`;

  $("#trade-body").innerHTML = header + (state.tradeTab === "chat" ? chat : mesa);
  const msgs = $("#msgs");
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

// Eventos de la mesa (delegación: se registran una sola vez)
const tb = $("#trade-body");
tb.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.tab) { state.tradeTab = b.dataset.tab; renderTradeModal(); }
  else if (b.hasAttribute("data-edit-side")) editMySide();
  else if (b.hasAttribute("data-note-send")) sendNote();
  else if (b.hasAttribute("data-cancel")) cancelTrade();
  else if (b.dataset.meet !== undefined) sendMeeting(Number(b.dataset.meet));
});
tb.addEventListener("input", (e) => {
  if (e.target.id === "note-input") drafts.note = e.target.value;
  if (e.target.id === "chat-input") drafts.chat = e.target.value;
});
tb.addEventListener("change", (e) => {
  if (!e.target.matches("[data-accept]")) return;
  if (Number(e.target.value) >= 95) acceptTrade();
  else e.target.value = 0;
});
tb.addEventListener("submit", (e) => {
  e.preventDefault();
  if (e.target.id === "chat-form") sendChat(drafts.chat);
});

// ---------- Mesa de negociación: acciones ----------
// Aceptar: transacción para que dos aceptaciones simultáneas no se pisen
async function acceptTrade() {
  const id = state.tradeOpen;
  if (!id) return;
  const uid = myUid();
  try {
    const out = await runTransaction(db, async (tx) => {
      const snap = await tx.get(tradeRef(id));
      if (!snap.exists()) throw new Error("El trato ya no existe");
      const t = snap.data();
      if (!t.participants.includes(uid)) throw new Error("No sos parte de este trato");
      if (t.status !== "negotiating") return { result: "stale" };

      const iAmA = t.aId === uid;
      const otherAccepted = iAmA ? t.bAccepted : t.aAccepted;
      if (otherAccepted) {
        tx.update(tradeRef(id), {
          aAccepted: true, bAccepted: true, status: "closed",
          closedAt: serverTimestamp(), updatedAt: serverTimestamp(),
        });
        return { result: "closed", t };
      }
      tx.update(tradeRef(id), {
        [iAmA ? "aAccepted" : "bAccepted"]: true,
        updatedAt: serverTimestamp(),
      });
      return { result: "accepted" };
    });

    if (out.result === "closed") await finalizeTrade(out.t);
    else if (out.result === "accepted") toast("Aceptaste. Esperando al otro…");
    else toast("Este trato ya no está en mesa");
  } catch (e) { showErr(e); }
}

// Al cerrar: los ítems de ambos lados pasan a "trocado" y salen del mercado
async function finalizeTrade(t) {
  const batch = writeBatch(db);
  [...t.aItems, ...t.bItems].forEach((id) => batch.update(itemRef(id), {
    isPublic: false, gridX: null, gridY: null, lat: null, lng: null,
    status: "traded", tradeId: t.id,
  }));
  await batch.commit();
  celebrate();
}

async function cancelTrade() {
  const t = state.currentTrade;
  if (!t) return;
  const msg = t.aId === myUid() ? "¿Cancelar la oferta?" : "¿Rechazar el trato?";
  if (!confirm(msg)) return;
  await updateDoc(tradeRef(t.id), { status: "cancelled", updatedAt: serverTimestamp() }).catch(showErr);
}

// Contraoferta: al enviar una nota, ambos deben volver a aceptar
async function sendNote() {
  const t = state.currentTrade;
  const text = drafts.note.trim();
  if (!t || !text) return;
  try {
    await updateDoc(tradeRef(t.id), {
      note: text.slice(0, 280),
      noteBy: myUid(),
      aAccepted: false,
      bAccepted: false,
      updatedAt: serverTimestamp(),
    });
    drafts.note = "";
    toast("Contraoferta enviada");
  } catch (e) { showErr(e); }
}

// Chat: solo disponible con el trato cerrado
async function sendChat(text) {
  const t = state.currentTrade;
  const clean = (text ?? "").trim().slice(0, 500);
  if (!t || t.status !== "closed" || !clean) return;
  if (text === drafts.chat) drafts.chat = "";
  try {
    await addDoc(collection(db, "trades", t.id, "messages"), {
      senderId: myUid(),
      text: clean,
      createdAt: serverTimestamp(),
    });
  } catch (e) { showErr(e); }
}

// Punto medio: usa las ubicaciones guardadas de ambos (si existen)
function sendMeeting(i) {
  const t = state.currentTrade;
  const p = MEETING_POINTS[i];
  if (!t || !p) return;
  sendChat(`📍 Punto medio sugerido (${p.name}): ${meetURL(t, p.term)}`);
}

function meetURL(t, term) {
  const base = `https://www.google.com/maps/search/${encodeURIComponent(term)}`;
  const a = state.profiles.get(t.aId);
  const b = state.profiles.get(t.bId);
  if (a?.lat != null && b?.lat != null) {
    const lat = ((a.lat + b.lat) / 2).toFixed(5);
    const lng = ((a.lng + b.lng) / 2).toFixed(5);
    return `${base}/@${lat},${lng},14z`;
  }
  return base;
}

function celebrate() {
  const el = $("#celebrate");
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 2600);
}

// ---------- Ubicación ----------
$("#btn-loc").onclick = () => {
  if (!navigator.geolocation) return toast("Tu navegador no permite geolocalización");
  navigator.geolocation.getCurrentPosition(async (pos) => {
    // Redondeo a 3 decimales (~100 m) para no exponer la dirección exacta
    const lat = Math.round(pos.coords.latitude * 1000) / 1000;
    const lng = Math.round(pos.coords.longitude * 1000) / 1000;
    try {
      // Actualiza también los publicados, para que el radar use la ubicación nueva
      const batch = writeBatch(db);
      batch.update(doc(db, "users", myUid()), { lat, lng, locationAt: serverTimestamp() });
      state.mine.filter((i) => i.isPublic).forEach((i) => batch.update(itemRef(i.id), { lat, lng }));
      await batch.commit();
      toast("Ubicación actualizada");
    } catch (e) { showErr(e); }
  }, () => toast("No pudimos leer tu ubicación. Revisá los permisos del navegador."), { timeout: 10000 });
};

// ---------- Filtros y navegación ----------
$("#radar").addEventListener("change", (e) => {
  state.radarLevel = Number(e.target.value);
  ensureMarketSub();
  renderRadar();
  renderMarket();
});

$("#cats").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cat]");
  if (!b) return;
  state.category = b.dataset.cat;
  renderCats();
  renderMarket();
});

$("#search").addEventListener("input", (e) => {
  state.search = e.target.value;
  renderMarket();
});

$("#results").addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (row) openDetail(row.dataset.id);
});

document.querySelectorAll(".bottom-nav button").forEach((b) => {
  b.onclick = () => setView(b.dataset.view);
});

// ---------- Render general e inicio ----------
function renderAll() {
  const p = me();
  if (!state.user || !p) return;
  $("#my-name").textContent = p.name;
  $("#my-level").textContent = `Nivel ${p.level}/${MAX_LEVEL}`;
  ensureMarketSub();
  renderRadar();
  renderMarket();
  renderInventory();
  renderTrades();
  if (state.currentTrade) renderTradeModal();
}

renderCats();
renderFormOptions();
setView("market");