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

|                       |                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                 | Florida Department of Management Services, MyFloridaMarketPlace                                                                                                                                                                                                                                                                             |
| Access                | Public "State of Florida Advertisements" search at `vendor.myfloridamarketplace.com/search/bids`, no sign-in. Replaced the legacy Vendor Bid System on March 28, 2022 (the VBS now holds history only)                                                                                                                                      |
| Method                | The same public JSON endpoints the public pages call, verified without cookies on Oct 15, 2026: `POST /mfmp/pub/search/bids` (status OPEN/PREVIEW, 100 per page) and `GET /mfmp/pub/search/bids/detail?id=` for each biddable ad. Both need `Accept: application/json`                                                                      |
| Observed              | Oct 15, 2026: 179 OPEN ads across 10 ad types; 134 biddable ads, each with UNSPSC commodity codes, description, contact and a document list                                                                                                                                                                                                 |
| Fields used           | List: advertisementId, uniqueName, agencyAdNumber, type, title, dates, status, version, organization. Detail: commodityCodes (UNSPSC), description (HTML converted to text), responseContact, docs (attachmentId, original fileName, description, date)                                                                                     |
| Documents             | Referenced, never stored by Radar: `/mfmp/bids/detail/attachment/download?attachmentId=` with the original file name kept. The portal returns the file only to a request with `Accept: application/octet-stream`, so the web app links these through `/docs/mfmp/<id>`, which asks for the file on the viewer's click and passes it through |
| Award detection       | Ads stay "OPEN" through their posting window even after an Intent to Award is posted (observed on 3 of 134 biddable ads on Oct 15). When the agency has posted such a document, Radar marks the record awarded so it leaves the bid lane                                                                                                    |
| Before commercial use | (1) Read and record the MFMP terms; (2) ask DMS whether a data feed exists for aggregators; (3) run daily for two weeks and compare counts with the public page                                                                                                                                                                             |

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

|                       |                                                                                                                                                                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                 | Euna Solutions (Bonfire), on behalf of each government that publishes a public portal                                                                                                                                                                                                        |
| Access                | Public portals at `<org>.bonfirehub.com/portal/?tab=openOpportunities`, no sign-in                                                                                                                                                                                                           |
| Method                | The JSON call the open-opportunities tab makes, verified without cookies on Oct 27, 2026: `GET /PublicPortal/getOpenPublicOpportunitiesSectionData`. Only projects with public visibility are kept                                                                                           |
| Portals               | Bonfire has no public directory, so portals are listed by hand in `BONFIRE_PORTALS` (packages/connectors/src/bonfire.ts). Add one only after opening its public portal page                                                                                                                  |
| Observed              | Oct 27, 2026: Broward County 26 open, Hillsborough County 22 open                                                                                                                                                                                                                            |
| Fields used           | ProjectID, ReferenceID (solicitation number), ProjectName, DateClose (UTC wall-clock time), department name, visibility and status                                                                                                                                                           |
| Not yet used          | Descriptions and documents, which are on each project's public page                                                                                                                                                                                                                          |
| Before commercial use | (1) Read and record Bonfire's terms of use; (2) confirm the remaining Florida portals (Marion County, Lee County Schools and others) by hand; (3) FAU (fau.bonfirehub.com) answered HTTP 429 to server requests on Oct 27, 2026, so it is left out until Bonfire confirms an acceptable rate |

## vendorlink

|                       |                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner                 | VendorLink (Diversified Data Systems), on behalf of each agency that posts there                                                                                                                                                                                   |
| Access                | Public bid search at `www.myvendorlink.com/external/bids` (about 115 agencies, nearly all in Florida) and agency-run copies at `vendorlink.osceola.org` (Osceola County and its school board) and `vendorlink.ocps.net` (Orange County Public Schools). No sign-in |
| Method                | The public ASP.NET search form, posted back exactly as a browser does (verified without cookies on Oct 28, 2026): GET the form, POST it with agency "all", status Active, 100 rows per page and piggyback contracts off, then follow the grid's own pager          |
| Observed              | Oct 28, 2026: 85 active solicitations on the shared site across about 40 agencies (Brevard, OUC, Hillsborough, Polk, Manatee, Sarasota, Seminole, St. Johns school districts, Ocala, Kissimmee, St. Cloud, DeLand, Oviedo, KUA and others); 10 on the Osceola site |
| Fields used           | Agency (and its id from the agency list), number, title, status, broadcast date, mandatory pre-bid flag, question end date, due date (Eastern time)                                                                                                                |
| Not yet used          | The detail page (scope of services, contacts, bonds, documents). It is session-bound (`/external/biddetails` with no id), so records link to the public list filtered to the agency                                                                                |
| State                 | Agencies are placed in Florida unless the name names another state (e.g. "City of Madison, Georgia", "Cape Hatteras Electric Cooperative" in NC)                                                                                                                   |
| Before commercial use | (1) Read and record VendorLink's terms of use; (2) run daily and paced (a handful of requests per site)                                                                                                                                                            |

