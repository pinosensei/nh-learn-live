// Learn Live With Friends - v2, PHASE B (UNTESTED).
// Phase A: Room Browser, Create Room, Join (public/password), 35 racer seats, Lobby, Leave, host transfer, presence, cleanup.
// Phase B: host setup (textbook, 1-4 units, game mode), word-pool check, START (writes the race config + roster),
//          a placeholder race screen (countdown, settings check, racers), END RACE, host "Remove" for dropped students.
// NO questions / scoring yet (Phase C).
// Uses ONLY the new database nodes liveRoomList / liveRooms. The old "rooms" node is never touched.
// Does NOT read or write any NH Interactive data. Only localStorage key used: nhLive_nickname.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, setPersistence, browserSessionPersistence, onAuthStateChanged, signInAnonymously }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getDatabase, ref, get, set, update, onValue, onDisconnect, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import * as V from "./vocab.js";

const firebaseConfig = {
  apiKey: "AIzaSyCQWPYbU7mMBmcoQMs3_Qn8ujpwOf1GxSw",
  authDomain: "nh-interactive.firebaseapp.com",
  databaseURL: "https://nh-interactive-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "nh-interactive",
  storageBucket: "nh-interactive.firebasestorage.app",
  messagingSenderId: "395085592450",
  appId: "1:395085592450:web:f1ee20534c2e69c1d9819b",
  measurementId: "G-TRZMNEEN4X"
};

const $ = id => document.getElementById(id);
const MAX = 35;                         // racer seats per room
const MIN_RACERS = 1;                   // TESTING value: START needs at least this many racers (a real classroom value is still to be decided)
const COUNTDOWN_MS = 5000;
const GRADES = [["nh1", "New Horizon 1 (NH1)"], ["nh2", "New Horizon 2 (NH2)"], ["nh3", "New Horizon 3 (NH3)"]];
const HIDE_AFTER = 2 * 60 * 1000;       // browser hides rooms silent for 2 minutes
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0 O 1 I L
const tabId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/-/g, "").slice(0, 12);

let db, uid = null, online = false, wasOnline = null, serverOffset = 0, busy = false, toastT;
let listing = {}, unsubBrowser = null;
let room = null;                        // { id, seat|null, nick, name, pw|null }
let members = {}, hostUid = null, seatsReal = {}, presence = {}, entry = null;
let unsubs = [], promoTimer = null, hbTimer = null, recovering = false, rc = 0, pwShown = false, pending = null;
const sweepTried = new Set();
let vocab = null, vocabErr = null, vocabLoading = false;           // the published portal-data.js (read only)
let setupData = null, raceData = null, sel = { grade: "nh1", units: [], mode: V.MODES[0].id }, selDirty = false;
let starting = false, setupT = null, stuckT = null, setupKey = "", verifyKey = "", armedLight = false, armQ = Promise.resolve(), raceTick = null;
let hostNameTry = 0;
setInterval(() => { rc = 0; }, 20000);

const denied = e => e && (e.code === "PERMISSION_DENIED" || /permission[_ ]denied/i.test(e.message || ""));
const show = id => document.querySelectorAll(".screen").forEach(s => { s.hidden = s.id !== id; });
const serverNow = () => Date.now() + serverOffset;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 7000); }
async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function genCode() { let s = ""; const buf = new Uint8Array(32); while (s.length < 6) { crypto.getRandomValues(buf); for (const b of buf) if (b < 248 && s.length < 6) s += ALPHA[b % 31]; } return s; }
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function getNick() { return $("nick").value.trim(); }
function nickOk() { const n = getNick(); if (!n || n.length > 20) { toast("Please enter a nickname (1–20 characters)."); $("nick").focus(); return null; } try { localStorage.setItem("nhLive_nickname", n); } catch {} return n; }

