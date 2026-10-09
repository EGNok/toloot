import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithPopup, signInAnonymously, GoogleAuthProvider, signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, onSnapshot, serverTimestamp,
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

// ---------- Reglas del juego ----------
const COLS = 6;                 // vidriera: 6 columnas
const ROWS = 5;                 // vidriera: 5 filas
const MAX_PHOTOS = 3;
const MAX_LEVEL = 10;
const TIERS = {
  pocket:   { label: "Pocket",   w: 1, h: 1, points: 10 },
  handheld: { label: "Handheld", w: 1, h: 2, points: 30 },
  standard: { label: "Standard", w: 2, h: 2, points: 100 },
  heavy:    { label: "Heavy",    w: 3, h: 3, points: 400 },
  oversize: { label: "Oversize", w: 4, h: 4, points: 1200 },
};
const CONDITIONS = ["Nuevo", "Como nuevo", "Usado", "Dañado"];
const PALETTE = ["#e76f51", "#2a9d8f", "#e9c46a", "#457b9d", "#8ab17d", "#b56576", "#6d597a", "#f4a261"];

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dimsOf = (tier, rotated) => (rotated
  ? { w: TIERS[tier].h, h: TIERS[tier].w }
  : { w: TIERS[tier].w, h: TIERS[tier].h });
const itemDims = (it) => dimsOf(it.tier, it.rotated);
const itemRef = (id) => doc(db, "items", id);
const itemInner = (it) => `${it.photos?.[0] ? `<img src="${esc(it.photos[0])}" alt="">` : ""}<span>${esc(it.title)}</span>`;
const preventScroll = (e) => { if (e.cancelable) e.preventDefault(); };

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
}
const showErr = (e) => toast("Error: " + (e.code || e.message));

// ---------- Estado ----------
const state = { user: null, profiles: new Map(), market: [], mine: [] };
let unsubs = [];
let drag = null;

const me = () => state.profiles.get(state.user?.uid);
const levelOf = (uid) => state.profiles.get(uid)?.level ?? 1;
const nameOf = (uid) => state.profiles.get(uid)?.name ?? "anónimo";

// ---------- Auth ----------
function showScreen(name) {
  $("#screen-login").classList.toggle("hidden", name !== "login");
  $("#screen-app").classList.toggle("hidden", name !== "app");
}
function loginErr(e) { $("#login-error").textContent = e.message; }

$("#btn-google").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch(loginErr);
$("#btn-anon").onclick = () => signInAnonymously(auth).catch(loginErr);
$("#btn-logout").onclick = () => signOut(auth);

onAuthStateChanged(auth, async (user) => {
  unsubs.forEach((u) => u());
  unsubs = [];
  state.user = user;
  if (!user) { showScreen("login"); return; }
  try { await ensureProfile(user); } catch (e) { showErr(e); }
  listen();
  showScreen("app");
  renderAll();
});

async function ensureProfile(user) {
  const ref = doc(db, "users", user.uid);
  if ((await getDoc(ref)).exists()) return;
  let name = (user.displayName || "").trim().slice(0, 24);
  if (name.length < 2) name = "Jugador" + user.uid.slice(0, 4);
  await setDoc(ref, { name, level: 1, createdAt: serverTimestamp() });
}

// ---------- Listeners en tiempo real ----------
function listen() {
  unsubs.push(onSnapshot(collection(db, "users"),
    (snap) => { state.profiles = new Map(snap.docs.map((d) => [d.id, d.data()])); renderAll(); },
    showErr));

  unsubs.push(onSnapshot(query(collection(db, "items"), where("isPublic", "==", true)),
    (snap) => { state.market = snap.docs.map((d) => ({ id: d.id, ...d.data() })); renderMarket(); },
    showErr));

  unsubs.push(onSnapshot(query(collection(db, "items"), where("ownerId", "==", state.user.uid)),
    (snap) => { state.mine = snap.docs.map((d) => ({ id: d.id, ...d.data() })); renderInventory(); },
    showErr));
}

