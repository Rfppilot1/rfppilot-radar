# Sources and collection basis

Every opportunity Radar stores carries `provenance.basis`, a key into this file. A source is only enabled in
production once its entry is complete and its "before commercial use" items are closed. Radar never signs in,
never creates accounts, never bypasses a login or CAPTCHA, and never downloads buyer files on a customer's behalf
without the customer's action.

Common rules for all sources:

- Identify ourselves: `User-Agent: RFPPilotRadar/<version> (+https://rfppilot.com; contact email)`.
- Pace requests (minimum 1–1.5 s between requests per host) and cap each run.
- Retry only on 429/5xx, with backoff that honors `Retry-After`.
- Keep the public URL of every record so a human can verify it.
- Store buyer documents by reference (original URL and original filename). Never merge, rename or convert them.

---

## sam-gov

|                       |                                                                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                 | U.S. General Services Administration                                                                                                                                                                                       |
| Access                | Official public API, Get Opportunities v2 (`api.sam.gov/opportunities/v2/search`)                                                                                                                                          |
| Auth                  | Free public API key from a SAM.gov account (Account Details → Public API Key)                                                                                                                                              |
| Basis                 | Documented public API intended for programmatic use                                                                                                                                                                        |
| Limits                | Posted-date range ≤ 1 year per query; `limit` ≤ 1000; daily request quota depends on the key's role                                                                                                                        |
| Fields used           | noticeId, title, solicitationNumber, fullParentPathName, postedDate, type, typeOfSetAside(Description), responseDeadLine, naicsCode, classificationCode, active, uiLink, resourceLinks, pointOfContact, placeOfPerformance |
| Not yet used          | `description` is a link that needs the key appended; fetch on demand for shortlisted items only                                                                                                                            |
| Before commercial use | Confirm the daily quota for our key role; register a system account if volume requires it                                                                                                                                  |

## tx-esbd

|                       |                                                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner                 | Texas Comptroller of Public Accounts, Statewide Procurement Division                                                                                                                                                                             |
| Access                | Public search at `txsmartbuy.gov/esbd`; the page states "Sign in is NOT required" and offers CSV export                                                                                                                                          |
| Method                | The same JSON service the public page calls (`ESBD.Service.ss`, POST, 24 records per page), filtered to status "Posted"                                                                                                                          |
| Observed              | Oct 15, 2026: 473 open solicitations across state agencies, cities, ISDs and other members                                                                                                                                                       |
| Fields used           | internalid, title, solicitationId, responseDue/Time (Central time), agencyNumber/Name, status, postingDate, nigpCodes                                                                                                                            |
| Not yet used          | Detail page (description, contact, attachment list) for shortlisted items                                                                                                                                                                        |
| Before commercial use | (1) Read and record the TxSmartBuy site terms; (2) ask the Comptroller's SPD whether a bulk feed or preferred method exists for commercial aggregators; (3) if they prefer it, switch to the CSV export. Until then, run at most daily and paced |

## fl-mfmp

|                       |                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner                 | Florida Department of Management Services, MyFloridaMarketPlace                                                                                                                                                          |
| Access                | Public "State of Florida Advertisements" search at `vendor.myfloridamarketplace.com/search/bids`, no sign-in. Replaced the legacy Vendor Bid System on March 28, 2022 (the VBS now holds history only)                   |
| Method                | Headless browser loads the public page, runs one search, then repeats the page's own search request with status OPEN/PREVIEW and 100 per page, paced                                                                     |
| Observed              | Oct 15, 2026: 178 OPEN ads across 10 ad types, including Agency Decisions (intended awards, bid tabulations)                                                                                                             |
| Fields used           | advertisementId, uniqueName, agencyAdNumber, type, title, open/close/publish dates, status, version, organization                                                                                                        |
| Gaps                  | The list view has no commodity codes or descriptions. Scoring is title-only until detail enrichment (UNSPSC codes and text from the advertisement page) is added for candidates. The Claude reviewer partly offsets this |
| Before commercial use | (1) Read and record the MFMP terms; (2) ask DMS whether a data feed exists for aggregators; (3) run the headless transport unattended for two weeks and compare counts with the public page                              |

## openfema

|        |                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------- |
| Owner  | FEMA                                                                                                     |
| Access | OpenFEMA API, `DisasterDeclarationsSummaries` v2, no key                                                 |
| Basis  | Official open-data API                                                                                   |
| Use    | Demand signal only: new declarations with Public Assistance predict recovery and consulting procurements |
