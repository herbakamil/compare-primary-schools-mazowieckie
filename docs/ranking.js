// Ranking page: sortable/filterable table of schools by (metric, subject, view).
// Base view works from schools-base.json alone; LOO/single_year/last_k require
// an opt-in download of the per-metric file.

(function () {
  const state = {
    metric: DEFAULTS.metric,
    subject: DEFAULTS.subject,
    view: 'base',                 // 'base' | 'last_k' | 'single_year' | 'loo'
    viewParam: null,              // string: year ('2023') or k ('3')
    publicFilter: 'all',
    nameQuery: '',
    sortKey: 'rank',
    sortDir: 'asc',
    selectedSchool: null,
    lang: DEFAULTS.lang,
    historyOptIn: false,
  };

  const ALLOWED_VIEWS = ['base', 'last_k', 'single_year', 'loo'];

  // History data fetched on demand (per-metric).
  const histByMetric = {};

  // ---------------------------------------------------------------------------
  // State resolution

  function resolveInitialState() {
    state.metric  = resolvePref('metric',  METRICS);
    state.subject = resolvePref('subject', SUBJECTS);
    state.lang    = resolvePref('lang',    ['pl', 'en']);

    const url = getURLParams();
    const view = url.get('view');
    if (view && ALLOWED_VIEWS.includes(view)) state.view = view;
    state.viewParam = url.get('view_param') || null;

    const pub = url.get('public');
    if (pub === 'tak' || pub === 'nie' || pub === 'all') state.publicFilter = pub;

    state.nameQuery = url.get('q') || '';

    const sort = url.get('sort');
    if (sort) state.sortKey = sort;
    const dir = url.get('dir');
    if (dir === 'asc' || dir === 'desc') state.sortDir = dir;

    const school = parseInt(url.get('school'), 10);
    state.selectedSchool = Number.isInteger(school) ? school : null;

    state.historyOptIn = !!readPrefs().history_optin;
  }

  function syncURL() {
    setURLParams({
      metric:     state.metric  !== DEFAULTS.metric  ? state.metric  : null,
      subject:    state.subject !== DEFAULTS.subject ? state.subject : null,
      view:       state.view !== 'base' ? state.view : null,
      view_param: state.view !== 'base' ? state.viewParam : null,
      public:     state.publicFilter !== 'all' ? state.publicFilter : null,
      q:          state.nameQuery || null,
      sort:       state.sortKey !== 'rank' ? state.sortKey : null,
      dir:        state.sortDir !== 'asc' ? state.sortDir : null,
      school:     state.selectedSchool,
      lang:       state.lang !== DEFAULTS.lang ? state.lang : null,
    });
  }

  // ---------------------------------------------------------------------------
  // Row construction

  // For each school, produce a flat object with the fields we sort/render.
  function buildRow(school) {
    const { metric, subject } = state;
    const base = school.scores?.[metric]?.[subject];

    // For non-base views, look up the per-metric/per-subject data if loaded.
    let viewScore = null, viewRank = null;
    let looMinR = null, looMaxR = null;
    let singleMinR = null, singleMaxR = null;

    const hist = histByMetric[metric]?.schools?.[String(school.rspo)]?.[subject];
    if (hist) {
      // LOO range
      const loo = hist.loo || {};
      const looRanks = Object.values(loo).map(v => v?.rank).filter(v => v != null);
      if (looRanks.length) {
        looMinR = Math.min(...looRanks);
        looMaxR = Math.max(...looRanks);
      }
      // single_year range
      const sy = hist.single_year || {};
      const syRanks = Object.values(sy).map(v => v?.rank).filter(v => v != null);
      if (syRanks.length) {
        singleMinR = Math.min(...syRanks);
        singleMaxR = Math.max(...syRanks);
      }

      // Selected view
      if (state.view === 'base') {
        viewScore = hist.base?.score ?? null;
        viewRank  = hist.base?.rank  ?? null;
      } else if (state.viewParam) {
        const cell = hist[state.view]?.[state.viewParam];
        viewScore = cell?.score ?? null;
        viewRank  = cell?.rank  ?? null;
      }
    }

    // For base view without history loaded, fall back to base from schools-base.json.
    if (state.view === 'base') {
      viewScore = base?.score ?? null;
      viewRank  = base?.rank  ?? null;
    }

    return {
      rspo: school.rspo,
      school,
      name: school.name,
      street: school.ulica_nr,
      town: school.miejscowosc,
      pub: isPublic(school),
      n_years: school.n_years,
      hasCoords: school.lat != null && school.lon != null,
      score: viewScore,
      rank: viewRank,
      looMinR, looMaxR,
      singleMinR, singleMaxR,
    };
  }

  // ---------------------------------------------------------------------------
  // Filtering + sorting

  function filterRows(rows) {
    const q = state.nameQuery.trim().toLowerCase();
    return rows.filter(r => {
      if (state.publicFilter === 'tak' && !r.pub) return false;
      if (state.publicFilter === 'nie' &&  r.pub) return false;
      if (q) {
        const inName = r.name.toLowerCase().includes(q);
        const inTown = (r.town || '').toLowerCase().includes(q);
        const inStreet = (r.street || '').toLowerCase().includes(q);
        if (!inName && !inTown && !inStreet) return false;
      }
      // Drop rows where the view's score is missing — they can't be ranked here.
      if (r.score == null) return false;
      return true;
    });
  }

  function sortRows(rows) {
    const key = state.sortKey;
    const dir = state.sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const va = a[key], vb = b[key];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;          // nulls last regardless of dir
      if (vb == null) return -1;
      if (typeof va === 'string') return va.localeCompare(vb, 'pl') * dir;
      return (va - vb) * dir;
    });
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Rendering

  const COLUMNS = [
    { key: 'rank',       i18n: 'colRank',        num: true,  width: '4rem' },
    { key: 'name',       i18n: 'colName',        num: false },
    { key: 'street',     i18n: 'colStreet',      num: false },
    { key: 'town',       i18n: 'colTown',        num: false },
    { key: 'pub',        i18n: 'colPublic',      num: false, width: '5rem' },
    { key: 'n_years',    i18n: 'colNYears',      num: true,  width: '4rem' },
    { key: 'score',      i18n: 'colScore',       num: true },
    { key: 'looMinR',    i18n: 'colLOORange',    num: true },
    { key: 'singleMinR', i18n: 'colSingleRange', num: true },
  ];

  function renderTable(rows) {
    const table = document.getElementById('ranking-table');
    const head = `<thead><tr>${COLUMNS.map(col => {
      const indicator = (state.sortKey === col.key)
        ? `<span class="sort-indicator">${state.sortDir === 'asc' ? '▲' : '▼'}</span>` : '';
      const style = col.width ? ` style="width:${col.width};"` : '';
      return `<th data-col="${col.key}" class="${col.num ? 'num' : ''}"${style}>${t(col.i18n)}${indicator}</th>`;
    }).join('')}</tr></thead>`;

    const body = `<tbody>${rows.map(r => {
      const offMap = !r.hasCoords ? ` <span class="off-map" title="${t('offMap')}">📍✗</span>` : '';
      const looCell = (r.looMinR != null) ? `${r.looMinR}–${r.looMaxR}` : '—';
      const syCell  = (r.singleMinR != null) ? `${r.singleMinR}–${r.singleMaxR}` : '—';
      const pubLabel = r.pub ? t('publicYesShort') : t('publicNoShort');
      const highlight = (r.rspo === state.selectedSchool) ? ' class="highlight"' : '';
      return `<tr data-rspo="${r.rspo}"${highlight}>
        <td class="num">${r.rank ?? '—'}</td>
        <td>${escapeHTML(r.name)}${offMap}</td>
        <td>${escapeHTML(r.street || '')}</td>
        <td>${escapeHTML(r.town || '')}</td>
        <td>${pubLabel}</td>
        <td class="num">${r.n_years}</td>
        <td class="num">${fmtScore(r.score, state.metric)}</td>
        <td class="num">${looCell}</td>
        <td class="num">${syCell}</td>
      </tr>`;
    }).join('')}</tbody>`;

    table.innerHTML = head + body;

    // Wire header sort.
    for (const th of table.querySelectorAll('thead th')) {
      th.addEventListener('click', () => onSortClick(th.getAttribute('data-col')));
    }
    // Wire row click → selectedSchool (deep link).
    for (const tr of table.querySelectorAll('tbody tr')) {
      tr.addEventListener('click', () => {
        const rspo = parseInt(tr.getAttribute('data-rspo'), 10);
        state.selectedSchool = (state.selectedSchool === rspo) ? null : rspo;
        syncURL();
        renderAll();
      });
    }
  }

  function escapeHTML(s) {
    if (s == null) return '';
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function onSortClick(key) {
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = (key === 'name' || key === 'town') ? 'asc' : 'asc';
    }
    syncURL();
    renderAll();
  }

  function renderAll() {
    const rows = baseData.schools.map(buildRow);
    const filtered = sortRows(filterRows(rows));
    document.getElementById('ranking-info').textContent =
      t('rowsShown', filtered.length, baseData.schools.length);
    renderTable(filtered);
    if (state.selectedSchool != null) {
      const tr = document.querySelector(`tr[data-rspo="${state.selectedSchool}"]`);
      if (tr) tr.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  }

  // ---------------------------------------------------------------------------
  // View / view_param management

  function updateViewParamField() {
    const wrap = document.getElementById('view-param-field');
    const sel = document.getElementById('view-param-select');
    sel.innerHTML = '';
    const years = baseData.metadata.years_in_data;
    let options = [];
    if (state.view === 'single_year' || state.view === 'loo') {
      options = years.map(y => ({ value: String(y), label: String(y) }));
    } else if (state.view === 'last_k') {
      // k = 2..max(years)-1; safest to expose 2..(n_years-1) per dataset
      options = [];
      for (let k = 2; k < years.length; k++) options.push({ value: String(k), label: String(k) });
    }
    if (options.length === 0) {
      wrap.style.display = 'none';
      state.viewParam = null;
      return;
    }
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    // Pick a sensible default if the current viewParam doesn't apply.
    if (!options.find(o => o.value === state.viewParam)) {
      state.viewParam = options[options.length - 1].value;  // latest year / largest k
    }
    sel.value = state.viewParam;
    wrap.style.display = '';
  }

  // ---------------------------------------------------------------------------
  // Non-base views need a metric file

  function maybeShowHistoryOptIn() {
    const row = document.getElementById('history-optin-row');
    const needsHistory = state.view !== 'base';
    const haveHistory = !!histByMetric[state.metric];
    row.style.display = (needsHistory && !haveHistory) ? '' : 'none';
  }

  async function ensureMetricLoaded() {
    if (histByMetric[state.metric]) return;
    document.getElementById('ranking-info').textContent = t('historyLoading');
    histByMetric[state.metric] = await loadMetricData(state.metric);
    writePref('history_optin', true);
    state.historyOptIn = true;
  }

  // ---------------------------------------------------------------------------
  // Controls wiring

  function wireControls() {
    const metricSel  = document.getElementById('metric-select');
    const subjectSel = document.getElementById('subject-select');
    const viewSel    = document.getElementById('view-select');
    const viewParamSel = document.getElementById('view-param-select');
    const nameInput  = document.getElementById('name-search');
    const optinCB    = document.getElementById('history-optin-cb');

    fillMetricSelect(metricSel,   state.metric);
    fillSubjectSelect(subjectSel, state.subject);
    viewSel.value = state.view;

    metricSel.addEventListener('change', async () => {
      state.metric = metricSel.value;
      writePref('metric', state.metric);
      syncURL();
      maybeShowHistoryOptIn();
      if (state.view !== 'base' && state.historyOptIn) {
        await ensureMetricLoaded();
      }
      renderAll();
    });

    subjectSel.addEventListener('change', () => {
      state.subject = subjectSel.value;
      writePref('subject', state.subject);
      syncURL();
      renderAll();
    });

    viewSel.addEventListener('change', async () => {
      state.view = viewSel.value;
      updateViewParamField();
      syncURL();
      maybeShowHistoryOptIn();
      if (state.view !== 'base' && state.historyOptIn) {
        await ensureMetricLoaded();
      }
      renderAll();
    });

    viewParamSel.addEventListener('change', () => {
      state.viewParam = viewParamSel.value;
      syncURL();
      renderAll();
    });

    for (const r of document.querySelectorAll('input[name="public"]')) {
      r.removeAttribute('checked');
      if (r.value === state.publicFilter) { r.checked = true; r.setAttribute('checked', ''); }
      r.addEventListener('change', () => {
        state.publicFilter = r.value;
        syncURL();
        renderAll();
      });
    }

    nameInput.value = state.nameQuery;
    nameInput.addEventListener('input', () => {
      state.nameQuery = nameInput.value;
      syncURL();
      renderAll();
    });

    optinCB.addEventListener('change', async () => {
      if (!optinCB.checked) return;
      optinCB.disabled = true;
      await ensureMetricLoaded();
      optinCB.disabled = false;
      maybeShowHistoryOptIn();
      renderAll();
    });

    wireNavLinks();
  }

  function wireNavLinks() {
    const link = document.querySelector('.topnav nav a[href="index.html"]');
    if (!link) return;
    const update = () => {
      const usp = new URLSearchParams();
      if (state.metric  !== DEFAULTS.metric)  usp.set('metric',  state.metric);
      if (state.subject !== DEFAULTS.subject) usp.set('subject', state.subject);
      if (state.lang    !== DEFAULTS.lang)    usp.set('lang',    state.lang);
      if (state.selectedSchool != null)       usp.set('school',  state.selectedSchool);
      const qs = usp.toString();
      link.href = 'index.html' + (qs ? '?' + qs : '');
    };
    update();
    link.addEventListener('pointerdown', update);
  }

  // ---------------------------------------------------------------------------
  // Bootstrap

  async function main() {
    resolveInitialState();
    setLang(state.lang);
    try {
      await loadBaseData();
    } catch (e) {
      console.error(e);
      document.body.innerHTML = '<p style="padding:1rem">Nie udało się wczytać danych: ' + e.message + '</p>';
      return;
    }
    wireControls();
    updateViewParamField();
    maybeShowHistoryOptIn();

    if (state.view !== 'base' && state.historyOptIn) {
      await ensureMetricLoaded();
    }
    renderAll();
    syncURL();
  }

  main();
})();