// ---------- Navegación ----------
function setView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".bottom-nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("#fab").classList.toggle("hidden", name !== "inventory");
}
document.querySelectorAll(".bottom-nav button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));

function closeModals() { document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden")); }
document.addEventListener("click", (e) => {
  if (e.target.matches("[data-close]") || e.target.classList.contains("modal")) closeModals();
});

// ---------- MERCADO ----------
function sellerStats() {
  const stats = new Map();
  for (const it of state.market) {
    const s = stats.get(it.ownerId) ?? { points: 0, count: 0 };
    s.points += it.basePoints;
    s.count += 1;
    stats.set(it.ownerId, s);
  }
  return stats;
}

function renderMarket() {
  const raw = $("#search").value;
  const hasQuery = norm(raw).length > 0;
  $("#feed").classList.toggle("hidden", hasQuery);
  $("#results").classList.toggle("hidden", !hasQuery);
  hasQuery ? renderResults(raw) : renderFeed();
}

// Modo 1: Feed TikTok. Poder del vendedor = (suma de puntos base) x (cantidad de publicados)
function renderFeed() {
  const stats = sellerStats();
  const power = (uid) => { const s = stats.get(uid); return s ? s.points * s.count : 0; };
  const list = [...state.market].sort((a, b) =>
    power(b.ownerId) - power(a.ownerId) ||
    a.ownerId.localeCompare(b.ownerId) ||
    b.basePoints - a.basePoints);

  $("#feed").innerHTML = list.length
    ? list.map((it) => cardHTML(it, `· Poder ${power(it.ownerId)}`)).join("")
    : `<div class="empty">Todavía no hay productos publicados. ¡Armá tu vidriera y sé el primero!</div>`;
}

// Modo 2: Búsqueda tipo Amazon. Score = puntos base x nivel del vendedor
function renderResults(raw) {
  const q = norm(raw);
  const hits = state.market
    .filter((it) => norm(`${it.title} ${it.description}`).includes(q))
    .map((it) => ({ it, score: it.basePoints * levelOf(it.ownerId) }))
    .sort((a, b) => b.score - a.score);

  $("#results").innerHTML = hits.length
    ? hits.map(({ it, score }) => rowHTML(it, score)).join("")
    : `<div class="empty">Sin resultados para “${esc(raw)}”</div>`;
}

function cardHTML(it, extra = "") {
  const slides = it.photos?.length
    ? it.photos.map((src) => `<div class="slide"><img src="${esc(src)}" alt="" loading="lazy"></div>`).join("")
    : `<div class="slide" style="background:${esc(it.color)}"></div>`;
  return `
    <article class="market-card">
      <div class="carousel">${slides}</div>
      <div class="card-info">
        <h2>${esc(it.title)}</h2>
        <p class="desc">${esc(it.description)}</p>
        <div class="chips">
          <span class="chip">${TIERS[it.tier].label} · ${it.basePoints} pts</span>
          <span class="chip">${esc(it.condition)}</span>
        </div>
        <div class="seller">@${esc(nameOf(it.ownerId))} · Nivel ${levelOf(it.ownerId)} ${esc(extra)}</div>
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
        <small>@${esc(nameOf(it.ownerId))} · Nv ${levelOf(it.ownerId)} · ${TIERS[it.tier].label} · ${esc(it.condition)}</small>
      </div>
      <div class="score">${score}</div>
    </button>`;
}

$("#search").addEventListener("input", renderMarket);
$("#results").addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (row) openDetail(row.dataset.id);
});

function openDetail(id) {
  const it = state.market.find((i) => i.id === id);
  if (!it) return;
  $("#detail-body").innerHTML =
    cardHTML(it, `· Score ${it.basePoints * levelOf(it.ownerId)}`) +
    `<button class="btn ghost" data-close>Cerrar</button>`;
  $("#modal-detail").classList.remove("hidden");
}

// ---------- INVENTARIO ----------
function renderInventory() {
  const placed = state.mine.filter((i) => i.isPublic);
  const stash = state.mine.filter((i) => !i.isPublic);
  $("#grid-count").textContent = `${placed.length} publicados`;
  $("#stash-count").textContent = `(${stash.length})`;

  $("#grid").innerHTML = placed.map((it) => {
    const d = itemDims(it);
    return `<div class="item placed" data-id="${esc(it.id)}"
      style="left:${(it.gridX * 100) / COLS}%;top:${(it.gridY * 100) / ROWS}%;
             width:${(d.w * 100) / COLS}%;height:${(d.h * 100) / ROWS}%;
             background:${esc(it.color)}">${itemInner(it)}</div>`;
  }).join("");

  $("#stash").innerHTML = stash.length
    ? stash.map((it) => `
        <div class="item" data-id="${esc(it.id)}" style="background:${esc(it.color)}">
          ${itemInner(it)}
          <button class="del" data-del title="Eliminar">✕</button>
        </div>`).join("")
    : `<div class="empty small">Tu cajón está vacío. Usá el + para cargar productos.</div>`;
}

$("#drawer-toggle").onclick = () => $("#drawer").classList.toggle("collapsed");
$("#grid").addEventListener("pointerdown", onPointerDown);
$("#stash").addEventListener("pointerdown", onPointerDown);

