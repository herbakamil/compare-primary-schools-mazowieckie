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

    // A–E class for the displayed score, bucketed against the base
    // distribution (same sigma/centre the map uses), so map and ranking agree.
    const centre = baseData.metadata.sigma_centre[metric][subject];
    const sigma  = baseData.metadata.sigma[metric][subject];
    const classIndex = classIndexFor(viewScore, centre, sigma);

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
      classIndex,
      classLetter: classIndex == null ? null : CLASS_LETTERS[classIndex],
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
    { key: 'score',       i18n: 'colScore',       num: true },
    { key: 'classLetter', i18n: 'colClass',       num: true,  width: '4rem' },
    { key: 'looMinR',     i18n: 'colLOORange',    num: true,  help: 'helpLOORange' },
    { key: 'singleMinR',  i18n: 'colSingleRange', num: true,  help: 'helpSingleRange' },
  ];

  // A small "score + class badge" cell, bucketed against the base distribution.
  function detailScoreCell(cell, subject) {
    if (!cell || cell.score == null) return '<td class="num">—</td>';
    const centre = baseData.metadata.sigma_centre[state.metric][subject];
    const sigma  = baseData.metadata.sigma[state.metric][subject];
    const ci = classIndexFor(cell.score, centre, sigma);
    return `<td class="num">${fmtScore(cell.score, state.metric)} ${classBadge(ci)}</td>`;
  }

  function classBadge(ci, label) {
    if (ci == null) return '<span class="class-badge class-badge-sm">—</span>';
    const text = (label != null) ? label : CLASS_LETTERS[ci];
    return `<span class="class-badge class-badge-sm" style="background:${CLASS_COLOURS[ci]};color:${CLASS_TEXT_COLOURS[ci]}">${text}</span>`;
  }

  // The expandable detail panel for one school: per-year × per-subject scores
  // with class badges (spot the bad year/subject), plus the composite_min class
  // trajectory and how often it lands in each class (border schools wander).
  // Needs the per-metric history file; if absent, offers to load it.
  function renderDetailRow(row) {
    const colspan = COLUMNS.length;
    const hist = histByMetric[state.metric]?.schools?.[String(row.rspo)];
    if (!hist) {
      return `<tr class="detail-row"><td colspan="${colspan}">
        <button type="button" class="detail-load-btn">${t('detailLoadHistory')}</button>
      </td></tr>`;
    }

    const subjects = ['polski', 'matematyka', 'angielski', 'composite_min'];
    const years = baseData.metadata.years_in_data;
    const yearsPresent = years.filter(y =>
      subjects.some(s => hist[s]?.single_year?.[String(y)] != null));

    const header = `<tr><th></th>${subjects.map(s => `<th>${t('subject_' + s)}</th>`).join('')}</tr>`;
    const yearRows = yearsPresent.map(y =>
      `<tr><th>${y}</th>${subjects.map(s => detailScoreCell(hist[s]?.single_year?.[String(y)], s)).join('')}</tr>`
    ).join('');
    const ks = Object.keys(hist[subjects[0]]?.last_k || {}).sort((a, b) => +a - +b);
    const lastKRows = ks.map(k =>
      `<tr><th>${t('lastKRow', k)}</th>${subjects.map(s => detailScoreCell(hist[s]?.last_k?.[k], s)).join('')}</tr>`
    ).join('');

    // composite_min class trajectory + per-class counts
    const cCentre = baseData.metadata.sigma_centre[state.metric].composite_min;
    const cSigma  = baseData.metadata.sigma[state.metric].composite_min;
    const counts = [0, 0, 0, 0, 0];
    const trajBadges = yearsPresent.map(y => {
      const cell = hist.composite_min?.single_year?.[String(y)];
      const ci = cell ? classIndexFor(cell.score, cCentre, cSigma) : null;
      if (ci != null) counts[ci]++;
      return `<span class="traj-item">${y}&nbsp;${classBadge(ci)}</span>`;
    }).join(' ');
    const countSummary = [4, 3, 2, 1, 0]
      .filter(i => counts[i] > 0)
      .map(i => `${CLASS_LETTERS[i]}×${counts[i]}`)
      .join('  ');

    return `<tr class="detail-row"><td colspan="${colspan}">
      <div class="detail-panel">
        <div class="detail-traj">
          <strong>${t('detailTrajectory')}:</strong> ${trajBadges}
          <span class="detail-counts">(${countSummary})</span>
        </div>
        <table class="detail-table">
          <thead>${header}</thead>
          <tbody>${yearRows}${lastKRows ? `<tr class="sep"><td colspan="5"></td></tr>${lastKRows}` : ''}</tbody>
        </table>
      </div>
    </td></tr>`;
  }

  function renderTable(rows) {
    const table = document.getElementById('ranking-table');
    const head = `<thead><tr>${COLUMNS.map(col => {
      const indicator = (state.sortKey === col.key)
        ? `<span class="sort-indicator">${state.sortDir === 'asc' ? '▲' : '▼'}</span>` : '';
      const style = col.width ? ` style="width:${col.width};"` : '';
      const help = col.help
        ? ` <span class="help-icon" tabindex="0" role="button" aria-label="?" data-help="${escapeHTML(t(col.help))}">i</span>`
        : '';
      return `<th data-col="${col.key}" class="${col.num ? 'num' : ''}"${style}>${t(col.i18n)}${help}${indicator}</th>`;
    }).join('')}</tr></thead>`;

    const body = `<tbody>${rows.map(r => {
      const offMap = !r.hasCoords ? ` <span class="off-map" title="${t('offMap')}">📍✗</span>` : '';
      const looCell = (r.looMinR != null) ? `${r.looMinR}–${r.looMaxR}` : '—';
      const syCell  = (r.singleMinR != null) ? `${r.singleMinR}–${r.singleMaxR}` : '—';
      const pubLabel = r.pub ? t('publicYesShort') : t('publicNoShort');
      const classCell = (r.classLetter)
        ? `<span class="class-badge" style="background:${CLASS_COLOURS[r.classIndex]};color:${CLASS_TEXT_COLOURS[r.classIndex]}">${r.classLetter}</span>`
        : '—';
      const selected = (r.rspo === state.selectedSchool);
      const mainRow = `<tr data-rspo="${r.rspo}"${selected ? ' class="highlight"' : ''}>
        <td class="num">${r.rank ?? '—'}</td>
        <td>${escapeHTML(r.name)}${offMap}</td>
        <td>${escapeHTML(r.street || '')}</td>
        <td>${escapeHTML(r.town || '')}</td>
        <td>${pubLabel}</td>
        <td class="num">${r.n_years}</td>
        <td class="num">${fmtScoreHTML(r.score, state.metric)}</td>
        <td class="num class-cell">${classCell}</td>
        <td class="num">${looCell}</td>
        <td class="num">${syCell}</td>
      </tr>`;
      // A selected row expands an inline detail panel below it.
      return mainRow + (selected ? renderDetailRow(r) : '');
    }).join('')}</tbody>`;

    table.innerHTML = head + body;

    // Wire header sort. Ignore clicks on the help icon (it shows a tooltip on
    // hover/focus; tapping it must not also re-sort the column).
    for (const th of table.querySelectorAll('thead th')) {
      th.addEventListener('click', (e) => {
        if (e.target.closest('.help-icon')) return;
        onSortClick(th.getAttribute('data-col'));
      });
    }
    // Wire main-row click → toggle selected (expands detail + deep link). Scoped
    // to [data-rspo] so clicks inside the detail row don't collapse it.
    for (const tr of table.querySelectorAll('tbody tr[data-rspo]')) {
      tr.addEventListener('click', () => {
        const rspo = parseInt(tr.getAttribute('data-rspo'), 10);
        state.selectedSchool = (state.selectedSchool === rspo) ? null : rspo;
        syncURL();
        renderAll();
      });
    }
    // The detail panel's "load year-by-year data" button (shown when the
    // per-metric file isn't loaded yet).
    const loadBtn = table.querySelector('.detail-load-btn');
    if (loadBtn) {
      loadBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        loadBtn.disabled = true;
        loadBtn.textContent = t('historyLoading');
        await ensureMetricLoaded();
        maybeShowHistoryOptIn();
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
    // The LOO-range and single-year-range columns are always in the table (and
    // non-base views also need the per-metric file), so offer the opt-in
    // whenever the current metric's file isn't loaded — not only for non-base
    // views. Previously it was hidden on the default base view, leaving those
    // two columns showing "—" with no visible way to fill them.
    const row = document.getElementById('history-optin-row');
    row.style.display = histByMetric[state.metric] ? 'none' : '';
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
      // Auto-load if the user has already consented — the range columns need
      // the new metric's file even on the base view.
      if (state.historyOptIn) await ensureMetricLoaded();
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
      if (state.historyOptIn) await ensureMetricLoaded();
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

    // Language toggle: re-translate JS-built content (metric/subject selects
    // and the whole table, whose headers/labels come from t()). The view-select
    // options carry data-i18n, so setLang's applyI18N already handles them.
    wireLangToggle(() => {
      state.lang = currentLang;
      syncURL();
      fillMetricSelect(metricSel, state.metric);
      fillSubjectSelect(subjectSel, state.subject);
      renderAll();
    });
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

    // Returning users who already consented get the per-metric file loaded up
    // front so the range columns are populated without re-checking the box.
    if (state.historyOptIn) await ensureMetricLoaded();
    renderAll();
    syncURL();
  }

  main();
})();
