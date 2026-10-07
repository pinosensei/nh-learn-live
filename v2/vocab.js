// NH Learn Live - vocabulary pool for races (Phase B; English -> Japanese added in Phase E1; Spelling in Phase E2).
import { EXCLUDE } from "./spelling-exceptions.js";
// Pure functions: no DOM, no Firebase, no localStorage. Reads PORTAL_DATA only; never modifies it.
export const PORTAL_URL = "https://pinosensei.github.io/nh-interactive-dev/portal-data.js";
export const TOTAL = 40;        // questions per race
export const MAX_UNITS = 4;     // units a host may combine
export const SCHEMA_VERSION = 1;

// Game modes: exactly three for now (Japanese -> English, English -> Japanese, Spelling).
export const MODES = [
  { id: "jp2en-choice4", label: "Japanese → English (4 choices)", available: true },
  { id: "en2jp-choice4", label: "English → Japanese (4 choices)", available: true },
  { id: "spelling", label: "Spelling (typing)", available: true }
];
export const isTyping = modeId => modeId === "spelling";   // the student types the English instead of picking a choice
export const modeLabel = id => (MODES.find(m => m.id === id) || { label: id }).label;

/* ------------------------------------------------------------ loading */
export function parsePortalData(text) {
  const data = new Function(text + "\n;return PORTAL_DATA;")();   // the file is `const PORTAL_DATA = {...};`
  if (!data || typeof data !== "object") throw new Error("PORTAL_DATA missing");
  for (const g of ["nh1", "nh2", "nh3"]) if (!data[g] || !data[g].units) throw new Error("PORTAL_DATA has no " + g);
  return data;
}
export async function loadPortalData(url = PORTAL_URL, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, { cache: "no-cache" });
  if (!res.ok) throw new Error("portal-data.js: HTTP " + res.status);
  return parsePortalData(await res.text());
}

/* ------------------------------------------------------------ word rules */
const JP = /[぀-ヿ㐀-鿿]/;             // hiragana, katakana, kanji
const ARROW = /^\s*[⇐←→⇒]/;
const normEn = s => String(s || "").normalize("NFKC").trim().toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, " ");
const normJa = s => String(s || "").normalize("NFKC").trim();
export const sameEnglish = (a, b) => normEn(a.english) === normEn(b.english);
export const sameJapanese = (a, b) => normJa(a.japanese) === normJa(b.japanese);
const dupKey = w => normEn(w.english) + "|" + normJa(w.japanese);

