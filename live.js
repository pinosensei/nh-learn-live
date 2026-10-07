// Learn Live With Friends - Phase 1 prototype (standalone).
// Does NOT read or write the NH Interactive localStorage data.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, setPersistence, browserSessionPersistence, onAuthStateChanged, signInAnonymously }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getDatabase, ref, set, get, remove, onValue, onDisconnect, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

/* ===================== PASTE YOUR FIREBASE CONFIG BELOW ===================== */
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
/* ============================================================================ */

const $ = id => document.getElementById(id);
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 characters, no 0 O 1 I L
const MAX = 6;
let db, uid = null, room = null, players = {}, hostUid = null;
let unsubs = [], promoTimer = null, recovering = false, busy = false;
let online = false, wasOnline = null, rc = 0, pwShown = false, toastT;
setInterval(() => { rc = 0; }, 15000);

const denied = e => e && (e.code === "PERMISSION_DENIED" || /permission_denied/i.test(e.message || ""));
const show = id => document.querySelectorAll(".screen").forEach(s => { s.hidden = s.id !== id; });
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 7000);
}
async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function genCode() { // unbiased random 6 characters (248 = 31 * 8)
  let s = ""; const buf = new Uint8Array(32);
  while (s.length < 6) { crypto.getRandomValues(buf); for (const b of buf) if (b < 248 && s.length < 6) s += ALPHA[b % 31]; }
  return s;
}
const seatRef = () => ref(db, `rooms/${room.code}/players/${room.seat}`);

async function init() {
  if (!firebaseConfig.apiKey || !firebaseConfig.databaseURL) {
    toast("Setup needed: paste your firebaseConfig (with databaseURL) into live.js."); return;
  }
  try {
    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    await setPersistence(auth, browserSessionPersistence); // per-tab identity, no localStorage
    await new Promise(r => { const off = onAuthStateChanged(auth, () => { off(); r(); }); });
    if (!auth.currentUser) await signInAnonymously(auth);
    uid = auth.currentUser.uid;
    db = getDatabase(app);
    onValue(ref(db, ".info/connected"), s => {
      online = s.val() === true;
      if (online && wasOnline === false && room) recover();
      wasOnline = online;
    });
    $("btn-create").disabled = $("btn-join").disabled = false;
  } catch (e) {
    console.error(e); toast("Couldn't connect to Firebase. Please check the setup and try again.");
  }
}

async function work(fn) {
  if (busy) return;
  if (!online) { toast("Not connected yet. Please wait a moment and try again."); return; }
  busy = true; document.querySelectorAll(".big").forEach(b => { b.disabled = true; });
  try { await fn(); } catch (e) { console.error(e); toast("Something went wrong. Please try again."); }
  finally { busy = false; document.querySelectorAll(".big").forEach(b => { b.disabled = false; }); }
}

// Take a seat p1..p6. Returns the seat key, or null if no seat could be taken.
// The rules only let MEMBERS read /players, so a newcomer must not read first.
// 1) Try each seat in order. The rules accept a write only if the seat is free, the proof
//    matches the room's password hash, the room exists, and our UID holds no other seat.
// 2) If all six are refused, the cause is either a wrong password / missing room / full room,
//    OR we already hold a seat (same UID, e.g. a quick reconnect or a duplicated tab).
//    Only then do we try reading /players: that read succeeds only for a member, so it
//    lets us resume our own seat. For a non-member it is denied and we return null.
async function takeSeat(code, hash, nick) {
  for (let n = 1; n <= MAX; n++) {
    const seat = "p" + n;
    try {
      await set(ref(db, `rooms/${code}/players/${seat}`), { uid, nickname: nick, joinedAt: serverTimestamp(), proof: hash });
      return seat;
    } catch (e) { if (!denied(e)) throw e; }
  }
  try {
    const snap = await get(ref(db, `rooms/${code}/players`));
    for (const [k, v] of Object.entries(snap.val() || {})) if (v.uid === uid) return k;
  } catch (e) { if (!denied(e)) throw e; }
  return null;
}

$("form-create").addEventListener("submit", ev => { ev.preventDefault(); work(async () => {
  const nick = $("c-nick").value.trim(), pw = $("c-pw").value;
  if (!nick || nick.length > 20) return toast("Please enter a nickname (1–20 characters).");
  if (pw.length < 6 || pw.length > 20) return toast("The password must be 6–20 characters.");
  for (let i = 0; i < 8; i++) { // a taken code is refused by the rules, so just try another
    const code = genCode(), hash = await sha256(code + ":" + pw);
    try {
      await set(ref(db, `rooms/${code}`), {
        hostUid: uid, createdAt: serverTimestamp(), status: "waiting",
        secret: { passwordHash: hash },
        players: { p1: { uid, nickname: nick, joinedAt: serverTimestamp(), proof: hash } }
      });
      return enter({ code, hash, seat: "p1", nick, pw });
    } catch (e) { if (!denied(e)) throw e; }
  }
  toast("Couldn't create a room. Please try again in a moment.");
}); });

