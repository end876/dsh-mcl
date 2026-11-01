const $ = (sel) => document.querySelector(sel);

const ui = {
  versionGroups: $('#version-groups'),
  versionEmpty: $('#version-empty'),
  picker: $('#remote-picker'),
  pickerBtn: $('#picker-btn'),
  pickerPop: $('#picker-pop'),
  pickerLabel: $('#picker-label'),
  pickerSearch: $('#picker-search'),
  pickerList: $('#picker-list'),
  btnRefresh: $('#btn-refresh'),
  exportSaves: $('#export-saves'),
  btnInstall: $('#btn-install'),
  btnLaunch: $('#btn-launch'),
  btnStop: $('#btn-stop'),
  btnClear: $('#btn-clear'),
  inputUser: $('#input-user'),
  inputMemory: $('#input-memory'),
  memoryLabel: $('#memory-label'),
  memoryConfirm: $('#memory-confirm'),
  inputWidth: $('#input-width'),
  inputHeight: $('#input-height'),
  console: $('#console'),
  toast: $('#toast'),
  pillJava: $('#pill-java'),
  pillSource: $('#pill-source'),
  launchHint: $('#launch-hint'),
  quickLaunch: $('#quick-launch'),
  drop: $('#drop'),
  dropText: $('#drop-text'),
  fileInput: $('#file-input'),
  result: $('#inspect-result'),
  inspectPath: $('#inspect-path'),
  btnInspectPath: $('#btn-inspect-path'),
  btnPickFile: $('#btn-pick-file'),
  msaBox: $('#msa-box'),
  msaLink: $('#msa-link'),
  msaCode: $('#msa-code'),
  msaOpen: $('#msa-open'),
  msaStatus: $('#msa-status'),
  msaClose: $('#msa-close'),
  btnMsa: $('#btn-msa'),
  btnLogout: $('#btn-logout'),
  btnOpenLibrary: $('#btn-open-library'),
  drawer: $('#drawer'),
  drawerMask: $('#drawer-mask'),
  drawerTabs: [...document.querySelectorAll('#drawer-tabs .tab')],
  drawerSearch: $('#drawer-search'),
  drawerMc: $('#drawer-mc'),
  drawerVersionFilter: $('#drawer-version-filter'),
  drawerSort: $('#drawer-sort'),
  drawerList: $('#drawer-list'),
  drawerFilters: $('#drawer-filters'),
  drawerCount: $('#drawer-count'),
  drawerInstall: $('#drawer-install'),
  drawerClose: $('#drawer-close'),
  conflictMask: $('#conflict-mask'),
  conflictDialog: $('#conflict-dialog'),
  conflictBody: $('#conflict-body'),
  conflictCancel: $('#conflict-cancel'),
  conflictContinue: $('#conflict-continue'),
  detailMask: $('#detail-mask'),
  detailDialog: $('#detail-dialog'),
  detailIcon: $('#detail-icon'),
  detailTitle: $('#detail-title'),
  detailMeta: $('#detail-meta'),
  detailZh: $('#detail-zh'),
  detailEn: $('#detail-en'),
  detailClose: $('#detail-close'),
  // 崩溃修复建议
  crashMask: $('#crash-mask'),
  crashDialog: $('#crash-dialog'),
  crashTitle: $('#crash-title'),
  crashMeta: $('#crash-meta'),
  crashSummary: $('#crash-summary'),
  crashCauses: $('#crash-causes'),
  btnCrashCopy: $('#btn-crash-copy'),
  btnCrashOpen: $('#btn-crash-open'),
  btnCrashRetry: $('#btn-crash-retry'),
  btnCrashClose: $('#btn-crash-close'),
  btnCrashfix: $('#btn-crashfix'),
  btnCrashfixStart: $('#btn-crashfix-start'),
  crashBannerStart: $('#crash-banner-start'),
  crashBannerLog: $('#crash-banner-log'),
  jobBanner: $('#job-banner'),
  jobBannerLabel: $('#job-banner-label'),
  jobBannerPct: $('#job-banner-pct'),
  jobBannerFill: $('#job-banner-fill'),
  jobBannerSub: $('#job-banner-sub'),
  tabs: [...document.querySelectorAll('.tab')],
};

const store = {
  state: { versions: [], selected: null, running: false, installing: false },
  lines: 0,
  kind: 'mod',
  job: null,
  remote: [],
  pick: '',
};

/** 崩溃修复：当前展示的报告 / 最近一次崩溃摘要 / 上次自动弹窗时间 */
let crashReport = null;
let lastCrashInfo = null;
let crashShownAt = 0;

const PREF_KEY = 'mcl.prefs';

const loadPrefs = () => {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
  } catch {
    return {};
  }
};

const savePrefs = (patch) => localStorage.setItem(PREF_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));

function toast(message, isError = false) {
  ui.toast.textContent = message;
  ui.toast.classList.toggle('error', Boolean(isError));
  ui.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ui.toast.classList.remove('show'), 2600);
}

