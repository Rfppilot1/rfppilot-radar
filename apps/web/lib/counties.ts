/**
 * Places a notice's buyer on a county, so the Market map can count bids by county.
 *
 * Notices carry a buyer name, not a county. The rules, in order:
 *   1. State-level buyers (state agencies) are statewide, never a county.
 *   2. A county named in the buyer, as "<Name> County ...", "School District of <Name>", "<Name> School District".
 *   3. A city, university or utility from the lookup tables below, matched as whole words.
 *      A city counts only as "City/Town/Village of X", "X ISD", or when the buyer name starts with it, so
 *      "Key Largo" is not Largo and "Stephen F. Austin State University" is not Austin. Names of three or more
 *      words (universities, utilities) count anywhere in the buyer name.
 * Anything else is unplaced and reported as such on the map, never guessed.
 */
export interface County {
  fips: string;
  name: string;
}

export type Placement =
  { kind: "county"; county: County } | { kind: "statewide" } | { kind: "federal" } | { kind: "unplaced" };

export const STATE_FIPS: Record<string, string> = {
  AL: "01",
  AK: "02",
  AZ: "04",
  AR: "05",
  CA: "06",
  CO: "08",
  CT: "09",
  DE: "10",
  DC: "11",
  FL: "12",
  GA: "13",
  HI: "15",
  ID: "16",
  IL: "17",
  IN: "18",
  IA: "19",
  KS: "20",
  KY: "21",
  LA: "22",
  ME: "23",
  MD: "24",
  MA: "25",
  MI: "26",
  MN: "27",
  MS: "28",
  MO: "29",
  MT: "30",
  NE: "31",
  NV: "32",
  NH: "33",
  NJ: "34",
  NM: "35",
  NY: "36",
  NC: "37",
  ND: "38",
  OH: "39",
  OK: "40",
  OR: "41",
  PA: "42",
  RI: "44",
  SC: "45",
  SD: "46",
  TN: "47",
  TX: "48",
  UT: "49",
  VT: "50",
  VA: "51",
  WA: "53",
  WV: "54",
  WI: "55",
  WY: "56",
};