/* ---------------------------------------------------------------- start-up */
async function init() {
  try { $("nick").value = localStorage.getItem("nhLive_nickname") || ""; } catch {}
  try {
    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    await setPersistence(auth, browserSessionPersistence);   // identity lives in this tab's session storage
    await new Promise(r => { const off = onAuthStateChanged(auth, () => { off(); r(); }); });
    if (!auth.currentUser) await signInAnonymously(auth);
    uid = auth.currentUser.uid;
    db = getDatabase(app);
    onValue(ref(db, ".info/serverTimeOffset"), s => { serverOffset = s.val() || 0; });
    onValue(ref(db, ".info/connected"), s => {
      online = s.val() === true;
      if (online && wasOnline === false && room) reconnected();
      wasOnline = online;
    });
    $("btn-new").disabled = false;
    startBrowser();
    loadVocab();
  } catch (e) { console.error(e); toast("Couldn't connect to Firebase. Please check the setup and try again."); }
}
async function loadVocab() {
  if (vocab || vocabLoading) return;
  vocabLoading = true;
  try { vocab = await V.loadPortalData(); vocabErr = null; } catch (e) { vocab = null; vocabErr = e; console.error("vocabulary", e); }
  finally { vocabLoading = false; }
  setupKey = ""; verifyKey = ""; if (room) render();
}
setInterval(() => { if (!vocab && room) loadVocab(); }, 20000);
async function work(fn) {
  if (busy) return;
  if (!online) { toast("Not connected yet. Please wait a moment and try again."); return; }
  busy = true; document.querySelectorAll(".big").forEach(b => { b.disabled = true; });
  try { await fn(); } catch (e) { console.error(e); toast("Something went wrong. Please try again."); }
  finally { busy = false; document.querySelectorAll(".big").forEach(b => { b.disabled = false; }); if (room) { setupKey = ""; render(); } }
}

/* ------------------------------------------------------------ room browser */
function startBrowser() {
  if (unsubBrowser) unsubBrowser();
  unsubBrowser = onValue(ref(db, "liveRoomList"), s => { listing = s.val() || {}; renderBrowser(); sweep(); },
    e => { console.error(e); toast("Couldn't load the room list."); });
}
const seatCount = e => Object.keys((e && e.seats) || {}).length;
function roomState(e) {
  if (e.status === "starting") return ["Starting", "b-racing", false];
  if (e.status === "racing") return ["Racing", "b-racing", false];
  if (e.status === "finished") return ["Finished", "b-finished", false];
  if (seatCount(e) >= MAX) return ["Full", "b-full", false];
  return ["Waiting", "b-waiting", true];
}
function renderBrowser() {
  const box = $("rooms"); box.replaceChildren();
  const now = serverNow();
  const rows = Object.entries(listing).filter(([, e]) => e && typeof e.heartbeatAt === "number" && now - e.heartbeatAt <= HIDE_AFTER)
    .sort((a, b) => (roomState(b[1])[2] - roomState(a[1])[2]) || ((a[1].createdAt || 0) - (b[1].createdAt || 0)));
  $("rooms-empty").hidden = rows.length > 0;
  for (const [id, e] of rows) {
    const [label, cls, joinable] = roomState(e);
    const b = document.createElement("button"); b.type = "button"; b.className = "room-row" + (joinable ? "" : " off");
    const lock = document.createElement("span"); lock.textContent = e.locked ? "🔒" : "🌐";
    const name = document.createElement("span"); name.className = "rn"; name.textContent = e.name;
    const host = document.createElement("small"); host.textContent = "Host: " + e.hostName; name.append(host);
    const cnt = document.createElement("span"); cnt.className = "rc"; cnt.textContent = `${seatCount(e)}/${MAX}`;
    const st = document.createElement("span"); st.className = "badge " + cls; st.textContent = label;
    b.append(lock, name, cnt, st);
    b.onclick = () => clickRoom(id);
    box.append(b);
  }
}
setInterval(() => { if (!room) renderBrowser(); }, 15000);

async function sweep() { // tidy up rooms that look dead; the rules refuse unless they really are dead
  const now = serverNow(); let n = 0;
  for (const [id, e] of Object.entries(listing)) {
    if (!e || typeof e.heartbeatAt !== "number" || now - e.heartbeatAt <= HIDE_AFTER || n >= 3) continue;
    const key = id + (now - e.heartbeatAt > 10 * 60 * 1000 ? ":stale" : ":idle");   // retry once more when it passes 10 minutes
    if (sweepTried.has(key)) continue;
    sweepTried.add(key); n++;
    update(ref(db), { [`liveRoomList/${id}`]: null, [`liveRooms/${id}`]: null }).catch(() => {});
  }
}

function clickRoom(id) {
  const nick = nickOk(); if (!nick) return;
  const e = listing[id]; if (!e) return toast("That room is gone.");
  const [, , joinable] = roomState(e);
  if (e.status !== "waiting") { work(() => joinRoom(id, null)); return; }   // a racer who dropped can return; anybody else is told the race is running
  if (!joinable) return toast("This room is full (35/35).");
  if (e.locked) { pending = id; $("pwdlg-name").textContent = e.name; $("j-pw").value = ""; show("pwdlg"); $("j-pw").focus(); return; }
  work(() => joinRoom(id, null));
}
$("form-pw").addEventListener("submit", ev => { ev.preventDefault(); const pw = $("j-pw").value, id = pending; $("j-pw").value = ""; work(() => joinRoom(id, pw)); });

