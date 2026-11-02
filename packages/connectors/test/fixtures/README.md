# Test fixtures

- `*.verbatim.json` are records copied exactly as each public source returned them, with the capture date in the
  filename. They pin the parsers to real payloads.
- `*.subset.json` are fields copied verbatim from a live response, keeping only the fields the parser reads (the full
  response is too large to keep usefully). Values are unchanged.
- `*.excerpt.csv` are the header and the first rows of a live export, byte for byte (line endings and the source's
  unescaped quotes included). `fl-facts-contracts.2026-11-01.excerpt.csv` is the first 30 records of the Executive
  Office of the Governor's FACTS export.
- `*.synthetic.json` are hand-written records that follow the source's documented or observed schema. They cover
  edge cases (ITN/RFP types, addenda, missing fields) and are not real postings.

When a source changes shape, capture a fresh page from the public site, save it as a new dated verbatim file, and keep the old one until the parser handles both.
