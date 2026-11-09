export const reportBrowserScript = String.raw`
(() => {
  const shell = document.querySelector('[data-report-scope="campaign"]');
  if (!shell) return;
  const cards = [...document.querySelectorAll('[data-report-case]')];
  const sections = [...document.querySelectorAll('[data-report-suite-section]')];
  const journeys = [...document.querySelectorAll('[data-report-journey]')];
  const controls = ['query','feature','profile','environment','suite','status'].map(name => document.querySelector('[data-report-' + name + ']'));
  const [query,feature,profile,environment,suite,status] = controls;
  const paramNames = ['q','feature','profile','environment','suite','status'];
  const byKey = new Map();
  cards.forEach(card => { const key = card.dataset.reportCaseKey; if (!byKey.has(key)) byKey.set(key, []); byKey.get(key).push(card); });
  const crumbs = document.querySelector('[data-nav-breadcrumbs]');
  const historyHref = crumbs.querySelector('a').getAttribute('href');
  const heading = document.querySelector('[data-case-page-heading]');
  const result = document.querySelector('[data-report-result]');
  let view = 'all', caseKey = '', configuration = '', lastReport = null, restoring = false;
  history.scrollRestoration = 'manual';
  const normalClick = event => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  const savePosition = () => { if (!restoring) history.replaceState({ ...history.state, reportScroll: window.scrollY }, '', location.href); };
  const severity = rows => rows.some(row => row.dataset.reportStatus === 'failed') ? 'failed' : rows.some(row => row.dataset.reportStatus === 'incomplete') ? 'incomplete' : rows.some(row => row.dataset.reportStatus === 'missing') ? 'missing' : 'passed';
  const clearFilters = () => controls.forEach(control => { control.value = ''; });
  const routeUrl = (nextView, key = '', hash = '') => {
    const url = new URL(location.href);
    url.searchParams.set('view', nextView);
    if (key) url.searchParams.set('case', key); else url.searchParams.delete('case');
    controls.forEach((control, i) => { if(control.value) url.searchParams.set(paramNames[i], control.value); else url.searchParams.delete(paramNames[i]); });
    url.hash = hash;
    return url.pathname + url.search + url.hash;
  };
  const readRoute = () => {
    const params = new URLSearchParams(location.search);
    view = ['all','attention','case'].includes(params.get('view')) ? params.get('view') : 'all';
    caseKey = params.get('case') || '';
    configuration = location.hash.startsWith('#execution-') ? decodeURIComponent(location.hash.slice(11)) : '';
    controls.forEach((control,i) => { control.value = params.get(paramNames[i]) || ''; });
    if(location.hash === '#history') { location.replace(historyHref); return false; }
    return true;
  };
  const appendCrumb = (label, href, attributes = {}) => {
    if(crumbs.childNodes.length) { const separator = document.createElement('span'); separator.setAttribute('aria-hidden','true'); separator.textContent = '/'; crumbs.append(separator); }
    const node = document.createElement(href ? 'a' : 'span'); node.textContent = label;
    if(href) node.setAttribute('href', href); else node.setAttribute('aria-current','page');
    Object.entries(attributes).forEach(([name,value]) => node.setAttribute(name,value)); crumbs.append(node);
  };
  const setBreadcrumbs = selected => {
    crumbs.replaceChildren();
    appendCrumb('Campaigns', historyHref);
    appendCrumb(shell.dataset.campaignLabel, lastReport?.url || routeUrl('all'), {'data-nav-return':''});
    if(view === 'case' && selected) {
      const section = selected.closest('[data-report-suite-section]');
      appendCrumb(section.dataset.suiteLabel, routeUrl('all','','#' + section.id), {'data-nav-suite-link':selected.dataset.reportSuite});
      appendCrumb(selected.dataset.reportLabel);
    } else appendCrumb(view === 'attention' ? 'Needs attention' : view === 'case' ? 'Case unavailable' : 'All results');
  };
  const apply = () => {
    const search = query.value.trim().toLowerCase();
    const matchesFilters = card =>
      (!search || card.dataset.reportSearch.includes(search)) &&
      (!feature.value || (feature.value === '__unmapped__' ? !card.dataset.reportFeatures : card.dataset.reportFeatures.split(' ').includes(feature.value))) &&
      (!profile.value || card.dataset.reportProfile === profile.value) &&
      (!environment.value || card.dataset.reportEnvironment === environment.value) &&
      (!suite.value || card.dataset.reportSuite === suite.value) &&
      (!status.value || card.dataset.reportStatus === status.value);
    const variants = byKey.get(caseKey) || [];
    const matchingVariants = variants.filter(matchesFilters);
    const candidates = matchingVariants.length ? matchingVariants : variants;
    let selected = variants.find(row => row.dataset.executionId === configuration);
    if(!selected) selected = candidates.find(row => row.dataset.reportStatus === severity(candidates)) || candidates[0];
    configuration = selected?.dataset.executionId || '';
    let visible = 0;
    cards.forEach(card => {
      const matches = view === 'case' ? card === selected :
        (view !== 'attention' || card.dataset.reportStatus !== 'passed') && matchesFilters(card);
      card.hidden = !matches;
      card.closest('.execution-preview').hidden = !matches;
      if(matches) visible++;
    });
    journeys.forEach(journey => {
      journey.hidden = !journey.querySelector('[data-report-case]:not([hidden])');
      journey.querySelector('.case-config-options').hidden = view !== 'case';
    });
    sections.forEach(section => { section.hidden = !section.querySelector('[data-report-case]:not([hidden])'); });
    document.querySelectorAll('[data-nav-configuration]').forEach(button => {
      const card = document.getElementById('execution-' + button.dataset.navConfiguration);
      button.setAttribute('aria-pressed', String(card === selected));
      button.dataset.caseStatus = card.dataset.reportStatus;
      button.setAttribute('aria-description', card.dataset.reportStatus);
    });
    document.querySelectorAll('[data-report-case-link]').forEach(link => {
      const variants = byKey.get(link.dataset.reportCaseLink) || [];
      const matching = variants.filter(matchesFilters);
      const rows = matching.length ? matching : variants;
      if(!rows.length) return;
      const state = severity(rows), target = rows.find(row => row.dataset.reportStatus === state) || rows[0];
      const passed = rows.filter(row => row.dataset.reportStatus === 'passed').length;
      const description = state.replaceAll('-', ' ') + ' · ' + passed + '/' + rows.length + ' configurations passed' + (matching.length ? '' : ' · no matching configurations');
      link.dataset.caseStatus = state; link.title = description; link.setAttribute('aria-description', description);
      link.setAttribute('href', link.hasAttribute('data-nav-case') ? routeUrl('case', link.dataset.navCase, '#execution-' + target.dataset.executionId) : '#execution-' + target.dataset.executionId);
    });
    shell.dataset.view = view;
    document.querySelector('[data-campaign-overview]').hidden = view !== 'all';
    document.querySelector('[data-feature-coverage]').hidden = view === 'case';
    document.querySelector('.report-filters').hidden = view === 'case';
    document.querySelector('.results-heading').hidden = view === 'case';
    document.querySelector('[data-results-title]').textContent = view === 'attention' ? 'Needs attention' : 'All results';
    document.querySelector('[data-results-description]').textContent = view === 'attention' ? 'Failed, incomplete, and missing executions in this campaign' : '';
    heading.hidden = view !== 'case';
    document.querySelector('[data-case-page-title]').textContent = selected?.dataset.reportLabel || 'This case was not selected in this campaign';
    document.querySelector('[data-nav-return]').setAttribute('href', lastReport?.url || routeUrl('all'));
    document.querySelectorAll('[data-nav-view]').forEach(link => { if(link.dataset.navView === view) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); });
    document.querySelectorAll('[data-nav-suite-link]').forEach(link => link.setAttribute('href',routeUrl('all','','#suite-' + link.dataset.navSuiteLink)));
    document.querySelectorAll('[data-nav-case]').forEach(link => { if(view === 'case' && link.dataset.navCase === caseKey) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); });
    const selectedSuite = selected?.dataset.reportSuite;
    if(view === 'case') document.querySelectorAll('[data-nav-suite]').forEach(details => { if(details.dataset.navSuite === selectedSuite) details.open = true; });
    result.textContent = visible + ' of ' + cards.length + ' executions shown' + (!visible ? ' — No executions match this selection.' : '');
    const images = cards.reduce((n,card) => n + (card.hidden ? 0 : card.querySelectorAll('[data-gallery-item]').length),0);
    const launch = document.querySelector('[data-gallery-open]');
    launch.disabled = images === 0; launch.textContent = images ? 'View gallery · ' + images : 'No visual evidence in selection';
    setBreadcrumbs(selected);
    measureHeader();
  };
  const measureHeader = () => document.documentElement.style.setProperty('--navigation-sticky-offset',document.querySelector('.report-topbar').offsetHeight + 'px');
  window.addEventListener('resize',measureHeader);
  const navigate = (url, scroll) => {
    savePosition(); history.pushState({reportScroll:scroll || 0},'',url);
    readRoute(); restoring = true; apply();
    if(typeof scroll === 'number') window.scrollTo({top:scroll,behavior:'instant'});
    else if(location.hash) revealTarget(location.hash);
    else window.scrollTo({top:0,behavior:'instant'});
    restoring = false;
  };
  const revealTarget = hash => {
    const id = decodeURIComponent(hash.slice(1));
    const target = document.getElementById(id);
    if(!target || !target.matches('.suite-section,[data-report-case],.report-journey,#overview,#results,#top')) return;
    if(target.hidden || target.closest('[hidden]')) {
      clearFilters(); view = 'all'; caseKey = ''; apply();
      history.replaceState(history.state,'',routeUrl('all','',hash));
    }
    target.scrollIntoView({block:'start',behavior:'instant'});
  };
  document.addEventListener('click', event => {
    if(event.defaultPrevented || !normalClick(event)) return;
    const link = event.target.closest('a');
    if(link?.hasAttribute('data-nav-return')) {
      event.preventDefault(); navigate(lastReport?.url || routeUrl('all'),lastReport?.scroll || 0); return;
    }
    if(link?.hasAttribute('data-nav-case')) {
      event.preventDefault();
      if(view !== 'case') lastReport = {url:location.pathname + location.search + location.hash,scroll:window.scrollY};
      const hash = new URL(link.href).hash;
      navigate(routeUrl('case',link.dataset.navCase,hash),0); return;
    }
    if(link?.hasAttribute('data-nav-view')) { event.preventDefault(); navigate(routeUrl(link.dataset.navView)); return; }
    if(link?.hasAttribute('data-nav-suite-link')) {
      event.preventDefault(); const id = link.dataset.navSuiteLink;
      document.querySelectorAll('[data-nav-suite]').forEach(details => {if(details.dataset.navSuite === id)details.open = true;});
      navigate(routeUrl('all','','#suite-' + id)); return;
    }
    if(link?.getAttribute('href')?.startsWith('#') && /^#(suite-|execution-|journey-|overview|results)/.test(link.getAttribute('href'))) {
      event.preventDefault(); navigate(routeUrl('all','',link.getAttribute('href'))); return;
    }
    const config = event.target.closest('[data-nav-configuration]');
    if(config) { configuration = config.dataset.navConfiguration; history.replaceState(history.state,'',routeUrl('case',caseKey,'#execution-' + configuration)); apply(); }
  });
  controls.forEach(control => control.addEventListener(control === query ? 'input' : 'change', () => { history.replaceState(history.state,'',routeUrl(view)); apply(); }));
  document.querySelector('[data-report-reset]').addEventListener('click', () => { clearFilters(); history.replaceState(history.state,'',routeUrl(view)); apply(); query.focus(); });
  document.querySelectorAll('[data-report-feature-choice]').forEach(button => button.addEventListener('click', () => { feature.value = button.dataset.reportFeatureChoice; navigate(routeUrl('all','','#results')); document.querySelector('.feature-coverage').open = false; }));
  document.addEventListener('keydown', event => { if(event.key === '/' && view !== 'case' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.target.matches('input,select,textarea,[contenteditable]')) { event.preventDefault(); query.focus(); } });
  window.addEventListener('popstate', event => { if(!readRoute())return; restoring = true; apply(); if(typeof event.state?.reportScroll === 'number')window.scrollTo({top:event.state.reportScroll,behavior:'instant'});else if(location.hash)revealTarget(location.hash);else window.scrollTo({top:0,behavior:'instant'});restoring=false; });
  let frame = 0;
  window.addEventListener('scroll', () => { if(frame)return;frame=requestAnimationFrame(() => { frame=0;savePosition();const current=sections.find(section=>!section.hidden && section.getBoundingClientRect().top<=130 && section.getBoundingClientRect().bottom>130);document.querySelectorAll('[data-nav-suite-link]').forEach(link=>link.classList.toggle('in-view',view!=='case' && link.dataset.navSuiteLink===current?.dataset.reportSuiteSection)); }); },{passive:true});
  if(readRoute()) { apply(); if(location.hash)revealTarget(location.hash); }
})();
`;
