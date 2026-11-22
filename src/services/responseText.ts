// Reads the full text of a Gemini answer.
//
// The Google SDK's `response.text()` helper returns only the first text part.
// The Gemini API sometimes splits one reply into several parts. The app then
// loses the description, the objects, and the hazards. This helper joins every
// part instead.

export type GeminiResponseLike = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string | null } | null>;
    };
  }>;
  text(): string;
};

/**
 * Returns the full text of the first candidate.
 *
 * The SDK helper still runs first, because it raises an error for a blocked
 * answer. The joined parts then replace its short result.
 */
export function readResponseText(response: GeminiResponseLike): string {
  // This throws for a blocked answer, so the caller still sees that error.
  const single = response.text();

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const joined = parts
    .map((part) => (part?.text ?? ""))
    .join("")
    .trim();

  return joined || single.trim();
}