/* -------------------------------------------------------------- create room */
$("btn-new").onclick = () => { if (nickOk()) { $("c-name").value = ""; $("c-pw").value = ""; show("create"); $("c-name").focus(); } };
document.querySelectorAll("[data-back]").forEach(b => { b.onclick = () => { show("browser"); startBrowser(); }; });
$("form-create").addEventListener("submit", ev => { ev.preventDefault(); work(async () => {
  const nick = nickOk(); if (!nick) return;
  const name = $("c-name").value.trim(), pw = $("c-pw").value;
  if (!name || name.length > 30) return toast("Please enter a room name (1–30 characters).");
  if (pw && (pw.length < 6 || pw.length > 20)) return toast("The password must be 6–20 characters (or leave it empty).");
  for (let i = 0; i < 8; i++) {
    const id = genCode(), proof = pw ? await sha256(id + ":" + pw) : null;
    const member = { nickname: nick, joinedAt: serverTimestamp(), tabId, seat: "1" };
    const data = { hostUid: uid, createdAt: serverTimestamp(), members: { [uid]: member }, seats: { 1: uid } };
    if (proof) { member.proof = proof; data.secret = { passwordHash: proof }; }
    try {
      await arm(id, "1");
      await update(ref(db), {
        [`liveRooms/${id}`]: data,
        [`liveRoomList/${id}`]: { name, hostName: nick, locked: !!pw, status: "waiting", createdAt: serverTimestamp(), heartbeatAt: serverTimestamp(), seats: { 1: true } }
      });
      return enter({ id, seat: "1", nick, name, pw: pw || null, key: pw || null });
    } catch (e) { if (!denied(e)) throw e; }   // a taken id is refused by the rules: just try another
  }
  await disarm();
  toast("Couldn't create a room. Please try again in a moment.");
}); });

/* --------------------------------------------------------------------- join */
const memberRef = (id = room.id) => ref(db, `liveRooms/${id}/members/${uid}`);
// What the server should clean up if this connection drops.
// In the lobby ("full"): member + seat + presence + mirror, so a student who closes the tab disappears.
// Once the game is starting or running ("light"): presence only, so a dropped racer keeps their seat, roster place and progress.
function arm(id, seat, light = false) {
  armedLight = light;
  const run = async () => {
    const p = { [`liveRooms/${id}/presence/${uid}`]: null };
    if (!light) { p[`liveRooms/${id}/members/${uid}`] = null; if (seat) { p[`liveRooms/${id}/seats/${seat}`] = null; p[`liveRoomList/${id}/seats/${seat}`] = null; } }
    const od = onDisconnect(ref(db)); await od.cancel(); await od.update(p);
  };
  armQ = armQ.catch(() => {}).then(run);   // one at a time, so two arms can never leave a mix behind
  return armQ;
}
async function disarm() { try { await onDisconnect(ref(db)).cancel(); } catch {} }

async function joinRoom(id, pw) {
  const nick = nickOk(); if (!nick) return;
  let e = (await get(ref(db, `liveRoomList/${id}`))).val();
  if (!e) return leaveLocal("That room is gone.");
  const proof = e.locked ? await sha256(id + ":" + (pw || "")) : null;

  // Already a member with this identity (duplicate tab, or a quick reload)? Take the entry over.
  try {
    const snap = await get(memberRef(id));
    if (snap.exists()) {
      const m = snap.val();
      await set(ref(db, `liveRooms/${id}/members/${uid}/tabId`), tabId);
      await arm(id, m.seat || null, e.status !== "waiting");
      return enter({ id, seat: m.seat || null, nick: m.nickname, name: e.name, pw: null });
    }
  } catch (err) { if (!denied(err)) throw err; }   // denied = not a member yet: the normal case

  for (let attempt = 0; attempt < 12; attempt++) {
    if (e.status !== "waiting") { await disarm(); return toast("A race is already in progress. You can join the next one."); }
    const taken = e.seats || {};
    const free = [], busySeats = [];
    for (let n = 1; n <= MAX; n++) (taken[n] ? busySeats : free).push(n);
    const seat = (free.length ? shuffle(free) : shuffle(busySeats))[0];   // a stale mirror may hide a free seat: try anyway
    const member = { nickname: nick, joinedAt: serverTimestamp(), tabId, seat: String(seat) };
    if (proof) member.proof = proof;
    try {
      await arm(id, String(seat));
      await update(ref(db), { [`liveRooms/${id}/seats/${seat}`]: uid, [`liveRooms/${id}/members/${uid}`]: member });
      update(ref(db), { [`liveRoomList/${id}/seats/${seat}`]: true }).catch(err => console.warn("mirror", err));
      return enter({ id, seat: String(seat), nick, name: e.name, pw: null, key: pw || null });
    } catch (err) {
      if (!denied(err)) throw err;
      e = (await get(ref(db, `liveRoomList/${id}`))).val();   // refresh: maybe taken, full, started or gone
      if (!e) { await disarm(); return toast("That room is gone."); }
      if (attempt === 2 && e.locked) break;                   // seats are free but we keep being refused: almost certainly the password
    }
  }
  await disarm();
  toast(e && e.locked ? "Couldn't join. Wrong password, or the room just filled up." : "Couldn't join. The room may be full or closed.");
}