async function api(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/** 1.20.1 -> 1.20；快照/特殊版本归到「其他」 */
function groupOf(id) {
  const match = String(id).match(/^(\d+\.\d+)/);
  return match ? match[1] : '其他';
}

function compareVersion(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function groupIds(ids) {
  const map = new Map();
  for (const id of ids) {
    const key = groupOf(id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(id);
  }
  return [...map.entries()]
    .map(([key, list]) => [key, list.slice().sort(compareVersion).reverse()])
    .sort((a, b) => (a[0] === '其他' ? -1 : b[0] === '其他' ? 1 : compareVersion(a[0], b[0]) * -1));
}

function updatePills() {
  const java = store.state.java ?? [];
  if (java.length === 0) {
    ui.pillJava.textContent = 'Java 待下载';
    ui.pillJava.className = 'pill warn';
  } else {
    const best = java.reduce((acc, item) => (item.major > acc.major ? item : acc), java[0]);
    ui.pillJava.textContent = `Java ${best.major}`;
    ui.pillJava.className = 'pill ok';
  }
}

function renderVersions() {
  const { versions, selected } = store.state;
  ui.versionGroups.innerHTML = '';
  ui.versionEmpty.hidden = versions.length > 0;

  for (const [group, list] of groupIds(versions.map((v) => v.id))) {
    const details = document.createElement('details');
    details.className = 'group';
    // 默认展开包含当前选中版本的分组，省得找
    details.open = Boolean(selected && list.includes(selected));

    const summary = document.createElement('summary');
    summary.innerHTML = `${group} <span class="count">${list.length}</span>`;
    details.appendChild(summary);

    const items = document.createElement('div');
    items.className = 'group-items';
    for (const id of list) {
      const info = versions.find((v) => v.id === id);
      const row = document.createElement('div');
      row.className = 'version-item';
      if (id === selected) row.classList.add('selected');
      row.innerHTML = `
        <div>
          <div class="version-name">${id}</div>
          <div class="version-meta">
            <span class="tag loader">${info.loader}</span>
            <span class="tag java">Java ${info.java}</span>
            ${info.mods > 0 ? `<span class="tag">${info.mods} mod</span>` : ''}
          </div>
        </div>
        <div class="version-actions">
          <button class="ghost" data-role="run">启动</button>
          <button class="ghost" data-role="export" title="导出为整合包">导出</button>
          <button class="ghost danger-ghost" data-role="delete" title="删除实例（不可恢复）">删除</button>
        </div>
      `;
      row.addEventListener('click', (event) => {
        selectVersion(id);
        const role = event.target.closest('[data-role]')?.dataset.role;
        if (role === 'run') doLaunch();
        else if (role === 'export') exportInstance(id);
        else if (role === 'delete') deleteInstance(id);
      });
      items.appendChild(row);
    }
    details.appendChild(items);
    ui.versionGroups.appendChild(details);
  }
}

function selectVersion(id) {
  store.state.selected = id;
  savePrefs({ selected: id });
  renderVersions();
  renderLaunchState();
}

let appliedMemory = Number(loadPrefs().memory) || 2;

function updateMemoryUi() {
  const mem = store.state.memory ?? { totalGb: 16, freeGb: 8 };
  const max = Math.max(2, Math.min(32, Math.ceil(mem.totalGb)));
  ui.inputMemory.max = String(max);
  if (Number(ui.inputMemory.value) > max) ui.inputMemory.value = String(max);

  // 安全上限只用于提示，不在这里强行截断——留给「确定」时再纠正
  const safeMax = Math.max(1, Math.floor(mem.freeGb ?? 8) - 1);
  const value = Number(ui.inputMemory.value) || 2;

  const ratio = Math.min(1, value / (mem.totalGb || 16));
  const hue = Math.round(130 - 130 * Math.pow(ratio, 0.75));
  ui.memoryLabel.textContent = `${value} G`;
  ui.memoryLabel.style.color = `hsl(${hue} 85% 60%)`;
  ui.inputMemory.style.accentColor = `hsl(${hue} 85% 55%)`;
  ui.inputMemory.title = `本机 ${mem.totalGb}G，可用 ${mem.freeGb}G，安全上限 ${safeMax}G`;
  ui.memoryConfirm.hidden = value === appliedMemory;
}

/** 下载/安装/启动任务的进度条（数据来自 SSE job 事件和 /api/state.job） */
function renderJobBanner() {
  const banner = ui.jobBanner;
  if (!banner) return;
  const job = store.job;
  const active = Boolean(job && job.status === 'running');
  banner.hidden = !active;
  if (!active) return;
  const meta = job.meta || {};
  const label =
    meta.label || (job.kind === 'install' ? `安装 ${meta.version ?? ''}` : `启动 ${meta.version ?? ''}`);
  ui.jobBannerLabel.textContent = String(label).trim() || '正在处理…';
  if (ui.jobBannerSub) ui.jobBannerSub.textContent = job.progress?.text || '';
  const pct =
    job.progress && Number.isFinite(job.progress.percent)
      ? Math.max(0, Math.min(100, job.progress.percent))
      : null;
  if (ui.jobBannerFill) {
    ui.jobBannerFill.classList.toggle('indeterminate', pct === null);
    ui.jobBannerFill.style.width = pct === null ? '38%' : `${pct}%`;
  }
  if (ui.jobBannerPct) ui.jobBannerPct.textContent = pct === null ? '' : `${Math.round(pct)}%`;
}

function renderLaunchState() {
  const { selected, running, installing } = store.state;
  ui.btnLaunch.disabled = !selected || running || installing;
  ui.btnStop.hidden = !running;
  const auth = store.state.auth;
  const who =
    auth?.loggedIn && !auth.expired
      ? `正版账号 ${auth.name}`
      : `离线玩家 ${ui.inputUser.value || 'Player'}`;
  const runtime = store.state.runtime;
  const exitCode = runtime?.exitCode;
  ui.launchHint.textContent = running
    ? '游戏正在运行…'
    : runtime?.state === 'exited'
      ? `上一局已退出${Number.isFinite(exitCode) ? `（退出码 ${exitCode}）` : ''}，可以再次启动`
      : selected
        ? `将启动 ${selected}（${who}）`
        : '先选一个版本';
  renderQuickLaunch();
}

function renderQuickLaunch() {
  const versions = store.state.versions ?? [];
  ui.quickLaunch.innerHTML = '';
  if (versions.length === 0) return;
  const title = document.createElement('span');
  title.className = 'quick-title';
  title.textContent = '快速启动';
  ui.quickLaunch.appendChild(title);
  for (const version of versions.slice(0, 4)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip quick';
    btn.textContent = `▶ ${version.id}`;
    btn.addEventListener('click', () => {
      selectVersion(version.id);
      doLaunch();
    });
    ui.quickLaunch.appendChild(btn);
  }
}

async function refresh() {
  const state = await api('/api/state');
  let selected = state.versions.some((v) => v.id === store.state.selected)
    ? store.state.selected
    : (state.versions[0]?.id ?? null);
  // 本地整合包装完之后，自动选到新实例上
  if (store.pendingSelect && state.versions.some((v) => v.id === store.pendingSelect)) {
    selected = store.pendingSelect;
    savePrefs({ selected });
    store.pendingSelect = null;
  }
  store.state = { ...state, selected };
  if (state.job) {
    store.job = {
      kind: state.job.kind,
      status: 'running',
      meta: state.job.meta ?? null,
      progress: state.job.progress ?? null,
    };
  } else if (!store.job || store.job.status !== 'running' || (!state.installing && !state.running)) {
    store.job = null;
  }
  renderJobBanner();
  renderVersions();
  renderLaunchState();
  updatePills();
  updateMemoryUi();
  // /api/state.lastCrash：后端已有最近崩溃时先点亮入口（不自动弹窗）
  if (state.lastCrash && !crashReport) {
    lastCrashInfo = state.lastCrash;
    updateCrashEntryPoints();
  }
}

async function loadRemote() {
  try {
    const remote = await api('/api/remote');
    ui.pillSource.textContent = remote.source;
    ui.pillSource.className = 'pill ok';
    store.remote = remote.versions.map((v) => v.id);
    store.pick = store.pick || store.state.selected || remote.latest.release;
    renderPicker();
    updatePickerLabel();
  } catch (error) {
    ui.pillSource.textContent = '下载源不可用';
    ui.pillSource.className = 'pill warn';
  }
}

function updatePickerLabel() {
  ui.pickerLabel.textContent = store.pick || '选择版本';
}

function renderPicker(filter = '') {
  const ids = filter ? store.remote.filter((id) => id.includes(filter)) : store.remote;
  ui.pickerList.innerHTML = '';
  if (ids.length === 0) {
    ui.pickerList.innerHTML = '<p class="hint">没有匹配的版本</p>';
    return;
  }
  for (const [group, list] of groupIds(ids)) {
    const details = document.createElement('details');
    details.className = 'group';
    details.open = Boolean(filter);
    const summary = document.createElement('summary');
    summary.innerHTML = `${group} <span class="count">${list.length}</span>`;
    details.appendChild(summary);
    const box = document.createElement('div');
    box.className = 'group-items';
    for (const id of list) {
      const option = document.createElement('div');
      option.className = 'option';
      if (id === store.pick) option.classList.add('active');
      option.textContent = id;
      option.addEventListener('click', () => {
        store.pick = id;
        updatePickerLabel();
        closePicker();
        renderPicker(ui.pickerSearch.value.trim());
      });
      box.appendChild(option);
    }
    details.appendChild(box);
    ui.pickerList.appendChild(details);
  }
}

function openPicker() {
  ui.pickerPop.hidden = false;
  ui.pickerSearch.value = '';
  renderPicker();
  setTimeout(() => ui.pickerSearch.focus(), 0);
}

function closePicker() {
  ui.pickerPop.hidden = true;
}

function appendLine(text) {
  const line = document.createElement('div');
  let cls = 'dim';
  if (text.startsWith('✓')) cls = 'ok';
  else if (text.startsWith('✗') || text.includes('[ERROR]') || text.includes('Exception')) cls = 'err';
  else if (text.startsWith('›')) cls = 'step';
  line.className = cls;
  line.textContent = text;
  ui.console.appendChild(line);
  store.lines += 1;
  if (store.lines > 900) {
    ui.console.firstElementChild?.remove();
    store.lines -= 1;
  }
  ui.console.scrollTop = ui.console.scrollHeight;
}

async function doInstall() {
  const version = store.pick;
  if (!version) return;
  ui.btnInstall.disabled = true;
  try {
    await api('/api/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version }),
    });
    toast(`开始安装 ${version}`);
  } catch (error) {
    toast(error.message, true);
    ui.btnInstall.disabled = false;
  }
}

async function doLaunch() {
  const version = store.state.selected;
  if (!version) return;
  const payload = {
    version,
    username: ui.inputUser.value.trim() || 'Player',
    memory: `${Number(ui.inputMemory.value) || 2}G`,
    width: Number(ui.inputWidth.value) || 854,
    height: Number(ui.inputHeight.value) || 480,
  };
  savePrefs({
    username: payload.username,
    memory: Number(ui.inputMemory.value) || 2,
    width: payload.width,
    height: payload.height,
  });
  try {
    await api('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    toast(`正在启动 ${version}`);
  } catch (error) {
    toast(error.message, true);
  }
}

async function exportInstance(id) {
  try {
    await api('/api/instance/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance: id, includeSaves: Boolean(ui.exportSaves?.checked) }),
    });
    toast(`开始导出「${id}」${ui.exportSaves?.checked ? '（含存档）' : ''}，完成后会自动下载`);
  } catch (error) {
    toast(`导出失败：${error.message}`, true);
  }
}

async function deleteInstance(id) {
  const ok = window.confirm(
    `确定删除实例「${id}」？\n\n它的模组、配置和存档都会被删除，无法恢复。`,
  );
  if (!ok) return;
  try {
    await api('/api/instance/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance: id }),
    });
    toast(`已删除「${id}」`);
    await refresh();
  } catch (error) {
    toast(`删除失败：${error.message}`, true);
  }
}

async function doStop() {
  try {
    const result = await api('/api/stop', { method: 'POST' });
    if (result?.ok === false) toast('当前没有正在运行的游戏');
    else toast('已请求停止');
  } catch (error) {
    toast(error.message, true);
  }
}

/* ---------- 崩溃修复建议 ---------- */

/** 客户端自己处理的 fix.kind（其余走服务端 /api/crashfix/apply） */
const CLIENT_FIX_KINDS = new Set(['set-memory', 'install-mod', 'retry-launch', 'update-loader', 'open-settings', 'advisory']);

/** 切页面统一走左侧导航按钮，复用 appearance.js 的 pageTo */
function navigateTo(page) {
  document.querySelector(`.nav-item[data-page="${page}"]`)?.click();
}

function confidenceText(value) {
  if (value === 'high') return '置信度高';
  if (value === 'medium') return '置信度中';
  if (value === 'low') return '置信度低';
  return '';
}

function fmtCrashTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** SSE crash 事件 / POST /api/crashfix 的 report -> /api/state.lastCrash 形状 */
function reportToLastCrash(report) {
  return {
    instance: report?.instance ?? null,
    at: report?.crashAt || report?.generatedAt || null,
    summary: report?.summary || '游戏异常退出',
    exitCode: report?.exitCode ?? null,
    causeIds: (report?.causes ?? []).map((cause) => cause.id).filter(Boolean),
    reportPath: report?.reportPath ?? null,
  };
}

function openCrashDialog() {
  if (ui.crashMask) ui.crashMask.hidden = false;
  if (ui.crashDialog) ui.crashDialog.hidden = false;
}

function closeCrash() {
  if (ui.crashMask) ui.crashMask.hidden = true;
  if (ui.crashDialog) ui.crashDialog.hidden = true;
  setCrashBusy(false);
}

function setCrashBusy(busy) {
  // false 不在这里恢复：由 renderCrashReport 按报告内容重新决定各按钮状态
  if (!busy) return;
  for (const button of [ui.btnCrashCopy, ui.btnCrashOpen, ui.btnCrashRetry]) {
    if (button) button.disabled = true;
  }
}

/** 展示一份修复报告（SSE 自动弹窗 / 手动打开都走这里） */
function showCrash(report) {
  if (!report) return;
  crashReport = report;
  crashShownAt = Date.now();
  if (report.crashed !== false) lastCrashInfo = reportToLastCrash(report);
  setCrashBusy(false);
  renderCrashReport(report);
  openCrashDialog();
  updateCrashEntryPoints();
}

/** 新一次启动开始时清空旧崩溃状态（不弹窗） */
function resetCrashState() {
  crashReport = null;
  lastCrashInfo = null;
  crashShownAt = 0;
  closeCrash();
  updateCrashEntryPoints();
}

/** 复制报告：优先 clipboard，失败退回 textarea + execCommand */
function copyViaTextarea(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', 'readonly');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';
  document.body.appendChild(area);
  let ok = false;
  try {
    area.select();
    area.setSelectionRange(0, area.value.length);
    ok = document.execCommand('copy');
  } finally {
    area.remove();
  }
  if (!ok) throw new Error('execCommand copy 失败');
}

async function copyCrashReport() {
  const text = crashReport?.text;
  if (!text) {
    toast('还没有可复制的报告', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('崩溃修复报告已复制，可直接粘给 AI');
  } catch {
    try {
      copyViaTextarea(text);
      toast('崩溃修复报告已复制，可直接粘给 AI');
    } catch {
      toast('复制失败，请手动选中报告文本', true);
    }
  }
}

/** 根据 report 推断「打开崩溃报告」按钮该发什么服务端动作 */
function crashOpenFix(report = crashReport) {
  if (!report) return null;
  const sources = report.sources ?? {};
  const file = sources.crashReport || report.reportPath;
  if (file) {
    return { id: 'open-crash-report', kind: 'open-report', label: '打开崩溃报告', executable: true, payload: { path: file } };
  }
  if (sources.log || sources.launcherConsole || report.instance) {
    return {
      id: 'open-crash-log',
      kind: 'open-log',
      label: '打开日志目录',
      executable: true,
      payload: { instance: report.instance },
    };
  }
  return null;
}

function renderFixNode(fix) {
  if (!fix) return document.createElement('span');
  // executable:false 只展示文案，不渲染按钮
  if (fix.executable === false) {
    const box = document.createElement('div');
    box.className = 'crash-fix-advisory';
    const title = document.createElement('strong');
    title.textContent = fix.label || fix.payload?.hint || '建议';
    box.appendChild(title);
    const desc = fix.description || (fix.payload?.hint !== fix.label ? fix.payload?.hint : '');
    if (desc) {
      const span = document.createElement('span');
      span.textContent = desc;
      box.appendChild(span);
    }
    return box;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost crash-fix';
  if (fix.kind === 'retry-launch' || fix.kind === 'set-memory') button.classList.add('crash-fix-main');
  button.textContent = fix.label || fix.kind || '修复';
  if (fix.description) button.title = fix.description;
  button.addEventListener('click', () => applyCrashFix(fix, button));
  return button;
}

function renderCauseCard(cause) {
  const severity = cause?.severity === 'warn' ? 'warn' : 'fatal';
  const card = document.createElement('article');
  card.className = `crash-cause crash-${severity}`;

  const head = document.createElement('header');
  head.className = 'crash-cause-head';
  const badge = document.createElement('span');
  badge.className = `crash-badge ${severity}`;
  badge.textContent = severity === 'warn' ? '警告' : '致命';
  const title = document.createElement('strong');
  title.className = 'crash-cause-title';
  title.textContent = cause?.title || '未知原因';
  head.append(badge, title);
  const confidence = Number(cause?.confidence);
  if (Number.isFinite(confidence)) {
    const conf = document.createElement('span');
    conf.className = 'crash-conf';
    conf.textContent = `置信度 ${Math.round(Math.min(1, Math.max(0, confidence)) * 100)}%`;
    head.appendChild(conf);
  }
  card.appendChild(head);

  if (cause?.explanation) {
    const exp = document.createElement('p');
    exp.className = 'crash-cause-exp';
    exp.textContent = cause.explanation;
    card.appendChild(exp);
  }

  const evidence = (cause?.evidence ?? []).filter((line) => String(line ?? '').trim()).slice(0, 6);
  if (evidence.length > 0) {
    const box = document.createElement('div');
    box.className = 'crash-evidence';
    for (const line of evidence) {
      const code = document.createElement('code');
      code.textContent = String(line).slice(0, 300);
      box.appendChild(code);
    }
    card.appendChild(box);
  }

  const fixes = (cause?.fixes ?? []).filter(Boolean);
  if (fixes.length > 0) {
    const row = document.createElement('div');
    row.className = 'crash-fixes';
    for (const fix of fixes) row.appendChild(renderFixNode(fix));
    card.appendChild(row);
  }
  return card;
}

function renderCrashReport(report) {
  const crashed = report?.crashed !== false;
  const causes = Array.isArray(report?.causes) ? report.causes : [];
  const fixes = Array.isArray(report?.fixes) ? report.fixes : [];

  ui.crashTitle.textContent = crashed ? '崩溃修复建议' : '崩溃检查结果';
  ui.crashDialog?.classList.toggle('crash-no-crash', !crashed);

  const meta = [];
  if (report?.instance) meta.push(`实例 ${report.instance}`);
  if (report?.mc) meta.push(`MC ${report.mc}`);
  if (report?.loader) meta.push(report.loader);
  if (report?.crashed) {
    if (report.exitCode !== null && report.exitCode !== undefined) meta.push(`退出码 ${report.exitCode}`);
    const at = report.crashAt || report.generatedAt;
    if (at) meta.push(fmtCrashTime(at));
  }
  const confidence = confidenceText(report?.confidence);
  if (confidence) meta.push(confidence);
  ui.crashMeta.textContent = meta.join(' · ');

  ui.crashSummary.textContent = report?.summary || (crashed ? '游戏异常退出，但没有生成结论。' : '没有找到崩溃日志。');
  ui.crashSummary.classList.toggle('warn', !crashed);

  ui.crashCauses.innerHTML = '';
  if (causes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'crash-empty';
    const text = document.createElement('p');
    text.textContent = crashed
      ? '未命中已知规则，把报告复制给 AI 分析（通常比人工翻日志更快）。'
      : '没有发现崩溃迹象，暂时不需要修复；下次游戏崩溃后再来看这里。';
    empty.appendChild(text);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'primary small';
    copy.textContent = '复制报告';
    copy.addEventListener('click', copyCrashReport);
    empty.appendChild(copy);
    ui.crashCauses.appendChild(empty);
  } else {
    for (const cause of causes) ui.crashCauses.appendChild(renderCauseCard(cause));
  }

  // 底部汇总跨 cause 的修复动作（去重，最多 8 个）
  if (fixes.length > 0) {
    const seen = new Set();
    const list = [];
    for (const fix of fixes) {
      if (!fix) continue;
      const key = fix.id || `${fix.kind}:${JSON.stringify(fix.payload ?? {})}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(fix);
      if (list.length >= 8) break;
    }
    if (list.length > 0) {
      const box = document.createElement('section');
      box.className = 'crash-all-fixes';
      const heading = document.createElement('h4');
      heading.textContent = '全部修复动作';
      const row = document.createElement('div');
      row.className = 'crash-fixes';
      for (const fix of list) row.appendChild(renderFixNode(fix));
      box.append(heading, row);
      ui.crashCauses.appendChild(box);
    }
  }

  const openTarget = crashOpenFix(report);
  if (ui.btnCrashOpen) {
    ui.btnCrashOpen.disabled = !openTarget;
    ui.btnCrashOpen.textContent = openTarget?.kind === 'open-log' ? '打开日志目录' : '打开崩溃报告';
  }
  if (ui.btnCrashCopy) {
    ui.btnCrashCopy.disabled = !report?.text;
    ui.btnCrashCopy.classList.toggle('crash-highlight', causes.length === 0 && Boolean(report?.text));
  }
  if (ui.btnCrashRetry) ui.btnCrashRetry.disabled = false;
}

/** 最近崩溃提示条（日志页 / 启动页各一份） */
function renderCrashBanners(info) {
  for (const banner of [ui.crashBannerStart, ui.crashBannerLog]) {
    if (!banner) continue;
    banner.innerHTML = '';
    if (!info) {
      banner.hidden = true;
      continue;
    }
    banner.hidden = false;
    const icon = document.createElement('span');
    icon.className = 'crash-banner-icon';
    icon.textContent = '⚠';
    const body = document.createElement('div');
    body.className = 'crash-banner-body';
    const title = document.createElement('div');
    title.className = 'crash-banner-title';
    title.textContent = `最近崩溃：${info.summary || '原因待分析'}`;
    const meta = document.createElement('div');
    meta.className = 'crash-banner-meta';
    meta.textContent = [
      info.instance ? `实例 ${info.instance}` : '',
      info.exitCode !== null && info.exitCode !== undefined ? `退出码 ${info.exitCode}` : '',
      info.at ? fmtCrashTime(info.at) : '',
    ].filter(Boolean).join(' · ');
    body.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'crash-banner-actions';
    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'primary small';
    view.textContent = '查看修复建议';
    view.addEventListener('click', openCrashFix);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'ghost small';
    retry.textContent = '重新启动';
    retry.addEventListener('click', () => retryLaunch(info.instance));
    actions.append(view, retry);
    banner.append(icon, body, actions);
  }
}

function updateCrashEntryPoints() {
  const info = lastCrashInfo;
  const hasCrash = Boolean(info || (crashReport && crashReport.crashed !== false));
  if (ui.btnCrashfixStart) ui.btnCrashfixStart.hidden = !hasCrash;
  if (ui.btnCrashfix) ui.btnCrashfix.classList.toggle('crash-alert', Boolean(info));
  renderCrashBanners(info);
}

function retryLaunch(instance) {
  if (store.state.running) {
    toast('游戏正在运行，先点「停止」再重试', true);
    return;
  }
  const target = instance || store.state.selected;
  const exists = target && (store.state.versions ?? []).some((version) => version.id === target);
  if (exists) selectVersion(target);
  else if (target && target !== store.state.selected) toast(`实例 ${target} 不在已安装列表里，用当前实例启动`, true);
  if (!store.state.selected) {
    toast('还没有可启动的实例', true);
    return;
  }
  doLaunch();
}

/** 打开崩溃修复面板：有缓存报告直接展示，否则 POST /api/crashfix 现场分析 */
async function openCrashFix() {
  if (crashReport) {
    showCrash(crashReport);
    return;
  }
  const instance = lastCrashInfo?.instance || store.state.selected;
  if (!instance) {
    toast('先选一个版本再分析崩溃', true);
    return;
  }
  openCrashDialog();
  ui.crashTitle.textContent = '崩溃修复建议';
  ui.crashMeta.textContent = `${instance} · 正在分析…`;
  ui.crashSummary.textContent = '正在读取 crash-reports / 日志 / 模组信息，生成修复建议…';
  ui.crashSummary.classList.remove('warn');
  ui.crashCauses.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'crash-empty';
  loading.textContent = '正在分析…';
  ui.crashCauses.appendChild(loading);
  if (ui.btnCrashOpen) ui.btnCrashOpen.disabled = true;
  setCrashBusy(true);
  try {
    const data = await api('/api/crashfix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance }),
    });
    if (!data?.report) throw new Error('接口没有返回报告');
    // 用户可能在分析过程中已经把弹窗关了：只缓存，不强行再弹
    const stillOpen = Boolean(ui.crashDialog && !ui.crashDialog.hidden);
    crashReport = data.report;
    crashShownAt = Date.now();
    if (data.report.crashed !== false) lastCrashInfo = reportToLastCrash(data.report);
    setCrashBusy(false);
    updateCrashEntryPoints();
    if (stillOpen) renderCrashReport(data.report);
    else toast('已生成崩溃修复建议，点「崩溃修复」查看');
  } catch (error) {
    setCrashBusy(false);
    if (ui.btnCrashCopy) ui.btnCrashCopy.disabled = true;
    if (ui.btnCrashOpen) ui.btnCrashOpen.disabled = true;
    if (ui.btnCrashRetry) ui.btnCrashRetry.disabled = false;
    ui.crashMeta.textContent = `${instance} · 分析失败`;
    ui.crashSummary.className = 'crash-summary warn';
    ui.crashSummary.textContent = `生成修复建议失败：${error.message}`;
    ui.crashCauses.innerHTML = '';
    const tip = document.createElement('div');
    tip.className = 'crash-empty';
    tip.textContent = '接口暂不可用或分析出错。可以关闭后稍后重试，或到日志页确认崩溃原因。';
    ui.crashCauses.appendChild(tip);
    toast(`生成修复建议失败：${error.message}`, true);
  }
}

/** 服务端类修复：POST /api/crashfix/apply，成功后重新分析刷新面板 */
async function applyCrashFixServer(fix) {
  const instance = fix.payload?.instance || crashReport?.instance || lastCrashInfo?.instance || store.state.selected;
  if (!instance) {
    toast('这个修复需要实例信息，但当前没有可用实例', true);
    return;
  }
  if (fix.kind === 'install-java') toast(`正在下载安装 Java ${fix.payload?.major ?? ''}，可能要几分钟…`);
  const data = await api('/api/crashfix/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instance, kind: fix.kind, payload: fix.payload ?? {} }),
  });
  if (data?.ok === false) {
    toast(data.message || (data.needsClient ? '这个修复需要在客户端处理' : '修复没有执行成功'), !data.needsClient);
    return;
  }
  toast(data?.message || fix.label || '已执行修复');
  await refreshCrashReport(instance);
}

async function refreshCrashReport(instance) {
  const target = instance || crashReport?.instance || lastCrashInfo?.instance || store.state.selected;
  if (!target) return;
  try {
    const data = await api('/api/crashfix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance: target }),
    });
    if (!data?.report) return;
    crashReport = data.report;
    if (data.report.crashed !== false) lastCrashInfo = reportToLastCrash(data.report);
    if (ui.crashDialog && !ui.crashDialog.hidden) renderCrashReport(data.report);
    updateCrashEntryPoints();
  } catch (error) {
    toast(`刷新修复建议失败：${error.message}`, true);
  }
}

/** fix 动作分发：客户端动作本地执行，服务端动作交给 /api/crashfix/apply */
async function applyCrashFix(fix, button) {
  if (!fix) return;
  if (fix.executable === false) {
    if (fix.label || fix.payload?.hint) toast(fix.label || fix.payload.hint);
    return;
  }
  const original = button?.textContent ?? '';
  if (button) {
    button.disabled = true;
    button.textContent = fix.kind === 'install-java' ? '正在安装 Java…' : '处理中…';
  }
  try {
    if (CLIENT_FIX_KINDS.has(fix.kind)) {
      switch (fix.kind) {
        case 'set-memory': {
          const next = Math.round(Number(String(fix.payload?.memory ?? '').replace(/[^\d.]/g, '')));
          if (!Number.isFinite(next) || next <= 0) {
            toast(fix.description || fix.label || '没能解析建议的内存值', true);
            return;
          }
          const value = Math.min(64, Math.max(1, next));
          ui.inputMemory.value = String(value);
          appliedMemory = value;
          savePrefs({ memory: value });
          updateMemoryUi();
          navigateTo('start');
          toast(`已设为 ${value} G，点「启动游戏」重试`);
          return;
        }
        case 'install-mod': {
          const query = String(fix.payload?.query ?? '').trim();
          const mc = String(fix.payload?.mc ?? '').trim();
          closeCrash();
          navigateTo('library');
          if (mc) ui.drawerMc.value = mc;
          drawerOpen('mod');
          if (!query) return;
          ui.drawerSearch.value = query;
          await doDrawerSearch();
          toast(`已在模组库搜索「${query}」`);
          return;
        }
        case 'retry-launch': {
          if (store.state.running) {
            toast('游戏正在运行，先点「停止」再重试', true);
            return;
          }
          const target = fix.payload?.instance || crashReport?.instance || lastCrashInfo?.instance;
          closeCrash();
          retryLaunch(target);
          return;
        }
        case 'update-loader': {
          const bits = [fix.payload?.loader, fix.payload?.mc].filter(Boolean).join(' · ');
          toast(`${fix.label || '建议升级加载器'}${bits ? `（${bits}）` : ''}`);
          if (fix.description) appendLine(`! ${fix.description}`);
          return;
        }
        case 'open-settings': {
          const page = fix.payload?.page === 'start' ? 'start' : 'appearance';
          closeCrash();
          navigateTo(page);
          toast(fix.label || '已切到设置页');
          return;
        }
        case 'advisory': {
          toast(fix.label || fix.payload?.hint || '建议');
          return;
        }
        default:
          break;
      }
    }
    await applyCrashFixServer(fix);
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

/** 启动时读取最近一次崩溃（GET /api/crash/last，失败时退回 /api/state.lastCrash） */
async function loadLastCrash() {
  const fromState = store.state?.lastCrash ?? null;
  let report = null;
  try {
    const data = await api('/api/crash/last');
    if (data?.report) report = data.report;
  } catch {
    /* 后端尚未提供 /api/crash/last 时静默降级 */
  }
  if (report && report.crashed !== false) {
    crashReport = report;
    lastCrashInfo = reportToLastCrash(report);
  } else if (fromState) {
    lastCrashInfo = fromState;
  }
  updateCrashEntryPoints();
}

/* ---------- 模组 / 整合包识别 ---------- */

function setKind(kind) {
  store.kind = kind;
  for (const tab of ui.tabs) tab.classList.toggle('active', tab.dataset.kind === kind);
  ui.fileInput.accept = kind === 'mod' ? '.jar' : '.zip,.mrpack';
  ui.dropText.textContent =
    kind === 'mod'
      ? '拖入模组 .jar 或点击选择，自动识别需要的模组框架'
      : '拖入整合包 .zip / .mrpack 或点击选择';
  ui.searchInput && (ui.searchInput.placeholder = '');
  ui.result.hidden = true;
}

async function inspectFile(file) {
  if (!file) return;
  // 拖入/选择的文件统一走流式上传：服务端暂存并返回 uploadId，后面能直接装
  ui.dropText.textContent =
    file.size > 8 * 1024 * 1024
      ? `正在读取 ${file.name}（${(file.size / 1024 / 1024).toFixed(0)}MB）…`
      : `正在识别 ${file.name}…`;
  try {
    const res = await fetch('/api/mod/inspect-file', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    });
    const info = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(info.error || `HTTP ${res.status}`);
    lastInspectPath = '';
    lastUpload = info.uploadId ? { id: info.uploadId, name: file.name } : null;
    renderInspect(info, file);
  } catch (error) {
    ui.dropText.textContent = '识别失败，试试用下面的路径识别';
    toast(`识别失败：${error.message}`, true);
  }
  return;
  ui.dropText.textContent = `正在识别 ${file.name}…`;
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });
    const base64 = String(dataUrl).split(',')[1] ?? '';
    if (!base64) throw new Error('浏览器读取结果为空，请改用路径识别');
    const info = await api('/api/mod/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, data: base64 }),
    });
    renderInspect(info, file);
  } catch (error) {
    toast(error.message, true);
    ui.dropText.textContent = '识别失败，试试用下面的路径识别';
  }
}

let lastInspectPath = '';
// 拖入/选择的文件会先传到服务端暂存，装整合包时用这个 id（浏览器拿不到本地路径）
let lastUpload = null;

async function importPack() {
  const source = lastInspectPath
    ? { path: lastInspectPath }
    : lastUpload?.id
      ? { uploadId: lastUpload.id }
      : null;
  if (!source) {
    toast('请重新拖入文件，或用「浏览…」选一次', true);
    return;
  }
  try {
    await api('/api/mod/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(source),
    });
    toast('开始导入，日志里能看到解压进度');
  } catch (error) {
    toast(error.message, true);
  }
}

async function startMsaLogin() {
  // 点按钮是用户手势，先同步开一个空白窗口，拿到设备码后再把窗口导航到微软登录页
  let popup = null;
  try {
    popup = window.open('about:blank', 'mcl-msa-login', 'popup=yes,width=560,height=720');
  } catch {
    popup = null;
  }
  ui.msaBox.hidden = false;
  ui.msaCode.textContent = '------';
  ui.msaStatus.textContent = '正在申请设备码…';
  try {
    const info = await api('/api/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    ui.msaCode.textContent = info.userCode;
    ui.msaLink.href = info.verificationUri;
    ui.msaLink.textContent = info.verificationUri;
    ui.msaStatus.textContent = `等待你在网页上完成登录…（${Math.round(info.expiresIn / 60)} 分钟内有效）`;
    savePrefs({ clientId: info.clientId });
    if (popup && !popup.closed) {
      try {
        popup.location.replace(info.verificationUri);
      } catch {
        try {
          popup.location.href = info.verificationUri;
        } catch {
          /* ignore */
        }
      }
    } else {
      toast('浏览器拦截了自动跳转，点「打开登录页」或链接继续');
    }
    try {
      await navigator.clipboard.writeText(info.userCode);
      toast(`登录代码 ${info.userCode} 已复制`);
    } catch {
      /* 剪贴板不可用就算了 */
    }
  } catch (error) {
    ui.msaStatus.textContent = `申请失败：${error.message}`;
    if (popup && !popup.closed) popup.close();
  }
}

async function refreshAuth() {
  try {
    const auth = await api('/api/auth/status');
    store.state.auth = auth;
    ui.btnMsa.textContent = auth.loggedIn ? `${auth.name} · 已登录` : '微软登录';
    ui.btnMsa.dataset.loggedIn = auth.loggedIn ? '1' : '';
    ui.btnMsa.title = auth.loggedIn ? '已用正版账号登录，点击可重新登录' : '微软设备码登录（不接触账号密码）';
    if (ui.btnLogout) ui.btnLogout.hidden = !auth.loggedIn;
    renderLaunchState();
  } catch {
    ui.btnMsa.textContent = '微软登录';
    ui.btnMsa.dataset.loggedIn = '';
    if (ui.btnLogout) ui.btnLogout.hidden = true;
  }
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
    toast('已退出正版账号，将使用离线身份启动');
    await refreshAuth();
    await refresh();
  } catch (error) {
    toast(`退出失败：${error.message}`, true);
  }
}

async function pickFileFromSystem() {
  try {
    const result = await api('/api/pick-file', { method: 'POST' });
    if (result.path) {
      ui.inspectPath.value = result.path;
      await inspectPath();
    }
  } catch (error) {
    toast(error.message, true);
  }
}

async function inspectPath() {
  const target = ui.inspectPath.value.trim();
  if (!target) return;
  ui.dropText.textContent = '正在识别本地文件…';
  try {
    const info = await api('/api/mod/inspect-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target }),
    });
    lastInspectPath = target;
    lastUpload = null;
    renderInspect(info, { name: target.split(/[\\/]/).pop(), size: 0 });
  } catch (error) {
    ui.dropText.textContent = '识别失败';
    toast(error.message, true);
  }
}

function renderInspect(info, file) {
  ui.dropText.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
  const badgeClass = info.kind === 'modpack' ? 'pack' : info.loader ?? '';
  const title = info.name || file.name;
  const rows = [];
  if (info.version) rows.push(`<span>版本 ${info.version}</span>`);
  if (info.mcConstraint) {
    const mc = Array.isArray(info.mcConstraint) ? info.mcConstraint.join(', ') : info.mcConstraint;
    rows.push(`<span>Minecraft ${mc}</span>`);
  }
  if (info.loaderVersion) rows.push(`<span>加载器 ${info.loaderVersion}</span>`);
  if (info.files) rows.push(`<span>${info.files} 个文件</span>`);
  if (info.format) rows.push(`<span>${info.format}</span>`);

  ui.result.hidden = false;
  ui.result.innerHTML = `
    <div class="result-head">
      <span class="badge ${badgeClass}">${info.kind === 'modpack' ? '整合包' : info.loaderLabel}</span>
      <span class="result-name">${escapeHtml(title)}</span>
    </div>
    ${rows.length ? `<div class="kv">${rows.join('')}</div>` : ''}
    <p>${escapeHtml(info.hint ?? '')}</p>
  `;
  if (info.kind === 'mod') {
    const need = document.createElement('p');
    need.textContent = '下一步：为对应版本安装加载器后，把 jar 放进「版本目录/mods」即可。';
    ui.result.appendChild(need);
  }
  if (info.kind === 'modpack' && info.format === 'CurseForge') {
    const instanceName = String(file.name ?? '').replace(/\.(zip|mrpack)$/i, '') || '整合包';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.style.marginTop = '10px';
    btn.textContent = `安装为实例「${instanceName}」`;
    btn.addEventListener('click', async () => {
      const source = lastInspectPath
        ? { path: lastInspectPath }
        : lastUpload?.id
          ? { uploadId: lastUpload.id }
          : null;
      if (!source) {
        toast('请重新拖入文件，或用「浏览…」选一次', true);
        return;
      }
      btn.disabled = true;
      btn.textContent = '正在加入安装队列…';
      try {
        await api('/api/pack/import-local', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...source, name: instanceName }),
        });
        store.pendingSelect = instanceName;
        toast(`开始安装「${instanceName}」，进度看下方日志`);
      } catch (error) {
        toast(`安装失败：${error.message}`, true);
      } finally {
        btn.disabled = false;
        btn.textContent = `安装为实例「${instanceName}」`;
      }
    });
    ui.result.appendChild(btn);
  }
  if (info.kind === 'modpack' && String(info.hint ?? '').includes('解压即玩')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.style.marginTop = '10px';
    btn.textContent = '一键导入';
    btn.addEventListener('click', importPack);
    ui.result.appendChild(btn);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/* ---------- 模组库抽屉 ---------- */

const drawer = { kind: 'mod', hits: [], selected: new Set(), analysis: null, filter: '', offset: 0, total: 0, loading: false, mc: '1.20.1', seq: 0 };

function drawerOpen(kind) {
  drawer.kind = kind || 'mod';
  drawer.selected.clear();
  drawer.hits = [];
  drawer.analysis = null;
  drawer.filter = '';
  for (const tab of ui.drawerTabs) tab.classList.toggle('active', tab.dataset.kind === drawer.kind);
  ui.drawer.hidden = false;
  ui.drawerMask.hidden = false;
  requestAnimationFrame(() => {
    ui.drawer.classList.add('open');
    ui.drawerMask.classList.add('show');
  });
  updateDrawerFoot();
  doDrawerSearch();
}

function drawerClose() {
  ui.drawer.classList.remove('open');
  ui.drawerMask.classList.remove('show');
  setTimeout(() => {
    ui.drawer.hidden = true;
    ui.drawerMask.hidden = true;
  }, 260);
}

const CAT_ZH = {
  optimization: '性能优化', technology: '科技', magic: '魔法', adventure: '冒险',
  decoration: '装饰', storage: '存储', worldgen: '世界生成', mobs: '生物',
  equipment: '装备', food: '食物', utility: '实用', library: '前置库',
  transport: '交通', 'game-mechanics': '机制', building: '建筑', management: '管理',
  minigame: '小游戏', social: '社交',
};
const zhCat = (name) => CAT_ZH[name] || name;

async function doDrawerSearch() {
  drawer.seq += 1; // 旧的请求就算回来了也丢掉
  drawer.loading = false; // 别让旧请求的 loading 拦住这次搜索
  drawer.mc = (ui.drawerMc.value || '1.20.1').trim();
  drawer.hits = [];
  drawer.analysis = null;
  drawer.offset = 0;
  drawer.total = 0;
  ui.drawerList.innerHTML = '<p class="hint">加载中…</p>';
  renderDrawerRows();
  await loadMore();
}

/** 取下一页并追加（滚到底自动触发） */
async function loadMore() {
  const seq = drawer.seq;
  if (drawer.loading) return;
  if (drawer.total > 0 && drawer.hits.length >= drawer.total) return;
  drawer.loading = true;
  const type = drawer.kind === 'pack' ? 'modpack' : drawer.kind === 'shader' ? 'shader' : 'mod';
  try {
    const data = await api('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: ui.drawerSearch.value.trim(),
        type,
        ...(ui.drawerVersionFilter.checked ? { mcVersion: drawer.mc } : {}),
        index: ui.drawerSort.value,
        // 光影不属于任何加载器，不能带 loader 筛选
        ...(type === 'shader' ? {} : { loader: 'fabric' }),
        limit: 24,
        offset: drawer.offset,
      }),
    });
    if (seq !== drawer.seq) return; // 搜索条件已经变了，这份结果作废
    drawer.total = data.total ?? 0;
    const fresh = data.hits ?? [];
    drawer.offset += fresh.length;
    drawer.hits = drawer.hits.concat(fresh);
    if (drawer.offset === fresh.length) {
      // 第一页：整体渲染 + 后台分析冲突（只有模组需要冲突/前置分析，整合包/光影跳过）
      renderDrawerRows();
      if (fresh.length > 0 && drawer.kind === 'mod') analyzeInBackground(drawer.mc, fresh.map((hit) => hit.id));
    } else {
      // 后续页：只追加，避免整列表重建（O(n²)）；有分类筛选时追加前先过一遍
      const visible = drawer.filter
        ? fresh.filter((hit) => (hit.categories ?? []).map(zhCat).includes(drawer.filter))
        : fresh;
      appendDrawerRows(visible);
    }
  } catch (error) {
    ui.drawerList.insertAdjacentHTML('beforeend', `<p class="hint">加载失败：${escapeHtml(error.message)}</p>`);
  } finally {
    if (seq === drawer.seq) {
      drawer.loading = false;
      updateDrawerFoot();
      ensureDrawerFilled();
    }
  }
}

/** 第一页没把容器撑满（没有滚动条）时继续拉：否则用户没有“滚到底”的机会 */
function ensureDrawerFilled() {
  if (drawer.loading) return;
  if (drawer.total > 0 && drawer.hits.length >= drawer.total) return;
  if (drawer.hits.length === 0 || drawer.hits.length >= 800) return; // 兜底：别无限灌
  const scroller = ui.drawerList.closest('.drawer-body') || ui.drawerList;
  if (!scroller) return;
  if (scroller.scrollHeight <= scroller.clientHeight + 120) loadMore();
}

async function analyzeInBackground(mc, ids) {
  const target = ids && ids.length > 0 ? ids : drawer.hits.map((hit) => hit.id);
  if (target.length === 0) return;
  try {
    const res = await api('/api/mods/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectIds: target, mcVersion: mc, loader: 'fabric' }),
    });
    const map = drawer.analysis ?? new Map();
    for (const project of res.projects) map.set(project.id, project);
    drawer.analysis = map;
    renderDrawerRows();
  } catch {
    /* 分析失败不影响列表 */
  }
}

function renderDrawerRows() {
  const cats = new Set();
  for (const hit of drawer.hits) {
    for (const cat of hit.categories ?? []) cats.add(zhCat(cat));
  }
  ui.drawerFilters.innerHTML = '';
  for (const cat of [...cats].slice(0, 10)) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (drawer.filter === cat ? ' active' : '');
    chip.dataset.cat = cat;
    chip.textContent = cat;
    ui.drawerFilters.appendChild(chip);
  }

  const rows = drawer.hits.filter((hit) => {
    if (!drawer.filter) return true;
    return (hit.categories ?? []).map(zhCat).includes(drawer.filter);
  });

  ui.drawerList.innerHTML = '';
  if (rows.length === 0) {
    ui.drawerList.innerHTML = '<p class="hint">没有结果</p>';
    return;
  }

  for (const hit of rows) {
    const info = drawer.analysis?.get(hit.id) ?? {};
    const conflict = Boolean(info.conflict);
    const deps = (info.dependencies ?? []).map((dep) => dep.title).filter(Boolean).join('、');
    const row = document.createElement('div');
    row.className = `mod-row${conflict ? ' conflict' : ''}`;
    row.innerHTML = `
      <input type="checkbox" class="mod-check" ${drawer.selected.has(hit.id) ? 'checked' : ''} />
      ${hit.icon ? `<img src="${escapeHtml(hit.icon)}" alt="" loading="lazy" />` : '<img alt="" />'}
      <div class="mod-main">
        <div class="mod-top">
          <span class="mod-title">${escapeHtml(hit.title)}</span>
          <span class="mod-ver">${escapeHtml(info.versionNumber ?? '')}</span>
        </div>
        <div class="mod-desc">${escapeHtml(hit.description ?? '')}</div>
        <div class="mod-tags">
          ${(hit.categories ?? []).map((cat) => `<span class="mod-tag">${escapeHtml(zhCat(cat))}</span>`).join('')}
          ${!ui.drawerVersionFilter.checked && (hit.versions ?? []).length
            ? `<span class="mod-tag ver">支持 ${escapeHtml((hit.versions ?? []).slice(-4).join(' / '))}</span>`
            : ''}
          ${deps ? `<span class="mod-tag dep">前置：${escapeHtml(deps)}</span>` : ''}
          ${conflict ? '<span class="mod-tag bad">冲突</span>' : ''}
        </div>
        ${conflict ? `<div class="mod-conflict-text">${escapeHtml((info.reasons ?? []).join('；'))}</div>` : ''}
      </div>
      <div class="mod-side">${(hit.downloads ?? 0).toLocaleString()}<span>下载</span></div>
    `;
    row.addEventListener('click', (event) => {
      if (event.target.classList.contains('mod-check')) return;
      openDetail(hit);
    });
    row.querySelector('.mod-check').addEventListener('change', (event) => toggleSelect(hit.id, event.target.checked));
    ui.drawerList.appendChild(row);
  }
  updateDrawerFoot();
}

function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<img[^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*`_~]{1,}/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function openDetail(hit) {
  const mc = (ui.drawerMc.value || '1.20.1').trim();
  ui.detailMask.hidden = false;
  ui.detailDialog.hidden = false;
  ui.detailTitle.textContent = hit.title;
  ui.detailIcon.src = hit.icon ?? '';
  ui.detailIcon.style.display = hit.icon ? 'block' : 'none';
  ui.detailMeta.textContent = `${(hit.downloads ?? 0).toLocaleString()} 次下载 · ${(hit.categories ?? []).map(zhCat).join(' / ')}`;
  ui.detailZh.textContent = '翻译中…';
  ui.detailEn.textContent = '加载中…';
  try {
    const detail = await api('/api/project/detail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: hit.id, mcVersion: mc, loader: 'fabric' }),
    });
    ui.detailMeta.textContent = `${detail.downloads.toLocaleString()} 次下载 · ${detail.categories.join(' / ')}${detail.version ? ` · 版本 ${detail.version.number}` : ''}`;
    const plain = stripMarkdown(detail.body);
    ui.detailEn.textContent = plain.slice(0, 4000) || '（没有描述）';
    const head = plain.slice(0, 300);
    if (!head.trim()) {
      ui.detailZh.textContent = '（没有简介）';
      return;
    }
    const tr = await api('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: head }),
    });
    ui.detailZh.textContent = tr.text || '（翻译服务不可用，请看下方英文）';
  } catch (error) {
    ui.detailEn.textContent = `加载失败：${error.message}`;
    ui.detailZh.textContent = '';
  }
}

function closeDetail() {
  ui.detailMask.hidden = true;
  ui.detailDialog.hidden = true;
}

/** 追加模式：只建新行，不重建已有 DOM */
function appendDrawerRows(fresh) {
  for (const hit of fresh) {
    const info = drawer.analysis?.get(hit.id) ?? {};
    const conflict = Boolean(info.conflict);
    const deps = (info.dependencies ?? []).map((dep) => dep.title).filter(Boolean).join('、');
    const row = document.createElement('div');
    row.className = `mod-row${conflict ? ' conflict' : ''}`;
    row.innerHTML = `
      <input type="checkbox" class="mod-check" ${drawer.selected.has(hit.id) ? 'checked' : ''} />
      ${hit.icon ? `<img src="${escapeHtml(hit.icon)}" alt="" loading="lazy" />` : '<img alt="" />'}
      <div class="mod-main">
        <div class="mod-top">
          <span class="mod-title">${escapeHtml(hit.title)}</span>
          <span class="mod-ver">${escapeHtml(info.versionNumber ?? '')}</span>
        </div>
        <div class="mod-desc">${escapeHtml(hit.description ?? '')}</div>
        <div class="mod-tags">
          ${(hit.categories ?? []).map((cat) => `<span class="mod-tag">${escapeHtml(zhCat(cat))}</span>`).join('')}
          ${!ui.drawerVersionFilter.checked && (hit.versions ?? []).length
            ? `<span class="mod-tag ver">支持 ${escapeHtml((hit.versions ?? []).slice(-4).join(' / '))}</span>`
            : ''}
          ${deps ? `<span class="mod-tag dep">前置：${escapeHtml(deps)}</span>` : ''}
        </div>
      </div>
      <div class="mod-side">${(hit.downloads ?? 0).toLocaleString()}<span>下载</span></div>
    `;
    row.addEventListener('click', (event) => {
      if (event.target.classList.contains('mod-check')) return;
      openDetail(hit);
    });
    row.querySelector('.mod-check').addEventListener('change', (event) => toggleSelect(hit.id, event.target.checked));
    ui.drawerList.appendChild(row);
  }
  updateDrawerFoot();
}

function toggleSelect(id, on) {
  if (on) drawer.selected.add(id);
  else drawer.selected.delete(id);
  updateDrawerFoot();
}

function updateDrawerFoot() {
  const count = drawer.selected.size;
  ui.drawerCount.textContent = count ? `已选 ${count} 个` : '未选择';
  ui.drawerInstall.disabled = count === 0;
  updateDrawerInstallLabel();
}

/** 按钮文案跟着页签走：模组是「安装」，整合包是「安装整合包」，光影是「下载光影」 */
function updateDrawerInstallLabel() {
  if (!ui.drawerInstall) return;
  ui.drawerInstall.textContent =
    drawer.kind === 'pack' ? '安装整合包' : drawer.kind === 'shader' ? '下载光影' : '安装选中';
}

function drawerTitle(id) {
  return (drawer.hits ?? []).find((hit) => hit.id === id)?.title ?? id;
}

/**
 * 整合包：走 /api/pack/install（会下载 mrpack 并新建独立实例）。
 * 以前这里和模组共用 /api/mods/install-batch，结果 .mrpack 被当模组下载进 mods/，
 * 既装不上又白下几十 MB——整合包一次只能装一个，后面的给提示。
 */
async function startPackInstall(ids, mc) {
  const id = ids[0];
  const title = drawerTitle(id);
  if (ids.length > 1) toast(`整合包一次只能装一个，已开始安装「${title}」`);
  try {
    await api('/api/pack/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: id, mcVersion: mc }),
    });
    toast(`开始安装整合包「${title}」，进度看底部日志`);
    drawerClose();
  } catch (error) {
    toast(error.message, true);
  }
}

/** 光影：走 /api/shader/install，装到当前实例（没有就退回第一个 Fabric 实例） */
async function startShaderInstall(ids, mc) {
  const selected = (store.state.versions ?? []).find((version) => version.id === store.state.selected);
  const fallback = (store.state.versions ?? []).find((version) => version.id.includes('fabric'));
  const instance = (selected ?? fallback)?.id;
  let done = 0;
  let lastError = null;
  for (const id of ids) {
    try {
      await api('/api/shader/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: id, mcVersion: mc, instance }),
      });
      done += 1;
    } catch (error) {
      lastError = error;
    }
  }
  if (done > 0) {
    toast(`已下载 ${done} 个光影${instance ? `到 ${instance}` : ''}`);
    drawerClose();
  }
  if (lastError) toast(lastError.message, true);
}

async function drawerInstallClick() {
  const ids = [...drawer.selected];
  if (ids.length === 0) return;
  const mc = (ui.drawerMc.value || '1.20.1').trim();
  if (drawer.kind === 'pack') {
    await startPackInstall(ids, mc);
    return;
  }
  if (drawer.kind === 'shader') {
    await startShaderInstall(ids, mc);
    return;
  }
  let analysis = drawer.analysis;
  try {
    const res = await api('/api/mods/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectIds: ids, mcVersion: mc, loader: 'fabric' }),
    });
    analysis = new Map(res.projects.map((p) => [p.id, p]));
  } catch {
    /* 分析失败就直接尝试下载 */
  }
  const bad = ids.map((id) => analysis?.get(id)).filter((item) => item?.conflict);
  if (bad.length > 0) {
    showConflict(bad, ids, mc);
    return;
  }
  startBatch(ids, mc);
}