// Which words a mode can use. jp2en needs a real Japanese meaning (not a note like "⇐ do not").
// en2jp uses the same rule, minus entries whose whole Japanese is only a bracketed grammar note
// (e.g. "was = ［am、isの過去形］"): fine as a hint in jp2en, but not a meaning to pick in a Japanese choice list.
const GRAMMAR_NOTE = /^\s*[\[［][^\]］]*[\]］]\s*$/;
// Spelling (Japanese question, the student types the English): same rule, minus fill-in-the-blank patterns that nobody can fairly type
// ("Call me …", "enjoy …ing", "… kind(s) of ~", "(Riko)’s", "(1970)s") and anything on the EXCLUDE list in spelling-exceptions.js.
const PLACEHOLDER = /[…~～〜]|\.\.\./;
const excluded = new Set(EXCLUDE.map(normEn));
const spellable = w => !PLACEHOLDER.test(w.english || "") && !/^\s*\(/.test(w.english || "") && !excluded.has(normEn(w.english));
const USABLE = {
  "jp2en-choice4": w => !!normEn(w.english) && JP.test(w.japanese || "") && !ARROW.test(w.japanese || ""),
  "spelling": w => !!normEn(w.english) && JP.test(w.japanese || "") && !ARROW.test(w.japanese || "") && spellable(w),
  "en2jp-choice4": w => !!normEn(w.english) && JP.test(w.japanese || "") && !ARROW.test(w.japanese || "") && !GRAMMAR_NOTE.test(w.japanese || "")
};
export const isUsable = (w, modeId) => (USABLE[modeId] || USABLE["jp2en-choice4"])(w);

/* ------------------------------------------------------------ question direction & choices */
export const direction = modeId => (modeId === "en2jp-choice4" ? "en2jp" : "jp2en");
export const promptOf = (w, modeId) => (direction(modeId) === "en2jp" ? w.english : w.japanese);   // what the student reads
export const answerOf = (w, modeId) => (direction(modeId) === "en2jp" ? w.japanese : w.english);   // what the student picks
const looseJa = s => normJa(s).replace(/\s+/g, "").replace(/[。．.]+$/, "");                          // "ありがとう。" == "ありがとう"
function shuffleWith(a, rand) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
// The 4 choices for one question: the right answer + 3 wrong ones from the same pool. Returns [{ text, ok }] in random order.
// A wrong choice never has the same English or Japanese as the target, and no two choices are the same text.
// jp2en: random wrong choices (unchanged since Phase C). en2jp: wrong Japanese choices of similar length, so a short answer is not a giveaway.
export function makeChoices(target, pool, modeId, rand = Math.random) {
  const dir = direction(modeId), opts = [];
  if (dir === "jp2en") {
    const seen = new Set([normEn(target.english)]);
    for (const w of shuffleWith(pool, rand)) {
      if (opts.length >= 3) break;
      if (sameEnglish(w, target) || sameJapanese(w, target) || seen.has(normEn(w.english))) continue;
      seen.add(normEn(w.english)); opts.push({ text: w.english, ok: false });
    }
    return shuffleWith([{ text: target.english, ok: true }, ...opts], rand);
  }
  const want = looseJa(target.japanese), len = want.length, seen = new Set([want]);
  const cands = shuffleWith(pool, rand).filter(w => !sameEnglish(w, target) && !sameJapanese(w, target) && looseJa(w.japanese) !== want);
  const near = cands.map((w, i) => ({ w, i, d: Math.abs(looseJa(w.japanese).length - len) })).sort((a, b) => a.d - b.d || a.i - b.i).slice(0, 14).map(x => x.w);
  for (const w of shuffleWith(near, rand)) {
    if (opts.length >= 3) break;
    const k = looseJa(w.japanese); if (seen.has(k)) continue;
    seen.add(k); opts.push({ text: w.japanese, ok: false });
  }
  for (const w of cands) { if (opts.length >= 3) break; const k = looseJa(w.japanese); if (seen.has(k)) continue; seen.add(k); opts.push({ text: w.japanese, ok: false }); }   // (only if the 14 nearest were not enough)
  return shuffleWith([{ text: target.japanese, ok: true }, ...opts], rand);
}

/* ------------------------------------------------------------ pools */
export function gradeList(data) {
  return ["nh1", "nh2", "nh3"].map(id => ({ id, title: data[id].title, label: data[id].label }));
}
export function unitList(data, gradeId, modeId) {
  return Object.keys(data[gradeId].units).sort((a, b) => a - b).map(n => {
    const U = data[gradeId].units[n];
    return { number: Number(n), title: U.title, subtitle: U.subtitle || "", count: buildPool(data, gradeId, [Number(n)], modeId).words.length };
  });
}
// Distinct, usable words of the chosen units (no duplicates between units).
export function buildPool(data, gradeId, unitNumbers, modeId) {
  const out = [], seen = new Set(); let unusable = 0, duplicates = 0;
  for (const n of unitNumbers) {
    const U = data[gradeId] && data[gradeId].units[String(n)]; if (!U) continue;
    for (const w of U.words) {
      if (!isUsable(w, modeId)) { unusable++; continue; }
      const k = dupKey(w); if (seen.has(k)) { duplicates++; continue; }
      seen.add(k); out.push({ id: w.id, english: w.english, japanese: w.japanese, unit: Number(n) });
    }
  }
  return { words: out, unusable, duplicates };
}

/* ------------------------------------------------------------ seeded random */
export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function shuffleSeeded(arr, seed) { const a = arr.slice(), r = rng(seed); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
export function randomSeed() { const b = new Uint32Array(1); globalThis.crypto.getRandomValues(b); return b[0]; }

// The 40 targets: a seeded shuffle of the whole pool, so the units are mixed together.
export function pickTargets(words, seed, total = TOTAL) {
  if (words.length < total) throw new Error("not enough words");
  return shuffleSeeded(words, seed).slice(0, total);
}

/* ------------------------------------------------------------ fingerprint & verification */
export async function fingerprint(words) {
  const text = words.map(w => `${w.id}|${normEn(w.english)}|${normJa(w.japanese)}`).join("\n");
  const b = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
export function wordIndex(data) {
  const m = new Map();
  for (const g of ["nh1", "nh2", "nh3"]) for (const [n, U] of Object.entries(data[g].units)) for (const w of U.words) m.set(w.id, { id: w.id, english: w.english, japanese: w.japanese, unit: Number(n) });
  return m;
}
// Does MY copy of the vocabulary give exactly the host's 40 words? ("ok" | "missing" | "different")
export async function verifyConfig(data, config) {
  const idx = wordIndex(data), ids = Object.values(config.questionIds || {});
  if (ids.length !== TOTAL) return { status: "different", reason: "wrong number of questions" };
  const words = ids.map(id => idx.get(id));
  if (words.some(w => !w)) return { status: "missing", reason: "some words are not in your copy of the vocabulary" };
  return (await fingerprint(words)) === config.fingerprint ? { status: "ok", words } : { status: "different", reason: "the words differ from the host's" };
}
