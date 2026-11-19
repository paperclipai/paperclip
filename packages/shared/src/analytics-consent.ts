const CONSENT_REQUIRED_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "AX", "GF", "GP", "MQ", "RE", "YT", "MF",
  "IS", "LI", "NO", "SJ",
  "GB", "GG", "JE", "IM", "GI",
  "CH",
  "EU",
]);

const CONSENT_REQUIRED_TIME_ZONES = new Set([
  "Arctic/Longyearbyen",
  "Asia/Famagusta",
  "Asia/Nicosia",
  "Atlantic/Azores",
  "Atlantic/Canary",
  "Atlantic/Faeroe",
  "Atlantic/Faroe",
  "Atlantic/Jan_Mayen",
  "Atlantic/Madeira",
  "Atlantic/Reykjavik",
  "America/Cayenne",
  "America/Guadeloupe",
  "America/Marigot",
  "America/Martinique",
  "America/St_Barthelemy",
  "Indian/Mayotte",
  "Indian/Reunion",
  "CET",
  "EET",
  "Eire",
  "GB",
  "GB-Eire",
  "Iceland",
  "MET",
  "Poland",
  "Portugal",
  "WET",
]);

const UNKNOWN_TIME_ZONES = new Set(["", "UTC", "GMT", "UCT", "Universal", "Zulu", "Greenwich"]);

const COUNTRY_ALIASES = new Map([
  ["UK", "GB"],
  ["EL", "GR"],
  ["EU", "EU"],
  ["EZ", "EU"],
]);

const ISO_COUNTRY_CODES = new Set(
  `
  AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE
  BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD
  CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM
  DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF
  GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU
  ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN
  KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME
  MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA
  NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM
  PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI
  SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK
  TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI
  VN VU WF WS YE YT ZA ZM ZW
  `
    .trim()
    .split(/\s+/),
);

export function countryRequiresAnalyticsConsent(country: string | null | undefined): boolean | null {
  const raw = country?.trim().toUpperCase();
  if (!raw || !/^[A-Z]{2}$/.test(raw)) return null;
  const code = COUNTRY_ALIASES.get(raw) ?? raw;
  if (CONSENT_REQUIRED_COUNTRIES.has(code)) return true;
  return ISO_COUNTRY_CODES.has(code) ? false : null;
}

export function timeZoneRequiresAnalyticsConsent(timeZone: string | null | undefined): boolean {
  const zone = timeZone?.trim() ?? "";
  if (UNKNOWN_TIME_ZONES.has(zone) || zone.startsWith("Etc/")) return true;
  return zone.startsWith("Europe/") || CONSENT_REQUIRED_TIME_ZONES.has(zone);
}
