// Learn Live With Friends - v2, PHASE E2 (UNTESTED): adds the Spelling race mode (Japanese question, the student types the English).
// Page-only: same rules, same data shapes. (Phase E1 added English -> Japanese; Phase D below.)
// (Phase D below:)
// Phase D: English + Japanese text, nickname/room-name filter, results screen, Words to Review (this device only),
//          projector view, PLAY AGAIN, host Remove with confirmation, optional sound/vibration (OFF by default).
// Phase D changes NO Firebase paths, rules or data shapes. Browser storage keys used: nhLive_nickname, nhLive_sound, nhLive_vibrate, (session) nhLive_review.
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
import { t, MODE_JA, questionsJa, ordinalEn } from "./strings.js";
import { checkNickname, checkRoomName } from "./namefilter.js";
import * as Sp from "./spelling.js";

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
let wasMember = false, blipped = false;   // "removed by the host" = our entry vanished while we stayed connected
let review = null;                       // Words to Review for this race, this device only: { key, wrong:Set, skip:Set }
setInterval(() => { rc = 0; }, 20000);

const denied = e => e && (e.code === "PERMISSION_DENIED" || /permission[_ ]denied/i.test(e.message || ""));
const show = id => document.querySelectorAll(".screen").forEach(s => { s.hidden = s.id !== id; });
const serverNow = () => Date.now() + serverOffset;
// English goes in the text, the Japanese in data-ja (the stylesheet shows it on the line below).
function setX(el, x) { el.textContent = x.en; el.setAttribute("data-ja", x.ja); }
function setT(el, key, vars) { setX(el, t(key, vars)); }
function toast(key, vars) { const el = $("toast"); setT(el, key, vars); el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 7000); }
async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function genCode() { let s = ""; const buf = new Uint8Array(32); while (s.length < 6) { crypto.getRandomValues(buf); for (const b of buf) if (b < 248 && s.length < 6) s += ALPHA[b % 31]; } return s; }
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function getNick() { return $("nick").value.trim(); }
function nickOk() {
  const r = checkNickname(getNick());
  if (!r.ok) { toast(r.reason === "blocked" ? "nickBlocked" : r.reason === "chars" ? "nickChars" : "needNick"); $("nick").focus(); return null; }
  $("nick").value = r.value;
  try { localStorage.setItem("nhLive_nickname", r.value); } catch {}
  return r.value;
}

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
      if (!online) blipped = true;
      if (online && wasOnline === false && room) reconnected();
      wasOnline = online;
    });
    $("btn-new").disabled = false;
    startBrowser();
    loadVocab();
  } catch (e) { console.error(e); toast("noServer"); }
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
  if (!online) { toast("notConnected"); return; }
  busy = true; document.querySelectorAll(".big").forEach(b => { b.disabled = true; });
  try { await fn(); } catch (e) { console.error(e); toast("wrong"); }
  finally { busy = false; document.querySelectorAll(".big").forEach(b => { b.disabled = false; }); if (room) { setupKey = ""; render(); } }
}

/* ------------------------------------------------------------ room browser */
function startBrowser() {
  if (unsubBrowser) unsubBrowser();
  unsubBrowser = onValue(ref(db, "liveRoomList"), s => { listing = s.val() || {}; renderBrowser(); sweep(); },
    e => { console.error(e); toast("roomListFail"); });
}
const seatCount = e => Object.keys((e && e.seats) || {}).length;
function roomState(e) {
  if (e.status === "starting") return ["stStarting", "b-racing", false];
  if (e.status === "racing") return ["stRacing", "b-racing", false];
  if (e.status === "finished") return ["stFinished", "b-finished", false];
  if (seatCount(e) >= MAX) return ["stFull", "b-full", false];
  return ["stWaiting", "b-waiting", true];
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
    const host = document.createElement("small"); setT(host, "hostIs", { name: e.hostName }); name.append(host);
    const cnt = document.createElement("span"); cnt.className = "rc"; cnt.textContent = `${seatCount(e)}/${MAX}`;
    const st = document.createElement("span"); st.className = "badge " + cls; setT(st, label);
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
  const e = listing[id]; if (!e) return toast("roomGone");
  const [, , joinable] = roomState(e);
  if (e.status !== "waiting") { work(() => joinRoom(id, null)); return; }   // a racer who dropped can return; anybody else is told the race is running
  if (!joinable) return toast("roomFull");
  if (e.locked) { pending = id; $("pwdlg-name").textContent = e.name; $("j-pw").value = ""; show("pwdlg"); $("j-pw").focus(); return; }
  work(() => joinRoom(id, null));
}
$("form-pw").addEventListener("submit", ev => { ev.preventDefault(); const pw = $("j-pw").value, id = pending; $("j-pw").value = ""; work(() => joinRoom(id, pw)); });

