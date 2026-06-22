// Map page: Leaflet + Carto Positron tiles, coloured school markers with
// clustering, filters, address search, popups, URL state + persistence.

(function () {
  // Touch-primary device? `matchMedia('(pointer: coarse)')` reflects whether
  // the main input is a finger, which is more reliable than UA sniffing
  // (L.Browser.mobile). Used to relax popup behaviour on touch (no autoPan,
  // no click-to-close — see createMarker).
  const IS_TOUCH = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  // ---------------------------------------------------------------------------
  // State (single source of truth for the page)

  const state = {
    metric: DEFAULTS.metric,
    subject: DEFAULTS.subject,
    publicFilter: 'all',          // 'all' | 'tak' | 'nie'
    threshold: null,              // number; null means no threshold filter
    minYears: 1,                  // 1..5
    selectedSchool: null,         // rspo (number) or null
    lang: DEFAULTS.lang,
    historyOptIn: false,
    gradient: false,              // continuous colour in B/D bands (vs 5 discrete classes)
  };

  let map = null;
  let clusterGroup = null;
  let markersByRspo = new Map();  // rspo -> Leaflet circleMarker
  let historyData = null;         // metric-keyed cache for opt-in history

  // ---------------------------------------------------------------------------
  // Initial state resolution: URL > localStorage > default (§9)

  function resolveInitialState() {
    state.metric   = resolvePref('metric',  METRICS);
    state.subject  = resolvePref('subject', SUBJECTS);
    state.lang     = resolvePref('lang',    ['pl', 'en']);

    const url = getURLParams();
    const pub = url.get('public');
    if (pub === 'tak' || pub === 'nie' || pub === 'all') state.publicFilter = pub;

    const thr = parseFloat(url.get('threshold'));
    state.threshold = Number.isFinite(thr) ? thr : null;

    const my = parseInt(url.get('min_years'), 10);
    if (Number.isInteger(my) && my >= 1 && my <= 5) state.minYears = my;

    const school = parseInt(url.get('school'), 10);
    state.selectedSchool = Number.isInteger(school) ? school : null;

    state.historyOptIn = !!readPrefs().history_optin;

    // gradient: URL > localStorage > default(false)
    const gradParam = getURLParams().get('gradient');
    if (gradParam === '1') state.gradient = true;
    else if (gradParam === '0') state.gradient = false;
    else state.gradient = !!readPrefs().gradient;
  }

  function syncURL() {
    const range = baseData?.metadata.slider_ranges[state.metric];
    const thresholdActive = range && state.threshold != null && state.threshold > range.min;
    setURLParams({
      metric:     state.metric  !== DEFAULTS.metric  ? state.metric  : null,
      subject:    state.subject !== DEFAULTS.subject ? state.subject : null,
      public:     state.publicFilter !== 'all' ? state.publicFilter : null,
      threshold:  thresholdActive ? state.threshold : null,
      min_years:  state.minYears > 1 ? state.minYears : null,
      school:     state.selectedSchool,
      lang:       state.lang !== DEFAULTS.lang ? state.lang : null,
      gradient:   state.gradient ? '1' : null,
    });
  }

  // ---------------------------------------------------------------------------
  // Map setup

  function initMap() {
    map = L.map('map', { zoomControl: true, preferCanvas: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);
  }

  // ---------------------------------------------------------------------------
  // Markers + clustering

  function createMarker(school) {
    const marker = L.circleMarker([school.lat, school.lon], {
      radius: 7,
      weight: 1,
      color: '#222',
      fillOpacity: 0.85,
    });
    marker._school = school;  // attach for cluster colour access
    marker.on('popupopen', () => {
      state.selectedSchool = school.rspo;
      syncURL();
    });
    marker.on('popupclose', () => {
      if (state.selectedSchool === school.rspo) {
        state.selectedSchool = null;
        syncURL();
      }
    });
    // Function-form: re-rendered each time the popup opens, so it reflects the
    // current metric/subject/history without an empty-flash on first open.
    marker.bindPopup(() => renderPopup(school), {
      maxWidth: 360,
      minWidth: 280,
      // Mobile bug fix: when the user taps "Pokaż historię roczną", the popup
      // grows tall after the async load. With autoPan on, Leaflet then pans the
      // map to fit the taller popup — on touch that map movement, landing under
      // the just-tapped finger, was closing the popup right after it opened
      // (worse the longer the school's history, because taller popup = bigger
      // pan). Disable autoPan on touch devices; the max-height + internal scroll
      // (see .leaflet-popup-content in style.css) keeps a tall popup usable
      // without needing to pan. Desktop keeps autoPan — the bug is touch-only
      // and autoPan is genuinely useful there.
      autoPan: !IS_TOUCH,
      // On touch, dragging to scroll a tall popup ends with a tap that lands on
      // the map, and the map's default closePopupOnClick then shuts the popup.
      // Since reading a long history requires that drag, disable click-to-close
      // on touch: the popup closes only via its × button (enlarged for touch in
      // style.css). Switching schools by tapping another marker still works —
      // that's a marker tap, not an empty-map tap. Desktop keeps click-to-close.
      closeOnClick: !IS_TOUCH,
    });
    return marker;
  }

  function scoreOf(school, metric, subject) {
    return school.scores?.[metric]?.[subject]?.score ?? null;
  }

  function colourOfSchool(school, metric, subject) {
    const score = scoreOf(school, metric, subject);
    const centre = baseData.metadata.sigma_centre[metric][subject];
    const sigma  = baseData.metadata.sigma[metric][subject];
    const { p1, p99 } = scoreExtent(metric, subject);
    return colourFor(score, centre, sigma, p1, p99, state.gradient);
  }

  function applyMarkerColour(marker) {
    const fill = colourOfSchool(marker._school, state.metric, state.subject);
    marker.setStyle({ fillColor: fill });
  }

  function clusterIcon(cluster) {
    const children = cluster.getAllChildMarkers();
    let sum = 0, n = 0;
    for (const m of children) {
      const sc = scoreOf(m._school, state.metric, state.subject);
      if (sc != null) { sum += sc; n++; }
    }
    const centre = baseData.metadata.sigma_centre[state.metric][state.subject];
    const sigma  = baseData.metadata.sigma[state.metric][state.subject];
    const { p1, p99 } = scoreExtent(state.metric, state.subject);
    const fill = n > 0 ? colourFor(sum / n, centre, sigma, p1, p99, state.gradient) : COLOURS.missing;
    const count = children.length;
    // Size scales gently with count.
    const size = Math.min(56, 28 + Math.round(Math.sqrt(count) * 2));
    const html = `<div class="school-cluster" style="background:${fill};width:${size}px;height:${size}px;">${count}</div>`;
    return L.divIcon({ html, className: '', iconSize: [size, size] });
  }

  function buildClusterGroup() {
    clusterGroup = L.markerClusterGroup({
      chunkedLoading: true,
      showCoverageOnHover: false,
      // Tighter than the default 80 so Warsaw breaks into multiple clusters
      // by neighbourhood as soon as the user zooms in past the city level,
      // instead of staying one big blob until you zoom to the street level.
      maxClusterRadius: 30,
      // At and beyond city-level zoom every school shows individually — at
      // that point the user is looking for specific schools, not aggregate
      // patterns, so clustering only obscures.
      disableClusteringAtZoom: 14,
      spiderfyOnMaxZoom: false,
      // Keep all markers in the layer even when off-screen. By default
      // markercluster removes markers outside the (buffered) viewport for
      // performance — but removing a marker closes its open popup, so panning
      // the map to read a popup was closing that popup. With canvas rendering
      // (preferCanvas) ~1,700 circle markers cost little, so we keep them all.
      removeOutsideVisibleBounds: false,
      iconCreateFunction: clusterIcon,
    });
    map.addLayer(clusterGroup);
  }

  function plotAllMarkers() {
    markersByRspo.clear();
    const latlngs = [];
    for (const s of baseData.schools) {
      if (s.lat == null || s.lon == null) continue;
      const marker = createMarker(s);
      applyMarkerColour(marker);
      markersByRspo.set(s.rspo, marker);
      latlngs.push([s.lat, s.lon]);
    }
    refreshFilters();  // adds visible markers to cluster
    if (latlngs.length) map.fitBounds(latlngs, { padding: [20, 20] });
  }

  // ---------------------------------------------------------------------------
  // Filters: figure out which schools pass, push to cluster

  function schoolPassesFilters(school) {
    if (school.lat == null || school.lon == null) return false;
    if (state.publicFilter === 'tak' && !isPublic(school)) return false;
    if (state.publicFilter === 'nie' &&  isPublic(school)) return false;
    if (school.n_years < state.minYears) return false;
    if (state.threshold != null) {
      const sc = scoreOf(school, state.metric, state.subject);
      if (sc == null || sc < state.threshold) return false;
    }
    return true;
  }

  function refreshFilters() {
    clusterGroup.clearLayers();
    const visible = [];
    for (const s of baseData.schools) {
      const marker = markersByRspo.get(s.rspo);
      if (!marker) continue;
      if (schoolPassesFilters(s)) visible.push(marker);
    }
    clusterGroup.addLayers(visible);
    updateFilterSummary(visible.length);
  }

  function updateFilterSummary(nVisible) {
    const total = baseData.schools.filter(s => s.lat != null).length;
    document.getElementById('filter-summary').textContent =
      t('rowsShown', nVisible, total);
  }

  function recolourAll() {
    for (const marker of markersByRspo.values()) applyMarkerColour(marker);
    // Cluster colours redraw when the cluster icons regenerate; force it:
    clusterGroup.refreshClusters();
  }

  // ---------------------------------------------------------------------------
  // Popup rendering

  function renderPopup(school) {
    const { metric } = state;
    const pub = isPublic(school) ? t('popupPublic') : t('popupPrivate');
    const addr = [school.miejscowosc, school.ulica_nr].filter(Boolean).join(', ');

    const rowsHTML = CORE_SUBJECTS.map(subj => {
      const cell = school.scores[metric]?.[subj];
      return `<tr>
        <th>${t('subject_' + subj)}</th>
        <td class="num">${fmtScore(cell?.score, metric)}</td>
        <td class="num">#${cell?.rank ?? '—'}</td>
        <td class="num">${cell?.pct != null ? cell.pct.toFixed(1) + '%' : '—'}</td>
      </tr>`;
    }).join('');

    const composite = school.scores[metric]?.composite_min;
    const compositeHTML = `<tr class="composite-row">
      <th>${t('popupComposite')}</th>
      <td class="num">${fmtScore(composite?.score, metric)}</td>
      <td class="num">#${composite?.rank ?? '—'}</td>
      <td class="num">${composite?.pct != null ? composite.pct.toFixed(1) + '%' : '—'}</td>
    </tr>`;

    const warnings = warningsFor(school);
    const warnHTML = warnings.length
      ? `<div class="warning">⚠️ ${warnings.join(' ')}</div>` : '';

    const histHTML = renderHistorySection(school);

    return `
      <div class="popup-school">
        <h3>${escapeHTML(school.name)}</h3>
        <p class="addr">${escapeHTML(addr)} · ${pub} · ${school.n_years} ${t('popupYears')}</p>
        <table>
          <thead><tr><th></th><th>${t('popupScore')}</th><th>${t('popupRank')}</th><th>${t('popupPct')}</th></tr></thead>
          <tbody>${rowsHTML}${compositeHTML}</tbody>
        </table>
        ${warnHTML}
        ${histHTML}
      </div>`;
  }

  function escapeHTML(s) {
    if (s == null) return '';
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function warningsFor(school) {
    const out = [];
    if (school.n_years < 3) out.push(t('warnShortHistory'));
    // LOO-range warning (§7) needs a metric file. Compute lazily once loaded.
    const histPerMetric = historyData?.[state.metric]?.schools?.[String(school.rspo)];
    if (histPerMetric && school.n_years >= 3) {
      const loo = histPerMetric.composite_min?.loo || {};
      const looScores = Object.values(loo).map(v => v?.score).filter(v => v != null);
      if (looScores.length >= 2) {
        const range = Math.max(...looScores) - Math.min(...looScores);
        const sigma = baseData.metadata.sigma[state.metric].composite_min;
        if (range > sigma) out.push(t('warnVolatile'));
      }
    }
    return out;
  }

  function renderHistorySection(school) {
    if (school.n_years < 2) return '';
    const hist = historyData?.[state.metric]?.schools?.[String(school.rspo)];
    if (!hist) {
      return `<button type="button" class="show-history-btn" data-rspo="${school.rspo}">${t('showHistory')}</button>`;
    }
    return renderHistoryTableAndSparkline(school, hist);
  }

  function renderHistoryTableAndSparkline(school, hist) {
    const years = baseData.metadata.years_in_data;
    const subjects = ['polski', 'matematyka', 'angielski', 'composite_min'];

    // Build single-year matrix: rows=years (only present), cols=subjects.
    const yearsPresent = years.filter(y => {
      return subjects.some(subj => hist[subj]?.single_year?.[String(y)] != null);
    });

    const tableRows = yearsPresent.map(y => {
      const cells = subjects.map(subj => {
        const v = hist[subj]?.single_year?.[String(y)]?.score;
        return `<td class="num">${fmtScore(v, state.metric)}</td>`;
      }).join('');
      return `<tr><th>${y}</th>${cells}</tr>`;
    }).join('');

    // last_k summary rows (k = 2..n-1)
    const ks = Object.keys(hist[subjects[0]]?.last_k || {}).sort((a, b) => +a - +b);
    const lastKRows = ks.map(k => {
      const cells = subjects.map(subj => {
        const v = hist[subj]?.last_k?.[k]?.score;
        return `<td class="num">${fmtScore(v, state.metric)}</td>`;
      }).join('');
      return `<tr><th>${t('lastKRow', k)}</th>${cells}</tr>`;
    }).join('');

    const header = `<tr><th></th>${subjects.map(s => `<th>${t('subject_' + s)}</th>`).join('')}</tr>`;

    const spark = sparklineSVG(school, hist, yearsPresent);

    return `
      <div class="history">
        ${spark}
        <table class="history-table">
          <thead>${header}</thead>
          <tbody>${tableRows}${lastKRows ? '<tr class="sep"><td colspan="5"></td></tr>' + lastKRows : ''}</tbody>
        </table>
      </div>`;
  }

  function sparklineSVG(school, hist, yearsPresent) {
    if (yearsPresent.length < 2) return '';
    const subjects = ['polski', 'matematyka', 'angielski', 'composite_min'];
    const series = subjects.map(subj => ({
      colour: SUBJECT_COLOURS[subj],
      // composite_min equals the weakest subject each year, so a line would sit
      // exactly on that subject's line and hide it — draw it as dots only.
      pointsOnly: subj === 'composite_min',
      points: Object.fromEntries(
        yearsPresent.map(y => [y, hist[subj]?.single_year?.[String(y)]?.score ?? null])),
    }));
    const svg = lineChartSVG({
      years: yearsPresent,
      series,
      invertY: false,
      fmtY: (v) => fmtScore(v, state.metric),
      width: 260,
      height: 120,
    });
    return `<div class="sparkline">${svg}<div class="spark-legend">${subjectLegendHTML(subjects)}</div></div>`;
  }

  // ---------------------------------------------------------------------------
  // Threshold slider — re-bound when metric changes (different scale)

  function syncThresholdSlider() {
    const slider = document.getElementById('threshold-slider');
    const display = document.getElementById('threshold-display');
    const range = baseData.metadata.slider_ranges[state.metric];
    slider.min = range.min;
    slider.max = range.max;
    slider.step = range.step;
    // No threshold filter on a fresh visit: slider sits at min (= include all).
    // If a URL-provided threshold is in range, honour it; otherwise reset to min.
    let v = state.threshold;
    if (v == null || v < range.min || v > range.max) v = range.min;
    state.threshold = v;
    slider.value = v;
    display.textContent = (v === range.min) ? '—' : fmtScore(v, state.metric);
  }

  async function onMetricChange(newMetric) {
    state.metric = newMetric;
    // Reset threshold when metric changes (scales differ; §5).
    state.threshold = baseData.metadata.slider_ranges[newMetric].min;
    writePref('metric', newMetric);
    syncURL();
    syncThresholdSlider();
    recolourAll();
    refreshFilters();
    if (state.selectedSchool != null) {
      // History (sparkline + table) comes from the per-metric file. If the user
      // already opted into history, load the NEW metric's file before reopening
      // so the popup shows the new metric's history — otherwise it would fall
      // back to the "Pokaż historię" button and the user couldn't read the new
      // metric's year-by-year data without clicking again.
      if (state.historyOptIn) await ensureHistoryLoaded();
      reopenSelectedPopup();
    }
  }

  function onSubjectChange(newSubject) {
    state.subject = newSubject;
    writePref('subject', newSubject);
    syncURL();
    recolourAll();
    refreshFilters();
    if (state.selectedSchool != null) reopenSelectedPopup();
  }

  function reopenSelectedPopup() {
    const marker = markersByRspo.get(state.selectedSchool);
    if (marker) marker.setPopupContent(renderPopup(marker._school));
  }

  // ---------------------------------------------------------------------------
  // Address search (Nominatim) — only on submit (§3)

  async function doAddressSearch(query) {
    const url = new URL(NOMINATIM_BASE);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('countrycodes', 'pl');
    url.searchParams.set('viewbox', MAZ_VIEWBOX);
    url.searchParams.set('bounded', '0');
    url.searchParams.set('limit', '1');
    const res = await fetch(url.toString(), { headers: { 'Accept-Language': 'pl' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const arr = await res.json();
    if (!arr || !arr.length) return null;
    return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) };
  }

  function wireSearch() {
    const form = document.getElementById('search-form');
    const input = document.getElementById('search-input');
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      try {
        const found = await doAddressSearch(q);
        if (!found) { alert(t('searchNotFound')); return; }
        map.setView([found.lat, found.lon], 14);
      } catch (e) {
        console.error(e);
        alert(t('searchError'));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // History opt-in fetch

  async function ensureHistoryLoaded() {
    if (historyData?.[state.metric]) return;
    historyData = historyData || {};
    // Show a tiny loading hint in panel summary.
    const summary = document.getElementById('filter-summary');
    const prev = summary.textContent;
    summary.textContent = t('historyLoading');
    try {
      historyData[state.metric] = await loadMetricData(state.metric);
      writePref('history_optin', true);
      state.historyOptIn = true;
    } finally {
      summary.textContent = prev;
    }
  }

  function wireHistoryButtons() {
    // Delegate from the map container so dynamic popup buttons get caught.
    document.getElementById('map').addEventListener('click', async (ev) => {
      const btn = ev.target.closest('.show-history-btn');
      if (!btn) return;
      const rspo = parseInt(btn.getAttribute('data-rspo'), 10);
      btn.disabled = true;
      btn.textContent = t('loadingHistory');
      await ensureHistoryLoaded();
      const marker = markersByRspo.get(rspo);
      if (marker) marker.setPopupContent(renderPopup(marker._school));
    });
  }

  // ---------------------------------------------------------------------------
  // Wiring UI controls

  function wireControls() {
    const subjectSel = document.getElementById('subject-select');
    const metricSel  = document.getElementById('metric-select');
    fillSubjectSelect(subjectSel, state.subject);
    fillMetricSelect(metricSel,   state.metric);

    subjectSel.addEventListener('change', e => onSubjectChange(e.target.value));
    metricSel .addEventListener('change', e => onMetricChange(e.target.value));

    // Public/private radios
    for (const r of document.querySelectorAll('input[name="public"]')) {
      r.removeAttribute('checked');
      if (r.value === state.publicFilter) { r.checked = true; r.setAttribute('checked', ''); }
      r.addEventListener('change', () => {
        state.publicFilter = r.value;
        syncURL();
        refreshFilters();
      });
    }

    // Threshold slider
    syncThresholdSlider();
    const slider = document.getElementById('threshold-slider');
    const display = document.getElementById('threshold-display');
    slider.addEventListener('input', () => {
      state.threshold = parseFloat(slider.value);
      const range = baseData.metadata.slider_ranges[state.metric];
      display.textContent = (state.threshold === range.min)
        ? '—' : fmtScore(state.threshold, state.metric);
      syncURL();
      refreshFilters();
    });

    // Min years slider
    const myr = document.getElementById('min-years-slider');
    const myrDisp = document.getElementById('min-years-display');
    myr.value = state.minYears;
    myrDisp.textContent = state.minYears;
    myr.addEventListener('input', () => {
      state.minYears = parseInt(myr.value, 10);
      myrDisp.textContent = state.minYears;
      syncURL();
      refreshFilters();
    });

    // Gradient toggle (continuous colour in B/D bands)
    const gradCb = document.getElementById('gradient-toggle');
    gradCb.checked = state.gradient;
    if (state.gradient) gradCb.setAttribute('checked', '');
    gradCb.addEventListener('change', () => {
      state.gradient = gradCb.checked;
      writePref('gradient', state.gradient);
      syncURL();
      recolourAll();
    });

    wireSearch();
    wireHistoryButtons();
    wireNavLinks();

    // Language toggle: re-translate the dynamic, JS-built content that
    // applyI18N (static [data-i18n] only) can't reach — the metric/subject
    // selects, the filter-count summary, and any open popup.
    wireLangToggle(() => {
      state.lang = currentLang;
      syncURL();
      fillSubjectSelect(subjectSel, state.subject);
      fillMetricSelect(metricSel, state.metric);
      refreshFilters();
      if (state.selectedSchool != null) reopenSelectedPopup();
    });
  }

  function wireNavLinks() {
    // Carry metric/subject/lang to the ranking page nav link.
    const link = document.querySelector('.topnav nav a[href="ranking.html"]');
    if (!link) return;
    const update = () => {
      const usp = new URLSearchParams();
      if (state.metric  !== DEFAULTS.metric)  usp.set('metric',  state.metric);
      if (state.subject !== DEFAULTS.subject) usp.set('subject', state.subject);
      if (state.lang    !== DEFAULTS.lang)    usp.set('lang',    state.lang);
      const qs = usp.toString();
      link.href = 'ranking.html' + (qs ? '?' + qs : '');
    };
    update();
    // Re-update on any nav-affecting state change. Simpler than wiring observers:
    // recompute on any pointerdown over the link.
    link.addEventListener('pointerdown', update);
  }

  function openInitialPopup() {
    if (state.selectedSchool == null) return;
    const marker = markersByRspo.get(state.selectedSchool);
    if (marker) {
      // Wait for cluster to settle before zooming.
      clusterGroup.zoomToShowLayer(marker, () => {
        marker.openPopup();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Bootstrap

  async function main() {
    resolveInitialState();
    setLang(state.lang);
    initMap();
    try {
      await loadBaseData();
    } catch (e) {
      console.error(e);
      document.body.innerHTML = '<p style="padding:1rem">Nie udało się wczytać danych: ' + e.message + '</p>';
      return;
    }
    buildClusterGroup();
    plotAllMarkers();
    wireControls();
    syncURL();          // canonicalise the URL (e.g. add resolved threshold)
    openInitialPopup(); // if ?school=… was in the URL
  }

  main();
})();