## openfema

|        |                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------- |
| Owner  | FEMA                                                                                                     |
| Access | OpenFEMA API, `DisasterDeclarationsSummaries` v2, no key                                                 |
| Basis  | Official open-data API                                                                                   |
| Use    | Demand signal only: new declarations with Public Assistance predict recovery and consulting procurements |

---

# Market data (Flight Deck Market Intelligence)

Public award data, stored in the `market` schema, separate from opportunities. Collectors never create notices
or alerts. Every raw response is kept (compressed, `market.captures`) and each record points at the capture it
came from, so any figure can show its source and date. Same rules as above: official APIs and public pages only,
no logins, identified and paced requests.

## usaspending

|             |                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner       | U.S. Department of the Treasury (USAspending.gov; data from FPDS / SAM.gov)                                                                                                                                                                      |
| Access      | `POST https://api.usaspending.gov/api/v2/search/spending_by_award/`, no key. Verified live Oct 31, 2026                                                                                                                                          |
| Basis       | Official open-data API                                                                                                                                                                                                                           |
| Scope       | Contract awards (types A–D) with place of performance in `RADAR_MARKET_STATES`, NAICS in `RADAR_MARKET_NAICS`                                                                                                                                    |
| Fields used | Award ID, recipient name and UEI, award amount (obligated to date), start/end dates, awarding agency and sub-agency, award type, NAICS, PSC, place of performance state, description, last modified, internal award id (for the award page link) |
| Limits      | 100 rows per page and a 10,000-row ceiling per query: windows are split by month and state; a month at the ceiling is marked incomplete and reported                                                                                             |
| Gotchas     | `country` must be `"USA"` (`"US"` returns nothing); unknown filter keys are ignored silently, so filters are pinned by tests                                                                                                                     |

## usaspending-detail

|             |                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner       | U.S. Department of the Treasury (USAspending.gov)                                                                                                                      |
| Access      | `GET https://api.usaspending.gov/api/v2/awards/<generated_unique_award_id>/`, no key. Verified live Oct 31, 2026                                                       |
| Basis       | Official open-data API                                                                                                                                                 |
| Fields used | Number of offers received, extent competed, set-aside, solicitation number, pricing type, base + all options value, total obligation, potential end date, parent award |
| Pace        | One request per award that is new or changed since its details were read; capped per run (`RADAR_MARKET_DETAIL_MAX`, default 1,000)                                    |
| Why not SAM | The SAM.gov Contract Awards API has the same FPDS fields but allows a personal key 10 requests a day, shared with every other SAM call on that key                     |

## openfema-pa

|             |                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner       | FEMA                                                                                                                                           |
| Access      | OpenFEMA `v2/PublicAssistanceFundedProjectsDetails` and `v1/PublicAssistanceApplicants`, no key. Verified live Oct 31, 2026                    |
| Basis       | Official open-data API                                                                                                                         |
| Scope       | Every Public Assistance project in the tracked states (all damage categories; A = debris removal), plus applicant names                        |
| Use         | Demand signal: who spent disaster money on what, by county. Names no contractors                                                               |
| Incremental | Filter `lastRefresh ge <last window end − 3 days>`; FEMA reloads applicants whole each day, so applicant pages are de-duplicated by their rows |
| Gotchas     | The v1 projects endpoint is gone; projects filter on `stateAbbreviation`, applicants on the full state name (`state eq 'Florida'`)             |

## Planned (not yet collected)

- **SAM.gov Contract Awards**: not needed for now; `usaspending-detail` reads the same FPDS competition fields without SAM's 10-requests-a-day limit.
- **Texas LBB Contracts Database**: the public site is a Dash app; its "Download Data" export needs to be confirmed as an allowed, stable route first.
- **Florida FACTS**: public search with spreadsheet export. Its search terms (checked Oct 31, 2026) describe the system and the Chapter 119 route and place no limit on automated use; no robots.txt. Next to build.
- **TxDOT bid tabulations**, **ESBD awards**, **MFMP Agency Decisions**: see the Flight Deck spec, Section 8.
