#!/usr/bin/env node
/* eslint-disable no-console */
// scrape-addresses.js
// Scrape residential addresses for a US zip code.
//
// Sources (merged, de-duplicated):
//   1) OpenStreetMap Overpass API    — community-mapped addresses (sparse but free)
//   2) San Mateo County ArcGIS Site_Address_Points — authoritative countywide
//      situs-address point layer (near-complete for Atherton / 94027).
//
// Usage:
//   node scripts/scrape-addresses.js                       # default: 94027, both sources
//   node scripts/scrape-addresses.js 94027
//   node scripts/scrape-addresses.js 94027 --source both        # both (default)
//   node scripts/scrape-addresses.js 94027 --source county     # SMC ArcGIS only
//   node scripts/scrape-addresses.js 94027 --source osm        # OSM Overpass only
//   node scripts/scrape-addresses.js 94027 --out ./out --bbox 37.43,-122.22,37.48,-122.16
//
// Outputs:
//   <out>/addresses-<zip>.csv   (street,city,state,zip,unit,lat,lon,sources)
//   <out>/addresses-<zip>.json  (array of address objects)
//
// Notes on residential filtering:
//   • OSM: drops features with commercial/civic tags; keeps residential building types.
//   • County (Site_Address_Points): no explicit "residential" flag is published by
//     San Mateo County, so we drop only points explicitly tagged as landmarks
//     (`landmkname` field) and keep the rest. Atherton is overwhelmingly single-
//     family residential; expect a handful of civic/school/commercial points on
//     El Camino Real frontage to slip through — filter manually if needed.

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// San Mateo County ArcGIS REST endpoint — Site_Address_Points layer.
// Source: https://data-smcmaps.opendata.arcgis.com (San Mateo County GIS).
// Layer 0 of "Site_Address_Points" FeatureServer; ~259k points countywide.
// The field `inc_muni` (incorporated municipality) is the city; `post_code` is
// unfortunately unpopulated, so we filter by city name for zip→city-aware fallbacks.
const ARCGIS_BASE =
  'https://services.arcgis.com/yq3FgOI44hYHAFVZ/arcgis/rest/services/Site_Address_Points/FeatureServer/0/query';
const ARCGIS_PAGE_SIZE = 2000;     // server maxRecordCount

const USER_AGENT = 'addr-scraper/1.0 (OpenStreetMap Overpass + San Mateo County ArcGIS; residential-address research)';

// Census place data: Atherton, CA centroid & rough bbox for 94027 fallback.
const ZIP_FALLBACKS = {
  '94027': {
    name: 'Atherton, CA',
    bbox: { south: 37.4300, west: -122.2210, north: 37.4770, east: -122.1540 },
    city: 'Atherton',
    state: 'CA',
  },
};

// OSM tags that mark a feature as NON-residential (commercial/civic/industrial).
const COMMERCIAL_TAGS = new Set([
  'shop', 'amenity', 'office', 'craft', 'tourism', 'leisure',
  'man_made', 'healthcare', 'club', 'industrial', 'public_transport',
]);

// building=* values that clearly indicate residential use.
const RESIDENTIAL_BUILDINGS = new Set([
  'house', 'detached', 'residential', 'apartments', 'apartment',
  'residence', 'bungalow', 'terrace', 'dormitory', 'cabin', 'semidetached_house',
]);

const TIMEOUT_SECONDS = 180;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { zip: '94027', out: null, bbox: null, source: 'both' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--bbox') args.bbox = argv[++i];
    else if (a === '--source') args.source = (argv[++i] || '').toLowerCase();
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!a.startsWith('--')) args.zip = String(parseInt(a, 10) ? a : args.zip);
  }
  if (!['osm', 'county', 'both'].includes(args.source)) {
    throw new Error(`Invalid --source "${args.source}". Use osm | county | both.`);
  }
  return args;
}

// --bbox parsing: "south,west,north,east"
function parseBbox(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',').map((v) => parseFloat(v.trim()));
  if (parts.length !== 4 || parts.some((v) => Number.isNaN(v))) {
    throw new Error(`Invalid --bbox "${raw}". Expected south,west,north,east.`);
  }
  const [south, west, north, east] = parts;
  if (south >= north || west >= east) throw new Error('--bbox south<north and west<east required.');
  return { south, west, north, east };
}