/** Cities, universities and utilities that name no county, mapped to the county they sit in. */
export const PLACE_TO_COUNTY: Record<string, Record<string, string>> = {
  FL: {
    "Altamonte Springs": "Seminole",
    Apopka: "Orange",
    Aventura: "Miami-Dade",
    "Avon Park": "Highlands",
    Bartow: "Polk",
    "Belle Glade": "Palm Beach",
    "Boca Raton": "Palm Beach",
    "Boynton Beach": "Palm Beach",
    Bradenton: "Manatee",
    "Cape Coral": "Lee",
    Clearwater: "Pinellas",
    Clermont: "Lake",
    Cocoa: "Brevard",
    "Coral Gables": "Miami-Dade",
    "Coral Springs": "Broward",
    "Cutler Bay": "Miami-Dade",
    Davie: "Broward",
    "Daytona Beach": "Volusia",
    "Deerfield Beach": "Broward",
    DeLand: "Volusia",
    "Delray Beach": "Palm Beach",
    Deltona: "Volusia",
    Destin: "Okaloosa",
    Doral: "Miami-Dade",
    Dunedin: "Pinellas",
    Edgewater: "Volusia",
    Eustis: "Lake",
    "Fernandina Beach": "Nassau",
    "Fort Lauderdale": "Broward",
    "Fort Myers": "Lee",
    "Fort Pierce": "St. Lucie",
    "Fort Walton Beach": "Okaloosa",
    Gainesville: "Alachua",
    Greenacres: "Palm Beach",
    Groveland: "Lake",
    "Haines City": "Polk",
    Hialeah: "Miami-Dade",
    Hollywood: "Broward",
    Homestead: "Miami-Dade",
    Jacksonville: "Duval",
    Jupiter: "Palm Beach",
    "Key West": "Monroe",
    Kissimmee: "Osceola",
    "Lake City": "Columbia",
    "Lake Mary": "Seminole",
    "Lake Worth Beach": "Palm Beach",
    Lakeland: "Polk",
    Largo: "Pinellas",
    Lauderhill: "Broward",
    Leesburg: "Lake",
    "Live Oak": "Suwannee",
    Margate: "Broward",
    Melbourne: "Brevard",
    "Miami Beach": "Miami-Dade",
    Miami: "Miami-Dade",
    Miramar: "Broward",
    "Mount Dora": "Lake",
    Naples: "Collier",
    "New Port Richey": "Pasco",
    "New Smyrna Beach": "Volusia",
    "North Miami": "Miami-Dade",
    "North Port": "Sarasota",
    Ocala: "Marion",
    Ocoee: "Orange",
    Okeechobee: "Okeechobee",
    Orlando: "Orange",
    "Ormond Beach": "Volusia",
    Oviedo: "Seminole",
    "Palm Bay": "Brevard",
    "Palm Beach Gardens": "Palm Beach",
    "Palm Coast": "Flagler",
    Palmetto: "Manatee",
    "Palmetto Bay": "Miami-Dade",
    "Panama City": "Bay",
    "Pembroke Pines": "Broward",
    Pensacola: "Escambia",
    Plantation: "Broward",
    "Plant City": "Hillsborough",
    "Pompano Beach": "Broward",
    "Port Orange": "Volusia",
    "Port St. Lucie": "St. Lucie",
    "Punta Gorda": "Charlotte",
    "Riviera Beach": "Palm Beach",
    "Royal Palm Beach": "Palm Beach",
    "St. Augustine": "St. Johns",
    "St. Cloud": "Osceola",
    "St. Petersburg": "Pinellas",
    Sanford: "Seminole",
    Sebastian: "Indian River",
    Sebring: "Highlands",
    Stuart: "Martin",
    Sunrise: "Broward",
    Tallahassee: "Leon",
    Tamarac: "Broward",
    Tampa: "Hillsborough",
    Tavares: "Lake",
    "Temple Terrace": "Hillsborough",
    Titusville: "Brevard",
    Venice: "Sarasota",
    "Vero Beach": "Indian River",
    Wellington: "Palm Beach",
    "West Palm Beach": "Palm Beach",
    Weston: "Broward",
    "Winter Garden": "Orange",
    "Winter Haven": "Polk",
    "Winter Park": "Orange",
    Zephyrhills: "Pasco",
    "University of Central Florida": "Orange",
    "Florida Atlantic University": "Palm Beach",
    "University of South Florida": "Hillsborough",
    "University of Florida": "Alachua",
    "Florida State University": "Leon",
    "Florida A&M University": "Leon",
    "Florida International University": "Miami-Dade",
    "University of North Florida": "Duval",
    "University of West Florida": "Escambia",
    "Florida Gulf Coast University": "Lee",
    // Names that start with a city in another county.
    "Key Largo": "Monroe",
    "Orlando Sanford International Airport": "Seminole",
    "Orlando Melbourne International Airport": "Brevard",
    OUC: "Orange",
    "Orlando Utilities Commission": "Orange",
    JEA: "Duval",
    "Tampa Bay Water": "Pinellas",
  },
  TX: {
    "Stephen F. Austin State University": "Nacogdoches",
    Abilene: "Taylor",
    Allen: "Collin",
    Amarillo: "Potter",
    Arlington: "Tarrant",
    Austin: "Travis",
    Baytown: "Harris",
    Beaumont: "Jefferson",
    Boerne: "Kendall",
    Brownsville: "Cameron",
    Bryan: "Brazos",
    Burleson: "Johnson",
    Carrollton: "Dallas",
    "Cedar Hill": "Dallas",
    "Cedar Park": "Williamson",
    "College Station": "Brazos",
    Conroe: "Montgomery",
    Coppell: "Dallas",
    "Corpus Christi": "Nueces",
    Dallas: "Dallas",
    "Del Rio": "Val Verde",
    Denton: "Denton",
    DeSoto: "Dallas",
    Duncanville: "Dallas",
    "Eagle Pass": "Maverick",
    Edinburg: "Hidalgo",
    "El Paso": "El Paso",
    Euless: "Tarrant",
    "Flower Mound": "Denton",
    "Fort Worth": "Tarrant",
    Friendswood: "Galveston",
    Frisco: "Collin",
    Galveston: "Galveston",
    Garland: "Dallas",
    Georgetown: "Williamson",
    "Grand Prairie": "Dallas",
    Grapevine: "Tarrant",
    Harlingen: "Cameron",
    Houston: "Harris",
    Huntsville: "Walker",
    Irving: "Dallas",
    Katy: "Harris",
    Keller: "Tarrant",
    Kerrville: "Kerr",
    Killeen: "Bell",
    Kyle: "Hays",
    Laredo: "Webb",
    "League City": "Galveston",
    Leander: "Williamson",
    Lewisville: "Denton",
    "Little Elm": "Denton",
    Longview: "Gregg",
    Lubbock: "Lubbock",
    Lufkin: "Angelina",
    Mansfield: "Tarrant",
    McAllen: "Hidalgo",
    McKinney: "Collin",
    Mesquite: "Dallas",
    Midland: "Midland",
    Mission: "Hidalgo",
    Nacogdoches: "Nacogdoches",
    "New Braunfels": "Comal",
    Odessa: "Ector",
    Pasadena: "Harris",
    Pearland: "Brazoria",
    Pflugerville: "Travis",
    Pharr: "Hidalgo",
    Plano: "Collin",
    "Port Arthur": "Jefferson",
    Prosper: "Collin",
    Richardson: "Dallas",
    "Rio Grande City": "Starr",
    Rockwall: "Rockwall",
    "Round Rock": "Williamson",
    Rowlett: "Dallas",
    "San Angelo": "Tom Green",
    "San Antonio": "Bexar",
    "San Marcos": "Hays",
    Schertz: "Guadalupe",
    Seguin: "Guadalupe",
    Sherman: "Grayson",
    "Sugar Land": "Fort Bend",
    Temple: "Bell",
    Texarkana: "Bowie",
    Tyler: "Smith",
    Victoria: "Victoria",
    Waco: "McLennan",
    Weatherford: "Parker",
    Weslaco: "Hidalgo",
    "Wichita Falls": "Wichita",
    Wylie: "Collin",
  },
};

