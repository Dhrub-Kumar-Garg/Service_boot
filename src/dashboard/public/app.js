'use strict';

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const ms = value => value == null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
const title = value => value.charAt(0).toUpperCase() + value.slice(1);
const icon = name => `<svg aria-hidden="true"><use href="#${name}"/></svg>`;
let plan = null;
let state = { phase: 'idle', logs: [], services: {}, config: null };
let selected = '';
let busy = false;
let lastLogs = '';
let lastServices = '';
let selectionVersion = 0;
const active = () => ['starting', 'running', 'stopping'].includes(state.phase);
const isCurrent = () => state.config === selected;
const currentService = name => isCurrent() ? state.services[name] || {} : {};

async function api(url, data) {
  const response = await fetch(url, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.errors ? result.errors.join('\n') : result.error || 'Request failed.');
  return result;
}

function showError(message) {
  $('#error-banner').textContent = message || '';
  $('#error-banner').hidden = !message;
}

function controls() {
  $('#start-button').disabled = !plan || busy || active();
  $('#stop-button').disabled = busy || !['starting', 'running', 'failed'].includes(state.phase) || !state.config;
  $('#config-select').disabled = busy || active();
  $('#parallel-limit').disabled = busy || active();
  document.querySelectorAll('[name="algorithm"]').forEach(input => { input.disabled = busy || active(); });
  const phase = isCurrent() ? state.phase : 'idle';
  const labels = { idle: 'Not started', starting: 'Starting up', running: 'Running', stopping: 'Stopping', stopped: 'Stopped', failed: 'Run failed' };
  $('#run-status').className = `status-pill ${phase}`;
  $('#run-status').innerHTML = `<i></i>${labels[phase] || 'Not started'}`;
  $('#start-button').innerHTML = `${icon('play')}${busy ? 'Please wait…' : 'Start services'}`;
}

function renderStats() {
  $('#stat-services').textContent = plan ? plan.order.length : '—';
  $('#stat-depth').textContent = plan ? plan.groups.length : '—';
  const ready = plan ? plan.order.filter(name => currentService(name).status === 'ready').length : 0;
  $('#stat-ready').textContent = ready;
  $('#stat-ready-total').textContent = ` / ${plan ? plan.order.length : '—'}`;
  $('#stat-time').textContent = isCurrent() ? ms(state.totalMs) : '—';
  $('#ready-caption').textContent = ready ? `${ready === plan.order.length ? 'all services' : `${ready} services`} marked ready` : active() ? 'checking readiness' : 'waiting for a run';
  $('#time-caption').textContent = isCurrent() && state.totalMs != null ? `last startup · ${state.effectiveAlgorithm}` : 'measured when all are ready';
}

function renderDecision() {
  const algorithm = $('[name="algorithm"]:checked').value;
  const text = !plan ? 'Choose a valid configuration to see its recommendation.' : algorithm === 'adaptive'
    ? `<strong>${title(plan.analysis.chosen)} fits this graph.</strong> Width ${plan.analysis.width} ${plan.analysis.chosen === 'parallel' ? '>' : '≤'} 2 × depth ${plan.analysis.depth}.`
    : algorithm === 'sequential' ? '<strong>Steady, one by one.</strong> Each service waits for the previous one to be ready.'
      : '<strong>Make room for concurrency.</strong> Services in each level start together, then wait at the level boundary.';
  $('#decision').innerHTML = `${icon('layers')}<p>${text}</p>`;
}

