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

|                       |                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                 | Texas Comptroller of Public Accounts, Statewide Procurement Division                                                                                                                                                                                                                                                                                                        |
| Access                | Public search at `txsmartbuy.gov/esbd`; the page states "Sign in is NOT required" and offers CSV export                                                                                                                                                                                                                                                                     |
| Method                | The same JSON services the public pages call: `ESBD.Service.ss` (POST, 24 records per page, status "Posted") for the list, and `ESBD.Details.Service.ss` (GET, the call the public `/esbd/<solicitation id>` page makes) for each posting's detail. Detail is fetched only for postings that are new or whose list entry changed; unchanged postings keep their stored copy |
| Observed              | Oct 15, 2026: 473 open solicitations across state agencies, cities, ISDs and other members                                                                                                                                                                                                                                                                                  |
| Fields used           | List: internalid, title, solicitationId, responseDue/Time (Central time), agencyNumber/Name, status, postingDate, nigpCodes. Detail (verified Oct 17, 2026): description, contact, attachments (original file names). Key dates (pre-bid, site visit, questions due, bid opening) are read from the description text                                                        |
| Not yet used          | The detail's addendum log text, awardee list and estimated value                                                                                                                                                                                                                                                                                                            |
| Before commercial use | (1) Read and record the TxSmartBuy site terms; (2) ask the Comptroller's SPD whether a bulk feed or preferred method exists for commercial aggregators; (3) if they prefer it, switch to the CSV export. Until then, run at most daily and paced                                                                                                                            |

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

## opengov

|                       |                                                                                                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                 | OpenGov, Inc. (OpenGov Procurement), on behalf of each government that publishes a public portal                                                                                                                                                                                                           |
| Access                | Public procurement portals at `procurement.opengov.com/portal/<code>`, no sign-in                                                                                                                                                                                                                          |
| Method                | The same public JSON API the portal pages call, verified without cookies on Oct 27, 2026: `GET api.procurement.opengov.com/api/v1/government` (every government on the platform, with state and portal code) and `POST /api/v1/government/<code>/project/public` with a status "open" filter, 100 per page |
| Observed              | Oct 27, 2026: 98 Florida governments (counties, cities, airports, utilities, school districts, CFX), 333 open projects; 45 Texas governments                                                                                                                                                               |
| Fields used           | id, title, financialId (the agency's solicitation number), summary (HTML converted to text), template title (notice type), department, releaseProjectDate, proposalDeadline (UTC), addendums (count), government code, organization name, state and timezone                                               |
| Not yet used          | Project documents, question deadlines and contacts on the project detail page; fetch on demand for shortlisted items                                                                                                                                                                                       |
| States                | `RADAR_OPENGOV_STATES` (default `FL`). Texas is off by default because many Texas local postings also reach ESBD, and Radar does not yet merge cross-source duplicates                                                                                                                                     |
| Before commercial use | (1) Read and record OpenGov's terms of use; (2) ask OpenGov whether a partner feed exists for aggregators; (3) keep the run daily and paced (about 100 portal requests at 1.5 s)                                                                                                                           |

## bonfire

|                       |                                                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                 | Euna Solutions (Bonfire), on behalf of each government that publishes a public portal                                                                                                              |
| Access                | Public portals at `<org>.bonfirehub.com/portal/?tab=openOpportunities`, no sign-in                                                                                                                 |
| Method                | The JSON call the open-opportunities tab makes, verified without cookies on Oct 27, 2026: `GET /PublicPortal/getOpenPublicOpportunitiesSectionData`. Only projects with public visibility are kept |
| Portals               | Bonfire has no public directory, so portals are listed by hand in `BONFIRE_PORTALS` (packages/connectors/src/bonfire.ts). Add one only after opening its public portal page                        |
| Observed              | Oct 27, 2026: Broward County 26 open, Hillsborough County 22 open                                                                                                                                  |
| Fields used           | ProjectID, ReferenceID (solicitation number), ProjectName, DateClose (UTC wall-clock time), department name, visibility and status                                                                 |
| Not yet used          | Descriptions and documents, which are on each project's public page                                                                                                                                |
| Before commercial use | (1) Read and record Bonfire's terms of use; (2) confirm the remaining Florida portals (Marion County, Lee County Schools and others) by hand                                                       |

## openfema

|        |                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------- |
| Owner  | FEMA                                                                                                     |
| Access | OpenFEMA API, `DisasterDeclarationsSummaries` v2, no key                                                 |
| Basis  | Official open-data API                                                                                   |
| Use    | Demand signal only: new declarations with Public Assistance predict recovery and consulting procurements |