/* -------------------------------------------------------------------- lobby */
function enter(r) {
  if (unsubBrowser) { unsubBrowser(); unsubBrowser = null; }
  room = r; members = {}; hostUid = null; seatsReal = {}; presence = {}; entry = null; pwShown = false; rc = 0;
  setupData = null; raceData = null; selDirty = false; starting = false; setupKey = ""; verifyKey = "";
  $("created").hidden = !r.pw;
  $("created-pw").textContent = "•".repeat(r.pw ? r.pw.length : 0); $("btn-pw").textContent = "Show";
  announce(); attach(); show("lobby"); startHeartbeat();
}
function announce() {
  set(ref(db, `liveRooms/${room.id}/presence/${uid}`), { tabId, at: serverTimestamp() }).catch(e => console.warn("presence", e));
}
function attach() {
  const b = `liveRooms/${room.id}/`;
  unsubs = [
    onValue(ref(db, b + "members"), s => { members = s.val() || {}; membersChanged(); }, listenErr),
    onValue(ref(db, b + "hostUid"), s => { hostUid = s.val(); render(); }, listenErr),
    onValue(ref(db, b + "seats"), s => { seatsReal = s.val() || {}; render(); }, listenErr),
    onValue(ref(db, b + "presence"), s => { presence = s.val() || {}; render(); }, () => {}),
    onValue(ref(db, `liveRoomList/${room.id}`), s => { entry = s.val(); render(); }, () => {}),
    onValue(ref(db, b + "setup"), s => { setupData = s.val(); adoptSetup(); render(); }, () => {}),
    onValue(ref(db, b + "race"), s => { raceData = s.val(); render(); }, () => {})
  ];
}
function detach() { unsubs.forEach(u => u()); unsubs = []; clearTimeout(promoTimer); clearTimeout(stuckT); clearTimeout(setupT); clearInterval(hbTimer); clearInterval(raceTick); hbTimer = null; raceTick = null; }
function listenErr() { if (room) recover(); }

function membersChanged() {
  if (!room) return;
  const me = members[uid];
  if (me && me.tabId !== tabId) { // another tab (same identity) took this room over
    detach(); room = null; disarm(); startBrowser(); show("browser");
    return toast("This room is already open in another tab. Please use that tab (or close it first).");
  }
  if (me) room.seat = me.seat || null;
  else { recover(); return; }
  render();
}

async function recover() { // our entry vanished (network blip, reload race): try to sit down again
  if (!room || recovering) return;
  if (++rc > 3) return leaveLocal("Lost connection to the room.");
  recovering = true; const r = room;
  try {
    const e = (await get(ref(db, `liveRoomList/${r.id}`))).val();
    if (!e) return leaveLocal("The room is no longer available.");
    if (e.status !== "waiting") return leaveLocal("You were disconnected and the race has already started.");
    const proof = e.locked && r.key ? await sha256(r.id + ":" + r.key) : null;
    if (e.locked && !proof) return leaveLocal("You were disconnected from the room. Please join again.");
    for (let n = 0; n < 6; n++) {
      const taken = (await get(ref(db, `liveRoomList/${r.id}`))).val()?.seats || {};
      const free = []; for (let k = 1; k <= MAX; k++) if (!taken[k]) free.push(k);
      if (!free.length) return leaveLocal("The room filled up while you were disconnected.");
      const seat = shuffle(free)[0], member = { nickname: r.nick, joinedAt: serverTimestamp(), tabId, seat: String(seat) };
      if (proof) member.proof = proof;
      try {
        await arm(r.id, String(seat));
        await update(ref(db), { [`liveRooms/${r.id}/seats/${seat}`]: uid, [`liveRooms/${r.id}/members/${uid}`]: member });
        update(ref(db), { [`liveRoomList/${r.id}/seats/${seat}`]: true }).catch(() => {});
        room.seat = String(seat); detach(); attach(); startHeartbeat(); announce(); return;   // the server cancelled our listeners when access was lost
      } catch (err) { if (!denied(err)) throw err; }
    }
    leaveLocal("Couldn't rejoin the room.");
  } catch (e) { console.error(e); leaveLocal("Lost connection to the room."); }
  finally { recovering = false; }
}
async function reconnected() { if (!room) return; try { await arm(room.id, room.seat, !!entry && entry.status !== "waiting"); announce(); heartbeat(); } catch (e) { console.warn(e); } }

