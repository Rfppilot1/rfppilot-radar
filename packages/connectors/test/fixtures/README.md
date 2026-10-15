# Test fixtures

- `*.verbatim.json` are records copied exactly as each public source returned them, with the capture date in the
  filename. They pin the parsers to real payloads.
- `*.synthetic.json` are hand-written records that follow the source's documented or observed schema. They cover
  edge cases (ITN/RFP types, addenda, missing fields) and are not real postings.

When a source changes shape, capture a fresh page from the public site, save it as a new dated verbatim file, and keep the old one until the parser handles both.
