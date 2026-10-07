// ============================================================================
//  NICKNAME / ROOM-NAME BLOCKLIST  -  edit this file on GitHub to add or remove words.
//  Keep the quotes and the commas. Lower-case is fine for English. Save (Commit) and reload the page.
//
//  Four lists, from "strict" to "careful":
//   ANYWHERE_*  the word is blocked if it appears ANYWHERE in the name (use only for long, unmistakable words:
//               short words would hit innocent names such as "Hashitani").
//   WORD_*      blocked only when it is a WHOLE separate word (English: between spaces/hyphens) or the WHOLE name (Japanese).
//   ALLOWED     exceptions: a name written exactly like this is always allowed (use it if a real name is blocked by mistake).
// ============================================================================

export const ANYWHERE_EN = ["fuck", "nigger", "faggot"];

export const ANYWHERE_JA = [
  "死ね", "氏ね", "殺す", "ちんこ", "ちんぽ", "まんこ", "チンコ", "チンポ", "マンコ", "ウンコ", "きもい", "キモい", "うざい", "消えろ"
];

export const WORD_EN = [
  "shit", "bitch", "bastard", "asshole", "ass", "dick", "cock", "cunt", "pussy", "slut", "whore", "penis", "vagina",
  "anal", "anus", "porn", "sex", "nude", "rape", "retard", "fag", "nigga", "nazi", "hitler", "kkk"
];

export const WORD_JA = ["しね", "うんこ", "えろ", "エロ", "えっち", "おっぱい", "ばいたい", "ブス", "セックス"];

export const ALLOWED = [];   // e.g. ["some real name"]
