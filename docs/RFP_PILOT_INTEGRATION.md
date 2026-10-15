# RFP Pilot integration

Three integration paths, all backed by the same API. They can ship in any order.

## 1. Backend to backend (recommended first)

RFP Pilot's server holds each customer's Radar API key and calls:

| Need                          | Call                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| Show matches in RFP Pilot     | `GET /v1/profiles/{profileId}/matches?band=strong,possible`          |
| Record a pursue/pass decision | `POST /v1/profiles/{profileId}/decisions`                            |
| Second-look queue             | `GET /v1/profiles/{profileId}/second-look`                           |
| Open a solicitation workspace | `GET /v1/profiles/{profileId}/opportunities/{opportunityId}/handoff` |

Full schema: `GET /openapi.json`.

### Handoff payload (v1.0)

```json
{
  "handoffVersion": "1.0",
  "radarOpportunityId": "fl-mfmp:16313",
  "tenantId": "isf",
  "solicitation": {
    "title": "…",
    "solicitationNumber": "…",
    "buyerName": "…",
    "buyerLevel": "state",
    "state": "FL",
    "noticeType": "Request for Proposals",
    "postedAt": "…",
    "dueAt": "…",
    "dueTimezone": "America/New_York",
    "codes": [{ "system": "UNSPSC", "code": "…", "description": "…" }],
    "setAside": null,
    "contact": null,
    "sourceUrl": "https://vendor.myfloridamarketplace.com/search/bids/detail/16313"
  },
  "documents": [{ "originalFilename": "…", "url": "…", "description": null }],
  "fit": {
    "score": 61,
    "band": "strong",
    "reasons": ["+35 Classification matches profile: …"],
    "scorerVersion": "2026.10.1"
  },
  "provenance": { "source": "fl-mfmp", "fetchedAt": "…", "contentHash": "…" }
}
```

RFP Pilot should: create the solicitation from `solicitation`; fetch each document from its public URL and keep
`originalFilename` exactly (base solicitation and addenda stay separate files); store `radarOpportunityId` so
later addenda detected by Radar (content hash changes) can be pushed to the same workspace.

Compatibility: fields are only added within 1.x. A breaking change becomes 2.0 and both versions are served
during a transition period.

## 2. Embedded view

```html
<script type="module" src="/static/radar-embed.js"></script>
<rfp-radar-matches endpoint="/api/radar/profiles/isf-main/matches"></rfp-radar-matches>
<script>
  document.addEventListener("radar-handoff", (e) => openWorkspaceFromRadar(e.detail.opportunityId));
</script>
```

`endpoint` is a route on RFP Pilot that proxies to Radar with the tenant's key. The browser never sees a key.
Styling follows CSS custom properties (`--radar-accent`, `--radar-line`, …).

## 3. MCP (customer's own Claude)

```json
{
  "mcpServers": {
    "rfp-pilot-radar": {
      "command": "npx",
      "args": ["-y", "@rfppilot/radar-mcp"],
      "env": {
        "RADAR_API_URL": "https://radar.rfppilot.com",
        "RADAR_API_KEY": "<tenant key>",
        "RADAR_PROFILE_ID": "isf-main"
      }
    }
  }
}
```

Tools: `list_matches`, `get_opportunity`, `record_decision`, `second_look`, `get_digest`, `get_rfp_pilot_handoff`.
A natural next step is a combined RFP Pilot MCP that exposes these alongside the existing solicitation tools.
(Package name above is a placeholder until it is published.)