$("form-join").addEventListener("submit", ev => { ev.preventDefault(); work(async () => {
  const nick = $("j-nick").value.trim(), pw = $("j-pw").value;
  const code = $("j-code").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!nick || nick.length > 20) return toast("Please enter a nickname (1–20 characters).");
  if (!/^[A-HJKMNP-Z2-9]{6}$/.test(code)) return toast("The room code has 6 letters or numbers.");
  if (pw.length < 6 || pw.length > 20) return toast("The password must be 6–20 characters.");
  const hash = await sha256(code + ":" + pw);
  const seat = await takeSeat(code, hash, nick);
  if (!seat) return toast("Couldn't join. Check the room code and password, or the room may be full.");
  enter({ code, hash, seat, nick });
}); });

function enter(r) {
  room = r; players = {}; hostUid = null; pwShown = false;
  $("c-pw").value = $("j-pw").value = "";
  $("created").hidden = !r.pw;
  $("created-pw").textContent = "•".repeat(r.pw ? r.pw.length : 0);
  $("btn-pw").textContent = "Show";
  $("room-code").replaceChildren(...[...r.code].map(c => { const s = document.createElement("span"); s.textContent = c; return s; }));
  presence(); attach(); show("lobby");
}

function presence() { onDisconnect(seatRef()).remove().catch(console.error); }

function attach() {
  const b = `rooms/${room.code}/`;
  unsubs = [
    onValue(ref(db, b + "players"), s => { players = s.val() || {}; render(); }, listenErr),
    onValue(ref(db, b + "hostUid"), s => { hostUid = s.val(); render(); }, listenErr)
  ];
}
function detach() { unsubs.forEach(u => u()); unsubs = []; clearTimeout(promoTimer); }
function listenErr() { if (room) recover(); }

async function recover() { // after a dropped connection our seat may be gone: take it again
  if (!room || recovering) return;
  if (++rc > 4) return leaveLocal("Lost connection to the room.");
  recovering = true; detach();
  try {
    const seat = await takeSeat(room.code, room.hash, room.nick);
    if (!seat) return leaveLocal("The room is no longer available.");
    room.seat = seat; presence(); attach();
  } catch (e) { console.error(e); leaveLocal("Lost connection to the room."); }
  finally { recovering = false; }
}

function render() {
  if (!room) return;
  const list = Object.values(players).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  const ul = $("players"); ul.replaceChildren();
  for (const p of list) {
    const host = p.uid === hostUid, li = document.createElement("li");
    if (host) li.className = "host";
    const name = document.createElement("span");
    name.textContent = (host ? "👑 " : "🟢 ") + p.nickname + (p.uid === uid ? " (you)" : "");
    const tag = document.createElement("span");
    tag.className = "tag" + (host ? " tag-host" : ""); tag.textContent = host ? "HOST" : "PLAYER";
    li.append(name, tag); ul.append(li);
  }
  $("count").textContent = `${list.length}/${MAX}`;
  $("wait").textContent = list.length < MAX ? "Waiting for players..." : "The room is full!";
  // Host promotion: if the host has no seat, the longest-present player claims host
  // (others wait a little longer, in case the first one fails). Rules allow only one winner.
  clearTimeout(promoTimer);
  const me = list.findIndex(p => p.uid === uid);
  if (hostUid && me >= 0 && !list.some(p => p.uid === hostUid)) {
    promoTimer = setTimeout(() => {
      if (room) set(ref(db, `rooms/${room.code}/hostUid`), uid).catch(() => {});
    }, 3000 + me * 2000);
  }
}

function leaveLocal(msg) {
  detach(); room = null; players = {}; hostUid = null; show("home");
  if (msg) toast(msg);
}
async function leave() {
  if (!room) return;
  const sref = seatRef(), code = room.code;
  leaveLocal();
  // Count the players while we still hold a seat (only members may read /players).
  let alone = false;
  try {
    const snap = await get(ref(db, `rooms/${code}/players`));
    alone = Object.keys(snap.val() || {}).length <= 1;
  } catch (e) { console.error(e); }
  try { await remove(sref); } catch (e) { console.error(e); return; } // onDisconnect stays as a fallback
  onDisconnect(sref).cancel().catch(() => {}); // our seat could be reused by someone else later
  if (alone) { // the rules allow deleting a room only when it has no players left
    try { await remove(ref(db, `rooms/${code}`)); } catch (e) { console.error(e); }
  }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied! ✅"); }
  catch { toast("Couldn't copy automatically. Please copy it by hand."); }
}

$("btn-create").onclick = () => show("create");
$("btn-join").onclick = () => show("join");
document.querySelectorAll("[data-back]").forEach(b => { b.onclick = () => show("home"); });
$("btn-leave").onclick = leave;
$("btn-copy").onclick = () => room && copy(room.code);
$("btn-pw").onclick = () => {
  if (!room || !room.pw) return;
  pwShown = !pwShown;
  $("created-pw").textContent = pwShown ? room.pw : "•".repeat(room.pw.length);
  $("btn-pw").textContent = pwShown ? "Hide" : "Show";
};

init();