/* -------------------------------------------------------------- create room */
$("btn-new").onclick = () => { if (nickOk()) { $("c-name").value = ""; $("c-pw").value = ""; show("create"); $("c-name").focus(); } };
document.querySelectorAll("[data-back]").forEach(b => { b.onclick = () => { show("browser"); startBrowser(); }; });
$("form-create").addEventListener("submit", ev => { ev.preventDefault(); work(async () => {
  const nick = nickOk(); if (!nick) return;
  const rn = checkRoomName($("c-name").value), pw = $("c-pw").value;
  if (!rn.ok) return toast(rn.reason === "blocked" ? "roomBlocked" : rn.reason === "chars" ? "roomChars" : "needRoom");
  const name = rn.value;
  if (pw && (pw.length < 6 || pw.length > 20)) return toast("pwLength");
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
  toast("createFail");
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
  if (!e) return leaveLocal("roomGone");
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
    if (e.status !== "waiting") { await disarm(); return toast("inProgress"); }
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
      if (!e) { await disarm(); return toast("roomGone"); }
      if (attempt === 2 && e.locked) break;                   // seats are free but we keep being refused: almost certainly the password
    }
  }
  await disarm();
  toast(e && e.locked ? "joinFailPw" : "joinFail");
}

/* -------------------------------------------------------------------- lobby */
function enter(r) {
  if (unsubBrowser) { unsubBrowser(); unsubBrowser = null; }
  wasMember = false; blipped = false; review = null; room = r; members = {}; hostUid = null; seatsReal = {}; presence = {}; entry = null; pwShown = false; rc = 0;
  setupData = null; raceData = null; selDirty = false; starting = false; setupKey = ""; verifyKey = "";
  $("created").hidden = !r.pw;
  $("created-pw").textContent = "•".repeat(r.pw ? r.pw.length : 0); setT($("btn-pw"), "show");
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
function detach() { unsubs.forEach(u => u()); unsubs = []; clearTimeout(promoTimer); clearTimeout(stuckT); clearTimeout(setupT); clearTimeout(returnT); returnT = null; returnKey = ""; eng = null; raceWords = null; clearInterval(hbTimer); clearInterval(raceTick); hbTimer = null; raceTick = null; }
function listenErr() { if (room) recover(); }

function membersChanged() {
  if (!room) return;
  const me = members[uid];
  if (me && me.tabId !== tabId) { // another tab (same identity) took this room over
    detach(); room = null; disarm(); startBrowser(); show("browser");
    return toast("otherTab");
  }
  if (me) { room.seat = me.seat || null; wasMember = true; blipped = false; }
  else if (wasMember && online && !blipped) { leaveLocal("youWereRemoved"); disarm(); return; }   // the host removed us while we were connected: do not sit down again
  else { recover(); return; }
  render();
}

async function recover() { // our entry vanished (network blip, reload race): try to sit down again
  if (!room || recovering) return;
  if (++rc > 3) return leaveLocal("lostRoom");
  recovering = true; const r = room;
  try {
    const e = (await get(ref(db, `liveRoomList/${r.id}`))).val();
    if (!e) return leaveLocal("roomUnavailable");
    if (wasMember && online && !blipped) { leaveLocal("youWereRemoved"); disarm(); return; }   // the room is still there but our place is gone, and we never lost the connection: the host removed us (the server also cuts our listeners when that happens)
    if (e.status !== "waiting") return leaveLocal("lostRace");
    const proof = e.locked && r.key ? await sha256(r.id + ":" + r.key) : null;
    if (e.locked && !proof) return leaveLocal("joinAgain");
    for (let n = 0; n < 6; n++) {
      const taken = (await get(ref(db, `liveRoomList/${r.id}`))).val()?.seats || {};
      const free = []; for (let k = 1; k <= MAX; k++) if (!taken[k]) free.push(k);
      if (!free.length) return leaveLocal("roomFilled");
      const seat = shuffle(free)[0], member = { nickname: r.nick, joinedAt: serverTimestamp(), tabId, seat: String(seat) };
      if (proof) member.proof = proof;
      try {
        await arm(r.id, String(seat));
        await update(ref(db), { [`liveRooms/${r.id}/seats/${seat}`]: uid, [`liveRooms/${r.id}/members/${uid}`]: member });
        update(ref(db), { [`liveRoomList/${r.id}/seats/${seat}`]: true }).catch(() => {});
        room.seat = String(seat); detach(); attach(); startHeartbeat(); announce(); return;   // the server cancelled our listeners when access was lost
      } catch (err) { if (!denied(err)) throw err; }
    }
    leaveLocal("rejoinFail");
  } catch (e) { console.error(e); leaveLocal("lostRoom"); }
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
    if (p.id === uid) name.setAttribute("data-ja", "（あなた）");
    const racer = !!p.seat && seatsReal[p.seat] === p.id;   // a racer really holds the seat named on their entry
    const tag = document.createElement("span");
    tag.className = "tag" + (host ? " tag-host" : racer ? "" : " tag-spec");
    setT(tag, host ? (racer ? "tagHostRacer" : "tagHost") : racer ? "tagRacer" : "tagSpectator");
    li.append(name, tag); ul.append(li);
  }
  const racers = Object.keys(seatsReal).length;
  $("lobby-name").textContent = (entry && entry.name) || room.name || "Room";
  $("count").textContent = `${racers}/${MAX}`;
  const st = entry && ({ waiting: "statusWaiting", starting: "hostStarting", racing: "statusRace", finished: "statusDone" }[entry.status]);
  if (st) setT($("lobby-status"), st); else { $("lobby-status").textContent = ""; $("lobby-status").removeAttribute("data-ja"); }
  setT($("wait"), racers < MAX ? "waitingFor" : "seatsFull");
  const iAmHost = hostUid === uid && !!members[uid];
  $("host-tools").hidden = !iAmHost; $("setup-view").hidden = iAmHost;
  { const on = !!(members[uid] && members[uid].seat && seatsReal[members[uid].seat] === uid); const x = t("hostJoin", { state: on ? "ON" : "OFF" }); setX($("btn-hostplays"), x); }
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
function setupText(c) { const u = Object.values(c.units || {}).map(Number).sort((a, b) => a - b); const base = `${gradeName(c.grade)} · ${unitsText(u)} · `; return { en: `${base}${V.modeLabel(c.mode)} · ${V.TOTAL} questions`, ja: `${base}${MODE_JA[c.mode] || V.modeLabel(c.mode)} · ${questionsJa(V.TOTAL)}` }; }

// Fill the dropdowns once.
(function initSetupControls() {
  const g = $("s-grade"); for (const [id, label] of GRADES) g.append(new Option(label, id));
  const m = $("s-mode"); for (const x of V.MODES) { const o = new Option((x.available ? x.label + " / " + (MODE_JA[x.id] || "") : x.label + " — " + t("comingSoon").en + " / " + t("comingSoon").ja), x.id); o.disabled = !x.available; m.append(o); }
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
    if (st === "starting") setT($("setup-text"), "hostStarting"); else if (setupData && setupData.units) setX($("setup-text"), setupText(setupData)); else setT($("setup-text"), "hostChoosing");
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
      const tt = document.createElement("span"); tt.textContent = "Unit " + u.number; const sm = document.createElement("small"); setT(sm, "unitWords", { n: u.count }); tt.append(sm);
      lab.append(cb, tt); box.append(lab);
    }
  }
  const msg = $("s-pool"); let ok = false;
  if (vocabErr) { msg.className = "pool bad"; setT(msg, "poolError"); }
  else if (!vocab) { msg.className = "pool"; setT(msg, "poolLoading"); }
  else if (!sel.units.length) { msg.className = "pool"; setT(msg, "poolNone"); }
  else if (n < V.TOTAL) { msg.className = "pool bad"; setT(msg, "poolShort", { n }); }
  else if (racers < MIN_RACERS) { msg.className = "pool"; setT(msg, "poolWait", { n, m: MIN_RACERS }); }
  else { ok = true; msg.className = "pool ok"; setT(msg, "poolOk", { n, r: racers }); }
  const mode = V.MODES.find(x => x.id === sel.mode);
  $("btn-start").disabled = !(ok && waiting && !starting && online && mode && mode.available);
  setT($("btn-start"), starting ? "starting" : "start");
}

/* --------------------------------------------------------------------- START */
$("btn-start").onclick = () => work(startFlow);
async function startFlow() {   // used by START GAME and by PLAY AGAIN
  if (!room || hostUid !== uid || !entry || entry.status !== "waiting") return;
  if (!vocab) return toast("wordsNotLoaded");
  const mode = V.MODES.find(x => x.id === sel.mode); if (!mode || !mode.available) return toast("modeSoon");
  const id = room.id, u = unitsOf();
  const pool = V.buildPool(vocab, sel.grade, u, sel.mode);
  if (!u.length || u.length > V.MAX_UNITS) return toast("chooseUnits");
  if (pool.words.length < V.TOTAL) return toast("tooFewWords", { n: pool.words.length });
  starting = true; setupKey = ""; render();
  const back = async (key, vars) => { try { await set(ref(db, `liveRoomList/${id}/status`), "waiting"); } catch {} starting = false; setupKey = ""; render(); if (key) toast(key, vars); };
  try {
    clearTimeout(setupT); await saveSetup();
    try { await set(ref(db, `liveRoomList/${id}/status`), "starting"); }       // closes the room to new joins
    catch (e) { starting = false; setupKey = ""; render(); if (!denied(e)) throw e; return toast("startChanged"); }
    // read the seats AFTER the room is closed, so nobody can slip in between
    const [sSnap, mSnap] = await Promise.all([get(ref(db, `liveRooms/${id}/seats`)), get(ref(db, `liveRooms/${id}/members`))]);
    const seats = sSnap.val() || {}, mem = mSnap.val() || {}, roster = {};
    for (const [n, who] of Object.entries(seats)) { const m = mem[who]; if (m && m.seat === n) roster[who] = { nickname: m.nickname, seat: n }; }
    if (Object.keys(roster).length < MIN_RACERS) return back("nobodyRacing", { m: MIN_RACERS });
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
  } catch (e) { console.error(e); await back("startFail"); }
}
// PLAY AGAIN: back to the lobby (the same clean-up as BACK TO LOBBY), then the same START with the same settings.
$("btn-again").onclick = () => work(async () => {
  if (!room || hostUid !== uid || !entry || entry.status !== "finished" || !raceData || !raceData.config) return;
  const c = raceData.config, m = V.MODES.find(x => x.id === c.mode);
  sel = { grade: c.grade, units: Object.values(c.units).map(Number), mode: m && m.available ? m.id : V.MODES[0].id }; selDirty = true;
  await update(ref(db), returnWrites(room.id));
  for (let i = 0; i < 60 && !(entry && entry.status === "waiting" && !raceData); i++) await sleep(100);
  if (!(entry && entry.status === "waiting")) return toast("playAgainFail");
  await startFlow();
});

/* ------------------------------------------------------- remove / end race */
const removeWrites = (id, who) => {
  const w = { [`liveRooms/${id}/members/${who}`]: null };
  if (presence[who]) w[`liveRooms/${id}/presence/${who}`] = null;   // only the host may clear a marker; the host-away return only removes people who have none
  const seat = members[who] && members[who].seat;
  if (seat) { if (seatsReal[seat] === who) w[`liveRooms/${id}/seats/${seat}`] = null; w[`liveRoomList/${id}/seats/${seat}`] = null; }
  return w;
};
function removeStudent(who) { return work(async () => { if (room && hostUid === uid && who !== uid && members[who]) await update(ref(db), removeWrites(room.id, who)); }); }
// Remove asks first.
let removeWho = null;
function askRemove(who) {
  if (!room || hostUid !== uid || who === uid || !members[who]) return;
  removeWho = who; const name = members[who].nickname;
  setT($("modal-q"), "confirmQ", { name }); setT($("modal-note"), "confirmNote", { name });
  $("modal").hidden = false; $("modal-no").focus();
}
const closeModal = () => { removeWho = null; $("modal").hidden = true; };
$("modal-no").onclick = closeModal;
$("modal").addEventListener("click", ev => { if (ev.target === $("modal")) closeModal(); });
$("modal-yes").onclick = () => { const who = removeWho; closeModal(); if (who) removeStudent(who); };
$("btn-end").onclick = () => work(async () => {
  if (!room || hostUid !== uid) return;
  await update(ref(db), returnWrites(room.id));   // dropped racers are cleared now
});
function renderPlayersExtras(list, iAmHost) {   // host: a "Remove" button next to every other person (asks first)
  if (!iAmHost) return;
  [...$("players").children].forEach((li, i) => {
    const p = list[i]; if (!p || p.id === uid) return;
    li.append(removeButton(p.id));
  });
}
function removeButton(who) { const b = document.createElement("button"); b.type = "button"; b.className = "small kick"; setT(b, "remove"); b.onclick = () => askRemove(who); return b; }

/* ------------------------------------------------------------------ race screen */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash32 = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const progOf = id => (raceData && raceData.progress && raceData.progress[id]) || {};
const solvedOf = id => Object.keys(progOf(id).solved || {}).map(Number);
let raceWords = null, raceWordsKey = "";                        // the 40 words as THIS device resolves them (verified against the host's fingerprint)
let eng = null;                                                 // this racer's game state
let finishTry = 0, returnT = null, returnKey = "";

function routeScreens(iAmHost) {
  const inRace = !!entry && (entry.status === "racing" || entry.status === "finished") && !!raceData && !!raceData.config;
  if (inRace) {
    if ($("race").hidden) { show("race"); verifyKey = ""; }
    renderRace(iAmHost);
    if (!raceTick) raceTick = setInterval(tick, 250);
  } else {
    if ($("lobby").hidden) show("lobby");
    clearInterval(raceTick); raceTick = null; clearTimeout(returnT); returnT = null; returnKey = ""; eng = null; document.body.classList.remove("projector");
  }
}
const raceStartMs = () => raceData.startAt + raceData.config.countdownMs;
function tick() {
  if (!room || !raceData || !raceData.config) return;
  const left = raceStartMs() - serverNow();
  if (entry && entry.status === "finished") setT($("race-count"), "raceOver"); else if (left > 0) setT($("race-count"), "startsIn", { n: Math.ceil(left / 1000) }); else setT($("race-count"), "go");
  if (left <= 0) startEngine();
}

/* ---- ranking (same on every device: finished by server time, then unfinished by solved count) ---- */
function ranking() {
  const rows = Object.entries(raceData.roster || {}).map(([id, r]) => {
    const p = progOf(id), n = solvedOf(id).length;
    return { id, nickname: r.nickname, solved: n, finishedAt: typeof p.finishedAt === "number" ? p.finishedAt : null };
  });
  rows.sort((a, b) => (a.finishedAt != null) !== (b.finishedAt != null) ? (a.finishedAt != null ? -1 : 1)
    : a.finishedAt != null ? (a.finishedAt - b.finishedAt) || (a.id < b.id ? -1 : 1)
    : (b.solved - a.solved) || a.nickname.localeCompare(b.nickname));
  rows.forEach((r, i) => { r.place = i + 1; });
  return rows;
}
const medal = n => (n === 1 ? "🥇" : n === 2 ? "🥈" : n === 3 ? "🥉" : n + ".");
const fmtTime = ms => { const s = Math.max(0, ms) / 1000; return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`; };

function renderRace(iAmHost) {
  const c = raceData.config, over = entry.status === "finished", racer = !!(raceData.roster && raceData.roster[uid]);
  setX($("race-info"), setupText(c));
  $("btn-end").hidden = !iAmHost; setT($("btn-end"), over ? "backLobby" : "endRace");
  $("btn-again").hidden = !(iAmHost && over);
  $("btn-proj").hidden = !(iAmHost || !racer); setT($("btn-proj"), document.body.classList.contains("projector") ? "projectorOff" : "projector");
  $("spectator-note").hidden = racer;
  $("results").hidden = !over; $("live").hidden = over;
  tick();
  // does MY copy of the vocabulary give the host's exact 40 words?
  const key = c.fingerprint + ":" + c.mode + (vocab ? "v" : "n");
  if (key !== verifyKey) {
    verifyKey = key; const v = $("race-verify"); raceWords = null;
    if (!V.MODES.some(m => m.id === c.mode && m.available)) setT(v, "modeUnsupported");   // this page does not know the host's game mode: do not guess
    else if (!vocab) setT(v, "checking");
    else V.verifyConfig(vocab, c).then(r => {
      if (verifyKey !== key) return;
      if (r.status === "ok") { raceWords = r.words; setT(v, "verifyOk"); startEngine(); if (room) render(); }
      else setT(v, "verifyBad");
    }).catch(() => { setT(v, "verifyFail"); });
  }
  if (over) renderResults(racer); else renderBoard(racer);
  renderPlayMode(racer, over);
  maybeFinishRace(racer);
  maybeReturnToLobby(iAmHost, over);
}

const iAmHostNow = () => hostUid === uid && !!members[uid];
function fillBoard(ul, rows, { trim = false, racer = false } = {}) {
  ul.replaceChildren();
  let shown = rows;
  const meIdx = rows.findIndex(r => r.id === uid);
  if (trim && racer && rows.length > 10 && meIdx >= 0 && !document.body.classList.contains("projector")) {   // racers see the top 5, themselves and their neighbours
    const keep = new Set([...Array(5).keys(), meIdx - 1, meIdx, meIdx + 1].filter(i => i >= 0 && i < rows.length));
    shown = [...keep].sort((a, b) => a - b).map(i => rows[i]);
  }
  let prev = -1;
  for (const r of shown) {
    const idx = rows.indexOf(r);
    if (prev >= 0 && idx > prev + 1) { const g = document.createElement("li"); g.className = "gap"; g.textContent = "···"; ul.append(g); }
    prev = idx;
    const li = document.createElement("li"), here = !!presence[r.id], member = !!members[r.id];
    li.className = (r.id === uid ? "me " : "") + (here ? "" : "off");
    const place = document.createElement("span"); place.className = "rk"; place.textContent = r.finishedAt != null ? medal(r.place) : "";
    const name = document.createElement("span");
    const state = here ? null : member ? t("offline") : t("removed");
    name.textContent = (r.id === hostUid ? "👑 " : here ? "🟢 " : "⚫ ") + r.nickname + (r.id === uid ? " (you)" : "") + (state ? " — " + state.en : "");
    const ja = [r.id === uid ? "（あなた）" : "", state ? state.ja : ""].filter(Boolean).join(" ");
    if (ja) name.setAttribute("data-ja", ja);
    const stat = document.createElement("span");
    stat.textContent = r.finishedAt != null ? "🏁 " + fmtTime(r.finishedAt - raceStartMs()) : `${r.solved}/${V.TOTAL}`;
    const bar = document.createElement("div"); bar.className = "bar"; const fill = document.createElement("i"); fill.style.width = Math.round(100 * r.solved / V.TOTAL) + "%"; bar.append(fill);
    li.append(place, name, stat, bar);
    if (trim && iAmHostNow() && member && r.id !== uid) li.append(removeButton(r.id));   // host: Remove (asks first)
    ul.append(li);
  }
}
function renderBoard(racer) {
  const rows = ranking();
  $("race-n").textContent = String(rows.length);
  fillBoard($("board"), rows, { trim: true, racer });
}

/* ---- results screen (race finished) ---- */
function renderResults(racer) {
  const rows = ranking(), done = rows.filter(r => r.finishedAt != null);
  // podium: 2nd, 1st, 3rd
  const pod = $("podium"); pod.replaceChildren(); pod.hidden = done.length === 0;
  for (const k of [1, 0, 2]) {
    const r = done[k]; if (!r) continue;
    const d = document.createElement("div"); d.className = "slot s" + (k + 1);
    const m = document.createElement("span"); m.className = "medal"; m.textContent = medal(k + 1);
    const n = document.createElement("span"); n.textContent = r.nickname;
    const tm = document.createElement("small"); tm.textContent = fmtTime(r.finishedAt - raceStartMs());
    d.append(m, n, tm); pod.append(d);
  }
  const mine = rows.find(r => r.id === uid);
  $("my-result").hidden = !(racer && mine);
  if (racer && mine) {
    if (mine.finishedAt != null) setT($("my-result-text"), "youCame", { place: ordinalEn(mine.place), n: mine.place, time: fmtTime(mine.finishedAt - raceStartMs()) });
    else setT($("my-result-text"), "dnf", { s: mine.solved });
  }
  fillBoard($("rank-list"), rows);
  renderReview(racer);
}
function renderReview(racer) {
  $("review").hidden = !(racer && raceWords);
  if ($("review").hidden) return;
  const mode = raceData.config.mode, rv = reviewState(), wrong = [...rv.wrong].sort((a, b) => a - b), skip = [...rv.skip].filter(i => !rv.wrong.has(i)).sort((a, b) => a - b);
  const fill = (ul, list) => { ul.replaceChildren(); for (const i of list) { const w = raceWords[i]; if (!w) continue; const li = document.createElement("li"); const a = document.createElement("span"); a.textContent = V.promptOf(w, mode); const b = document.createElement("b"); const tp = (ul === $("review-wrong-list") && V.isTyping(mode) && rv.typed[i]) || []; b.textContent = (tp.length ? tp.join(" / ") + " → " : "") + V.answerOf(w, mode); li.append(a, b); ul.append(li); } };
  fill($("review-wrong-list"), wrong); fill($("review-skip-list"), skip);
  $("review-wrong").hidden = !wrong.length; $("review-skip").hidden = !skip.length; $("review-none").hidden = !!(wrong.length || skip.length);
}

/* ---- Words to Review: kept on THIS device only (memory + this tab's session storage). It never goes to Firebase and never touches NH Interactive. ---- */
function reviewState() {
  const key = room.id + ":" + raceData.startAt;
  if (review && review.key === key) return review;
  review = { key, wrong: new Set(), skip: new Set(), typed: {} };
  try { const o = JSON.parse(sessionStorage.getItem("nhLive_review") || "null"); if (o && o.key === key) review = { key, wrong: new Set(o.wrong || []), skip: new Set(o.skip || []), typed: o.typed || {} }; } catch {}
  return review;
}
function noteReview(kind, i, typedText) {   // typedText (Spelling) stays on this device only
  if (!room || !raceData) return;
  const rv = reviewState(); rv[kind].add(i);
  if (typedText != null) { const t0 = String(typedText).trim().slice(0, 40), list = rv.typed[i] || (rv.typed[i] = []); if (t0 && !list.includes(t0) && list.length < 3) list.push(t0); }
  try { sessionStorage.setItem("nhLive_review", JSON.stringify({ key: rv.key, wrong: [...rv.wrong], skip: [...rv.skip], typed: rv.typed })); } catch {}
}

/* ---- sound / vibration (OFF until switched on; kept only in this browser) ---- */
const getPref = k => { try { return localStorage.getItem(k) === "1"; } catch { return false; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch {} };
let soundOn = getPref("nhLive_sound"), vibOn = getPref("nhLive_vibrate"), actx = null;
function prefButtons() { setT($("btn-sound"), soundOn ? "soundOn" : "soundOff"); setT($("btn-vib"), vibOn ? "vibOn" : "vibOff"); }
function tone(notes) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    let at = actx.currentTime;
    for (const [f, d, type] of notes) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type || "sine"; o.frequency.value = f; g.gain.value = 0.12;
      o.connect(g); g.connect(actx.destination); o.start(at); o.stop(at + d); at += d;
    }
  } catch {}
}
function fx(kind) {
  if (soundOn) tone(kind === "ok" ? [[660, 0.08], [880, 0.1]] : kind === "bad" ? [[200, 0.16, "square"]] : [[523, 0.12], [659, 0.12], [784, 0.12], [1047, 0.25]]);
  if (vibOn && navigator.vibrate) { try { navigator.vibrate(kind === "ok" ? 25 : kind === "bad" ? [60] : [100, 50, 100, 50, 200]); } catch {} }
}
$("btn-sound").onclick = () => { soundOn = !soundOn; setPref("nhLive_sound", soundOn); prefButtons(); if (soundOn) fx("ok"); };
$("btn-vib").onclick = () => { vibOn = !vibOn; setPref("nhLive_vibrate", vibOn); prefButtons(); if (vibOn) fx("ok"); };
$("btn-proj").onclick = () => { document.body.classList.toggle("projector"); if (room && entry && raceData) render(); };
prefButtons();

/* ---- the game for a racer: Japanese -> English, 4 choices ---- */
function startEngine() {
  if (!room || !raceData || !raceData.config || !raceWords || !entry || entry.status !== "racing") return;
  if (!raceData.roster || !raceData.roster[uid]) return;
  if (raceStartMs() - serverNow() > 0) return;
  const key = String(raceData.startAt) + ":" + raceData.config.fingerprint;
  if (eng && eng.key === key) return;
  const solved = new Set(solvedOf(uid));                               // resume after a reload / reconnect
  const order = V.shuffleSeeded([...Array(V.TOTAL).keys()], (raceData.config.seed ^ hash32(uid)) >>> 0);
  const c = raceData.config, units = Object.values(c.units).map(Number);
  eng = { key, mode: c.mode, order, queue: order.filter(i => !solved.has(i)), solved, pending: new Set(), chain: Promise.resolve(), lastWrite: 0, choices: {}, wrong: new Set(), locked: false, pool: V.buildPool(vocab, c.grade, units, c.mode).words, shown: "", checker: V.isTyping(c.mode) ? Sp.makeChecker(vocab) : null, inputFor: -1 };
  renderPlayMode(true, false);
}
function choicesFor(i) {   // 4 choices for question i, built by vocab.js for the race's mode (every racer uses the host's mode)
  if (eng.choices[i]) return eng.choices[i];
  return (eng.choices[i] = V.makeChoices(raceWords[i], eng.pool, eng.mode));
}
function renderPlayMode(racer, over) {
  const playing = racer && !!eng && !over && entry.status === "racing";
  const iFinished = racer && typeof progOf(uid).finishedAt === "number";
  $("play").hidden = !(playing && eng.queue.length > 0 && !iFinished);
  $("my-done").hidden = over || !(racer && (iFinished || (eng && eng.solved.size === V.TOTAL)));
  if (!$("my-done").hidden) setT($("my-done-text"), "finishedWait");
  if (!playing || $("play").hidden) return;
  // merge answers the server already has (another tab, a retry) into the local queue
  for (const i of solvedOf(uid)) if (!eng.solved.has(i)) { eng.solved.add(i); eng.queue = eng.queue.filter(x => x !== i); }
  if (!eng.queue.length) return;
  const i = eng.queue[0], shownKey = i + "|" + [...eng.wrong].join(",") + "|" + eng.locked + "|" + eng.solved.size;
  if (eng.shown === shownKey) return; eng.shown = shownKey;
  setT($("q-label"), "question", { n: eng.solved.size + 1, s: eng.solved.size });
  $("q-word").textContent = V.promptOf(raceWords[i], eng.mode);
  $("q-word").className = "qword" + (V.promptOf(raceWords[i], eng.mode).length > 16 ? " long" : "");
  const typing = V.isTyping(eng.mode);
  setT($("q-ask"), typing ? "askType" : V.direction(eng.mode) === "en2jp" ? "askJa" : "whichWord");
  $("q-choices").hidden = typing; $("q-type").hidden = !typing;
  if (typing) {   // Spelling: letter-count blanks (no letters revealed) and a text box that keeps its focus
    $("q-blanks").textContent = Sp.blankPattern(raceWords[i].english);
    if (eng.inputFor !== i) { eng.inputFor = i; $("q-input").value = ""; $("q-input").focus(); }
  } else {
    const box = $("q-choices"); box.replaceChildren();
    choicesFor(i).forEach((ch, k) => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = ch.text;
      if (eng.wrong.has(k)) { b.className = "bad"; b.disabled = true; }
      if (eng.locked && ch.ok) b.className = "good";
      if (eng.locked) b.disabled = true;
      b.onclick = () => answer(i, k);
      box.append(b);
    });
  }
  $("q-skip").disabled = eng.locked || eng.queue.length < 2;
}
const clearMsg = () => { $("q-msg").textContent = ""; $("q-msg").removeAttribute("data-ja"); };
function correct(i) {   // a right answer (a tapped choice or a typed word): save it and move on
  eng.locked = true; setT($("q-msg"), "correct");
  eng.solved.add(i); eng.pending.add(i); persistSolved(i); fx(eng.solved.size >= V.TOTAL ? "done" : "ok");
  renderPlayMode(true, false);
  setTimeout(() => { if (!eng) return; eng.queue = eng.queue.filter(x => x !== i); eng.wrong = new Set(); eng.locked = false; clearMsg(); $("q-input").value = ""; eng.shown = ""; renderPlayMode(true, false); }, 600);
}
function answer(i, k) {
  if (!eng || eng.locked || eng.queue[0] !== i) return;
  if (choicesFor(i)[k].ok) correct(i);
  else { eng.wrong.add(k); noteReview("wrong", i); fx("bad"); setT($("q-msg"), "tryAgain"); eng.shown = ""; renderPlayMode(true, false); }
}
// Spelling: ENTER / the keyboard's Enter key. Case, spaces and punctuation do not matter (see spelling.js).
let composing = false;   // a Japanese keyboard is still converting text: Enter then only confirms the conversion
$("q-input").addEventListener("compositionstart", () => { composing = true; });
$("q-input").addEventListener("compositionend", () => { composing = false; });
$("q-input").placeholder = t("typeHere").en + " / " + t("typeHere").ja;
$("q-type").addEventListener("submit", ev => {
  ev.preventDefault();
  if (!eng || eng.locked || composing || !V.isTyping(eng.mode) || !eng.queue.length) return;
  const i = eng.queue[0], typed = $("q-input").value;
  if (!typed.trim()) return;
  if (eng.checker.isCorrect(typed, raceWords[i])) correct(i);
  else {
    noteReview("wrong", i, typed); fx("bad"); setT($("q-msg"), "tryAgain");
    const el = $("q-input"); el.className = "bad"; setTimeout(() => { el.className = ""; }, 400);
    if (el.select) el.select();   // the wrong text stays (easy to fix) and is selected (easy to replace)
  }
});
$("q-skip").onclick = () => {   // SKIP: the question goes to the back of my queue and still has to be answered
  if (!eng || eng.locked || eng.queue.length < 2) return;
  noteReview("skip", eng.queue[0]);
  eng.queue.push(eng.queue.shift()); eng.wrong = new Set(); clearMsg(); eng.shown = ""; renderPlayMode(true, false);
};
// Save one correct answer. One write at a time, spaced out (the rules enforce a pause), retried if it fails.
function persistSolved(i) {
  const e = eng, id = room.id;
  e.chain = e.chain.then(async () => {
    for (let t = 0; t < 8 && eng === e && room && room.id === id; t++) {
      const wait = 700 - (Date.now() - e.lastWrite); if (wait > 0) await sleep(wait);
      const w = { [`liveRooms/${id}/race/progress/${uid}/solved/${i}`]: serverTimestamp(), [`liveRooms/${id}/race/progress/${uid}/lastAt`]: serverTimestamp() };
      const done = [...e.solved].filter(x => !e.pending.has(x) || x === i).length;     // answers already saved + this one
      if (done >= V.TOTAL) w[`liveRooms/${id}/race/progress/${uid}/finishedAt`] = serverTimestamp();
      try { await update(ref(db), w); e.lastWrite = Date.now(); e.pending.delete(i); return; }
      catch (err) { e.lastWrite = Date.now(); if (!denied(err)) console.warn("save answer", err); await sleep(900); }
    }
  });
}
// If all 40 are saved but the finish stamp is missing (a retry gave up), add it.
setInterval(() => {
  if (!room || !eng || !raceData || !entry || entry.status !== "racing") return;
  const p = progOf(uid);
  if (solvedOf(uid).length >= V.TOTAL && typeof p.finishedAt !== "number")
    update(ref(db), { [`liveRooms/${room.id}/race/progress/${uid}/finishedAt`]: serverTimestamp() }).catch(() => {});
  for (const i of eng.solved) if (!(p.solved && p.solved[i] != null) && !eng.pending.has(i)) { eng.pending.add(i); persistSolved(i); }   // an answer that never reached the server
}, 4000);

/* ---- the race ends by itself, and the room goes back to the lobby ---- */
function maybeFinishRace(racer) {
  if (!racer || entry.status !== "racing" || typeof progOf(uid).finishedAt !== "number") return;
  for (const [, who] of Object.entries(seatsReal)) if (typeof progOf(who).finishedAt !== "number" && presence[who]) return;   // someone who is here is still racing
  if (Date.now() - finishTry < 3000) return; finishTry = Date.now();
  set(ref(db, `liveRoomList/${room.id}/status`), "finished").catch(() => {});   // the rules double-check this
}
function returnWrites(id) {   // race removed, room back to waiting, people who are not here are cleared (the old host too)
  let w = { [`liveRooms/${id}/race`]: null, [`liveRoomList/${id}/status`]: "waiting" };
  for (const who of Object.keys(members)) if (who !== uid && !presence[who]) w = { ...w, ...removeWrites(id, who) };
  return w;
}
// Host present: the host presses BACK TO LOBBY. Host away: the present members, in joining order, do it for them after a pause.
function maybeReturnToLobby(iAmHost, over) {
  const note = $("return-note");
  const hostHere = !!hostUid && !!presence[hostUid] && !!members[hostUid];
  if (!over || hostHere || !members[uid] || !presence[uid]) { clearTimeout(returnT); returnT = null; returnKey = ""; note.textContent = ""; note.removeAttribute("data-ja"); return; }
  const here = Object.entries(members).filter(([id]) => presence[id]).map(([id, m]) => ({ id, joinedAt: m.joinedAt || 0 })).sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
  const rank = Math.max(0, here.findIndex(p => p.id === uid)), delay = 15000 + rank * 4000;
  const key = room.id + ":" + raceData.startAt + ":" + rank;
  setT(note, "hostAway");
  if (returnKey === key) return; returnKey = key; clearTimeout(returnT);
  returnT = setTimeout(async () => {
    returnT = null;
    if (!room || !entry || entry.status !== "finished" || (presence[hostUid] && members[hostUid])) return;
    try { await update(ref(db), returnWrites(room.id)); } catch (e) { console.warn("return to lobby", e); returnKey = ""; }   // somebody else was first: fine
  }, delay);
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
    toast("hostSeatsFull");
  }
});

/* -------------------------------------------------------------------- leave */
function leaveLocal(msg) {
  detach(); room = null; members = {}; hostUid = null; seatsReal = {}; presence = {}; entry = null; setupData = null; raceData = null; starting = false; review = null; wasMember = false; closeModal(); document.body.classList.remove("projector");
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
  pwShown = !pwShown; $("created-pw").textContent = pwShown ? room.pw : "•".repeat(room.pw.length); setT($("btn-pw"), pwShown ? "hide" : "show");
};

init();
