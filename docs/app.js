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
// Colour mapping

function colourFor(score, centre, sigma) {
  if (score == null || sigma == null || sigma === 0) return COLOURS.missing;
  const z = (score - centre) / sigma;
  if (z <= -1.5)   return COLOURS.satRed;
  if (z <  -0.33)  return COLOURS.red;
  if (z <=  0.33)  return COLOURS.yellow;
  if (z <   1.5)   return COLOURS.green;
  return COLOURS.satGreen;
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
    colLOORange: 'Zakres LOO',
    colSingleRange: 'Zakres pojedynczych lat',
    colScore: 'Wynik',
    offMap: 'brak lokalizacji',
    rowsShown: (n, total) => `${n} z ${total} szkół`,
    historyOptIn: 'Pokaż szczegółową historię (pobiera ~0.8 MB)',
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
    colLOORange: 'LOO range',
    colSingleRange: 'Single-year range',
    colScore: 'Score',
    offMap: 'no location',
    rowsShown: (n, total) => `${n} of ${total} schools`,
    historyOptIn: 'Show detailed history (downloads ~0.8 MB)',
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

function isPublic(s) { return s.is_public === 'Tak'; }
