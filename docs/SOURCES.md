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

|                       |                                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                 | Florida Department of Management Services, MyFloridaMarketPlace                                                                                                                                                                                                        |
| Access                | Public "State of Florida Advertisements" search at `vendor.myfloridamarketplace.com/search/bids`, no sign-in. Replaced the legacy Vendor Bid System on March 28, 2022 (the VBS now holds history only)                                                                 |
| Method                | The same public JSON endpoints the public pages call, verified without cookies on Oct 15, 2026: `POST /mfmp/pub/search/bids` (status OPEN/PREVIEW, 100 per page) and `GET /mfmp/pub/search/bids/detail?id=` for each biddable ad. Both need `Accept: application/json` |
| Observed              | Oct 15, 2026: 179 OPEN ads across 10 ad types; 134 biddable ads, each with UNSPSC commodity codes, description, contact and a document list                                                                                                                            |
| Fields used           | List: advertisementId, uniqueName, agencyAdNumber, type, title, dates, status, version, organization. Detail: commodityCodes (UNSPSC), description (HTML converted to text), responseContact, docs (attachmentId, original fileName, description, date)                |
| Documents             | Referenced, never downloaded by Radar: `/mfmp/bids/detail/attachment/download?attachmentId=` with the original file name kept                                                                                                                                          |
| Award detection       | Ads stay "OPEN" through their posting window even after an Intent to Award is posted (observed on 3 of 134 biddable ads on Oct 15). When the agency has posted such a document, Radar marks the record awarded so it leaves the bid lane                               |
| Before commercial use | (1) Read and record the MFMP terms; (2) ask DMS whether a data feed exists for aggregators; (3) run daily for two weeks and compare counts with the public page                                                                                                        |

## openfema

|        |                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------- |
| Owner  | FEMA                                                                                                     |
| Access | OpenFEMA API, `DisasterDeclarationsSummaries` v2, no key                                                 |
| Basis  | Official open-data API                                                                                   |
| Use    | Demand signal only: new declarations with Public Assistance predict recovery and consulting procurements |