function showConflict(items, ids, mc) {
  ui.conflictBody.innerHTML = items
    .map(
      (item) =>
        `<div class="mod-conflict-text"><strong>${escapeHtml(item.title)}</strong>：${escapeHtml((item.reasons ?? []).join('；'))}</div>`,
    )
    .join('');
  ui.conflictMask.hidden = false;
  ui.conflictDialog.hidden = false;
  ui.conflictContinue.onclick = () => {
    hideConflict();
    startBatch(ids, mc);
  };
}

function hideConflict() {
  ui.conflictMask.hidden = true;
  ui.conflictDialog.hidden = true;
}

async function startBatch(ids, mc) {
  try {
    await api('/api/mods/install-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectIds: ids, mcVersion: mc }),
    });
    toast(`开始下载 ${ids.length} 个模组（日志里有进度）`);
    drawerClose();
  } catch (error) {
    toast(error.message, true);
  }
}

async function doSearch() {
  const query = ui.searchInput.value.trim();
  const type = store.kind === 'pack' ? 'modpack' : 'mod';
  const mcVersion = (ui.searchMc.value || '1.20.1').trim();
  ui.searchResults.innerHTML = '<p class="hint">搜索中…</p>';
  try {
    const data = await api('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, type, mcVersion, loader: 'fabric', limit: 12 }),
    });
    renderSearch(data.hits, type, mcVersion);
  } catch (error) {
    ui.searchResults.innerHTML = '';
    toast(error.message, true);
  }
}