$("#stash").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-del]");
  if (!btn) return;
  const id = btn.closest(".item").dataset.id;
  const item = state.mine.find((i) => i.id === id);
  if (!item || !confirm(`¿Eliminar "${item.title}"?`)) return;
  deleteDoc(itemRef(id)).catch(showErr);
});

// ---------- Colisiones y posiciones ----------
function collides(item, x, y, d) {
  return state.mine.some((o) => {
    if (o.id === item.id || !o.isPublic) return false;
    const od = itemDims(o);
    return x < o.gridX + od.w && o.gridX < x + d.w && y < o.gridY + od.h && o.gridY < y + d.h;
  });
}

function cellSize() {
  const rect = $("#grid").getBoundingClientRect();
  return { rect, cellW: rect.width / COLS, cellH: rect.height / ROWS };
}

async function placeItem(item, gx, gy) {
  await updateDoc(itemRef(item.id), { gridX: gx, gridY: gy, isPublic: true });
  toast("Publicado en el mercado");
}

async function stashItem(item) {
  await updateDoc(itemRef(item.id), { gridX: null, gridY: null, isPublic: false });
  toast("Devuelto al cajón");
}

async function rotate(item) {
  const next = !item.rotated;
  const d = dimsOf(item.tier, next);
  if (item.gridX + d.w > COLS || item.gridY + d.h > ROWS || collides(item, item.gridX, item.gridY, d)) {
    toast("No hay espacio para rotar");
    return;
  }
  await updateDoc(itemRef(item.id), { rotated: next });
}

// ---------- Drag & drop (mouse + touch) ----------
function onPointerDown(e) {
  if (drag || e.target.closest("[data-del]")) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const el = e.target.closest(".item");
  const item = el && state.mine.find((i) => i.id === el.dataset.id);
  if (!item) return;

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
  // En touch, mantener presionado ~180ms para arrastrar; si se mueve antes, es scroll
  if (drag.touch) drag.timer = setTimeout(() => drag && startGhost(drag), 180);

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", cancelDrag);
}

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
  const fits = gx >= 0 && gy >= 0 && gx + d.w <= COLS && gy + d.h <= ROWS && !collides(s.item, gx, gy, d);
  return { gx, gy, d, inside, fits };
}

function showPreview(s) {
  const pv = $("#preview");
  const t = dropTarget(s);
  if (!t.inside) { pv.classList.add("hidden"); return; }
  const gx = clamp(t.gx, 0, COLS - t.d.w);
  const gy = clamp(t.gy, 0, ROWS - t.d.h);
  Object.assign(pv.style, {
    left: `${(gx * 100) / COLS}%`,
    top: `${(gy * 100) / ROWS}%`,
    width: `${(t.d.w * 100) / COLS}%`,
    height: `${(t.d.h * 100) / ROWS}%`,
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
  else if (s.item.isPublic) stashItem(s.item).catch(showErr); // sacado de la vidriera -> cajón
}

// ---------- Crear producto ----------
$("#fab").onclick = openNewForm;

function openNewForm() {
  const form = $("#form-new");
  form.reset();
  form.querySelector('select[name="condition"]').innerHTML =
    CONDITIONS.map((c) => `<option>${esc(c)}</option>`).join("");
  $("#tier-list").innerHTML = Object.entries(TIERS).map(([key, t], i) => `
    <label class="tier">
      <input type="radio" name="tier" value="${key}" ${i === 0 ? "checked" : ""} />
      <span class="tier-box" style="--w:${t.w};--h:${t.h}"></span>
      <strong>${t.label}</strong>
      <small>${t.w}×${t.h} · ${t.points} pts</small>
    </label>`).join("");
  $("#modal-new").classList.remove("hidden");
}

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
  const submitBtn = form.querySelector('[type="submit"]');

  submitBtn.disabled = true;
  try {
    const photos = await Promise.all(files.map(compressImage));
    await addDoc(collection(db, "items"), {
      ownerId: state.user.uid,
      ownerName: me()?.name ?? "Jugador",
      title: String(fd.get("title")).trim(),
      description: String(fd.get("description")).trim(),
      condition: fd.get("condition"),
      tier: tierKey,
      basePoints: t.points,
      w: t.w,
      h: t.h,
      color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
      photos,
      rotated: false,
      gridX: null,
      gridY: null,
      isPublic: false,           // entra al cajón privado (Stash)
      createdAt: serverTimestamp(),
    });
    closeModals();
    toast("Guardado en tu cajón");
  } catch (err) {
    showErr(err);
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- Render general ----------
function renderAll() {
  if (!state.user) return;
  const p = me();
  if (p) {
    $("#my-name").textContent = p.name;
    $("#my-level").textContent = `Nivel ${p.level}/${MAX_LEVEL}`;
  }
  renderMarket();
  renderInventory();
}

setView("market");