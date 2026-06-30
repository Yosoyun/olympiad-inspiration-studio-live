const fs = require("fs");
const path = require("path");

const CONTESTANT_URL = "https://www.imo-official.org/results/contestant/11101/";
const COUNTRY_URL = "https://www.imo-official.org/results/individual/country/";
const OUTPUT = path.join(__dirname, "..", "data", "imo-medalist-directory-20260630.js");
const AWARDS = new Set(["gold", "silver", "bronze", "hm"]);
const AWARD_ORDER = { gold: 1, silver: 2, bronze: 3, hm: 4 };

function decodeEntities(text) {
  return text
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractJson(html, attr) {
  const pattern = new RegExp(`<script type="application/json" ${attr}>([\\s\\S]*?)<\\/script>`);
  const match = html.match(pattern);
  if (!match) return null;
  return JSON.parse(decodeEntities(match[1]));
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return response.text();
}

async function pool(items, limit, worker) {
  const results = [];
  let index = 0;
  async function run() {
    while (index < items.length) {
      const current = items[index++];
      results.push(await worker(current));
    }
  }
  await Promise.all(Array.from({ length: limit }, run));
  return results;
}

function isPerfect(row) {
  return Array.isArray(row.scores)
    && row.scores.length > 0
    && row.scores.every((score) => score === 7);
}

function fullName(row) {
  return [row.name, row.surname].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function bestAward(records) {
  return records
    .map((record) => record.award)
    .sort((a, b) => AWARD_ORDER[a] - AWARD_ORDER[b])[0];
}

function compactRecord(row, country) {
  return {
    year: Number(row.year),
    country: country.name,
    countryCode: row.countryCode || country.code,
    award: row.award,
    total: row.total,
    rank: row.rank,
    perfect: isPerfect(row)
  };
}

function summarizePerson(person) {
  const counts = { gold: 0, silver: 0, bronze: 0, hm: 0 };
  person.records.forEach((record) => {
    counts[record.award] += 1;
  });
  person.records.sort((a, b) => a.year - b.year || AWARD_ORDER[a.award] - AWARD_ORDER[b.award]);
  person.years = [...new Set(person.records.map((record) => record.year))];
  person.countries = [...new Set(person.records.map((record) => record.country))];
  person.countryCodes = [...new Set(person.records.map((record) => record.countryCode))];
  person.awards = counts;
  person.bestAward = bestAward(person.records);
  person.perfectScores = person.records.filter((record) => record.perfect).length;
  person.officialUrl = `https://www.imo-official.org/results/contestant/${person.id}/`;
  return person;
}

async function main() {
  const contestantHtml = await fetchText(CONTESTANT_URL);
  const countryLookup = extractJson(contestantHtml, "data-contestant-country-lookup");
  if (!countryLookup) throw new Error("Could not read IMO country lookup.");

  const countries = Object.values(countryLookup)
    .filter((country) => (country.statistics?.participations || 0) > 0)
    .sort((a, b) => a.code.localeCompare(b.code));

  const people = new Map();
  const failures = [];

  await pool(countries, 8, async (country) => {
    const url = `${COUNTRY_URL}${country.code}/`;
    try {
      const html = await fetchText(url);
      const rows = extractJson(html, "data-results-individual-country-contestants") || [];
      rows
        .filter((row) => AWARDS.has(row.award))
        .forEach((row) => {
          const id = String(row.slug || row.contestantId || row.participationId);
          if (!people.has(id)) {
            people.set(id, {
              id,
              name: fullName(row) || "Anonymous contestant",
              records: []
            });
          }
          people.get(id).records.push(compactRecord(row, country));
        });
    } catch (error) {
      failures.push({ country: country.code, message: error.message });
    }
  });

  const medalists = [...people.values()].map(summarizePerson).sort((a, b) => {
    return AWARD_ORDER[a.bestAward] - AWARD_ORDER[b.bestAward]
      || b.awards.gold - a.awards.gold
      || b.awards.silver - a.awards.silver
      || b.awards.bronze - a.awards.bronze
      || b.perfectScores - a.perfectScores
      || a.name.localeCompare(b.name);
  });

  const totals = medalists.reduce((acc, person) => {
    acc.people += 1;
    acc.records += person.records.length;
    acc.gold += person.awards.gold;
    acc.silver += person.awards.silver;
    acc.bronze += person.awards.bronze;
    acc.hm += person.awards.hm;
    acc.perfectScores += person.perfectScores;
    person.records.forEach((record) => {
      acc.yearStart = Math.min(acc.yearStart, record.year);
      acc.yearEnd = Math.max(acc.yearEnd, record.year);
    });
    return acc;
  }, {
    people: 0,
    records: 0,
    gold: 0,
    silver: 0,
    bronze: 0,
    hm: 0,
    perfectScores: 0,
    yearStart: Infinity,
    yearEnd: -Infinity
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceName: "International Mathematical Olympiad official results",
    sourceUrl: "https://www.imo-official.org/results.aspx",
    coverage: `${totals.yearStart}-${totals.yearEnd}`,
    countryPagesChecked: countries.length,
    failedCountryPages: failures,
    note: "Includes official IMO gold, silver, bronze, and honorable mention records exposed by the IMO country result pages. It does not invent biographies where reliable public career sources are absent.",
    totals,
    medalists
  };

  const js = `window.IMO_MEDALIST_DIRECTORY = ${JSON.stringify(payload)};\n`;
  fs.writeFileSync(OUTPUT, js);
  console.log(JSON.stringify({
    output: OUTPUT,
    countries: countries.length,
    failures: failures.length,
    people: totals.people,
    records: totals.records,
    coverage: payload.coverage,
    gold: totals.gold,
    silver: totals.silver,
    bronze: totals.bronze,
    hm: totals.hm
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