/** Lowercase, "Saint" and "St." read alike, punctuation dropped, single spaces. */
export function norm(s: string): string {
  return ` ${s
    .toLowerCase()
    .replace(/\bsaint\b/g, "st")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

export interface PlaceArgs {
  buyerName: string;
  buyerLevel: "federal" | "state" | "local" | "other";
  state: string | null;
  /** Counties of the notice's state, from the Census shapes. */
  counties: County[];
}

export function placeBuyer(a: PlaceArgs): Placement {
  if (a.buyerLevel === "state") return { kind: "statewide" };
  if (!a.state || a.counties.length === 0) return { kind: "unplaced" };
  const name = norm(a.buyerName);
  const byName = new Map(a.counties.map((c) => [norm(c.name).trim(), c] as const));
  // Longest county names first, so "Palm Beach County" wins over a shorter name inside it.
  const sorted = [...byName.keys()].sort((x, y) => y.length - x.length);
  for (const cn of sorted) {
    const c = byName.get(cn)!;
    if (
      name.includes(` ${cn} county `) ||
      name.includes(` school district of ${cn} `) ||
      name.includes(` ${cn} school district `) ||
      name.includes(` ${cn} county public schools `) ||
      name.includes(` school board of ${cn} `)
    )
      return { kind: "county", county: c };
  }
  const places = PLACE_TO_COUNTY[a.state.toUpperCase()] ?? {};
  const keys = Object.keys(places).sort((x, y) => y.length - x.length);
  for (const k of keys) {
    if (placeNamed(name, norm(k))) {
      const c = byName.get(norm(places[k]!).trim());
      if (c) return { kind: "county", county: c };
    }
  }
  return { kind: "unplaced" };
}

/** `name` and `key` are normalized (space-padded). */
function placeNamed(name: string, key: string): boolean {
  const k = key.trim();
  if (k.split(" ").length >= 3) return name.includes(key);
  return (
    name.startsWith(key) ||
    [" city of ", " town of ", " village of "].some((p) => name.includes(`${p}${k} `)) ||
    name.includes(`${key}isd `) ||
    name.includes(`${key}independent school district `)
  );
}