function render() {
  if (!room) return;
  const list = Object.entries(members).map(([id, m]) => ({ id, ...m })).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  const ul = $("players"); ul.replaceChildren();
  for (const p of list) {
    const host = p.id === hostUid, li = document.createElement("li");
    if (host) li.className = "host"; else if (!presence[p.id]) li.className = "offline";
    const name = document.createElement("span");
    name.textContent = (host ? "👑 " : presence[p.id] ? "🟢 " : "⚫ ") + p.nickname + (p.id === uid ? " (you)" : "");
    const racer = !!p.seat && seatsReal[p.seat] === p.id;   // a racer really holds the seat named on their entry
    const tag = document.createElement("span");
    tag.className = "tag" + (host ? " tag-host" : racer ? "" : " tag-spec");
    tag.textContent = host ? (racer ? "HOST · RACER" : "HOST") : racer ? "RACER" : "SPECTATOR";
    li.append(name, tag); ul.append(li);
  }
  const racers = Object.keys(seatsReal).length;
  $("lobby-name").textContent = (entry && entry.name) || room.name || "Room";
  $("count").textContent = `${racers}/${MAX}`;
  $("lobby-status").textContent = entry ? ({ waiting: "Waiting for players", starting: "The host is starting the game...", racing: "Race in progress", finished: "Race finished" }[entry.status] || "") : "";
  $("wait").textContent = racers < MAX ? "Waiting for players..." : "All 35 seats are taken!";
  const iAmHost = hostUid === uid && !!members[uid];
  $("host-tools").hidden = !iAmHost; $("setup-view").hidden = iAmHost;
  $("btn-hostplays").textContent = "Host Join Race: " + (members[uid] && members[uid].seat && seatsReal[members[uid].seat] === uid ? "ON" : "OFF");
  $("btn-hostplays").disabled = !(entry && entry.status === "waiting");
  renderPlayersExtras(list, iAmHost);
  renderSetup(iAmHost, racers);
  routeScreens(iAmHost);
  // keep the disconnect handler matched to the room state (lobby = full cleanup, game running = presence only)
  if (entry && online && armedLight !== (entry.status !== "waiting")) arm(room.id, room.seat, entry.status !== "waiting").catch(() => {});
  // a "starting" that never finished (the host's tab died halfway) is reset by the host
  clearTimeout(stuckT);
  if (iAmHost && entry && entry.status === "starting" && !starting) stuckT = setTimeout(() => { if (room && hostUid === uid && entry && entry.status === "starting" && !starting) set(ref(db, `liveRoomList/${room.id}/status`), "waiting").catch(() => {}); }, 12000);
  // Host promotion: if the host is gone, the longest-present member claims host first; others wait longer.
  clearTimeout(promoTimer);
  const me = list.findIndex(p => p.id === uid);
  if (hostUid && me >= 0 && !members[hostUid]) {
    promoTimer = setTimeout(async () => {
      if (!room) return;
      try { await set(ref(db, `liveRooms/${room.id}/hostUid`), uid); await set(ref(db, `liveRoomList/${room.id}/hostName`), room.nick); } catch { /* somebody else won */ }
    }, 3000 + me * 2000);
  } else if (iAmHost && entry && entry.hostName !== room.nick && Date.now() - hostNameTry > 5000) {
    hostNameTry = Date.now(); set(ref(db, `liveRoomList/${room.id}/hostName`), room.nick).catch(() => {});
  }
}


/* ------------------------------------------------------------ host setup (Phase B) */
const unitsOf = () => sel.units.slice().sort((a, b) => a - b);
const gradeName = g => (GRADES.find(x => x[0] === g) || [g, g])[1];
const unitsText = u => "Unit" + (u.length > 1 ? "s " : " ") + u.join(", ");
function setupText(c) { const u = Object.values(c.units || {}).map(Number).sort((a, b) => a - b); return `${gradeName(c.grade)} · ${unitsText(u)} · ${V.modeLabel(c.mode)} · ${V.TOTAL} questions`; }

