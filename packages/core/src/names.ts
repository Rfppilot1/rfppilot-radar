/** Acronyms kept upper-case when an all-caps agency name is put into title case. */
const ACRONYMS = new Set([
  "US",
  "USA",
  "DOD",
  "DHS",
  "DOE",
  "DOI",
  "DOJ",
  "DOL",
  "DOS",
  "DOT",
  "HHS",
  "HUD",
  "VA",
  "GSA",
  "SBA",
  "EPA",
  "NASA",
  "NOAA",
  "NIH",
  "CDC",
  "FDA",
  "FEMA",
  "IRS",
  "SSA",
  "USDA",
  "USACE",
  "USCG",
  "USMC",
  "USSOCOM",
  "DLA",
  "DISA",
  "NAVSEA",
  "NAVAIR",
  "NAVFAC",
  "NAVSUP",
  "AFB",
  "AFMC",
  "ACC",
  "MICC",
  "NSF",
  "OPM",
  "FBI",
  "DEA",
  "ATF",
  "ICE",
  "CBP",
  "TSA",
  "FAA",
  "FHWA",
  "NPS",
  "BLM",
  "BOP",
  "NGA",
  "NRO",
  "DTRA",
  "DARPA",
  "SPAWAR",
  "TRANSCOM",
]);
const SMALL = new Set(["of", "the", "and", "for", "on", "in", "at", "to", "a", "an", "by"]);

/**
 * Agency names for display. Federal feeds write them in capitals and repeat the parent as the office
 * ("NATIONAL AERONAUTICS AND SPACE ADMINISTRATION / NATIONAL AERONAUTICS AND SPACE ADMINISTRATION"). Names that
 * already use lower case are returned unchanged; repeated path segments are dropped.
 */
export function displayAgency(name: string): string {
  const parts = name
    .split(" / ")
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p, i, all) => all.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
  return parts.map(titleIfShouting).join(" / ");
}

function titleIfShouting(s: string): string {
  if (/[a-z]/.test(s)) return s;
  let inParens = false;
  return s
    .split(/(\s+)/)
    .map((tok, i) => {
      if (/^\s+$/.test(tok)) return tok;
      const opens = tok.startsWith("(");
      if (opens) inParens = true;
      const keep = inParens || ACRONYMS.has(tok.replace(/[^A-Z0-9]/g, "")) || /\d/.test(tok);
      if (tok.endsWith(")")) inParens = false;
      if (keep) return tok;
      const lower = tok.toLowerCase();
      if (i > 0 && SMALL.has(lower)) return lower;
      return lower.replace(/(^|[-/&])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
    })
    .join("");
}
