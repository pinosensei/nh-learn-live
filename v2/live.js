// Learn Live With Friends - v2, PHASE A (UNTESTED).
// Room Browser, Create Room, Join (public/password), 35 racer seats, Lobby, Leave,
// host transfer, presence and cleanup. NO race yet.
// Uses ONLY the new database nodes liveRoomList / liveRooms. The old "rooms" node is never touched.
// Does NOT read or write any NH Interactive data. Only localStorage key used: nhLive_nickname.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, setPersistence, browserSessionPersistence, onAuthStateChanged, signInAnonymously }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getDatabase, ref, get, set, update, onValue, onDisconnect, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

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
const HIDE_AFTER = 2 * 60 * 1000;       // browser hides rooms silent for 2 minutes
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0 O 1 I L
const tabId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/-/g, "").slice(0, 12);

let db, uid = null, online = false, wasOnline = null, serverOffset = 0, busy = false, toastT;
let listing = {}, unsubBrowser = null;
let room = null;                        // { id, seat|null, nick, name, pw|null }
let members = {}, hostUid = null, seatsReal = {}, presence = {}, entry = null;
let unsubs = [], promoTimer = null, hbTimer = null, recovering = false, rc = 0, pwShown = false, pending = null;
const sweepTried = new Set();
let hostNameTry = 0;
setInterval(() => { rc = 0; }, 20000);

const denied = e => e && (e.code === "PERMISSION_DENIED" || /permission_denied/i.test(e.message || ""));
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
  } catch (e) { console.error(e); toast("Couldn't connect to Firebase. Please check the setup and try again."); }
}
async function work(fn) {
  if (busy) return;
  if (!online) { toast("Not connected yet. Please wait a moment and try again."); return; }
  busy = true; document.querySelectorAll(".big").forEach(b => { b.disabled = true; });
  try { await fn(); } catch (e) { console.error(e); toast("Something went wrong. Please try again."); }
  finally { busy = false; document.querySelectorAll(".big").forEach(b => { b.disabled = false; }); }
}

/* ------------------------------------------------------------ room browser */
function startBrowser() {
  if (unsubBrowser) unsubBrowser();
  unsubBrowser = onValue(ref(db, "liveRoomList"), s => { listing = s.val() || {}; renderBrowser(); sweep(); },
    e => { console.error(e); toast("Couldn't load the room list."); });
}
const seatCount = e => Object.keys((e && e.seats) || {}).length;
function roomState(e) {
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
  if (e.status === "racing" || e.status === "finished") return toast("A race is already in progress. You can join the next one.");
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
async function arm(id, seat) {   // what the server should clean up if this connection drops
  const p = { [`liveRooms/${id}/members/${uid}`]: null, [`liveRooms/${id}/presence/${uid}`]: null };
  if (seat) { p[`liveRooms/${id}/seats/${seat}`] = null; p[`liveRoomList/${id}/seats/${seat}`] = null; }
  const od = onDisconnect(ref(db)); await od.cancel(); await od.update(p);
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
      await arm(id, m.seat || null);
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
    onValue(ref(db, `liveRoomList/${room.id}`), s => { entry = s.val(); render(); }, () => {})
  ];
}
function detach() { unsubs.forEach(u => u()); unsubs = []; clearTimeout(promoTimer); clearInterval(hbTimer); hbTimer = null; }
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
async function reconnected() { if (!room) return; try { await arm(room.id, room.seat); announce(); heartbeat(); } catch (e) { console.warn(e); } }

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
  $("lobby-status").textContent = entry ? ({ waiting: "Waiting for players", racing: "Race in progress", finished: "Race finished" }[entry.status] || "") : "";
  $("wait").textContent = racers < MAX ? "Waiting for players..." : "All 35 seats are taken!";
  const iAmHost = hostUid === uid && !!members[uid];
  $("host-tools").hidden = !iAmHost;
  $("btn-hostplays").textContent = "Host Join Race: " + (members[uid] && members[uid].seat && seatsReal[members[uid].seat] === uid ? "ON" : "OFF");
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
  detach(); room = null; members = {}; hostUid = null; seatsReal = {}; presence = {}; entry = null;
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
$("btn-pw").onclick = () => {
  if (!room || !room.pw) return;
  pwShown = !pwShown; $("created-pw").textContent = pwShown ? room.pw : "•".repeat(room.pw.length); $("btn-pw").textContent = pwShown ? "Hide" : "Show";
};

init();