// Fill the dropdowns once.
(function initSetupControls() {
  const g = $("s-grade"); for (const [id, label] of GRADES) g.append(new Option(label, id));
  const m = $("s-mode"); for (const x of V.MODES) { const o = new Option(x.label + (x.available ? "" : " — coming soon"), x.id); o.disabled = !x.available; m.append(o); }
  $("s-total").textContent = String(V.TOTAL);
  g.onchange = () => { sel.grade = g.value; sel.units = []; hostEdited(); };
  m.onchange = () => { sel.mode = m.value; hostEdited(); };
})();
function hostEdited() { selDirty = true; setupKey = ""; render(); clearTimeout(setupT); setupT = setTimeout(saveSetup, 400); }
function saveSetup() {
  if (!room || hostUid !== uid) return Promise.resolve();
  const u = unitsOf();
  const val = u.length ? { grade: sel.grade, units: Object.fromEntries(u.map((n, i) => [i, n])), mode: sel.mode } : null;
  return set(ref(db, `liveRooms/${room.id}/setup`), val).catch(e => console.warn("setup", e));
}
// A new host (or a reloaded one) starts from what was saved in the room.
function adoptSetup() {
  if (selDirty || !setupData || !setupData.units) return;
  const m = V.MODES.find(x => x.id === setupData.mode);
  sel = { grade: setupData.grade, units: Object.values(setupData.units).map(Number), mode: m && m.available ? m.id : V.MODES[0].id };
  setupKey = "";
}
function currentPool() { return vocab && sel.units.length ? V.buildPool(vocab, sel.grade, unitsOf(), sel.mode) : null; }

function renderSetup(iAmHost, racers) {
  if (!iAmHost) {
    const st = entry && entry.status;
    $("setup-text").textContent = st === "starting" ? "The host is starting the game..." : setupData && setupData.units ? setupText(setupData) : "The host is choosing a game...";
    return;
  }
  const waiting = !!entry && entry.status === "waiting";
  const pool = currentPool(), n = pool ? pool.words.length : 0;
  const key = JSON.stringify([sel, !!vocab, !!vocabErr, waiting, racers, starting, n, online]);
  if (key === setupKey) return; setupKey = key;
  $("s-grade").value = sel.grade; $("s-mode").value = sel.mode;
  $("s-grade").disabled = $("s-mode").disabled = !waiting;
  const box = $("s-units"); box.replaceChildren();
  if (vocab) {
    for (const u of V.unitList(vocab, sel.grade, sel.mode)) {
      const on = sel.units.includes(u.number), lab = document.createElement("label");
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = on;
      cb.disabled = !waiting || (!on && sel.units.length >= V.MAX_UNITS);
      if (cb.disabled && !on) lab.className = "off";
      cb.onchange = () => { sel.units = cb.checked ? [...new Set([...sel.units, u.number])] : sel.units.filter(x => x !== u.number); hostEdited(); };
      const t = document.createElement("span"); t.textContent = "Unit " + u.number; const sm = document.createElement("small"); sm.textContent = u.count + " words"; t.append(sm);
      lab.append(cb, t); box.append(lab);
    }
  }
  const msg = $("s-pool"); let ok = false;
  if (vocabErr) { msg.className = "pool bad"; msg.textContent = "❌ Couldn't load the word list. Check your connection; it will try again."; }
  else if (!vocab) { msg.className = "pool"; msg.textContent = "Loading the word list..."; }
  else if (!sel.units.length) { msg.className = "pool"; msg.textContent = "Choose at least one unit (up to " + V.MAX_UNITS + ")."; }
  else if (n < V.TOTAL) { msg.className = "pool bad"; msg.textContent = `❌ Only ${n} usable words in your selection, but ${V.TOTAL} are needed. Please select another unit.`; }
  else if (racers < MIN_RACERS) { msg.className = "pool"; msg.textContent = `✅ ${n} words available. Waiting for at least ${MIN_RACERS} racer${MIN_RACERS > 1 ? "s" : ""}.`; }
  else { ok = true; msg.className = "pool ok"; msg.textContent = `✅ ${n} words available (${V.TOTAL} are used per race). ${racers} racer${racers > 1 ? "s" : ""} ready.`; }
  const mode = V.MODES.find(x => x.id === sel.mode);
  $("btn-start").disabled = !(ok && waiting && !starting && online && mode && mode.available);
  $("btn-start").textContent = starting ? "STARTING..." : "START GAME";
}