function renderGraph() {
  if (!plan) { $('#graph').innerHTML = '<p class="empty-text">Fix the configuration to see its startup plan.</p>'; return; }
  const nodeWidth = 142;
  const columnWidth = 208;
  const rows = Math.max(...plan.groups.map(group => group.length));
  const width = plan.groups.length * columnWidth - 26;
  const height = Math.max(185, rows * 68 + 55);
  const positions = new Map();
  for (let level = 0; level < plan.groups.length; level++) {
    const group = plan.groups[level];
    group.forEach((name, index) => positions.set(name, {
      x: 20 + level * columnWidth,
      y: 40 + (height - 65 - group.length * 64) / 2 + index * 64, level
    }));
  }
  const edges = plan.order.flatMap(name => plan.services[name].dependsOn.map(dependency => {
    const from = positions.get(dependency);
    const to = positions.get(name);
    const startX = from.x + nodeWidth;
    const startY = from.y + 22;
    const endY = to.y + 22;
    return `<path class="edge" d="M${startX} ${startY} C${startX + 32} ${startY},${to.x - 32} ${endY},${to.x - 4} ${endY}" marker-end="url(#arrowhead)"/>`;
  })).join('');
  const nodes = plan.order.map(name => {
    const { x, y, level } = positions.get(name);
    const check = plan.services[name].readyCheck;
    const label = check.type === 'port' ? `127.0.0.1:${check.port}` : check.type === 'http' ? `HTTP · ${new URL(check.url).port || 'health check'}` : 'Ready after spawn';
    return `<g><title>${escapeHtml(name)} · level ${level} · ${escapeHtml(label)}</title><rect class="node ${level ? 'dependent-node' : ''}" x="${x}" y="${y}" width="${nodeWidth}" height="44" rx="7"/><circle class="node-dot ${level ? 'dependent-dot' : ''}" cx="${x + 15}" cy="${y + 16}" r="3"/><text class="node-title" x="${x + 25}" y="${y + 20}">${escapeHtml(name.length > 16 ? name.slice(0, 14) + '…' : name)}</text><text class="node-caption" x="${x + 25}" y="${y + 33}">${escapeHtml(label)}</text></g>`;
  }).join('');
  const labels = plan.groups.map((_, level) => `<text class="level-label" x="${20 + level * columnWidth}" y="20">LEVEL ${level}${level === 0 ? ' · START HERE' : ''}</text>`).join('');
  $('#graph').innerHTML = `<svg class="dependency-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="Dependency graph. ${escapeHtml(plan.groups.map((group, i) => `Level ${i}: ${group.join(', ')}`).join('. '))}"><defs><marker id="arrowhead" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="m0 0 6 3-6 3" fill="#9eb6a6"/></marker></defs>${labels}${edges}${nodes}</svg>`;
  $('.dependency-graph').style.minWidth = `${Math.min(width, 900)}px`;
  $('#graph').style.maxHeight = '370px';
}

function renderServices() {
  const query = $('#service-search').value.toLowerCase();
  const signature = JSON.stringify([plan?.services, isCurrent() ? state.services : {}, query]);
  // Keep unchanged rows in place so polling doesn't interrupt screen readers
  // or replace a row the user is currently inspecting.
  if (signature === lastServices) return;
  lastServices = signature;
  const names = plan ? plan.order.filter(name => name.toLowerCase().includes(query)) : [];
  $('#service-count').textContent = plan ? plan.order.length : 0;
  $('#services-body').innerHTML = names.map(name => {
    const service = plan.services[name];
    const running = currentService(name);
    const status = running.status || 'pending';
    const labels = { pending: 'Waiting', starting: 'Starting', ready: 'Ready', stopped: 'Stopped', failed: 'Failed', restarting: 'Restarting' };
    const check = service.readyCheck.type === 'port' ? `TCP · 127.0.0.1:${service.readyCheck.port}` : service.readyCheck.type === 'http' ? service.readyCheck.url : 'After successful spawn';
    return `<tr><td><div class="service-name"><span class="service-symbol ${service.dependsOn.length ? 'dependent' : ''}">${icon(service.dependsOn.length ? 'layers' : 'terminal')}</span><div><strong>${escapeHtml(name)}</strong><small>${running.pid ? `PID ${running.pid} · ` : ''}Level ${plan.groups.findIndex(group => group.includes(name))}</small></div></div></td><td><span class="status-pill ${status}"><i></i>${labels[status] || status}</span></td><td><div class="check-label">${escapeHtml(check)}</div></td><td>${service.dependsOn.length ? service.dependsOn.map(dep => `<span class="dependency-tag">${escapeHtml(dep)}</span>`).join('') : '<span class="no-deps">None — starts first</span>'}</td><td>${ms(running.ms)}</td></tr>`;
  }).join('') || `<tr><td colspan="5" class="empty-text">${plan ? 'No services match your search.' : 'Choose a valid configuration to see its services.'}</td></tr>`;
  $('#table-note').textContent = plan ? `${names.length} of ${plan.order.length} services · declaration order preserved` : 'No valid plan loaded.';
}

async function selectConfig(config) {
  const version = ++selectionVersion;
  selected = config;
  plan = null;
  controls();
  showError('');
  try {
    const loaded = await api(`/api/plan?config=${encodeURIComponent(config)}`);
    if (version !== selectionVersion) return;
    plan = loaded;
    $('#config-content').textContent = loaded.source;
  } catch (error) {
    if (version !== selectionVersion) return;
    $('#config-content').textContent = 'This configuration could not be validated. See the error above.';
    showError(error.message);
  }
  if (version !== selectionVersion) return;
  renderStats(); renderGraph(); renderServices(); renderDecision(); controls();
}