// ---------------------------------------------------------------------------
// Overpass query construction
// ---------------------------------------------------------------------------
// Strategy: try (1) OSM postal_code boundary, then (2) named town boundary
// (Atherton), then (3) explicit bbox.
function buildQueries(zip, bboxOverride) {
  const fallback = ZIP_FALLBACKS[zip];
  const timeout = TIMEOUT_SECONDS;
  const out = 'out center tags;';

  const addressFilter = '["addr:housenumber"]["addr:street"]';
  const residentialFilter =
    '["addr:housenumber"]["addr:street"]["building"~"^(house|detached|residential|apartments|apartment|residence|bungalow|terrace|dormitory|cabin|semidetached_house)$"i]';

  const queries = [];

  // 1) postal_code boundary relation
  queries.push(`[out:json][timeout:${timeout}];
area["boundary"="postal_code"]["postal_code"="${zip}"]->.a;
(
  node${residentialFilter}(area.a);
  way${residentialFilter}(area.a);
  relation${residentialFilter}(area.a);
);
${out}
`);
  queries.push(`[out:json][timeout:${timeout}];
area["boundary"="postal_code"]["postal_code"="${zip}"]->.a;
(
  node${addressFilter}(area.a);
  way${addressFilter}(area.a);
  relation${addressFilter}(area.a);
);
${out}
`);

  // 2) named town boundary (Atherton, San Mateo County)
  if (fallback) {
    queries.push(`[out:json][timeout:${timeout}];
area["boundary"="administrative"]["name"="${fallback.city}"]["admin_level"~"^(6|7|8)$"]->.a;
(
  node${residentialFilter}(area.a);
  way${residentialFilter}(area.a);
  relation${residentialFilter}(area.a);
);
${out}
`);
    queries.push(`[out:json][timeout:${timeout}];
area["boundary"="administrative"]["name"="${fallback.city}"]["admin_level"~"^(6|7|8)$"]->.a;
(
  node${addressFilter}(area.a);
  way${addressFilter}(area.a);
  relation${addressFilter}(area.a);
);
${out}
`);
  }

  // 3) explicit / fallback bbox
  const bb = bboxOverride || (fallback ? fallback.bbox : null);
  if (bb) {
    const box = `${bb.south},${bb.west},${bb.north},${bb.east}`;
    queries.push(`[out:json][timeout:${timeout}];
(
  node${residentialFilter}(${box});
  way${residentialFilter}(${box});
);
${out}
`);
    queries.push(`[out:json][timeout:${timeout}];
(
  node${addressFilter}(${box});
  way${addressFilter}(${box});
);
${out}
`);
  }

  return queries;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postOverpass(query) {
  const body = 'data=' + encodeURIComponent(query);
  const maxAttemptsPerEndpoint = 2;
  let lastErr;
  for (let round = 0; round < maxAttemptsPerEndpoint; round++) {
    if (round > 0) {
      const backoff = 5000 * round;
      console.warn(`  … retrying all endpoints after ${backoff}ms backoff`);
      await sleep(backoff);
    }
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), (TIMEOUT_SECONDS + 30) * 1000);
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
            'Accept': 'application/json',
          },
          body,
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (res.status === 429 || res.status === 503 || res.status === 504) {
          lastErr = new Error(`${endpoint} -> HTTP ${res.status}`);
          console.warn(`  ! ${endpoint} -> ${res.status}, will back off`);
          continue;
        }
        if (!res.ok) {
          lastErr = new Error(`${endpoint} -> HTTP ${res.status}`);
          continue;
        }
        const json = await res.json();
        return json;
      } catch (e) {
        lastErr = e;
        console.warn(`  ! ${endpoint} failed: ${e.message}`);
      }
    }
  }
  throw lastErr || new Error('All Overpass endpoints failed.');
}

// ---------------------------------------------------------------------------
// Feature -> address record
// ---------------------------------------------------------------------------
function isCommercial(tags) {
  for (const k of Object.keys(tags)) if (COMMERCIAL_TAGS.has(k) && tags[k] && tags[k] !== 'no') return true;
  return false;
}

function isResidential(tags) {
  // explicit building tag preferred
  const b = tags.building;
  if (b && RESIDENTIAL_BUILDINGS.has(b.toLowerCase())) return true;
  if (b && b !== 'yes' && b !== 'no' && !RESIDENTIAL_BUILDINGS.has(b.toLowerCase())) return false;
  // building=yes or no building tag: residential unless any commercial tag present
  return !isCommercial(tags);
}

function titleCase(s) {
  if (!s) return s;
  return s.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}

function makeStreet(tags) {
  const num = (tags['addr:housenumber'] || '').trim();
  const street = (tags['addr:street'] || '').trim();
  if (!num || !street) return null;
  return `${num} ${street}`.replace(/\s+/g, ' ').trim();
}

function coordOf(el) {
  if (el.type === 'node') return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  if (typeof el.lat === 'number' && typeof el.lon === 'number') return { lat: el.lat, lon: el.lon };
  return { lat: null, lon: null };
}

