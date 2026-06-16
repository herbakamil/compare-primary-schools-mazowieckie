// Shared code for index.html (map) and ranking.html (table).
// - constants, colour mapping
// - data loading (base + per-metric on demand)
// - URL state + localStorage persistence (§9 of MAP_APP_BRIEF.md)
// - i18n translations

// -----------------------------------------------------------------------------
// Constants

const METRICS  = ['mean', 'median', 'diff_mean', 'unit_norm_diff_mean'];
const SUBJECTS = ['polski', 'matematyka', 'angielski', 'composite_min'];
const CORE_SUBJECTS = ['polski', 'matematyka', 'angielski'];

const DEFAULTS = {
  metric:  'unit_norm_diff_mean',
  subject: 'composite_min',
  lang:    'pl',
};

const COLOURS = {
  satRed:   '#d6604d',
  red:      '#f4a582',
  yellow:   '#fde08a',
  green:    '#a6dba0',
  satGreen: '#1a9850',
  missing:  '#bbb',
};

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';
// Mazowieckie viewbox: left,top,right,bottom (lon/lat).
const MAZ_VIEWBOX = '19.2,53.6,23.2,51.0';

// -----------------------------------------------------------------------------
// Colour / class mapping
//
// One set of z-score thresholds drives both the map colours and the ranking
// A–E class, so they always agree. Index 0..4 runs worst → best:
//   0 = E (≤ −1.5σ), 1 = D, 2 = C (±0.33σ), 3 = B, 4 = A (≥ +1.5σ).

const CLASS_LETTERS = ['E', 'D', 'C', 'B', 'A'];
const CLASS_COLOURS = [COLOURS.satRed, COLOURS.red, COLOURS.yellow, COLOURS.green, COLOURS.satGreen];
// Text colour that reads on each class colour (white on the saturated ends).
const CLASS_TEXT_COLOURS = ['#fff', '#222', '#222', '#222', '#fff'];

function classIndexFor(score, centre, sigma) {
  if (score == null || sigma == null || sigma === 0) return null;
  const z = (score - centre) / sigma;
  if (z <= -1.5)   return 0;  // E
  if (z <  -0.33)  return 1;  // D
  if (z <=  0.33)  return 2;  // C
  if (z <   1.5)   return 3;  // B
  return 4;                   // A
}

function colourFor(score, centre, sigma) {
  const i = classIndexFor(score, centre, sigma);
  return i == null ? COLOURS.missing : CLASS_COLOURS[i];
}

// Per-subject line colours, shared by the map popup sparkline and the ranking
// detail charts so a subject reads the same everywhere.
const SUBJECT_COLOURS = {
  polski: '#1f77b4',
  matematyka: '#d62728',
  angielski: '#2ca02c',
  composite_min: '#7f7f7f',
};

// -----------------------------------------------------------------------------
// Small multi-line chart with labelled axes (shared: map popup + ranking detail)
//
// opts:
//   years:   [2021, 2022, …]  — x positions, in order
//   series:  [{ colour, points: {<year>: value|null}, markers?: bool }]
//   invertY: true for rank charts (1 = best, drawn at the top)
//   fmtY:    (value) => short string, used for the two Y-axis labels
//   width/height: optional pixel size
// Points keyed by year; missing years are gaps (line skips them).

