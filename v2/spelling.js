// NH Learn Live - Spelling mode (Phase E2): decides whether what a student typed is a right answer.
// Pure functions: no DOM, no Firebase, no storage. Reads the vocabulary only.
// Question direction is always Japanese -> the student types the English.
import { EXTRA, NOT_EQUIVALENT } from "./spelling-exceptions.js";
import { isUsable } from "./vocab.js";

// ---- tidy-up: capitals, spaces, dots/commas/?/!, apostrophes (’ ' ‘), hyphens and full-width letters do not matter
const clean = s => String(s == null ? "" : s).normalize("NFKC").toLowerCase().replace(/[’‘`´ʼ]/g, "'").replace(/[‐-―−－]/g, "-");
export const norm = s => clean(s).replace(/'/g, "").replace(/[.?!;:"“”()]/g, "").replace(/[,-]/g, " ").replace(/\s+/g, " ").trim();

// "number(s)" -> number / numbers ; "stay (ed)" -> stay / stayed ; "on one's way (to)" -> ... / ... to
function expand(a) {
  const m = a.match(/\(([^)]*)\)/);
  if (!m) return [a];
  const pre = a.slice(0, m.index), post = a.slice(m.index + m[0].length), inner = m[1].trim(), head = pre.replace(/\s+$/, "");
  const out = [];
  for (const v of [head + post, head + inner + post, head + " " + inner + post]) out.push(...expand(v));
  return out;
}
const splitAlternatives = english => {
  let s = clean(english).trim().replace(/\s*\(\s*[⇐←=][^)]*\)/g, "");   // teacher notes such as "(← meet)" are not part of the answer
  if (/\s\/\s/.test(s)) return s.split(/\s+\/\s+/);                       // "accessory / accessories"
  if (s.includes(",") && !/,\s*[A-Z]/.test(String(english))) return s.split(/\s*,\s*/);   // "country, countries" (but not "Martin Luther King, Jr.")
  return [s];
};
// Every typed text (after norm) that counts as right for this English entry.
export function forms(english) {
  const out = new Set([norm(english)]), hyphen = /-/.test(clean(english));   // (the entry exactly as written in the vocabulary always counts)
  for (const alt of splitAlternatives(english)) for (const v of expand(alt)) {
    const k = norm(v); if (!k) continue;
    out.add(k); if (hyphen) out.add(k.replace(/ /g, ""));               // left-handed = left handed = lefthanded
  }
  return out;
}
// The shape shown to the student: letters as blanks, word gaps kept, apostrophes and hyphens shown. No letter is ever revealed.
export function blankPattern(english) {
  const first = expand(splitAlternatives(english)[0])[0] || "";
  return first.trim().split(/\s+/).map(tok => [...tok].filter(c => /[\p{L}\p{N}'-]/u.test(c)).map(c => (c === "'" || c === "-" ? c : "_")).join(" ")).filter(Boolean).join("  ");
}

// ---- meanings: which other words in the vocabulary mean the same as this one
const strip = s => s.replace(/[…~～〜・\s]/g, "");
function meaningItems(w) {
  return String(w.japanese || "").normalize("NFKC")
    .replace(/[（(][^）)]*[）)]/g, "").replace(/[\[［][^\]］]*[\]］]/g, "")        // notes in brackets are not meanings
    .split(/[、，,;；]/).map(x => x.replace(/[。\s]+$/, "").trim())
    .filter(x => { const t = strip(x); return t.length > 0 && !(t.length < 2 && !/[一-鿿]/.test(t)); });
}
const pairKey = (a, b) => { const x = norm(a), y = norm(b); return x < y ? x + "|" + y : y + "|" + x; };
const NOT_EQ = new Set(NOT_EQUIVALENT.map(([a, b]) => pairKey(a, b)));
const extraFor = new Map(Object.entries(EXTRA).map(([k, v]) => [norm(k), v]));

// checker(data) -> { accepted(word) -> Set, isCorrect(typed, word) }
export function makeChecker(data) {
  const byItem = new Map(), memo = new Map();
  for (const g of ["nh1", "nh2", "nh3"]) for (const U of Object.values(data[g].units)) for (const w of U.words) {
    if (!isUsable(w, "spelling")) continue;
    for (const it of meaningItems(w)) { if (!byItem.has(it)) byItem.set(it, []); byItem.get(it).push(w); }
  }
  function accepted(word) {
    if (memo.has(word.id)) return memo.get(word.id);
    const out = new Set(forms(word.english));
    for (const it of meaningItems(word)) for (const o of byItem.get(it) || []) {
      if (o.id === word.id || NOT_EQ.has(pairKey(word.english, o.english))) continue;
      for (const f of forms(o.english)) out.add(f);
    }
    for (const x of extraFor.get(norm(word.english)) || []) for (const f of forms(x)) out.add(f);
    memo.set(word.id, out); return out;
  }
  return { accepted, isCorrect: (typed, word) => { const k = norm(typed); return k !== "" && accepted(word).has(k); } };
}