function renderSearch(hits, type, mcVersion) {
  ui.searchResults.innerHTML = '';
  if (!hits || hits.length === 0) {
    ui.searchResults.innerHTML = '<p class="hint">没有结果，换个关键词或版本试试</p>';
    return;
  }
  for (const hit of hits) {
    const row = document.createElement('div');
    row.className = 'hit';
    const icon = hit.icon ? `<img src="${escapeHtml(hit.icon)}" alt="" loading="lazy" />` : '';
    row.innerHTML = `
      ${icon}
      <div class="hit-body">
        <div class="hit-title">${escapeHtml(hit.title)}</div>
        <div class="hit-desc">${escapeHtml(hit.description ?? '')}</div>
        <div class="hit-meta">${(hit.downloads ?? 0).toLocaleString()} 次下载 · ${hit.versions.slice(-3).join(' / ')}</div>
      </div>
      <div class="hit-actions">
        <button class="primary">安装</button>
      </div>
    `;
    row.querySelector('button').addEventListener('click', () => installHit(hit, type, mcVersion));
    ui.searchResults.appendChild(row);
  }
}

async function installHit(hit, type, mcVersion) {
  try {
    if (type === 'shader') {
      // 优先装到当前选中的实例，没有再退回第一个 Fabric 实例
      const selected = (store.state.versions ?? []).find((v) => v.id === store.state.selected);
      const fallback = (store.state.versions ?? []).find((v) => v.id.includes('fabric'));
      const result = await api('/api/shader/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: hit.id, mcVersion, instance: (selected ?? fallback)?.id }),
      });
      if (result.hasShaderLoader) {
        toast(`光影已装到 ${result.instance}，游戏内「视频设置 → 光影」里选它`);
      } else {
        toast(`已装到 ${result.instance}，但这个实例没有 Iris/OptiFine，光影不会生效`, true);
      }
      return;
    }
    const path = type === 'modpack' ? '/api/pack/install' : '/api/mod/install';
    await api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: hit.id, mcVersion }),
    });
    toast(`开始安装 ${hit.title}（日志里有进度）`);
  } catch (error) {
    toast(error.message, true);
  }
}