/* --------------------------------------------------------------------- START */
$("btn-start").onclick = () => work(async () => {
  if (!room || hostUid !== uid || !entry || entry.status !== "waiting") return;
  if (!vocab) return toast("The word list isn't loaded yet.");
  const mode = V.MODES.find(x => x.id === sel.mode); if (!mode || !mode.available) return toast("That game mode is coming soon.");
  const id = room.id, u = unitsOf();
  const pool = V.buildPool(vocab, sel.grade, u, sel.mode);
  if (!u.length || u.length > V.MAX_UNITS) return toast("Choose 1 to " + V.MAX_UNITS + " units.");
  if (pool.words.length < V.TOTAL) return toast(`Only ${pool.words.length} usable words. Please select another unit.`);
  starting = true; setupKey = ""; render();
  const back = async msg => { try { await set(ref(db, `liveRoomList/${id}/status`), "waiting"); } catch {} starting = false; setupKey = ""; render(); if (msg) toast(msg); };
  try {
    clearTimeout(setupT); await saveSetup();
    try { await set(ref(db, `liveRoomList/${id}/status`), "starting"); }       // closes the room to new joins
    catch (e) { starting = false; setupKey = ""; render(); if (!denied(e)) throw e; return toast("Couldn't start: the room changed. Please try again."); }
    // read the seats AFTER the room is closed, so nobody can slip in between
    const [sSnap, mSnap] = await Promise.all([get(ref(db, `liveRooms/${id}/seats`)), get(ref(db, `liveRooms/${id}/members`))]);
    const seats = sSnap.val() || {}, mem = mSnap.val() || {}, roster = {};
    for (const [n, who] of Object.entries(seats)) { const m = mem[who]; if (m && m.seat === n) roster[who] = { nickname: m.nickname, seat: n }; }
    if (Object.keys(roster).length < MIN_RACERS) return back("Nobody is racing yet. Wait for at least " + MIN_RACERS + " racer(s).");
    const seed = V.randomSeed(), targets = V.pickTargets(pool.words, seed, V.TOTAL), fp = await V.fingerprint(targets);
    await update(ref(db), {
      [`liveRooms/${id}/race`]: {
        config: { schemaVersion: V.SCHEMA_VERSION, mode: sel.mode, grade: sel.grade, units: Object.fromEntries(u.map((n, i) => [i, n])), total: V.TOTAL,
                  questionIds: Object.fromEntries(targets.map((w, i) => [i, w.id])), seed, fingerprint: fp, countdownMs: COUNTDOWN_MS },
        startAt: serverTimestamp(), roster
      },
      [`liveRoomList/${id}/status`]: "racing"
    });
    starting = false; setupKey = "";
  } catch (e) { console.error(e); await back("Couldn't start the game. Please try again."); }
});

/* ------------------------------------------------------- remove / end race */
const removeWrites = (id, who) => {
  const w = { [`liveRooms/${id}/members/${who}`]: null, [`liveRooms/${id}/presence/${who}`]: null };
  const seat = members[who] && members[who].seat;
  if (seat) { if (seatsReal[seat] === who) w[`liveRooms/${id}/seats/${seat}`] = null; w[`liveRoomList/${id}/seats/${seat}`] = null; }
  return w;
};
function removeStudent(who) { return work(async () => { if (room && hostUid === uid && who !== uid && !presence[who]) await update(ref(db), removeWrites(room.id, who)); }); }
$("btn-end").onclick = () => work(async () => {
  if (!room || hostUid !== uid) return;
  const id = room.id; let w = { [`liveRooms/${id}/race`]: null, [`liveRoomList/${id}/status`]: "waiting" };
  for (const who of Object.keys(members)) if (who !== uid && !presence[who]) w = { ...w, ...removeWrites(id, who) };   // dropped racers are cleared now
  await update(ref(db), w);
});
function renderPlayersExtras(list, iAmHost) {   // "Remove" for students who dropped (grey dot), lobby list
  if (!iAmHost) return;
  [...$("players").children].forEach((li, i) => {
    const p = list[i]; if (!p || p.id === uid || presence[p.id]) return;
    li.append(removeButton(p.id));
  });
}
function removeButton(who) { const b = document.createElement("button"); b.type = "button"; b.className = "small kick"; b.textContent = "Remove"; b.onclick = () => removeStudent(who); return b; }