function renderLogs() {
  const query = $('#log-search').value.toLowerCase();
  const logs = state.logs.filter(entry => entry.line.toLowerCase().includes(query));
  $('#log-count').textContent = state.logs.length > 999 ? '999+' : state.logs.length;
  $('#logs-empty').hidden = state.logs.length > 0;
  const key = `${logs.length}:${logs[0]?.id}:${logs.at(-1)?.id}:${query}`;
  if (key === lastLogs) return;
  lastLogs = key;
  const container = $('#log-lines');
  container.innerHTML = logs.map(entry => `<div class="log-line ${entry.stream === 'stderr' || entry.line.startsWith('service:failed') ? 'error' : ''}"><time datetime="${escapeHtml(entry.at)}">${new Date(entry.at).toLocaleTimeString([], { hour12: false })}</time><span>${escapeHtml(entry.line)}</span></div>`).join('') || (state.logs.length ? '<p class="empty-text">No log lines match this filter.</p>' : '');
  if ($('#follow-logs').checked) container.scrollTop = container.scrollHeight;
}

function navigate() {
  const requested = location.hash.slice(1);
  const page = ['overview', 'logs', 'benchmarks'].includes(requested) ? requested : 'overview';
  document.querySelectorAll('.view').forEach(view => { view.hidden = view.id !== `${page}-view`; });
  document.querySelectorAll('[data-page]').forEach(link => {
    link.classList.toggle('active', link.dataset.page === page);
    if (link.dataset.page === page) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  $('#breadcrumb-page').textContent = page === 'logs' ? 'Live logs' : title(page);
  document.title = `ServiceBoot · ${page === 'logs' ? 'Live logs' : title(page)}`;
}

async function loadReport() {
  try {
    const report = await api('/api/report');
    const configNames = [...new Set(report.summary.map(row => row.config))];
    const cards = configNames.map(config => {
      const rows = report.summary.filter(row => row.config === config);
      const max = Math.max(1, ...rows.map(row => row.startupMs?.mean || 0));
      const meta = report.configs.find(entry => entry.path === config);
      return `<section class="panel benchmark-card"><div class="panel-header"><div><h2>${escapeHtml(config.split('/').pop())}</h2><p>${meta?.services ?? '—'} services · ${meta?.groups.length ?? '—'} dependency levels</p></div>${icon('chart')}</div><div class="chart-body">${rows.map(row => `<div class="bar-row"><div class="bar-label"><span>${title(row.algorithm)}</span><strong>${ms(row.startupMs?.mean)}</strong></div><div class="bar-track"><div class="bar-fill ${row.algorithm}" data-width="${row.startupMs ? (row.startupMs.mean / max * 100).toFixed(2) : 0}"></div></div></div>`).join('')}</div><div class="chart-footnote">Mean startup time · ${report.settings.runsPerPair} runs per algorithm<br>Lower is faster. Failed runs are excluded from timings.</div></section>`;
    }).join('');
    $('#benchmark-content').innerHTML = `<div class="report-banner">A fair comparison starts with the same graph. These are saved measurements from <strong>report/results.json</strong>, not this machine’s live performance.</div><div class="report-meta"><span>Recorded <strong>${escapeHtml(new Date(report.startedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}</strong></span><span>Environment <strong>${escapeHtml(report.environment.platform)} · ${report.environment.logicalCpus} CPUs · Node ${escapeHtml(report.environment.node)}</strong></span><span><strong>${report.runs.length}</strong> measured runs</span><a class="text-button" href="/api/report" download="serviceboot-results.json">Download JSON ${icon('arrow')}</a></div><div class="benchmark-grid">${cards}</div><section class="panel benchmark-details"><div class="panel-header"><div><h2>Beyond startup time</h2><p>Service process trees only. Unavailable measurements stay unavailable.</p></div></div><div class="table-scroll"><table><thead><tr><th>Configuration</th><th>Algorithm</th><th>Successful runs</th><th>Mean CPU</th><th>Mean peak memory</th></tr></thead><tbody>${report.summary.map(row => `<tr><td><strong>${escapeHtml(row.config.split('/').pop())}</strong></td><td>${title(row.algorithm)}</td><td>${row.successful} / ${row.runs}</td><td>${row.meanCpuPercent ? `${row.meanCpuPercent.mean.toFixed(1)}%` : 'Unavailable'}</td><td>${row.peakRssBytes ? `${(row.peakRssBytes.mean / 1048576).toFixed(1)} MB` : 'Unavailable'}</td></tr>`).join('')}</tbody></table></div></section><p class="report-note">CPU is measured as a percentage of one core. Memory is the sum of resident memory across service processes; shared pages can be counted more than once.<br>To measure on your own machine, run the CLI and restart the dashboard to load an updated report:<code class="report-command">node bin/serviceboot.js benchmark --runs 3 --out report/results.json</code></p>`;
    document.querySelectorAll('[data-width]').forEach(bar => { bar.style.width = `${bar.dataset.width}%`; });
  } catch (error) {
    $('#benchmark-content').innerHTML = `<div class="panel empty-state">${icon('chart')}<h3>No report just yet.</h3><p>${escapeHtml(error.message)}</p><code class="report-command">node bin/serviceboot.js benchmark --runs 3 --out report/results.json</code></div>`;
  }
}

async function poll() {
  try {
    state = await api('/api/state');
    $('#connection-warning').hidden = true;
    if (active() && state.config !== selected) {
      $('#config-select').value = state.config;
      await selectConfig(state.config);
    }
    if (active()) {
      document.querySelectorAll('[name="algorithm"]').forEach(input => { input.checked = input.value === state.algorithm; });
      $('#parallel-limit').value = state.maxParallel ?? '';
      renderDecision();
    }
    controls(); renderStats(); renderServices(); renderLogs();
    if (isCurrent() && state.error) showError(state.error);
  } catch {
    $('#connection-warning').hidden = false;
    $('#start-button').disabled = true;
    $('#stop-button').disabled = true;
  } finally { setTimeout(poll, 750); }
}

$('#config-select').addEventListener('change', event => { void selectConfig(event.target.value); });
document.querySelectorAll('[name="algorithm"]').forEach(input => input.addEventListener('change', renderDecision));
$('#service-search').addEventListener('input', renderServices);
$('#log-search').addEventListener('input', renderLogs);
$('#view-logs').addEventListener('click', () => { location.hash = 'logs'; });
window.addEventListener('hashchange', navigate);
document.querySelectorAll('[data-guide]').forEach(button => button.addEventListener('click', () => $('#guide-dialog').showModal()));
$('#close-guide').addEventListener('click', () => $('#guide-dialog').close());
$('#guide-dialog').addEventListener('click', event => { if (event.target === $('#guide-dialog')) $('#guide-dialog').close(); });
for (const [name, showGraph] of [['graph', true], ['config', false]]) {
  $(`#${name}-tab`).addEventListener('click', () => {
    $('#graph-content').hidden = !showGraph;
    $('#config-content').hidden = showGraph;
    for (const tab of ['graph', 'config']) {
      $(`#${tab}-tab`).classList.toggle('active', tab === name);
      $(`#${tab}-tab`).setAttribute('aria-selected', String(tab === name));
      $(`#${tab}-tab`).tabIndex = tab === name ? 0 : -1;
    }
  });
  $(`#${name}-tab`).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 'graph' : event.key === 'End' ? 'config' : name === 'graph' ? 'config' : 'graph';
      $(`#${next}-tab`).click();
      $(`#${next}-tab`).focus();
    }
  });
}