function lineChartSVG(opts) {
  const W = opts.width || 210;
  const H = opts.height || 132;
  const mL = 38, mR = 16, mT = 8, mB = 18;      // margins for axis labels
  const years = opts.years;
  const plotW = W - mL - mR, plotH = H - mT - mB;

  const allY = [];
  for (const s of opts.series) {
    for (const y of years) {
      const v = s.points[y];
      if (v != null) allY.push(v);
    }
  }
  if (!allY.length) return `<svg width="${W}" height="${H}"></svg>`;

  let lo = Math.min(...allY), hi = Math.max(...allY);
  const dataLo = lo, dataHi = hi;   // real range, for the axis labels
  if (lo === hi) { lo -= 1; hi += 1; }
  const padv = (hi - lo) * 0.1;     // padded range, for plotting (breathing room)
  lo -= padv; hi += padv;

  const xOf = (year) => {
    const i = years.indexOf(year);
    return mL + (years.length === 1 ? plotW / 2 : (i / (years.length - 1)) * plotW);
  };
  // invertY: low value (rank 1) at the top; normal: high value at the top.
  const yOf = (v) => {
    const t = (v - lo) / (hi - lo);
    return opts.invertY ? (mT + t * plotH) : (mT + (1 - t) * plotH);
  };

  const axes =
    `<line x1="${mL}" y1="${mT}" x2="${mL}" y2="${mT + plotH}" stroke="#ccc"/>` +
    `<line x1="${mL}" y1="${mT + plotH}" x2="${mL + plotW}" y2="${mT + plotH}" stroke="#ccc"/>`;

  // Top/bottom Y labels — actual data extremes; for invertY the top is the
  // best (lowest) value.
  const topVal = opts.invertY ? dataLo : dataHi;
  const botVal = opts.invertY ? dataHi : dataLo;
  const fmtY = opts.fmtY || ((v) => String(Math.round(v)));
  const yLabels =
    `<text x="${mL - 4}" y="${mT + 7}" text-anchor="end" font-size="9" fill="#666">${fmtY(topVal)}</text>` +
    `<text x="${mL - 4}" y="${mT + plotH}" text-anchor="end" font-size="9" fill="#666">${fmtY(botVal)}</text>`;

  const xLabels = years.map(y =>
    `<text x="${xOf(y).toFixed(1)}" y="${H - 5}" text-anchor="middle" font-size="9" fill="#666">${y}</text>`
  ).join('');

  const lines = opts.series.map(s => {
    const coords = years
      .map(y => (s.points[y] == null) ? null : `${xOf(y).toFixed(1)},${yOf(s.points[y]).toFixed(1)}`)
      .filter(Boolean);
    if (!coords.length) return '';
    const poly = `<polyline fill="none" stroke="${s.colour}" stroke-width="${s.markers ? 2 : 1.4}" points="${coords.join(' ')}"/>`;
    const dots = s.markers
      ? years.map(y => (s.points[y] == null) ? '' :
          `<circle cx="${xOf(y).toFixed(1)}" cy="${yOf(s.points[y]).toFixed(1)}" r="2.3" fill="${s.colour}"/>`).join('')
      : '';
    return poly + dots;
  }).join('');

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${axes}${yLabels}${xLabels}${lines}</svg>`;
}

// Shared subject legend (coloured dots + names), used under chart groups.
function subjectLegendHTML(subjects) {
  return subjects.map(s =>
    `<span class="legend-item" style="color:${SUBJECT_COLOURS[s]}">●&nbsp;${t('subject_' + s)}</span>`
  ).join(' ');
}

// -----------------------------------------------------------------------------
// Data loading

let baseData = null;
const metricCache = {};  // metric -> parsed JSON

async function loadBaseData() {
  if (baseData) return baseData;
  const res = await fetch('data/schools-base.json');
  if (!res.ok) throw new Error(`schools-base.json: HTTP ${res.status}`);
  baseData = await res.json();
  return baseData;
}

async function loadMetricData(metric) {
  if (metricCache[metric]) return metricCache[metric];
  const res = await fetch(`data/schools-${metric}.json`);
  if (!res.ok) throw new Error(`schools-${metric}.json: HTTP ${res.status}`);
  metricCache[metric] = await res.json();
  return metricCache[metric];
}

// -----------------------------------------------------------------------------
// URL state + localStorage persistence

const STORAGE_KEY = 'schools-app-prefs';

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writePref(key, value) {
  const prefs = readPrefs();
  if (value == null) delete prefs[key]; else prefs[key] = value;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch {}
}

function getURLParams() {
  return new URLSearchParams(window.location.search);
}

function setURLParams(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || v === false) continue;
    usp.set(k, String(v));
  }
  const qs = usp.toString();
  const url = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
  window.history.replaceState(null, '', url);
}

// Pick a value from URL > storage > default, validating against allowed list.
function resolvePref(name, allowed) {
  const url = getURLParams().get(name);
  if (url && (!allowed || allowed.includes(url))) return url;
  const stored = readPrefs()[name];
  if (stored && (!allowed || allowed.includes(stored))) return stored;
  return DEFAULTS[name];
}

// -----------------------------------------------------------------------------
// i18n

const I18N = {
  pl: {
    appTitle: 'Mapa szkół podstawowych — Mazowieckie',
    navMap: 'Mapa',
    navRanking: 'Ranking',
    navMethodology: 'Metodologia',
    methodologyTitle: 'Metodologia',
    methodologyComingSoon: 'Opis metodologii w przygotowaniu.',
    methodologyIntro: 'Tu znajdzie się opis jak liczone są wyniki i pozycje: metryki, normalizacja względem średniej województwa, agregacja po latach oraz skala kolorów. Na razie szczegóły są w pliku CLAUDE.md w repozytorium.',
    sectionView: 'Widok',
    sectionFilters: 'Filtry',
    sectionSearch: 'Szukaj adresu',
    sectionLegend: 'Legenda',
    labelSubject: 'Przedmiot',
    labelMetric: 'Metryka',
    labelPublic: 'Publiczna',
    publicAll: 'Wszystkie',
    publicYes: 'Tak',
    publicNo: 'Nie',
    labelThreshold: 'Min. wynik',
    labelMinYears: 'Min. liczba lat danych',
    searchPlaceholder: 'np. Marszałkowska 1, Warszawa',
    searchButton: 'Szukaj',
    searchHelp: 'Geokodowanie: OpenStreetMap Nominatim. Wyszukiwanie tylko po kliknięciu „Szukaj”.',
    searchNotFound: 'Nie znaleziono adresu.',
    searchError: 'Błąd geokodowania.',
    legendSatGreen: 'Bardzo dobry (≥ +1.5σ)',
    legendGreen: 'Dobry (+0.33σ … +1.5σ)',
    legendYellow: 'Przeciętny (±0.33σ)',
    legendRed: 'Słaby (−1.5σ … −0.33σ)',
    legendSatRed: 'Bardzo słaby (≤ −1.5σ)',
    metric_mean: 'Średnia',
    metric_median: 'Mediana',
    metric_diff_mean: 'Różnica od średniej',
    metric_unit_norm_diff_mean: 'Wynik znormalizowany',
    subject_polski: 'Polski',
    subject_matematyka: 'Matematyka',
    subject_angielski: 'Angielski',
    subject_composite_min: 'Najsłabszy przedmiot',
    popupPublic: 'Publiczna',
    popupPrivate: 'Niepubliczna',
    popupYears: 'lat danych',
    popupScore: 'Wynik',
    popupRank: 'Miejsce',
    popupPct: 'Percentyl',
    popupComposite: 'Najsłabszy z 3',
    warnShortHistory: 'Krótka historia (< 3 lata) — wyniki mniej pewne.',
    warnVolatile: 'Duże wahania roczne — wynik zależy od wyboru lat.',
    showHistory: 'Pokaż historię roczną',
    loadingHistory: 'Ładowanie historii…',
    rankingTitle: 'Ranking szkół — Mazowieckie',
    rankingNameSearch: 'Szukaj po nazwie',
    rankingSearchPlaceholder: 'np. STO, Vizja, Słupica',
    lastKRow: (k) => `ostatnie ${k}`,
    rankingView: 'Widok danych',
    rankingViewParam: 'Parametr widoku',
    rankingViewBase: 'wszystkie lata (base)',
    rankingViewLastK: 'ostatnie k lat (last_k)',
    rankingViewSingleYear: 'jeden rok (single_year)',
    rankingViewLOO: 'bez jednego roku (LOO)',
    colName: 'Szkoła',
    colStreet: 'Ulica',
    colTown: 'Miejscowość',
    colPublic: 'Publiczna',
    colNYears: 'Lata',
    colRank: 'Miejsce',
    colLOORange: 'Zakres pozycji (LOO)',
    colSingleRange: 'Zakres pozycji (pojed. lata)',
    helpLOORange: 'Zakres miejsc w rankingu, gdy z obliczeń pominiemy po kolei każdy rok (jackknife „leave-one-out”). Szeroki zakres = pozycja mocno zależy od tego, który rok uwzględnimy.',
    helpSingleRange: 'Zakres miejsc w rankingu liczonych z każdego pojedynczego roku osobno. Szeroki zakres = duże wahania wyniku rok do roku.',
    colScore: 'Wynik',
    colClass: 'Klasa',
    clickHint: 'Kliknij wiersz, aby rozwinąć szczegóły szkoły.',
    detailLoadHistory: 'Wczytaj dane roczne (~0.8 MB)',
    detailClassByYear: (s) => `Klasa (${s}) po latach`,
    detailViewLOO: 'LOO',
    detailViewSingle: 'pojedyncze lata',
    detailShowTables: 'Pokaż tabele liczbowe',
    detailHideTables: 'Ukryj tabele liczbowe',
    detailSecSingle: 'Pojedyncze lata',
    detailSecLOO: 'LOO (z pominięciem roku)',
    detailSecLastK: 'Ostatnie k lat',
    offMap: 'brak lokalizacji',
    rowsShown: (n, total) => `${n} z ${total} szkół`,
    historyOptIn: 'Wczytaj zakresy rankingu (LOO, pojedyncze lata) i widoki — ~0.8 MB',
    historyLoading: 'Ładowanie szczegółowych danych…',
    publicYesShort: 'Tak',
    publicNoShort: 'Nie',
    langPL: 'PL',
    langEN: 'EN',
  },
  en: {
    appTitle: 'Primary schools map — Mazowieckie',
    navMap: 'Map',
    navRanking: 'Ranking',
    navMethodology: 'Methodology',
    methodologyTitle: 'Methodology',
    methodologyComingSoon: 'Methodology writeup in preparation.',
    methodologyIntro: 'This page will explain how scores and ranks are computed: the metrics, normalisation against the voivodeship mean, aggregation across years, and the colour scale. For now the details live in CLAUDE.md in the repository.',
    sectionView: 'View',
    sectionFilters: 'Filters',
    sectionSearch: 'Address search',
    sectionLegend: 'Legend',
    labelSubject: 'Subject',
    labelMetric: 'Metric',
    labelPublic: 'Public',
    publicAll: 'All',
    publicYes: 'Yes',
    publicNo: 'No',
    labelThreshold: 'Min. score',
    labelMinYears: 'Min. years of data',
    searchPlaceholder: 'e.g. Marszałkowska 1, Warszawa',
    searchButton: 'Search',
    searchHelp: 'Geocoding: OpenStreetMap Nominatim. Searches only on submit.',
    searchNotFound: 'Address not found.',
    searchError: 'Geocoding error.',
    legendSatGreen: 'Excellent (≥ +1.5σ)',
    legendGreen: 'Good (+0.33σ … +1.5σ)',
    legendYellow: 'Average (±0.33σ)',
    legendRed: 'Weak (−1.5σ … −0.33σ)',
    legendSatRed: 'Very weak (≤ −1.5σ)',
    metric_mean: 'Mean',
    metric_median: 'Median',
    metric_diff_mean: 'Difference from mean',
    metric_unit_norm_diff_mean: 'Normalised score',
    subject_polski: 'Polish',
    subject_matematyka: 'Maths',
    subject_angielski: 'English',
    subject_composite_min: 'Weakest subject',
    popupPublic: 'Public',
    popupPrivate: 'Private',
    popupYears: 'years of data',
    popupScore: 'Score',
    popupRank: 'Rank',
    popupPct: 'Percentile',
    popupComposite: 'Weakest of 3',
    warnShortHistory: 'Short history (< 3 years) — less certain.',
    warnVolatile: 'High year-to-year volatility — score depends on which years are included.',
    showHistory: 'Show year-by-year history',
    loadingHistory: 'Loading history…',
    rankingTitle: 'School ranking — Mazowieckie',
    rankingNameSearch: 'Search by name',
    rankingSearchPlaceholder: 'e.g. STO, Vizja, Słupica',
    lastKRow: (k) => `last ${k}`,
    rankingView: 'View',
    rankingViewParam: 'View parameter',
    rankingViewBase: 'all years (base)',
    rankingViewLastK: 'last k years (last_k)',
    rankingViewSingleYear: 'single year (single_year)',
    rankingViewLOO: 'leave-one-out (LOO)',
    colName: 'School',
    colStreet: 'Street',
    colTown: 'Town',
    colPublic: 'Public',
    colNYears: 'Years',
    colRank: 'Rank',
    colLOORange: 'Rank range (LOO)',
    colSingleRange: 'Rank range (single-year)',
    helpLOORange: 'Range of ranks when each year is left out in turn (leave-one-out jackknife). A wide range means the position depends a lot on which year is included.',
    helpSingleRange: 'Range of ranks computed from each single year alone. A wide range means big year-to-year swings.',
    colScore: 'Score',
    colClass: 'Class',
    clickHint: 'Click a row to expand school details.',
    detailLoadHistory: 'Load year-by-year data (~0.8 MB)',
    detailClassByYear: (s) => `Class (${s}) by year`,
    detailViewLOO: 'LOO',
    detailViewSingle: 'single years',
    detailShowTables: 'Show numeric tables',
    detailHideTables: 'Hide numeric tables',
    detailSecSingle: 'Single years',
    detailSecLOO: 'LOO (year left out)',
    detailSecLastK: 'Last k years',
    offMap: 'no location',
    rowsShown: (n, total) => `${n} of ${total} schools`,
    historyOptIn: 'Load rank ranges (LOO, single years) and views — ~0.8 MB',
    historyLoading: 'Loading detailed data…',
    publicYesShort: 'Yes',
    publicNoShort: 'No',
    langPL: 'PL',
    langEN: 'EN',
  },
};

let currentLang = 'pl';

function t(key, ...args) {
  const v = (I18N[currentLang] && I18N[currentLang][key]) || I18N.pl[key] || key;
  return (typeof v === 'function') ? v(...args) : v;
}

function applyI18N(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n'));
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    const spec = el.getAttribute('data-i18n-attr');
    const [attr, key] = spec.split('|');
    if (attr && key) el.setAttribute(attr, t(key));
  }
}

function setLang(lang) {
  currentLang = (lang === 'en') ? 'en' : 'pl';
  document.documentElement.lang = currentLang;
  applyI18N();
}

// Wire the #lang-toggle button (present in every page's nav). The button shows
// the language you'd switch TO (EN while on PL, PL while on EN). On click it
// flips the language, re-translates static [data-i18n] labels (via setLang),
// persists the choice, then calls onAfterChange so the page can re-render its
// dynamic, language-dependent content (select options, table, popups) — that
// part differs per page, so each passes its own callback.
function wireLangToggle(onAfterChange) {
  const btn = document.getElementById('lang-toggle');
  if (!btn) return;
  // Show the CURRENT language (PL while on Polish), not the target.
  const relabel = () => { btn.textContent = (currentLang === 'pl') ? 'PL' : 'EN'; };
  relabel();
  btn.addEventListener('click', () => {
    setLang(currentLang === 'pl' ? 'en' : 'pl');
    writePref('lang', currentLang);
    relabel();
    if (onAfterChange) onAfterChange();
  });
}

// -----------------------------------------------------------------------------
// Helpers used by both pages

function fillMetricSelect(selectEl, currentMetric) {
  selectEl.innerHTML = '';
  for (const m of METRICS) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = t('metric_' + m);
    if (m === currentMetric) { opt.selected = true; opt.setAttribute('selected', ''); }
    selectEl.appendChild(opt);
  }
}

function fillSubjectSelect(selectEl, currentSubject) {
  selectEl.innerHTML = '';
  for (const s of SUBJECTS) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = t('subject_' + s);
    if (s === currentSubject) { opt.selected = true; opt.setAttribute('selected', ''); }
    selectEl.appendChild(opt);
  }
}

function fmtScore(score, metric) {
  if (score == null || Number.isNaN(score)) return '—';
  if (metric === 'mean' || metric === 'median') return score.toFixed(1);
  if (metric === 'diff_mean') return (score >= 0 ? '+' : '') + score.toFixed(1);
  return (score >= 0 ? '+' : '') + score.toFixed(3);
}

// Same as fmtScore but renders the decimals in a muted/smaller span so the
// ranking table can show 3 decimals without visually shouting them — the
// integer part is the main read, the decimals are for breaking apparent ties.
// Returns HTML; only use in trusted DOM (we control the score values).
function fmtScoreHTML(score, metric) {
  if (score == null || Number.isNaN(score)) return '—';
  let formatted;
  if (metric === 'mean' || metric === 'median') {
    formatted = score.toFixed(3);
  } else {
    formatted = (score >= 0 ? '+' : '') + score.toFixed(3);
  }
  const dotIdx = formatted.indexOf('.');
  if (dotIdx < 0) return formatted;
  const integer = formatted.slice(0, dotIdx);
  const decimal = formatted.slice(dotIdx);
  return `${integer}<span class="dec">${decimal}</span>`;
}

function isPublic(s) { return s.is_public === 'Tak'; }