/* ---------------------------------------------------- race screen (placeholder) */
function routeScreens(iAmHost) {
  const inRace = !!entry && (entry.status === "racing" || entry.status === "finished") && !!raceData && !!raceData.config;
  if (inRace) {
    if ($("race").hidden) { show("race"); verifyKey = ""; }
    renderRace(iAmHost);
    if (!raceTick) raceTick = setInterval(tickCountdown, 250);
  } else {
    if ($("lobby").hidden) show("lobby");
    clearInterval(raceTick); raceTick = null;
  }
}
function tickCountdown() {
  if (!room || !raceData || !raceData.config) return;
  const left = raceData.startAt + raceData.config.countdownMs - serverNow();
  $("race-count").textContent = left > 0 ? `Starting in ${Math.ceil(left / 1000)}...` : "GO!";
}
function renderRace(iAmHost) {
  const c = raceData.config;
  $("race-info").textContent = setupText(c);
  $("btn-end").hidden = !iAmHost;
  const roster = Object.entries(raceData.roster || {}).map(([id, r]) => ({ id, ...r })).sort((a, b) => Number(a.seat) - Number(b.seat));
  $("race-n").textContent = `${roster.length}`;
  const ul = $("race-players"); ul.replaceChildren();
  for (const r of roster) {
    const li = document.createElement("li"), here = !!presence[r.id], member = !!members[r.id];
    if (!here) li.className = member ? "offline" : "gone";
    const span = document.createElement("span");
    span.textContent = (r.id === hostUid ? "👑 " : here ? "🟢 " : "⚫ ") + r.nickname + (r.id === uid ? " (you)" : "") + (here ? "" : member ? " — Disconnected" : " — Removed");
    li.append(span);
    if (iAmHost && member && !here && r.id !== uid) li.append(removeButton(r.id));
    ul.append(li);
  }
  tickCountdown();
  // does MY copy of the vocabulary give the host's exact 40 words?
  const key = c.fingerprint + (vocab ? "v" : "n");
  if (key !== verifyKey) {
    verifyKey = key; const v = $("race-verify");
    if (!vocab) v.textContent = "Checking the word list...";
    else V.verifyConfig(vocab, c).then(r => {
      if (verifyKey !== key) return;
      v.textContent = r.status === "ok" ? "✅ Your word list matches the host's (40 words verified)." : "⚠️ Your word list doesn't match the host's (" + r.reason + "). Please reload the page.";
    }).catch(() => { v.textContent = "⚠️ Couldn't check the word list."; });
  }
}

/* ---------------------------------------------------------------- heartbeat */
function heartbeat() { if (room) set(ref(db, `liveRoomList/${room.id}/heartbeatAt`), serverTimestamp()).catch(() => {}); } // refused when too soon: fine
function startHeartbeat() { clearInterval(hbTimer); hbTimer = setInterval(heartbeat, 30000); }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") heartbeat(); });
window.addEventListener("online", heartbeat);

/* ---------------------------------------------------------- host seat on/off */
$("btn-hostplays").onclick = () => work(async () => {
  if (!room || hostUid !== uid) return;
  const id = room.id, me = members[uid];
  if (me && me.seat && seatsReal[me.seat] === uid) { // OFF: give the seat back
    const n = me.seat;
    await update(ref(db), { [`liveRooms/${id}/seats/${n}`]: null, [`liveRooms/${id}/members/${uid}/seat`]: null, [`liveRoomList/${id}/seats/${n}`]: null });
    room.seat = null; await arm(id, null);
  } else {               // ON: take a free seat
    const free = []; for (let k = 1; k <= MAX; k++) if (!seatsReal[k]) free.push(k);
    for (const n of shuffle(free)) {
      try {
        await update(ref(db), { [`liveRooms/${id}/seats/${n}`]: uid, [`liveRooms/${id}/members/${uid}/seat`]: String(n) });
        update(ref(db), { [`liveRoomList/${id}/seats/${n}`]: true }).catch(() => {});
        room.seat = String(n); await arm(id, String(n)); return;
      } catch (e) { if (!denied(e)) throw e; }
    }
    toast("All 35 racer seats are taken, so the host can't race.");
  }
});

/* -------------------------------------------------------------------- leave */
function leaveLocal(msg) {
  detach(); room = null; members = {}; hostUid = null; seatsReal = {}; presence = {}; entry = null; setupData = null; raceData = null; starting = false;
  show("browser"); startBrowser(); if (msg) toast(msg);
}
async function leave() {
  if (!room) return;
  const r = room, alone = Object.keys(members).length <= 1, seat = r.seat;
  leaveLocal();
  const w = { [`liveRooms/${r.id}/members/${uid}`]: null, [`liveRooms/${r.id}/presence/${uid}`]: null };
  if (seat) { w[`liveRooms/${r.id}/seats/${seat}`] = null; w[`liveRoomList/${r.id}/seats/${seat}`] = null; }
  try { await update(ref(db), w); } catch (e) { console.error(e); return; }   // the disconnect handler stays as a fallback
  await disarm();
  if (alone) { try { await update(ref(db), { [`liveRooms/${r.id}`]: null, [`liveRoomList/${r.id}`]: null }); } catch (e) { console.error(e); } }
}
$("btn-leave").onclick = leave;
$("btn-leave2").onclick = leave;
$("btn-pw").onclick = () => {
  if (!room || !room.pw) return;
  pwShown = !pwShown; $("created-pw").textContent = pwShown ? room.pw : "•".repeat(room.pw.length); $("btn-pw").textContent = pwShown ? "Hide" : "Show";
};

init();