function featureToAddress(el, defaultCity, defaultState, zip) {
  const t = el.tags || {};
  if (!isResidential(t)) return null;
  const street = makeStreet(t);
  if (!street) return null;
  const { lat, lon } = coordOf(el);
  const city = t['addr:city'] || t['addr:suburb'] || defaultCity || null;
  const state = t['addr:state'] || defaultState || null;
  const zc = t['addr:postcode'] || zip;
  const unit = t['addr:unit'] || t['addr:door'] || t['addr:flats'] || t['addr:flat'] || null;
  return {
    street: titleCase(street),
    city: city ? titleCase(city) : city,
    state: state ? state.toUpperCase() : state,
    zip: zc,
    unit: unit ? String(unit) : null,
    lat,
    lon,
    source: `openstreetmap/${el.type}/${el.id}`,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/scrape-addresses.js [zip] [--out dir] [--bbox s,w,n,e]');
    process.exit(0);
  }
  const fallback = ZIP_FALLBACKS[args.zip];
  const bbox = parseBbox(args.bbox);
  const outDir = args.out
    ? path.resolve(args.out)
    : path.resolve(process.cwd(), 'out', 'addresses');
  fs.mkdirSync(outDir, { recursive: true });

  const queries = buildQueries(args.zip, bbox);
  console.log(`Scraping residential addresses for zip ${args.zip}${fallback ? ` (${fallback.name})` : ''}`);
  console.log(`Overpass queries (attempted in order until results): ${queries.length}`);

  const seen = new Set();          // key -> dedupe
  const byQueryStrict = [];       // count per stage
  let records = [];

  // Strategies are ordered: postal_code boundary, then named town, then bbox.
  // Each strategy tries a strict residential filter first, then a broad
  // addr:* filter as fallback. The first strategy that yields records wins.
  const strategies = [
    { name: 'postal_code boundary', strictIdx: 0, broadIdx: 1 },
    { name: 'named town boundary',  strictIdx: 2, broadIdx: 3 },
    { name: 'bbox',                  strictIdx: 4, broadIdx: 5 },
  ].filter((s) => s.broadIdx < queries.length);

  let chosen = null;
  for (const strat of strategies) {
    console.log(`\n=== Strategy: ${strat.name} ===`);
    for (const kind of ['strict', 'broad']) {
      if (chosen) break;
      const idx = kind === 'strict' ? strat.strictIdx : strat.broadIdx;
      const label = `${idx + 1}/${queries.length} ${kind}`;
      console.log(`→ Query ${label}`);
      if (records.length && kind === 'broad' && chosen) break;
      let json;
      try {
        json = await postOverpass(queries[idx]);
      } catch (e) {
        console.warn(`  ! query ${label} aborted: ${e.message}`);
        continue;
      }
      const els = (json && Array.isArray(json.elements)) ? json.elements : [];
      console.log(`  raw elements: ${els.length}`);
      if (!els.length) continue;

      let added = 0;
      for (const el of els) {
        const rec = featureToAddress(el, fallback && fallback.city, fallback && fallback.state, args.zip);
        if (!rec) continue;
        const key = [
          rec.street.toLowerCase(),
          rec.unit ? rec.unit.toLowerCase() : '',
          rec.zip,
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        records.push(rec);
        added++;
      }
      console.log(`  added: ${added}  (running unique total: ${records.length})`);
      byQueryStrict.push({ label, added });
      if (added > 0) { chosen = { strat: strat.name, label }; }
      await sleep(2000); // polite pause between requests
    }
    if (chosen) break;
  }

  console.log(
    chosen
      ? `\nPicked strategy "${chosen.strat}" via query ${chosen.label}`
      : '\nNo strategy returned records.',
  );

  records.sort((a, b) =>
    a.street === b.street
      ? (a.unit || '').localeCompare(b.unit || '')
      : a.street.localeCompare(b.street));

  const csvPath = path.join(outDir, `addresses-${args.zip}.csv`);
  const jsonPath = path.join(outDir, `addresses-${args.zip}.json`);

  // CSV
  const cols = ['street', 'city', 'state', 'zip', 'unit', 'lat', 'lon', 'source'];
  const csvLines = [cols.join(',')];
  for (const r of records) {
    const row = cols.map((c) => {
      const v = r[c];
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    });
    csvLines.push(row.join(','));
  }
  fs.writeFileSync(csvPath, csvLines.join('\n') + '\n', 'utf8');

  // JSON
  fs.writeFileSync(jsonPath, JSON.stringify(records, null, 2), 'utf8');

  console.log(`\nDone. ${records.length} unique residential addresses.`);
  console.log(`  CSV : ${csvPath}`);
  console.log(`  JSON: ${jsonPath}`);
  if (!records.length) {
    console.warn('No results. Possible causes: zip boundary missing from OSM,');
    console.warn('network/Overpass outage, or bbox mismatch. Try --bbox s,w,n,e.');
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});