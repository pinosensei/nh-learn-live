// Nickname and room-name check (runs in the browser only). The words live in blocklist.js.
import { ANYWHERE_EN, ANYWHERE_JA, WORD_EN, WORD_JA, ALLOWED } from "./blocklist.js";

export const NICK_MAX = 20, ROOM_MAX = 30;
const KANA_KANJI = "\\u3041-\\u3096\\u30A1-\\u30FA\\u30FC\\u3005\\u30FB\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u{20000}-\\u{2A6DF}";
const NICK_RE = new RegExp(`^[A-Za-z0-9 '\\-${KANA_KANJI}]+$`, "u");
const ROOM_RE = new RegExp(`^[A-Za-z0-9 '\\-.,!?&()#+:~_${KANA_KANJI}]+$`, "u");
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t" };

const normalize = s => String(s ?? "").normalize("NFKC").replace(/[’‘`´]/g, "'").replace(/\s+/g, " ").trim();
const len = s => [...s].length;
const leet = s => (/[a-z]/.test(s) ? s.replace(/[013457]/g, c => LEET[c] || c) : s);
const collapse = (s, min) => s.replace(new RegExp(`(.)\\1{${min - 1},}`, "g"), "$1");   // "shiiit" -> "shit"
const variants = t => { const out = new Set(); for (const a of [t, leet(t)]) { out.add(a); out.add(collapse(a, 3)); out.add(collapse(a, 2)); } return out; };

// Words made of single letters ("s h i t") are glued together before checking.
function tokens(n) {
  const raw = n.toLowerCase().split(/[ \-']+/).filter(Boolean), out = []; let run = "";
  for (const t of raw) {
    if (len(t) === 1 && /[a-z0-9]/.test(t)) run += t; else { if (run) { out.push(run); run = ""; } out.push(t); }
  }
  if (run) out.push(run);
  return out;
}

export function containsBlocked(input) {
  const n = normalize(input), lower = n.toLowerCase();
  if (ALLOWED.map(a => normalize(a).toLowerCase()).includes(lower)) return false;
  // contact details / links
  const digitsOnly = lower.replace(/[ \-]/g, "");
  if (/@|https?:|www\./.test(lower) || /\.(com|net|org|jp|io|me|co|info|biz|tv|gg)\b/.test(lower) || /\d{7,}/.test(digitsOnly)) return true;
  // 1. strict words anywhere in the name
  const squashed = lower.replace(/[ \-'.]+/g, "");
  const latin = new Set([squashed, leet(squashed), collapse(squashed, 2), collapse(leet(squashed), 2)]);
  for (const w of ANYWHERE_EN) for (const v of latin) if (v.includes(w.toLowerCase())) return true;
  const ja = n.replace(/ /g, "");
  for (const w of ANYWHERE_JA) if (ja.includes(w)) return true;
  // 2. careful words: whole word only
  const wordsEn = new Set(WORD_EN.map(w => w.toLowerCase()));
  for (const t of tokens(n)) for (const v of variants(t)) if (wordsEn.has(v)) return true;
  const wordsJa = new Set(WORD_JA);
  if (wordsJa.has(ja) || n.split(" ").some(t => wordsJa.has(t))) return true;
  return false;
}

function check(input, re, max) {
  const n = normalize(input);
  if (!n) return { ok: false, reason: "empty" };
  if (len(n) > max) return { ok: false, reason: "long" };
  if (!re.test(n)) return { ok: false, reason: "chars" };
  if (containsBlocked(n)) return { ok: false, reason: "blocked" };
  return { ok: true, value: n };
}
export const checkNickname = s => check(s, NICK_RE, NICK_MAX);
export const checkRoomName = s => check(s, ROOM_RE, ROOM_MAX);
