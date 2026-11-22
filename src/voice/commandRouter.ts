// Routes a spoken utterance to a command or to a free-form question.
//
// A command must match the whole utterance. A near match only counts when the
// utterance is short, so a question never loses its turn to a command.

export type VoiceCommandId =
  | "start"
  | "stop"
  | "restart"
  | "scene"
  | "navigation"
  | "hazards"
  | "language";

type CommandSpec = {
  id: VoiceCommandId;
  phrases: string[];
};

export const VOICE_COMMANDS: CommandSpec[] = [
  {
    id: "start",
    phrases: [
      "start",
      "begin",
      "start app",
      "start the app",
      "शुरू करें",
      "തുടങ്ങുക",
    ],
  },
  {
    id: "stop",
    phrases: [
      "stop",
      "pause",
      "stop app",
      "stop the app",
      "रोकें",
      "നിർത്തുക",
    ],
  },
  {
    id: "restart",
    phrases: [
      "restart",
      "resume",
      "continue",
      "start again",
      "पुनः शुरू करें",
      "പുനരാരംഭിക്കുക",
      "തുടരുക",
    ],
  },
  {
    id: "navigation",
    phrases: [
      "switch to navigation",
      "navigation mode",
      "enable navigation",
      "start navigation",
      "begin navigation",
      "navigate",
      "help me navigate",
      "नेविगेशन",
      "नेविगेट",
      "നാവിഗേഷൻ",
      "നാവിഗേഷൻ മോഡ്",
    ],
  },
  {
    id: "scene",
    phrases: [
      "switch to scene",
      "scene mode",
      "scene description",
      "enable scene",
      "start scene",
      "describe scene",
      "describe what you see",
      "what do you see",
      "दृश्य विवरण",
      "दृश्य मोड",
      "ദൃശ്യ വിവരണം",
      "സീൻ മോഡ്",
    ],
  },
  {
    id: "hazards",
    phrases: [
      "hazards",
      "dangers",
      "what are the hazards",
      "any hazards",
      "any dangers",
      "are there any hazards",
      "is there danger",
      "खतरे",
      "कोई खतरा",
      "അപകടങ്ങൾ",
      "അപകട സാധ്യതകൾ",
    ],
  },
  {
    id: "language",
    phrases: [
      "switch language",
      "change language",
      "toggle language",
      "भाषा बदलें",
      "ഭാഷ മാറ്റുക",
    ],
  },
];

/** An utterance with more words than this is a question, never a command. */
const MAX_FUZZY_WORDS = 4;

/** Words that can follow a command without changing its meaning. */
const FILLER_WORDS = new Set([
  "please",
  "now",
  "app",
  "the app",
  "sight sound",
  "it",
]);

/** Lower case, drop the trailing punctuation and collapse the spaces. */
export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[.!?,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Checks whether the utterance is the command plus a short filler word. */
function matchesWithFiller(normalized: string, phrase: string): boolean {
  if (!normalized.startsWith(phrase + " ")) return false;
  return FILLER_WORDS.has(normalized.slice(phrase.length).trim());
}

/**
 * Checks whether the utterance is close enough to the phrase.
 *
 * A longer phrase can absorb more edits. A short phrase must also start with
 * the same letter, so "top" does not become "stop".
 */
function isNearMatch(utterance: string, phrase: string): boolean {
  if (phrase.length <= 3) return false;
  const maxDistance = phrase.length <= 7 ? 1 : 2;
  if (editDistance(utterance, phrase) > maxDistance) return false;
  if (phrase.length <= 7 && utterance[0] !== phrase[0]) return false;
  return true;
}

/**
 * The edit distance between two strings. A swapped pair of letters counts as
 * one edit, because speech recognition often swaps two letters.
 */
function editDistance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push(new Array<number>(b.length + 1).fill(0));
  }
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1, // delete
        rows[i][j - 1] + 1, // insert
        rows[i - 1][j - 1] + cost, // replace
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1); // swap
      }
    }
  }
  return rows[a.length][b.length];
}

/**
 * Returns the command for an utterance, or null when the user asked a question.
 */
export function matchVoiceCommand(text: string): VoiceCommandId | null {
  const normalized = normalizeUtterance(text);
  if (!normalized) return null;

  // An exact match always wins.
  for (const spec of VOICE_COMMANDS) {
    for (const phrase of spec.phrases) {
      if (normalized === normalizeUtterance(phrase)) return spec.id;
    }
  }

  if (normalized.split(" ").length > MAX_FUZZY_WORDS) return null;

  // A command with a short filler word after it is still that command.
  for (const spec of VOICE_COMMANDS) {
    for (const phrase of spec.phrases) {
      if (matchesWithFiller(normalized, normalizeUtterance(phrase))) return spec.id;
    }
  }

  // Stop is the safety command. It must always stop the app.
  if (normalized.startsWith("stop ")) return "stop";

  // A near match only counts for a short utterance.
  let bestId: VoiceCommandId | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const spec of VOICE_COMMANDS) {
    for (const phrase of spec.phrases) {
      const target = normalizeUtterance(phrase);
      const distance = editDistance(normalized, target);
      if (distance < bestDistance && isNearMatch(normalized, target)) {
        bestId = spec.id;
        bestDistance = distance;
      }
    }
  }
  return bestId;
}