function bindEvents() {
  ui.btnRefresh.addEventListener('click', () => refresh().catch((e) => toast(e.message, true)));
  ui.btnInstall.addEventListener('click', doInstall);
  ui.btnLaunch.addEventListener('click', doLaunch);
  ui.btnStop.addEventListener('click', doStop);
  ui.btnOpenLibrary.addEventListener('click', () => drawerOpen(store.kind === 'pack' ? 'pack' : 'mod'));
  for (const tab of ui.drawerTabs) {
    tab.addEventListener('click', () => {
      drawer.kind = tab.dataset.kind;
      // 换页签后旧的勾选/分析结果作废（模组和整合包的 ID 混在一起会装错）
      drawer.selected.clear();
      drawer.analysis = null;
      drawer.filter = '';
      for (const item of ui.drawerTabs) item.classList.toggle('active', item === tab);
      updateDrawerInstallLabel();
      doDrawerSearch();
    });
  }
  ui.drawerSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') doDrawerSearch();
  });
  ui.drawerMc.addEventListener('change', doDrawerSearch);
  ui.drawerVersionFilter.addEventListener('change', doDrawerSearch);
  ui.drawerSort.addEventListener('change', doDrawerSearch);
  ui.drawerClose.addEventListener('click', drawerClose);
  ui.drawerMask.addEventListener('click', drawerClose);
  // 滚到底部自动加载下一页。
  // #drawer-list 自己就是 .drawer-body（滚动容器），以前写成 parentElement 挂到了不滚动的
  // <section class="drawer"> 上，所以滚到底永远不触发。
  const scroller = ui.drawerList.closest('.drawer-body') || ui.drawerList;
  if (scroller) {
    scroller.addEventListener('scroll', () => {
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 260) loadMore();
    });
  }
  ui.drawerInstall.addEventListener('click', drawerInstallClick);
  ui.conflictCancel.addEventListener('click', hideConflict);
  ui.conflictMask.addEventListener('click', hideConflict);
  ui.detailClose.addEventListener('click', closeDetail);
  ui.detailMask.addEventListener('click', closeDetail);
  // 崩溃修复面板
  ui.btnCrashfix?.addEventListener('click', openCrashFix);
  ui.btnCrashfixStart?.addEventListener('click', openCrashFix);
  ui.btnCrashClose?.addEventListener('click', closeCrash);
  ui.crashMask?.addEventListener('click', closeCrash);
  ui.btnCrashCopy?.addEventListener('click', copyCrashReport);
  ui.btnCrashOpen?.addEventListener('click', () => {
    const fix = crashOpenFix(crashReport);
    if (!fix) {
      toast('报告里没有可打开的文件路径', true);
      return;
    }
    applyCrashFix(fix, ui.btnCrashOpen);
  });
  ui.btnCrashRetry?.addEventListener('click', () => {
    const target = crashReport?.instance || lastCrashInfo?.instance;
    closeCrash();
    retryLaunch(target);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && ui.crashDialog && !ui.crashDialog.hidden) closeCrash();
  });
  ui.drawerFilters.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    drawer.filter = drawer.filter === chip.dataset.cat ? '' : chip.dataset.cat;
    renderDrawerRows();
  });
  ui.pickerBtn.addEventListener('click', () => {
    if (ui.pickerPop.hidden) openPicker();
    else closePicker();
  });
  ui.pickerSearch.addEventListener('input', () => renderPicker(ui.pickerSearch.value.trim()));
  document.addEventListener('mousedown', (event) => {
    if (!ui.picker.contains(event.target)) closePicker();
  });
  for (const button of document.querySelectorAll('[data-clear-log]')) {
    button.addEventListener('click', () => {
      ui.console.innerHTML = '';
      store.lines = 0;
    });
  }
  for (const button of document.querySelectorAll('[data-copy-log]')) {
    button.addEventListener('click', async () => {
      const text = ui.console.innerText.trim();
      if (!text) {
        toast('还没有日志可复制');
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        toast('日志已复制');
      } catch {
        toast('复制失败，请手动选中日志', true);
      }
    });
  }
  ui.inputUser.addEventListener('input', renderLaunchState);
  ui.inputMemory.addEventListener('input', updateMemoryUi);
  ui.memoryConfirm.addEventListener('click', () => {
    const mem = store.state.memory ?? { totalGb: 16, freeGb: 8 };
    const safeMax = Math.max(1, Math.floor(mem.freeGb ?? 8) - 1);
    let value = Number(ui.inputMemory.value) || 2;
    if (value > safeMax) {
      value = safeMax;
      ui.inputMemory.value = String(value);
      toast(`超出可用内存，已调整到 ${safeMax} G`, true);
    } else {
      toast(`内存已设为 ${value} G`);
    }
    appliedMemory = value;
    savePrefs({ memory: value });
    updateMemoryUi();
    ui.memoryConfirm.hidden = true;
  });

  ui.btnInspectPath.addEventListener('click', inspectPath);
  ui.btnPickFile.addEventListener('click', pickFileFromSystem);
  ui.btnMsa.addEventListener('click', startMsaLogin);
  ui.msaOpen?.addEventListener('click', () => {
    const href = ui.msaLink.href || 'https://www.microsoft.com/link';
    window.open(href, '_blank', 'noopener');
  });
  ui.btnLogout?.addEventListener('click', logout);
  ui.msaClose.addEventListener('click', () => {
    ui.msaBox.hidden = true;
  });
  ui.inspectPath.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') inspectPath();
  });
  for (const tab of ui.tabs) tab.addEventListener('click', () => setKind(tab.dataset.kind));

  ui.fileInput.addEventListener('change', () => {
    const file = ui.fileInput.files?.[0];
    inspectFile(file);
    ui.fileInput.value = '';
  });

  for (const eventName of ['dragenter', 'dragover']) {
    ui.drop.addEventListener(eventName, (event) => {
      event.preventDefault();
      ui.drop.classList.add('over');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    ui.drop.addEventListener(eventName, (event) => {
      event.preventDefault();
      ui.drop.classList.remove('over');
    });
  }
  ui.drop.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) inspectFile(file);
  });

  const es = new EventSource('/api/events');
  es.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'line') return appendLine(data.line);
    if (data.type === 'job') {
      store.job = {
        kind: data.kind,
        status: data.status,
        meta: data.meta ?? store.job?.meta ?? null,
        progress: data.progress ?? (data.status === 'running' ? store.job?.progress ?? null : null),
      };
      renderJobBanner();
      if (data.kind === 'install') {
        store.state.installing = data.status === 'running';
        ui.btnInstall.disabled = store.state.installing;
        if (data.status === 'done' && data.meta?.exportFile) {
          const name = data.meta.exportFile;
          const link = document.createElement('a');
          link.href = `/api/exports/${encodeURIComponent(name)}`;
          link.download = name;
          document.body.appendChild(link);
          link.click();
          link.remove();
          toast(`导出完成：${name}`);
        } else if (data.status === 'done') {
          toast(`${data.meta?.version ?? ''} 安装完成`);
        }
        if (data.status === 'error') toast('安装失败，看日志', true);
      }
      if (data.kind === 'launch') {
        store.state.running = data.status === 'running';
        // 新一次启动开始：清空旧崩溃状态（不弹窗）
        if (data.status === 'running') resetCrashState();
        if (data.status === 'done') toast('游戏已退出');
        // 崩溃时后端会自动分析并广播 crash 事件，这里只提示等待
        if (data.status === 'error') toast('游戏异常退出，正在生成修复建议…', true);
        renderLaunchState();
      }
      return;
    }
    if (data.type === 'crash') {
      if (data.report) {
        showCrash(data.report);
        appendLine('✗ 已生成崩溃修复建议，可在弹窗里一键处理');
      } else {
        resetCrashState();
      }
      return;
    }
    if (data.type === 'auth') {
      const ok = data.status === 'ok';
      if (ui.msaStatus) {
        ui.msaStatus.textContent = ok ? `登录成功：${data.name}` : `登录失败：${data.message}`;
      }
      if (ok) {
        toast(`正版登录成功：${data.name}`);
        ui.msaBox.hidden = true;
        refresh().catch(() => {});
      } else {
        toast(`登录失败：${data.message}`, true);
      }
      refreshAuth().catch(() => {});
      return;
    }
    if (data.type === 'refresh') refresh().catch(() => {});
  };
}

async function main() {
  const prefs = loadPrefs();
  if (prefs.username) ui.inputUser.value = prefs.username;
  if (prefs.memory) ui.inputMemory.value = String(prefs.memory);
  if (prefs.width) ui.inputWidth.value = prefs.width;
  if (prefs.height) ui.inputHeight.value = prefs.height;
  if (prefs.selected) store.state.selected = prefs.selected;

  setKind('mod');
  bindEvents();
  await refreshAuth();
  await refresh();
  await loadLastCrash();
  await loadRemote();
}

main().catch((error) => toast(`初始化失败：${error.message}`, true));
