// Spelling mode: the lists you can edit on GitHub. Nothing else needs to change.
// Words are written as they appear in the vocabulary (capitals, dots and apostrophes do not matter).
//
// EXCLUDE: words that must never be used as Spelling questions.
//   Example:  export const EXCLUDE = ["South Africa", "totem pole"];
// EXTRA: extra answers that should ALSO count as right for a word.
//   Example:  export const EXTRA = { "movie": ["film"], "TV": ["television"] };
// NOT_EQUIVALENT: pairs of words that share a Japanese meaning in the vocabulary but must NOT count for each other.
//   Example:  ["Mr.", "Ms."] means typing "Ms." for the Mr. question is wrong (and the other way round).
//
// (Words with fill-in-the-blank patterns like "Call me …" or "enjoy …ing" are left out of Spelling automatically.)

export const EXCLUDE = [];

export const EXTRA = {};

export const NOT_EQUIVALENT = [
  ["Mr.", "Ms."],                       // different people
  ["golden", "great"], ["golden", "wonderful"], ["golden", "fantastic"],
  ["there", "where"],
  ["age", "year(s)"],
  ["clean", "pretty"],
  ["follow", "protect"],
  ["up", "What’s up?"],
  ["forward", "look forward to"],
  ["already", "yet"],
  ["original", "own"],
  ["research", "survey"],
  ["want to", "would love to"],
  ["a lot of", "large"]
];