async function mutate(endpoint, data) {
  busy = true; controls(); showError('');
  try { state = await api(endpoint, data); }
  catch (error) { showError(error.message); }
  finally { busy = false; controls(); renderStats(); renderServices(); renderLogs(); }
}
$('#start-button').addEventListener('click', () => {
  const limit = $('#parallel-limit');
  if (!limit.reportValidity()) return;
  void mutate('/api/start', { config: selected, algorithm: $('[name="algorithm"]:checked').value,
    ...(limit.value ? { maxParallel: Number(limit.value) } : {}) });
});
$('#stop-button').addEventListener('click', () => { void mutate('/api/stop', {}); });
$('#download-logs').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([state.logs.map(entry => `${entry.at} ${entry.line}`).join('\n')], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'serviceboot-logs.txt'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

async function init() {
  navigate();
  try {
    const result = await api('/api/configs');
    $('#config-select').innerHTML = result.configs.map(config => `<option value="${escapeHtml(config)}">${escapeHtml(config)}</option>`).join('');
    selected = result.configs.includes('samples/small.yml') ? 'samples/small.yml' : result.configs[0];
    if (selected) {
      $('#config-select').value = selected;
      await selectConfig(selected);
    } else { showError('Add serviceboot.yml or a YAML file in samples/ to get started.'); controls(); }
    void loadReport();
  } catch (error) { showError(error.message); }
  void poll();
}
void init();
