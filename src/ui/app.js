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
  tabs: [...document.querySelectorAll('.tab')],
};

const store = {
  state: { versions: [], selected: null, running: false, installing: false },
  lines: 0,
  kind: 'mod',
  remote: [],
  pick: '',
};

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
        <button class="ghost" data-role="run">启动</button>
      `;
      row.addEventListener('click', (event) => {
        selectVersion(id);
        if (event.target.closest('[data-role="run"]')) doLaunch();
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

function renderLaunchState() {
  const { selected, running, installing } = store.state;
  ui.btnLaunch.disabled = !selected || running || installing;
  ui.btnStop.hidden = !running;
  const auth = store.state.auth;
  const who =
    auth?.loggedIn && !auth.expired
      ? `正版账号 ${auth.name}`
      : `离线玩家 ${ui.inputUser.value || 'Player'}`;
  ui.launchHint.textContent = running
    ? '游戏正在运行…'
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
  const selected = state.versions.some((v) => v.id === store.state.selected)
    ? store.state.selected
    : (state.versions[0]?.id ?? null);
  store.state = { ...state, selected };
  renderVersions();
  renderLaunchState();
  updatePills();
  updateMemoryUi();
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

async function doStop() {
  try {
    await api('/api/stop', { method: 'POST' });
    toast('已请求停止');
  } catch (error) {
    toast(error.message, true);
  }
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
  // 大文件浏览器读不动（1.4GB 的整合包读出来是空字符串），走本地路径识别
  if (file.size > 48 * 1024 * 1024) {
    toast(`${(file.size / 1024 / 1024).toFixed(0)}MB 太大，浏览器拿不到完整路径，请用系统对话框选择`, true);
    ui.dropText.textContent = '大文件请用「浏览…」选择';
    pickFileFromSystem();
    return;
  }
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

async function importPack() {
  if (!lastInspectPath) {
    toast('请先用路径识别这个整合包', true);
    return;
  }
  try {
    await api('/api/mod/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: lastInspectPath }),
    });
    toast('开始导入，日志里能看到解压进度');
  } catch (error) {
    toast(error.message, true);
  }
}

async function startMsaLogin() {
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
  } catch (error) {
    ui.msaStatus.textContent = `申请失败：${error.message}`;
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

async function diagnoseInstance(instance) {
  if (!instance) return;
  appendLine(`› 正在分析 ${instance} 的崩溃日志…`);
  try {
    const result = await api('/api/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance }),
    });
    if (result.findings?.length) {
      for (const finding of result.findings) {
        appendLine(`✗ ${finding.title}｜${finding.suggestion}`);
      }
    } else {
      appendLine(`! ${result.message ?? '没有命中已知规则'}`);
    }
    if (result.excerpt) appendLine(result.excerpt.split('\n').slice(0, 4).join('\n'));
  } catch (error) {
    appendLine(`! 诊断失败：${error.message}`);
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
      // 第一页：整体渲染 + 后台分析冲突
      renderDrawerRows();
      if (fresh.length > 0) analyzeInBackground(drawer.mc, fresh.map((hit) => hit.id));
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
}

async function drawerInstallClick() {
  const ids = [...drawer.selected];
  if (ids.length === 0) return;
  const mc = (ui.drawerMc.value || '1.20.1').trim();
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
      for (const item of ui.drawerTabs) item.classList.toggle('active', item === tab);
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
      if (data.kind === 'install') {
        store.state.installing = data.status === 'running';
        ui.btnInstall.disabled = store.state.installing;
        if (data.status === 'done') toast(`${data.meta?.version ?? ''} 安装完成`);
        if (data.status === 'error') toast('安装失败，看日志', true);
      }
      if (data.kind === 'launch') {
        store.state.running = data.status === 'running';
        if (data.status === 'done') toast('游戏已退出');
        if (data.status === 'error') {
          toast('游戏异常退出，正在分析日志…', true);
          diagnoseInstance(store.state.selected);
        }
        renderLaunchState();
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
  await loadRemote();
}

main().catch((error) => toast(`初始化失败：${error.message}`, true));
