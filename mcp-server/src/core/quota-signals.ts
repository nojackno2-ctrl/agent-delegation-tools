/**
 * Quota/credit exhaustion signatures shared by the CLI invokers. Mirrors the
 * PowerShell wrappers' pattern; callers only apply it to non-zero exits so a
 * prompt or file that merely quotes these phrases cannot reclassify a success.
 * Covers typographic apostrophes ("You’ve hit your usage limit", Codex) and
 * "credits balance is too low" / RESOURCE_EXHAUSTED (Antigravity).
 */
const QUOTA_EXHAUSTED = new RegExp([
  String.raw`insufficient[_ -]?quota`,
  String.raw`quota\s+(?:has\s+been\s+)?(?:exceeded|exhausted|depleted|used\s+up)`,
  String.raw`usage\s+(?:limit|cap)\s+(?:has\s+been\s+)?(?:reached|exceeded|exhausted)`,
  String.raw`(?:daily|weekly|monthly)\s+(?:usage\s+)?limit\s+(?:reached|exceeded|exhausted)`,
  String.raw`you(?:['’]ve|\s+have)\s+(?:hit|reached|exceeded)\s+(?:your\s+)?(?:usage\s+)?limit`,
  String.raw`rate[_ -]?limit(?:ed|\s+(?:reached|exceeded))?`,
  String.raw`too\s+many\s+requests`,
  String.raw`resource[_ -]?exhausted`,
  String.raw`(?:out\s+of|insufficient)\s+credits?\b`,
  String.raw`no\s+credits?\s+(?:left|remaining)`,
  String.raw`credits?\s+(?:are\s+)?(?:exhausted|depleted)`,
  String.raw`credits?\s+balance\s+(?:is\s+)?(?:too\s+low|empty)`,
  String.raw`(?:http\s*)?\b429\b`,
].join('|'), 'i');

export function isQuotaExhausted(text: string): boolean {
  return QUOTA_EXHAUSTED.test(text);
}
