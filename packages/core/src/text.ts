/** Normalizes text for phrase matching: lowercase, ASCII-folded, punctuation to spaces, single-spaced. */
export function normalize(text: string): string {
  return ` ${text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

/**
 * True when `phrase` appears in `normalizedText` as whole words. A trailing "s" on the last word is
 * tolerated so "assessment" matches "assessments". `normalizedText` must come from `normalize()`.
 */
export function hasPhrase(normalizedText: string, phrase: string): boolean {
  const p = normalize(phrase).trim();
  if (!p) return false;
  return normalizedText.includes(` ${p} `) || normalizedText.includes(` ${p}s `);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000;
}
