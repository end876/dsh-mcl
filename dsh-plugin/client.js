window.__ModuleLoader__.load({
  id: '@local/dsh-mc-launcher',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const DEFAULT_PORT = 51730;
    const PORT_SCAN = 20; // 和启动器的端口兜底范围一致：51730 ~ 51749
    const PORT_KEY = 'mcl.port';
    const MODE_KEY = 'mcl.mode'; // 旧设置，仅用于迁移
    const EMBED_KEY = 'mcl.embedded';
    const POS_KEY = 'mcl.pos';
    const COLLAPSED_KEY = 'mcl.collapsed';

    let resolvedPort = Number(readPref(PORT_KEY, '')) || DEFAULT_PORT;
    let portReady = false;

    function originFor(port) {
      return `http://127.0.0.1:${port}`;
    }

    /** 这个端口上跑的是不是我们的启动器 */
    async function probePort(port, timeoutMs = 1500) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${originFor(port)}/api/state`, { signal: controller.signal });
        if (!res.ok) return false;
        const body = await res.json().catch(() => null);
        return Boolean(body && Array.isArray(body.versions));
      } catch {
        return false;
      } finally {
        window.clearTimeout(timer);
      }
    }

    let portPromise = null;

    /** 找启动器端口：先用上次记住的，不行就按范围扫（并发调用只扫一次） */
    async function resolvePort() {
      if (portReady) return resolvedPort;
      if (portPromise) return portPromise;
      portPromise = discoverPort().finally(() => {
        portPromise = null;
      });
      return portPromise;
    }

    async function discoverPort() {
      if (await probePort(resolvedPort)) {
        portReady = true;
        return resolvedPort;
      }
      const candidates = [];
      for (let offset = 0; offset < PORT_SCAN; offset += 1) {
        const port = DEFAULT_PORT + offset;
        if (port !== resolvedPort) candidates.push(port);
      }
      // 并行探：最坏情况从 20×1.5s 串行降到一次 800ms 超时
      const hits = await Promise.all(
        candidates.map((port) => probePort(port, 800).then((ok) => (ok ? port : 0))),
      );
      const found = hits.find(Boolean);
      if (found) {
        resolvedPort = found;
        portReady = true;
        writePref(PORT_KEY, String(found));
        reconnectEvents(); // 端口换了，SSE 也要重连
        return found;
      }
      return null;
    }

    async function api(path, init, timeoutMs = 30000) {
      const port = await resolvePort();
      if (!port) throw new Error('启动器服务未启动');
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(`${originFor(port)}${path}`, { ...init, signal: controller.signal });
      } catch (error) {
        if (error?.name === 'AbortError') {
          // 服务还活着，只是这个操作慢（比如下载 Java），别把端口发现也重置掉
          throw new Error(`启动器响应超时（${Math.round(timeoutMs / 1000)} 秒）`);
        }
        portReady = false; // 端口可能变了，下次重新找
        throw error;
      } finally {
        window.clearTimeout(timer);
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return body;
    }

    /** 大文件用原始字节流（几百 MB 的整合包 base64 会卡死界面） */
    async function apiUpload(path, file) {
      const port = await resolvePort();
      if (!port) throw new Error('启动器服务未启动');
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 180000);
      let res;
      try {
        res = await fetch(`${originFor(port)}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name),
            'X-Discard-Upload': '1',
          },
          body: file,
          signal: controller.signal,
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('识别超时（180 秒）');
        throw error;
      } finally {
        window.clearTimeout(timer);
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return body;
    }

    function post(path, payload, timeoutMs) {
      return api(
        path,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        },
        timeoutMs,
      );
    }

    function get(path, timeoutMs) {
      return api(path, { method: 'GET' }, timeoutMs);
    }

    function readPref(key, fallback) {
      try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : value;
      } catch {
        return fallback;
      }
    }

    function writePref(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* 存储不可用就算了 */
      }
    }

    /** 登录凭证还能不能用（登录了但 token 过期时不能再拿去启动） */
    function authUsable(auth) {
      return Boolean(auth?.loggedIn) && auth.expired !== true;
    }

    /** 内置浮窗是否显示：独立开关，和"开没开独立窗口"解耦 */
    function getEmbedded() {
      const raw = readPref(EMBED_KEY, '');
      if (raw === '1') return true;
      if (raw === '0') return false;
      // 迁移旧设置：以前选"独立窗口"就等于不显示浮窗
      return readPref(MODE_KEY, 'embedded') !== 'standalone';
    }

    function setEmbedded(value) {
      writePref(EMBED_KEY, value ? '1' : '0');
      window.dispatchEvent(new Event('mcl-embedded-change'));
    }

    function useEmbedded() {
      const [value, setLocal] = useState(getEmbedded);
      useEffect(() => {
        const handler = () => setLocal(getEmbedded());
        window.addEventListener('mcl-embedded-change', handler);
        return () => window.removeEventListener('mcl-embedded-change', handler);
      }, []);
      return value;
    }

    /* ---------- 全局状态轮询：设置页和浮窗共用一份，只有一个定时器 ---------- */

    const store = {
      state: null,
      error: null,
      text: '',
      subscribers: new Set(),
      timer: 0,
      inflight: false,
      lastAt: 0,
    };

    function notify() {
      for (const fn of store.subscribers) {
        try {
          fn({ state: store.state, error: store.error });
        } catch {
          /* 单个订阅者出错不影响其它 */
        }
      }
    }

    async function refreshLauncher() {
      if (store.inflight) return store.state;
      // 后台窗口里降频：14 秒内最多拉一次，省电也省服务端
      if (typeof document !== 'undefined' && document.hidden && Date.now() - store.lastAt < 14000) {
        return store.state;
      }
      const beforeState = store.state;
      const beforeError = store.error;
      store.inflight = true;
      try {
        const next = await api('/api/state');
        // 内容一模一样就保留旧引用，订阅方可以直接跳过重渲染
        const text = JSON.stringify(next);
        if (text !== store.text) {
          store.state = next;
          store.text = text;
        }
        store.error = null;
        store.lastAt = Date.now();
        // 服务是后来才起来的：这里有订阅者但还没连 SSE，补连一次
        if (evStore.subscribers.size > 0 && !evStore.source) connectEvents();
      } catch (err) {
        store.error = err.message;
      } finally {
        store.inflight = false;
        // 状态引用没变、错误也没变，就不用惊动订阅者
        if (store.state !== beforeState || store.error !== beforeError) notify();
      }
      return store.state;
    }

    function subscribeLauncher(fn) {
      store.subscribers.add(fn);
      fn({ state: store.state, error: store.error });
      if (!store.timer) {
        refreshLauncher();
        store.timer = window.setInterval(refreshLauncher, 3000);
      }
      return () => {
        store.subscribers.delete(fn);
        if (store.subscribers.size === 0) {
          window.clearInterval(store.timer);
          store.timer = 0;
        }
      };
    }

    // 回到前台立刻拉一次，别等定时器
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && store.timer) {
          store.lastAt = 0;
          refreshLauncher();
        }
      });
    }

    /** 所有组件共用的启动器状态（不再是各自轮询） */
    function useLauncher() {
      const [snapshot, setSnapshot] = useState({ state: store.state, error: store.error });
      useEffect(
        () =>
          subscribeLauncher((next) => {
            setSnapshot((prev) => (prev.state === next.state && prev.error === next.error ? prev : next));
          }),
        [],
      );
      return { state: snapshot.state, error: snapshot.error, reload: refreshLauncher };
    }


    /* ---------- 主题：跟随启动器外观设置（A 深海 / B 像素 / C 极简） ---------- */
    const THEME_TOKENS = {
      minimal: {
        '--dsw-alias-bg-base': '#f5f6f8',
        '--dsw-alias-bg-layer-1': '#ffffff',
        '--dsw-alias-bg-layer-2': '#fafbfc',
        '--dsw-alias-bg-overlay': 'rgba(255,255,255,0.98)',
        '--dsw-alias-border-l1': '#e6e8ec',
        '--dsw-alias-border-l2': '#eef0f3',
        '--dsw-alias-label-primary': '#111418',
        '--dsw-alias-label-secondary': '#6b7280',
        '--dsw-alias-label-tertiary': '#9aa1ab',
        '--dsw-alias-brand-primary': '#2f6bff',
        '--dsw-alias-state-success-primary': '#22c55e',
        '--dsw-alias-state-warn-primary': '#f59e0b',
        '--dsw-alias-state-error-primary': '#ef4444',
        '--dsw-alias-state-idle-primary': '#9aa1ab',
      },
      deepsea: {
        '--dsw-alias-bg-base': '#071627',
        '--dsw-alias-bg-layer-1': '#0d2436',
        '--dsw-alias-bg-layer-2': 'rgba(255,255,255,0.04)',
        '--dsw-alias-bg-overlay': 'rgba(10,30,46,0.98)',
        '--dsw-alias-border-l1': 'rgba(120,200,255,0.16)',
        '--dsw-alias-border-l2': 'rgba(120,200,255,0.10)',
        '--dsw-alias-label-primary': '#e8f4ff',
        '--dsw-alias-label-secondary': '#8fb3cc',
        '--dsw-alias-label-tertiary': '#6f93ac',
        '--dsw-alias-brand-primary': '#4fd1ff',
        '--dsw-alias-state-success-primary': '#46e6a8',
        '--dsw-alias-state-warn-primary': '#ffd166',
        '--dsw-alias-state-error-primary': '#ff7b7b',
        '--dsw-alias-state-idle-primary': '#557a8e',
      },
      pixel: {
        '--dsw-alias-bg-base': '#2b2622',
        '--dsw-alias-bg-layer-1': '#3a332c',
        '--dsw-alias-bg-layer-2': '#332c26',
        '--dsw-alias-bg-overlay': 'rgba(58,51,44,0.98)',
        '--dsw-alias-border-l1': '#191511',
        '--dsw-alias-border-l2': '#2a241e',
        '--dsw-alias-label-primary': '#f2e9d8',
        '--dsw-alias-label-secondary': '#c9bba4',
        '--dsw-alias-label-tertiary': '#a9977c',
        '--dsw-alias-brand-primary': '#8fc257',
        '--dsw-alias-state-success-primary': '#7ee06a',
        '--dsw-alias-state-warn-primary': '#ffc94d',
        '--dsw-alias-state-error-primary': '#ff6b5e',
        '--dsw-alias-state-idle-primary': '#7a6a55',
      },
    };

    function themeVars(theme) {
      return THEME_TOKENS[theme] ?? THEME_TOKENS.minimal;
    }

    /** 读一次外观设置（主题改得很少，挂载时读一次就够；浮窗隐藏会卸载，再显示会重读） */
    function useLauncherTheme() {
      const [theme, setTheme] = useState('minimal');
      useEffect(() => {
        let alive = true;
        api('/api/ui/appearance')
          .then((data) => {
            if (alive && data && THEME_TOKENS[data.theme]) setTheme(data.theme);
          })
          .catch(() => {
            /* 服务没起来就用默认主题 */
          });
        return () => {
          alive = false;
        };
      }, []);
      return THEME_TOKENS[theme] ? theme : 'minimal';
    }

    /* ---------- 事件流：安装/启动进度、登录结果都从 /api/events 拿 ---------- */

    const evStore = {
      subscribers: new Set(),
      source: null,
      port: 0,
      retryTimer: 0,
      jobs: { install: null, launch: null },
      lines: { install: [], launch: [] },
      auth: null,
      // 最近一次崩溃修复报告（SSE {type:'crash'}），null = 当前没有崩溃
      crash: null,
    };

    function evSnapshot() {
      return { jobs: evStore.jobs, lines: evStore.lines, auth: evStore.auth, crash: evStore.crash };
    }

    function evNotify() {
      for (const fn of evStore.subscribers) {
        try {
          fn(evSnapshot());
        } catch {
          /* 单个订阅者出错不影响其它 */
        }
      }
    }

    // 进度更新单独节流：150ms 最多重渲染一次
    let jobNotifyTimer = 0;
    function jobNotifySoon() {
      if (jobNotifyTimer) return;
      jobNotifyTimer = window.setTimeout(() => {
        jobNotifyTimer = 0;
        evNotify();
      }, 150);
    }

    // 日志行很密：合并到下一帧统一通知（最多 ~16ms 一次）
    let evNotifyHandle = 0;
    let evNotifyIsFrame = false;
    function evNotifySoon() {
      if (evNotifyHandle) return;
      const run = () => {
        evNotifyHandle = 0;
        evNotify();
      };
      if (typeof requestAnimationFrame === 'function') {
        evNotifyIsFrame = true;
        evNotifyHandle = requestAnimationFrame(run);
      } else {
        evNotifyIsFrame = false;
        evNotifyHandle = window.setTimeout(run, 80);
      }
    }
    function flushEvNotify() {
      if (!evNotifyHandle) return;
      if (evNotifyIsFrame) cancelAnimationFrame(evNotifyHandle);
      else window.clearTimeout(evNotifyHandle);
      evNotifyHandle = 0;
      evNotify();
    }

    function handleEvent(payload) {
      if (!payload || typeof payload !== 'object') return;
      if (payload.type === 'line') {
        const kind = payload.kind;
        if (kind) {
          const list = evStore.lines[kind] || [];
          list.push(String(payload.line ?? ''));
          if (list.length > 80) list.splice(0, list.length - 80);
          evStore.lines[kind] = list;
          evNotifySoon();
        }
        return;
      }
      if (payload.type === 'job') {
        const kind = payload.kind;
        if (kind) {
          if (payload.status === 'running') {
            const prev = evStore.jobs[kind];
            evStore.jobs[kind] = {
              status: 'running',
              meta: payload.meta ?? prev?.meta ?? null,
              progress: payload.progress ?? prev?.progress ?? null,
            };
            // 只有任务真正开始时才清空上一次的日志行（进度更新不能清）
            if (!prev || prev.status !== 'running') evStore.lines[kind] = [];
            // 新一次启动开始：上一次的崩溃报告作废（服务端同时会推 crash report:null）
            if (kind === 'launch' && (!prev || prev.status !== 'running')) evStore.crash = null;
          } else {
            evStore.jobs[kind] = { status: payload.status, meta: payload.meta ?? null, progress: null };
          }
        }
        if (payload.status === 'running' && payload.progress) {
          jobNotifySoon(); // 只有进度在变：节流到 150ms 一次
        } else {
          flushEvNotify();
          evNotify();
        }
        if (payload.status !== 'running') refreshLauncher();
        return;
      }
      if (payload.type === 'crash') {
        // 自动分析完成（report 对象）或新一次启动开始（report:null）
        evStore.crash = payload.report && typeof payload.report === 'object' ? payload.report : null;
        flushEvNotify();
        evNotify();
        return;
      }
      if (payload.type === 'auth') {
        // 带上到达时间：面板只认「本次登录发起之后」的事件，避免上一次的结果把新面板顶掉
        evStore.auth = { ...payload, at: Date.now() };
        flushEvNotify();
        evNotify();
        refreshLauncher();
        return;
      }
      if (payload.type === 'refresh') refreshLauncher();
    }

    function closeEvents() {
      if (evStore.source) {
        try {
          evStore.source.close();
        } catch {
          /* ignore */
        }
        evStore.source = null;
      }
      evStore.port = 0;
    }

    function connectEvents() {
      if (typeof EventSource === 'undefined') return;
      if (evStore.source && evStore.port === resolvedPort) return;
      closeEvents();
      evStore.port = resolvedPort;
      try {
        const source = new EventSource(`${originFor(resolvedPort)}/api/events`);
        source.onmessage = (event) => {
          try {
            handleEvent(JSON.parse(event.data));
          } catch {
            /* 半截数据就丢了 */
          }
        };
        source.onerror = () => {
          // 服务重启/换端口：关掉旧的，3 秒后重新找端口再连
          if (evStore.retryTimer) return;
          evStore.retryTimer = window.setTimeout(() => {
            evStore.retryTimer = 0;
            if (evStore.source === source) closeEvents();
            portReady = false;
            resolvePort()
              .then((found) => {
                if (found) connectEvents();
              })
              .catch(() => {});
          }, 3000);
        };
        evStore.source = source;
      } catch {
        /* ignore */
      }
    }

    /** 端口变化后让 SSE 重连 */
    function reconnectEvents() {
      if (evStore.subscribers.size === 0) return;
      closeEvents();
      connectEvents();
    }

    function subscribeEvents(fn) {
      evStore.subscribers.add(fn);
      fn(evSnapshot());
      resolvePort()
        .then((found) => {
          if (found) connectEvents();
        })
        .catch(() => {});
      return () => {
        evStore.subscribers.delete(fn);
        if (evStore.subscribers.size === 0) {
          if (evStore.retryTimer) {
            window.clearTimeout(evStore.retryTimer);
            evStore.retryTimer = 0;
          }
          closeEvents();
        }
      };
    }

    function useEvents() {
      const [snapshot, setSnapshot] = useState(evSnapshot);
      useEffect(() => subscribeEvents(setSnapshot), []);
      return snapshot;
    }

    /** 正在跑的任务（安装 / 启动），给界面显示进度用 */
    function runningJob(events) {
      const order = ['install', 'launch'];
      for (const kind of order) {
        const job = events?.jobs?.[kind];
        if (!job || job.status !== 'running') continue;
        const list = events?.lines?.[kind] ?? [];
        let last = '';
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const line = String(list[i] ?? '').replace(/\s+/g, ' ').trim();
          if (line) {
            last = line.length > 90 ? `${line.slice(0, 90)}…` : line;
            break;
          }
        }
        return {
          kind,
          label:
            job.meta?.label ||
            (kind === 'install' ? `安装 ${job.meta?.version ?? ''}` : `启动 ${job.meta?.version ?? ''}`),
          last,
          progress: job.progress ?? null,
        };
      }
      return null;
    }

    /** 下载进度条（安装/下载任务有百分比时显示） */
    function JobBar({ progress }) {
      if (!progress || !Number.isFinite(progress.percent)) return null;
      const pct = Math.max(0, Math.min(100, progress.percent));
      return h(
        'div',
        { style: { width: '100%', marginTop: 6 } },
        h(
          'div',
          {
            style: {
              height: 5,
              borderRadius: 999,
              overflow: 'hidden',
              background: 'var(--dsw-alias-bg-layer-2)',
            },
          },
          h('div', {
            style: {
              width: `${pct}%`,
              height: '100%',
              borderRadius: 999,
              background: 'var(--dsw-alias-brand-primary)',
              transition: 'width .25s ease',
            },
          }),
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: 3,
              fontSize: 10,
              color: 'var(--dsw-alias-label-secondary)',
            },
          },
          h('span', null, '下载进度'),
          h('span', null, `${Math.round(pct)}%`),
        ),
      );
    }

    // 进度小圆点的呼吸动画（只注入一次）
    if (typeof document !== 'undefined' && !document.getElementById('mcl-panel-anim')) {
      const style = document.createElement('style');
      style.id = 'mcl-panel-anim';
      style.textContent =
        '@keyframes mclPulse{0%,100%{opacity:.3}50%{opacity:1}}.mcl-pulse{animation:mclPulse 1.1s ease-in-out infinite}';
      document.head.appendChild(style);
    }

    /* ---------- 小工具 ---------- */

    function groupIds(ids) {
      const map = new Map();
      for (const id of ids) {
        const match = String(id).match(/^(\d+\.\d+)/);
        const key = match ? match[1] : '其他';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(id);
      }
      return [...map.entries()];
    }

    /** "6G" / "768M" → GB 数字 */
    function toGb(size) {
      const match = String(size ?? '').match(/([\d.]+)\s*([GM])/i);
      if (!match) return null;
      const value = Number(match[1]);
      if (!Number.isFinite(value)) return null;
      return match[2].toUpperCase() === 'M' ? value / 1024 : value;
    }

    function fmtMb(mb) {
      if (!Number.isFinite(mb)) return '—';
      return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.round(mb)}M`;
    }

    function fmtUptime(sec) {
      if (!Number.isFinite(sec)) return '';
      const total = Math.max(0, Math.round(sec));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
      if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
      return `${seconds}s`;
    }

    function lineColor(line) {
      if (/\[(ERROR|FATAL)\/|Exception|Error:/i.test(line)) return 'var(--dsw-alias-state-error-primary)';
      if (/\[WARN\/|\bWARN\b/i.test(line)) return 'var(--dsw-alias-state-warn-primary)';
      return 'var(--dsw-alias-label-primary)';
    }

    /* ---------- 崩溃修复：报告字段兜底 + 修复动作渲染（浮窗和设置页共用） ---------- */

    /** 内存值统一成 "6G" / "512M"；看不懂就返回空串 */
    function normalizeMemory(value) {
      if (value === null || value === undefined || value === '') return '';
      const text = String(value).trim().toUpperCase().replace(/\s+/g, '');
      const gb = toGb(text);
      if (!gb) return '';
      return gb >= 1 ? `${Math.round(gb)}G` : `${Math.round(gb * 1024)}M`;
    }

    /** 内存下拉选项：默认档位 + 当前值/报告建议值（服务端可能给 5G、16G 这种非默认档） */
    function memoryChoices(...values) {
      const set = new Set(['1G', '2G', '4G', '6G', '8G', '10G', '12G']);
      for (const value of values) {
        const normalized = normalizeMemory(value);
        if (normalized) set.add(normalized);
      }
      return [...set].sort((a, b) => (toGb(a) ?? 0) - (toGb(b) ?? 0));
    }

    function crashSummaryText(report) {
      const summary = report?.summary ? String(report.summary) : '';
      return summary || '游戏异常退出，没有拿到具体原因';
    }

    function crashConfidenceLabel(confidence) {
      if (confidence === 'high') return '高置信';
      if (confidence === 'medium') return '中等置信';
      if (confidence === 'low') return '低置信';
      return '';
    }

    /** 卡片副标题：实例 · 退出码 · 置信度（报告字段缺失的部分直接跳过） */
    function crashMetaText(report) {
      const parts = [];
      if (report?.instance) parts.push(String(report.instance));
      const exitCode = report?.exitCode;
      if (exitCode !== null && exitCode !== undefined && Number.isFinite(Number(exitCode))) {
        parts.push(`退出码 ${exitCode}`);
      }
      const level = crashConfidenceLabel(report?.confidence);
      if (level) parts.push(level);
      return parts.join(' · ');
    }

    /** 每条 fix 的稳定 key：后端可能没给 id，就按 kind + payload 去重 */
    function fixKey(fix, index = 0) {
      if (fix?.id) return `id:${fix.id}`;
      try {
        return `raw:${fix?.kind ?? ''}:${JSON.stringify(fix?.payload ?? {})}`;
      } catch {
        return `raw:${index}`;
      }
    }

    function dedupeFixes(list) {
      const out = [];
      const seen = new Set();
      for (const fix of Array.isArray(list) ? list : []) {
        if (!fix || typeof fix !== 'object') continue;
        const key = fixKey(fix, out.length);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(fix);
      }
      return out;
    }

    function fixPayloadOf(fix) {
      return fix?.payload && typeof fix.payload === 'object' ? fix.payload : {};
    }

    /** 一个 fix 的按钮文案（没有 label 时按 kind 给个兜底中文） */
    const FIX_FALLBACK_LABEL = {
      'set-memory': '调整内存',
      'disable-mod': '禁用这个 mod',
      'disable-mods': '禁用这些 mod',
      'enable-mod': '恢复这个 mod',
      'remove-mod': '移除这个 mod',
      'open-report': '打开崩溃报告',
      'open-log': '打开日志目录',
      'install-java': '安装 Java',
      'install-mod': '去模组库安装',
      'retry-launch': '重新启动',
      'update-loader': '升级加载器',
      'open-settings': '去设置页',
      'copy-report': '复制报告',
      advisory: '建议',
    };

    function fixLabel(fix) {
      const label = fix?.label ? String(fix.label) : '';
      return label || FIX_FALLBACK_LABEL[String(fix?.kind ?? '')] || '执行修复';
    }

    /** 一个 cause 的修复按钮组；executable:false 的只显示文字 */
    function CrashFixButtons({ fixes, busy, onFix }) {
      const list = dedupeFixes(fixes);
      if (list.length === 0) return null;
      return h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 } },
        list.map((fix, index) => {
          const label = fixLabel(fix);
          if (fix.executable === false) {
            return h(
              'div',
              {
                key: `${index}-${label}`,
                style: { fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
              },
              label,
              fix.description ? `：${String(fix.description)}` : '',
            );
          }
          return h(
            'button',
            {
              key: `${index}-${label}`,
              type: 'button',
              disabled: Boolean(busy),
              onClick: () => {
                if (typeof onFix === 'function') onFix(fix);
              },
              style: {
                padding: '4px 9px',
                borderRadius: 7,
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-bg-layer-1)',
                color: 'var(--dsw-alias-label-primary)',
                fontSize: 11,
                lineHeight: 1.4,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
              },
            },
            label,
          );
        }),
      );
    }

    /**
     * 结构化崩溃报告正文：summary/meta + 最多 maxCauses 个 cause（标题/解释/证据前几行/修复按钮）。
     * 没有 cause 时退回 report.fixes（跨 cause 汇总），再没有就提示复制给 AI。
     */
    function CrashReportBody({ report, busy, onFix, maxCauses = 3, maxEvidence = 2, compact = true }) {
      const causes = (Array.isArray(report?.causes) ? report.causes : []).slice(0, maxCauses);
      const topFixes = causes.length === 0 ? dedupeFixes(report?.fixes) : [];
      const mono = 'ui-monospace, SFMono-Regular, Consolas, monospace';
      const severityOf = (cause) => {
        const level = String(cause?.severity ?? '').toLowerCase();
        if (level === 'fatal') return 'var(--dsw-alias-state-error-primary)';
        if (level) return 'var(--dsw-alias-state-warn-primary)';
        return 'var(--dsw-alias-label-primary)';
      };
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        causes.map((cause, index) => {
          const evidence = (Array.isArray(cause?.evidence) ? cause.evidence : [])
            .slice(0, maxEvidence)
            .map((line) => String(line ?? '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .map((line) => (line.length > (compact ? 140 : 220) ? `${line.slice(0, compact ? 140 : 220)}…` : line));
          return h(
            'div',
            {
              key: `${index}-${cause?.id ?? 'cause'}`,
              style: {
                padding: '7px 8px',
                borderRadius: 7,
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-bg-layer-2)',
                fontSize: 11,
                lineHeight: 1.55,
                color: 'var(--dsw-alias-label-secondary)',
              },
            },
            h(
              'div',
              { style: { fontWeight: 600, color: severityOf(cause) } },
              String(cause?.title ?? `原因 ${index + 1}`),
              cause?.severity === 'fatal' ? ' · 致命' : '',
              Number.isFinite(Number(cause?.confidence)) ? ` · ${Math.round(Number(cause.confidence) * 100)}%` : '',
            ),
            cause?.explanation
              ? h('div', { style: { marginTop: 2 } }, String(cause.explanation))
              : null,
            evidence.map((line, lineIndex) =>
              h(
                'div',
                {
                  key: `e${lineIndex}`,
                  style: {
                    marginTop: 3,
                    padding: '2px 5px',
                    borderRadius: 4,
                    background: 'var(--dsw-alias-bg-base)',
                    fontFamily: mono,
                    fontSize: 10,
                    color: 'var(--dsw-alias-label-tertiary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  },
                  title: line,
                },
                line,
              ),
            ),
            h(CrashFixButtons, { fixes: cause?.fixes, busy, onFix }),
          );
        }),
        causes.length === 0
          ? h(
              'div',
              { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 } },
              '没命中已知规则，把报告复制给 AI 分析',
            )
          : null,
        topFixes.length > 0 ? h(CrashFixButtons, { fixes: topFixes, busy, onFix }) : null,
      );
    }

    function loadPos() {
      try {
        const parsed = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
        if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) return parsed;
      } catch {
        /* ignore */
      }
      return null;
    }

    function savePos(pos) {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(pos));
      } catch {
        /* ignore */
      }
    }

    /**
     * 复制文本。DSH 桌面版页面是自定义协议 dsh-app://app，
     * navigator.clipboard 在非安全上下文里可能直接不可用，所以留一条 execCommand 兜底。
     */
    async function copyText(text) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        /* 掉到兜底 */
      }
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.left = '-9999px';
        area.style.top = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
      } catch {
        return false;
      }
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 24 },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        padding: 16,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      title: { margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      sub: { margin: '0 0 14px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', display: 'block', marginBottom: 6 },
      input: {
        width: '100%',
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        outline: 'none',
        boxSizing: 'border-box',
      },
      row: { display: 'flex', gap: 10, flexWrap: 'wrap' },
      col: { flex: 1, minWidth: 120 },
      button: {
        padding: '9px 16px',
        borderRadius: 8,
        border: 'none',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
      },
      ghost: {
        padding: '8px 14px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        cursor: 'pointer',
      },
      danger: {
        padding: '9px 16px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 13,
        cursor: 'pointer',
      },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
      dot: (color) => ({ width: 7, height: 7, borderRadius: '50%', background: color, flex: 'none' }),
      hint: { margin: '10px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
      result: {
        marginTop: 12,
        padding: 12,
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        lineHeight: 1.7,
      },
    };

    /** 两个独立开关：内置浮窗显示与否、独立窗口打开 */
    function WindowToggles({ embedded, busy, onToggleEmbedded, onOpenWindow }) {
      const row = {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
      };
      const text = (title, hint) =>
        h(
          'div',
          { style: { flex: 1, minWidth: 170 } },
          h('div', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, title),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 2, lineHeight: 1.5 } }, hint),
        );

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h(
          'div',
          { style: row },
          text(
            '内置浮窗',
            embedded ? '显示在 DSH 右下角，可拖动、看日志、诊断' : '已隐藏，随时可以再打开',
          ),
          h(
            'button',
            {
              type: 'button',
              style: embedded ? S.ghost : S.button,
              onClick: () => onToggleEmbedded(!embedded),
              disabled: busy,
            },
            embedded ? '隐藏浮窗' : '显示浮窗',
          ),
        ),
        h(
          'div',
          { style: row },
          text('独立窗口', '单独开一个浏览器窗口，打开后会自动收起内置浮窗'),
          h('button', { type: 'button', style: S.ghost, onClick: onOpenWindow, disabled: busy }, '打开独立窗口'),
        ),
      );
    }

    function VersionSelect({ versions, value, onChange, compact }) {
      const groups = groupIds(versions);
      return h(
        'select',
        {
          style: { ...S.input, padding: compact ? '6px 8px' : '8px 10px', fontSize: compact ? 12 : 13 },
          value: value,
          onChange: (event) => onChange(event.target.value),
          title: '选择实例',
        },
        versions.length === 0 ? h('option', { value: '' }, '还没有安装版本') : null,
        groups.map(([group, list]) =>
          h(
            'optgroup',
            { key: group, label: group },
            list.map((id) => h('option', { key: id, value: id }, id)),
          ),
        ),
      );
    }

    /* ---------- 设置页 ---------- */

    function fmtCount(n) {
      const value = Number(n) || 0;
      if (value >= 1e8) return `${(value / 1e8).toFixed(1)} 亿`;
      if (value >= 1e4) return `${Math.round(value / 1e4)} 万`;
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
      return String(value);
    }

    const MOD_TABS = [
      ['mod', '模组'],
      ['modpack', '整合包'],
      ['shader', '光影'],
    ];

    /**
     * 模组库：搜 Modrinth → 勾选 → 冲突/依赖预检 → 批量安装（装成后台任务，进度走 SSE）
     * 目标实例不在这里选：模组会装到 fabric-<mc>-mods，整合包会自己建实例，光影装到当前实例。
     */
    function ModLibrary({ instanceId, mc, loader, busy: busyOuter, onNotice }) {
      const [tab, setTab] = useState('mod');
      const [query, setQuery] = useState('');
      const [hits, setHits] = useState([]);
      const [offset, setOffset] = useState(0);
      const [total, setTotal] = useState(0);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [picked, setPicked] = useState(() => new Set());
      const [review, setReview] = useState(null);
      const [confirming, setConfirming] = useState(false);

      const PAGE = 20;
      const disabled = Boolean(busyOuter) || busy || !mc;
      const loadingRef = useRef(false);
      const listEndRef = useRef(null);
      const seenIdsRef = useRef(new Set());
      const searchSeqRef = useRef(0); // 每次搜索一个序号，过期响应直接丢弃
      const [loadingMore, setLoadingMore] = useState(false);
      const [hasMore, setHasMore] = useState(false);

      async function runSearch(nextOffset = 0) {
        if (!mc) {
          setError('这个实例识别不出 Minecraft 版本，先在「启动游戏」里选一个具体版本');
          return;
        }
        const first = nextOffset === 0;
        // 只挡「翻页」：换页签/换关键词的首页请求要能打断旧请求，否则新页签会一直空着
        if (!first && loadingRef.current) return;
        const seq = ++searchSeqRef.current;
        loadingRef.current = true;
        if (first) setBusy(true);
        else setLoadingMore(true);
        setError('');
        try {
          const payload = { query, type: tab, limit: PAGE, offset: nextOffset };
          if (mc) payload.mcVersion = mc;
          if (tab === 'mod' && loader) payload.loader = loader;
          const data = await post('/api/search', payload);
          if (seq !== searchSeqRef.current) return; // 页面已经切走/换了关键词，这份结果作废
          const next = data.hits ?? [];
          const total = Number(data.total ?? next.length) || 0;
          setTotal(total);
          let added = 0;
          if (first) {
            seenIdsRef.current = new Set(next.map((hit) => hit.id));
            added = next.length;
            setHits(next);
          } else {
            // 去重：服务端 offset 抖动/重复返回同一页时不至于把列表撑爆
            const fresh = next.filter((hit) => !seenIdsRef.current.has(hit.id));
            for (const hit of fresh) seenIdsRef.current.add(hit.id);
            added = fresh.length;
            if (fresh.length > 0) setHits((prev) => [...prev, ...fresh]);
          }
          const loaded = nextOffset + next.length;
          setOffset(loaded);
          // 这一页没新东西 / 已经到总数 → 没有下一页了（也别让观察器空转）
          setHasMore(added > 0 && loaded < total);
        } catch (err) {
          if (seq !== searchSeqRef.current) return;
          setError(err.message);
          if (first) setHasMore(false);
        } finally {
          if (seq === searchSeqRef.current) {
            loadingRef.current = false;
            setBusy(false);
            setLoadingMore(false);
          }
        }
      }

      // 滚到列表末尾自动加载下一页（和 PCL 一样，不用再点按钮）
      useEffect(() => {
        const node = listEndRef.current;
        if (!node || typeof IntersectionObserver === 'undefined') return undefined;
        const observer = new IntersectionObserver(
          (entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            if (!hasMore || loadingRef.current || disabled) return;
            runSearch(offset);
          },
          { root: null, rootMargin: '400px 0px', threshold: 0 },
        );
        observer.observe(node);
        return () => observer.disconnect();
      }, [hasMore, offset, disabled, tab, query, mc, loader]);

      // 切页签或换了实例：清空列表，自动搜第一页（原版/PCL 都是打开就有内容）
      useEffect(() => {
        setHits([]);
        setOffset(0);
        setTotal(0);
        setHasMore(false);
        setReview(null);
        setConfirming(false);
        if (mc) runSearch(0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tab, mc]);

      function togglePick(id) {
        setPicked((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        setReview(null);
        setConfirming(false);
      }

      async function installPicked() {
        const ids = [...picked];
        if (ids.length === 0) {
          setError('先勾选要装的模组');
          return;
        }
        setBusy(true);
        setError('');
        try {
          // 先分析：没适配版本 / 互相不兼容都先拦一下
          const analysis = await post('/api/mods/analyze', { projectIds: ids, mcVersion: mc, loader: loader ?? 'fabric' }, 60000);
          setReview(analysis);
          if ((analysis.conflicts ?? []).length > 0 && !confirming) {
            setConfirming(true);
            setBusy(false);
            return;
          }
          await post('/api/mods/install-batch', {
            projectIds: ids,
            mcVersion: mc,
            loader: loader ?? 'fabric',
            // 选中的实例本来就是这个加载器，就直接装进它，别再另建一个
            ...(loader ? { instance: instanceId } : {}),
          });
          setConfirming(false);
          setPicked(new Set());
          onNotice?.(
            `已开始安装 ${ids.length} 个模组到 ${loader ? instanceId : `fabric-${mc}-mods`}，进度看上面的进度条`,
          );
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }

      async function installPack(hit) {
        setBusy(true);
        setError('');
        try {
          await post('/api/pack/install', { projectId: hit.id, mcVersion: mc });
          onNotice?.(`开始安装整合包「${hit.title}」，进度看上面的进度条`);
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }

      async function installShaderHit(hit) {
        setBusy(true);
        setError('');
        try {
          await post('/api/shader/install', { projectId: hit.id, mcVersion: mc, instance: instanceId });
          onNotice?.(`光影「${hit.title}」已下载到 ${instanceId}`);
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }

      const rowStyle = {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
      };

      const tabButton = (value, label) =>
        h(
          'button',
          {
            type: 'button',
            key: value,
            onClick: () => {
              setTab(value);
              setPicked(new Set());
              setReview(null);
              setConfirming(false);
              setHits([]);
            },
            style: {
              ...S.ghost,
              padding: '5px 12px',
              fontSize: 12,
              ...(tab === value
                ? {
                    background: 'var(--dsw-alias-brand-primary)',
                    borderColor: 'var(--dsw-alias-brand-primary)',
                    color: '#fff',
                    fontWeight: 600,
                  }
                : {}),
            },
          },
          label,
        );

      const conflicts = review?.conflicts ?? [];

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h(
          'div',
          { style: { ...S.row, gap: 6 } },
          MOD_TABS.map(([value, label]) => tabButton(value, label)),
          h('span', { style: { flex: 1 } }),
          h(
            'span',
            { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', alignSelf: 'center' } },
            mc ? `目标 Minecraft ${mc}${tab === 'mod' && loader ? ' · ' + (loader === 'neoforge' ? 'NeoForge' : loader === 'forge' ? 'Forge' : loader === 'quilt' ? 'Quilt' : 'Fabric') : ''}` : '识别不到 MC 版本',
          ),
        ),
        h(
          'div',
          { style: S.row },
          h('input', {
            style: { ...S.input, flex: 1, minWidth: 160 },
            placeholder: tab === 'mod' ? '搜模组，例如 jei / sodium' : tab === 'modpack' ? '搜整合包，例如 fabulously optimized' : '搜光影，例如 complementary',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') runSearch(0);
            },
          }),
          h(
            'button',
            { type: 'button', style: { ...S.button, opacity: disabled ? 0.5 : 1 }, onClick: () => runSearch(0), disabled },
            busy ? '搜索中…' : '搜索',
          ),
        ),

        hits.length > 0
          ? h(
              'div',
              { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
              `共 ${fmtCount(total)} 个结果，已加载 ${hits.length} 个`,
            )
          : null,

        hits.length === 0 && !busy && query
          ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '没有结果，换个关键词')
          : null,

        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          hits.map((hit) =>
            h(
              'div',
              { key: hit.id, style: rowStyle },
              tab === 'mod'
                ? h('input', {
                    type: 'checkbox',
                    checked: picked.has(hit.id),
                    onChange: () => togglePick(hit.id),
                    style: { marginTop: 3 },
                  })
                : null,
              h(
                'div',
                { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, hit.title),
                h(
                  'div',
                  { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 2, lineHeight: 1.5 } },
                  [
                    hit.description ? String(hit.description).slice(0, 90) : '',
                    `下载 ${fmtCount(hit.downloads)}`,
                    ...(hit.categoriesZh ?? hit.categories ?? [])
                      .filter((name) => !/^(fabric|quilt|forge|neoforge|fabric-api|neoforged)$/i.test(String(name)))
                      .slice(0, 3),
                  ]
                    .filter(Boolean)
                    .join(' · '),
                ),
              ),
              tab === 'mod'
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      style: { ...S.ghost, padding: '4px 10px', fontSize: 11, flex: 'none', opacity: disabled ? 0.5 : 1 },
                      disabled,
                      onClick: () => (tab === 'modpack' ? installPack(hit) : installShaderHit(hit)),
                    },
                    tab === 'modpack' ? '安装' : '下载',
                  ),
            ),
          ),
        ),

        hits.length > 0
          ? h(
              'div',
              {
                ref: listEndRef,
                style: {
                  padding: '10px 0 2px',
                  textAlign: 'center',
                  fontSize: 12,
                  color: 'var(--dsw-alias-label-secondary)',
                },
              },
              loadingMore
                ? '加载更多…'
                : hasMore
                  ? '继续下拉，自动加载更多'
                  : `没有更多了（共 ${fmtCount(total)} 个）`,
            )
          : null,

        // 老环境没有 IntersectionObserver 时，留个手动按钮兜底
        typeof IntersectionObserver === 'undefined' && hits.length > 0 && hasMore
          ? h(
              'div',
              { style: S.row },
              h(
                'button',
                { type: 'button', style: { ...S.ghost, fontSize: 12 }, onClick: () => runSearch(offset), disabled },
                '加载更多',
              ),
            )
          : null,

        tab === 'mod'
          ? h(
              'div',
              { style: { ...S.row, alignItems: 'center' } },
              h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', flex: 1 } }, `已选 ${picked.size} 个`),
              h(
                'button',
                {
                  type: 'button',
                  style: { ...S.button, opacity: disabled || picked.size === 0 ? 0.5 : 1 },
                  onClick: installPicked,
                  disabled: disabled || picked.size === 0,
                },
                confirming ? '仍然安装' : '冲突检查并安装',
              ),
            )
          : null,

        review
          ? h(
              'div',
              {
                style: {
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-base)',
                  fontSize: 11,
                  lineHeight: 1.6,
                  color: 'var(--dsw-alias-label-secondary)',
                  maxHeight: 120,
                  overflowY: 'auto',
                },
              },
              conflicts.length > 0
                ? h(
                    'div',
                    { style: { color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 4 } },
                    `⚠ ${conflicts.length} 个有冲突，确认后仍会安装：`,
                  )
                : h('div', { style: { color: 'var(--dsw-alias-state-success-primary)', marginBottom: 4 } }, '✓ 没发现冲突'),
              (review.projects ?? []).map((item) =>
                h(
                  'div',
                  { key: item.id, style: { marginBottom: 2 } },
                  `${item.title}${item.versionNumber ? ` · ${item.versionNumber}` : ' · 无适配版本'}`,
                  item.dependencies?.length
                    ? ` · 需要前置：${item.dependencies.map((dep) => dep.title).join('、')}（会自动补装）`
                    : '',
                  item.reasons?.length ? ` · ${item.reasons.join('；')}` : '',
                ),
              ),
            )
          : null,

        error ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
      );
    }

    function SettingsSection() {
      const embedded = useEmbedded();
      const { state, error, reload } = useLauncher();
      const events = useEvents();
      const job = runningJob(events);
      const theme = useLauncherTheme();
      const [version, setVersion] = useState('');
      const [player, setPlayer] = useState(() => readPref('mcl.player', 'Player'));
      const [memory, setMemory] = useState(() => normalizeMemory(readPref('mcl.memory', '2G')) || '2G');
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      const [manageNotice, setManageNotice] = useState('');
      // 崩溃修复：手动诊断结果 { report } | { legacy } | { error }，以及执行修复时的忙碌态
      const [crashInfo, setCrashInfo] = useState(null);
      const [crashBusy, setCrashBusy] = useState(false);
      const [installTarget, setInstallTarget] = useState('');
      const [installLoader, setInstallLoader] = useState('vanilla');
      const [installLoaderVersion, setInstallLoaderVersion] = useState('');
      const [loaderVersions, setLoaderVersions] = useState([]);

      // 选了加载器就顺手查一下可用版本（输入 MC 版本后防抖 500ms）
      useEffect(() => {
        const target = installTarget.trim();
        if (installLoader === 'vanilla' || !target) {
          setLoaderVersions([]);
          setInstallLoaderVersion('');
          return undefined;
        }
        let cancelled = false;
        const timer = setTimeout(() => {
          get(`/api/loader/list?loader=${installLoader}&mc=${encodeURIComponent(target)}`)
            .then((data) => {
              if (!cancelled) setLoaderVersions(Array.isArray(data.versions) ? data.versions : []);
            })
            .catch(() => {
              if (!cancelled) setLoaderVersions([]);
            });
        }, 500);
        return () => {
          cancelled = true;
          clearTimeout(timer);
        };
      }, [installLoader, installTarget]);
      const [modInfo, setModInfo] = useState(null);
      const [modName, setModName] = useState('');
      const [jarDeps, setJarDeps] = useState(null);

      useEffect(() => {
        if (!version && state?.versions?.length) setVersion(state.versions[0].id);
        if (version && state?.versions?.length && !state.versions.some((v) => v.id === version)) {
          setVersion(state.versions[0].id);
        }
      }, [state, version]);

      useEffect(() => {
        writePref('mcl.player', player);
        writePref('mcl.memory', memory);
      }, [player, memory]);

      // 刷新/重新打开设置页时，从 /api/state.lastCrash 恢复上一次崩溃报告
      const settingsCrashHydrated = useRef(false);
      useEffect(() => {
        if (settingsCrashHydrated.current) return;
        const summary = state?.lastCrash;
        if (!summary || !summary.instance) return;
        settingsCrashHydrated.current = true;
        post('/api/crashfix', { instance: summary.instance }, 60000)
          .then((data) => {
            if (data?.report && typeof data.report === 'object') setCrashInfo({ report: data.report });
          })
          .catch(() => {
            /* 报告拉不到就保持空 */
          });
      }, [state?.lastCrash]);

      // 切实例后旧实例的崩溃报告不再适用
      const settingsPrevVersion = useRef('');
      useEffect(() => {
        if (settingsPrevVersion.current && settingsPrevVersion.current !== version) {
          setCrashInfo(null);
        }
        settingsPrevVersion.current = version;
      }, [version]);

      const act = useCallback(
        async (fn) => {
          setBusy(true);
          setNotice('');
          try {
            await fn();
            await reload();
          } catch (err) {
            setNotice(err.message);
          } finally {
            setBusy(false);
          }
        },
        [reload],
      );

      function launch(instanceId) {
        const target = instanceId || version;
        if (!target) return;
        act(() =>
          post('/api/launch', {
            version: target,
            username: player || 'Player',
            memory,
            // 登录过期了就别带 --auth，否则游戏会在登录阶段失败
            auth: authUsable(state?.auth),
          }),
        );
      }

      function stop() {
        act(() => post('/api/stop'));
      }

      async function exportSelected() {
        if (!version) return;
        setManageNotice('');
        try {
          await post('/api/instance/export', { instance: version });
          setManageNotice('已开始导出，完成后在 ~/.mcl/exports/ 里');
        } catch (error) {
          setManageNotice(error.message);
        }
      }

      async function deleteSelected() {
        if (!version) return;
        const ok = window.confirm(
          `确定删除实例「${version}」？\n\n它的模组、配置和存档都会被删除，无法恢复。`,
        );
        if (!ok) return;
        setManageNotice('');
        try {
          await post('/api/instance/delete', { instance: version });
          setManageNotice('已删除');
          await reload();
        } catch (error) {
          setManageNotice(error.message);
        }
      }

      /** 手动崩溃诊断：新接口 /api/crashfix，失败回退旧 /api/diagnose */
      async function diagnoseCrash() {
        if (!version) return;
        setCrashBusy(true);
        setNotice('');
        try {
          const data = await post('/api/crashfix', { instance: version });
          const report = data?.report && typeof data.report === 'object' ? data.report : null;
          if (!report) throw new Error('诊断接口没有返回报告');
          setCrashInfo({ report });
        } catch (crashErr) {
          try {
            const legacy = await post('/api/diagnose', { instance: version });
            setCrashInfo({ legacy });
          } catch (err) {
            setCrashInfo({ error: err.message || crashErr.message });
          }
        } finally {
          setCrashBusy(false);
        }
      }

      /** 设置页里的修复动作分发（和浮窗共用一套 kind 约定） */
      async function applySettingsFix(fix) {
        if (!fix || typeof fix !== 'object' || crashBusy) return;
        const kind = String(fix.kind ?? '');
        const payload = fixPayloadOf(fix);
        const report = crashInfo?.report ?? null;
        const target = String(payload.instance || report?.instance || version || '').trim();

        if (fix.executable === false) {
          setNotice(String(fix.description || fix.label || ''));
          return;
        }
        if (kind === 'set-memory') {
          const next = normalizeMemory(payload.memory);
          if (!next) {
            setNotice(`报告里的内存值看不懂：${String(payload.memory ?? '')}`);
            return;
          }
          setMemory(next);
          setNotice(`已把内存设为 ${next}，点「启动游戏」重试`);
          return;
        }
        if (kind === 'retry-launch') {
          if (target && (state?.versions ?? []).some((item) => item.id === target)) setVersion(target);
          launch(target || version);
          return;
        }
        if (kind === 'install-mod') {
          const query = String(payload.query ?? payload.q ?? '').trim();
          setNotice(
            query ? `去下方「模组库」搜索「${query}」安装（关键词已复制）` : '去下方「模组库」搜索缺失的前置模组',
          );
          if (query) copyText(query).catch(() => {});
          return;
        }
        if (kind === 'copy-report') {
          const text = String(report?.text ?? '');
          if (!text) {
            setNotice('报告还没有生成好，稍后再试');
            return;
          }
          setNotice((await copyText(text)) ? '报告已复制' : '复制失败，请手动选中');
          return;
        }
        if (kind === 'open-settings') {
          setNotice(String(payload.page) === 'appearance' ? '去「设置 → 外观」调整显示相关设置' : String(fix.label ?? '去设置页调整'));
          return;
        }
        if (kind === 'update-loader' || kind === 'advisory') {
          setNotice(String(payload.hint || fix.description || fix.label || ''));
          return;
        }
        const serverKinds = ['disable-mod', 'enable-mod', 'remove-mod', 'open-report', 'open-log', 'install-java'];
        if (!serverKinds.includes(kind)) {
          setNotice(`不认识这个修复动作：${kind || '（缺少 kind）'}`);
          return;
        }
        if (kind === 'install-java') setNotice('正在准备 Java，下载可能比较慢，请稍等…');
        setCrashBusy(true);
        try {
          const result = await post('/api/crashfix/apply', { instance: target, kind, payload }, 600000);
          if (result && result.ok === false) {
            setNotice(String(result.message || '服务端没有执行这个动作'));
          } else {
            setNotice(String(result?.message || `${fixLabel(fix)}：已执行`));
            if (kind.includes('mod')) {
              // 修完 mod 刷新报告，已解决的 cause 会自然消失
              try {
                const data = await post('/api/crashfix', { instance: target || version });
                if (data?.report && typeof data.report === 'object') setCrashInfo({ report: data.report });
              } catch {
                /* 后端没就绪就保持旧报告 */
              }
            }
          }
        } catch (err) {
          setNotice(`修复失败：${err.message}`);
        } finally {
          setCrashBusy(false);
        }
      }

      function openWindow() {
        // 打开独立窗口的同时收起内置浮窗：两个都开着既挡视线又重复
        act(async () => {
          await post('/api/open-window');
          setEmbedded(false);
        });
      }

      function install() {
        const target = installTarget.trim();
        if (!target) return;
        if (installLoader === 'vanilla') {
          act(() => post('/api/install', { version: target }));
        } else {
          act(() => post('/api/loader/install', {
            loader: installLoader,
            mcVersion: target,
            ...(installLoaderVersion ? { loaderVersion: installLoaderVersion } : {}),
          }));
        }
        setInstallTarget('');
      }

      async function inspect(file) {
        if (!file) return;
        setModName(file.name);
        setModInfo(null);
        setJarDeps(null);
        const bigFile = file.size > 8 * 1024 * 1024;
        try {
          let info;
          if (bigFile) {
            info = await apiUpload('/api/mod/inspect-file', file);
          } else {
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(new Error('读取文件失败'));
              reader.readAsDataURL(file);
            });
            const data = String(dataUrl).split(',')[1] || '';
            info = await post('/api/mod/inspect', { name: file.name, data });
          }
          setModInfo(info);
          // 本地 jar 里写着它依赖哪些 mod：拿去 Modrinth 反查，能装的就给按钮
          const depIds = (info.depends ?? []).map((dep) => dep.id).filter(Boolean);
          if (info.kind === 'mod' && depIds.length > 0) {
            try {
              const resolved = await post('/api/mods/resolve', {
                ids: depIds,
                loader: info.loader ?? 'fabric',
                mcVersion: targetMc ?? undefined,
              });
              setJarDeps(resolved);
            } catch {
              setJarDeps({ found: [], missing: depIds });
            }
          } else if (info.kind === 'mod') {
            setJarDeps({ found: [], missing: [] });
          }
        } catch (err) {
          setNotice(err.message);
        }
      }

      async function installJarDeps() {
        const ids = (jarDeps?.found ?? []).map((item) => item.projectId).filter(Boolean);
        if (ids.length === 0 || !targetMc) return;
        try {
          // targetLoader 是当前选中实例的加载器（这里以前误写成未定义的 loader，点了会直接报错）
          await post('/api/mods/install-batch', {
            projectIds: ids,
            mcVersion: targetMc,
            loader: targetLoader ?? 'fabric',
            ...(targetLoader ? { instance: version } : {}),
          });
          setNotice(
            `已开始安装 ${ids.length} 个前置到 ${targetLoader ? version : `fabric-${targetMc}-mods`}，进度看上面的进度条`,
          );
        } catch (err) {
          setNotice(err.message);
        }
      }

      const running = Boolean(state?.running);
      const java = state?.java ?? [];
      const statusText = error ? '服务未启动' : '服务在线';
      const statusColor = error
        ? 'var(--dsw-alias-state-warn-primary)'
        : 'var(--dsw-alias-state-success-primary)';
      const auth = state?.auth ?? { loggedIn: false };
      const targetVersion = (state?.versions ?? []).find((item) => item.id === version) ?? null;
      const targetMc = targetVersion?.mc ?? null;
      const targetLoader = (() => {
        const name = String(targetVersion?.loader ?? '').toLowerCase();
        if (name.includes('neoforge')) return 'neoforge';
        if (name.includes('forge')) return 'forge';
        if (name.includes('quilt')) return 'quilt';
        if (name.includes('fabric')) return 'fabric';
        return null;
      })();
      const loaderVersionSelect = installLoader === 'vanilla'
        ? null
        : h(
            'select',
            {
              key: 'loader-version',
              style: { ...S.input, flex: 'none', width: 168 },
              value: installLoaderVersion,
              onChange: (event) => setInstallLoaderVersion(event.target.value),
            },
            h('option', { value: '' }, loaderVersions.length ? '加载器版本：推荐' : '加载器版本：自动'),
            ...loaderVersions.slice(0, 30).map((item) => h('option', { key: item, value: item }, item)),
          );

      // 浮窗里也在用同一份 SSE 崩溃报告：设置页给个「查看」入口，不自动弹
      const liveCrash =
        events?.crash && typeof events.crash === 'object' && events.crash.crashed !== false ? events.crash : null;
      const crashReportView = crashInfo?.report
        ? h(
            'div',
            { style: { ...S.result, maxHeight: 360, overflowY: 'auto' } },
            h(
              'div',
              { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600, marginBottom: 6 } },
              crashSummaryText(crashInfo.report),
            ),
            crashMetaText(crashInfo.report)
              ? h(
                  'div',
                  { style: { fontSize: 11, marginBottom: 8, color: 'var(--dsw-alias-label-tertiary)' } },
                  crashMetaText(crashInfo.report),
                )
              : null,
            h(CrashReportBody, {
              report: crashInfo.report,
              busy: crashBusy,
              onFix: applySettingsFix,
              maxCauses: 4,
              maxEvidence: 4,
              compact: false,
            }),
          )
        : null;
      const crashLegacyView = crashInfo?.legacy
        ? h(
            'div',
            { style: S.result },
            (crashInfo.legacy.findings ?? []).length > 0
              ? (crashInfo.legacy.findings ?? []).slice(0, 4).map((finding, index) =>
                  h(
                    'div',
                    { key: `${index}-${finding.id}`, style: { marginBottom: index === 0 ? 6 : 0 } },
                    h('div', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, finding.title),
                    (finding.evidence ?? []).slice(0, 2).map((line, lineIndex) =>
                      h(
                        'div',
                        {
                          key: `e${lineIndex}`,
                          style: {
                            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                            fontSize: 10,
                            color: 'var(--dsw-alias-label-tertiary)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          },
                          title: String(line),
                        },
                        String(line),
                      ),
                    ),
                    h('div', null, finding.suggestion),
                  ),
                )
              : h('div', null, crashInfo.legacy.message || '没命中已知规则'),
          )
        : null;
      const crashLiveView = liveCrash
        ? h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                marginTop: 10,
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-state-error-primary)',
                background: 'rgba(255, 90, 90, 0.10)',
                fontSize: 12,
                lineHeight: 1.55,
              },
            },
            h('span', { style: { color: 'var(--dsw-alias-state-error-primary)', flex: 'none' } }, '⚠'),
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h(
                'div',
                { style: { color: 'var(--dsw-alias-state-error-primary)', fontWeight: 600 } },
                `检测到崩溃：${crashSummaryText(liveCrash)}`,
              ),
              crashMetaText(liveCrash)
                ? h(
                    'div',
                    { style: { fontSize: 11, marginTop: 2, color: 'var(--dsw-alias-label-secondary)' } },
                    crashMetaText(liveCrash),
                  )
                : null,
            ),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.ghost, padding: '4px 10px', fontSize: 12, flex: 'none' },
                onClick: () => setCrashInfo({ report: liveCrash }),
              },
              '查看修复建议',
            ),
          )
        : null;

      return h(
        'div',
        { style: { ...S.page, ...themeVars(theme) } },
        h(
          'div',
          null,
          h('h2', { style: S.title }, 'Minecraft 启动器'),
          h('p', { style: S.sub }, '离线 / 正版启动 · 版本安装 · 模组识别'),
        ),

        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: { ...S.row, marginBottom: 12 } },
            h('span', { style: S.pill }, h('span', { style: S.dot(statusColor) }), statusText),
            h(
              'span',
              { style: S.pill },
              java.length ? `Java ${Math.max(...java.map((j) => j.major))}` : 'Java 待下载',
            ),
            h('span', { style: S.pill }, `已安装 ${state?.versions?.length ?? 0} 个版本`),
            h(
              'span',
              { style: S.pill },
              h('span', {
                style: S.dot(
                  auth.loggedIn
                    ? auth.expired
                      ? 'var(--dsw-alias-state-warn-primary)'
                      : 'var(--dsw-alias-state-success-primary)'
                    : 'var(--dsw-alias-state-idle-primary)',
                ),
              }),
              auth.loggedIn
                ? auth.expired
                  ? `正版 ${auth.name}（登录已过期）`
                  : `正版 ${auth.name}`
                : '离线模式',
            ),
          ),
          h('div', { style: S.label }, '窗口'),
          h(WindowToggles, {
            embedded,
            busy,
            onToggleEmbedded: (next) => setEmbedded(next),
            onOpenWindow: openWindow,
          }),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: S.label }, '启动游戏'),
          h(VersionSelect, { versions: (state?.versions ?? []).map((v) => v.id), value: version, onChange: setVersion }),
          h(
            'div',
            { style: { ...S.row, marginTop: 10 } },
            h(
              'div',
              { style: S.col },
              h('span', { style: S.label }, '玩家名'),
              h('input', {
                style: S.input,
                value: player,
                maxLength: 16,
                onChange: (event) => setPlayer(event.target.value),
              }),
            ),
            h(
              'div',
              { style: S.col },
              h('span', { style: S.label }, '内存'),
              h(
                'select',
                { style: S.input, value: memory, onChange: (event) => setMemory(event.target.value) },
                memoryChoices(memory).map((size) => h('option', { key: size, value: size }, size)),
              ),
            ),
          ),
          h(
            'div',
            { style: { ...S.row, marginTop: 14 } },
            running
              ? h('button', { type: 'button', style: S.danger, onClick: stop, disabled: busy }, '停止游戏')
              : h(
                  'button',
                  {
                    type: 'button',
                    style: { ...S.button, opacity: !version || busy ? 0.5 : 1 },
                    onClick: launch,
                    disabled: !version || busy,
                  },
                  authUsable(state?.auth) ? '启动游戏（正版）' : '启动游戏',
                ),
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, notice),
          ),
          h(
            'div',
            { style: { ...S.row, marginTop: 8, alignItems: 'center' } },
            h(
              'button',
              { type: 'button', style: S.ghost, onClick: exportSelected, disabled: !version || busy },
              '导出为整合包',
            ),
            h(
              'button',
              { type: 'button', style: S.ghost, onClick: deleteSelected, disabled: !version || busy },
              '删除实例',
            ),
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, manageNotice),
          ),
          job
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap',
                    marginTop: 10,
                    fontSize: 12,
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                },
                h('span', {
                  className: 'mcl-pulse',
                  style: {
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: 'var(--dsw-alias-brand-primary)',
                    flex: 'none',
                  },
                }),
                h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', flex: 'none' } }, job.label),
                h(
                  'span',
                  { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  job.last || '…',
                ),
                h(JobBar, { progress: job.progress }),
              )
            : null,
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: S.label }, '崩溃修复'),
          h(
            'p',
            { style: { ...S.hint, margin: '0 0 10px' } },
            '游戏异常退出后，读 crash-reports、latest.log 和 mod 列表给出原因与一键修复；浮窗也会自动弹出红色提示。',
          ),
          h(
            'div',
            { style: { ...S.row, alignItems: 'center' } },
            h(
              'button',
              {
                type: 'button',
                style: { ...S.button, opacity: crashBusy || !version ? 0.5 : 1 },
                onClick: diagnoseCrash,
                disabled: crashBusy || !version,
              },
              crashBusy ? '分析中…' : '崩溃诊断',
            ),
            crashInfo?.report?.text
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: S.ghost,
                    onClick: async () => {
                      setNotice((await copyText(String(crashInfo.report.text))) ? '报告已复制' : '复制失败，请手动选中');
                    },
                  },
                  '复制报告',
                )
              : null,
          ),
          crashLiveView,
          crashInfo?.error
            ? h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, crashInfo.error)
            : null,
          crashReportView,
          crashLegacyView,
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: S.label }, '安装游戏'),
          h(
            'div',
            { style: S.row },
            h(
              'select',
              {
                style: { ...S.input, flex: 'none', width: 110 },
                value: installLoader,
                onChange: (event) => setInstallLoader(event.target.value),
              },
              h('option', { value: 'vanilla' }, '原版'),
              h('option', { value: 'fabric' }, 'Fabric'),
              h('option', { value: 'quilt' }, 'Quilt'),
              h('option', { value: 'forge' }, 'Forge'),
              h('option', { value: 'neoforge' }, 'NeoForge'),
            ),
            loaderVersionSelect,
            h('input', {
              style: { ...S.input, flex: 1, minWidth: 160 },
              placeholder: '例如 1.20.1 / 1.21 / latest',
              value: installTarget,
              onChange: (event) => setInstallTarget(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') install();
              },
            }),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.button, opacity: installTarget.trim() && !busy ? 1 : 0.5 },
                onClick: install,
                disabled: !installTarget.trim() || busy,
              },
              '安装',
            ),
          ),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: S.label }, '模组库'),
          h(
            'p',
            { style: { ...S.hint, margin: '0 0 10px' } },
            targetLoader
              ? `搜 Modrinth 直接装：模组装进当前实例 ${version}（${targetLoader}），整合包会自己建实例，光影装到当前实例。装之前会先查冲突和前置。`
              : '搜 Modrinth 直接装：原版实例装模组会自动建 fabric-<版本>-mods 实例；整合包会自己建实例，光影装到当前实例。装之前会先查冲突和前置。',
          ),
          h(ModLibrary, {
            instanceId: version,
            mc: targetMc,
            loader: targetLoader,
            busy,
            onNotice: (text) => setNotice(text),
          }),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: S.label }, '模组识别'),
          h('input', {
            type: 'file',
            accept: '.jar,.zip,.mrpack',
            style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
            onChange: (event) => inspect(event.target.files && event.target.files[0]),
          }),
          modName ? h('p', { style: S.hint }, modName) : null,
          modInfo
            ? h(
                'div',
                { style: S.result },
                h(
                  'div',
                  { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600, marginBottom: 6 } },
                  modInfo.kind === 'modpack' ? '整合包' : modInfo.loaderLabel || '未知',
                  ' · ',
                  modInfo.name || modName,
                ),
                modInfo.mcConstraint
                  ? h('div', null, `Minecraft ${Array.isArray(modInfo.mcConstraint) ? modInfo.mcConstraint.join(', ') : modInfo.mcConstraint}`)
                  : null,
                h('div', null, modInfo.hint || ''),
                jarDeps && ((jarDeps.found ?? []).length > 0 || (jarDeps.missing ?? []).length > 0)
                  ? h(
                      'div',
                      { style: { marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--dsw-alias-border-l2)' } },
                      h('div', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600, marginBottom: 4 } }, '前置依赖'),
                      (jarDeps.found ?? []).map((item) =>
                        h('div', { key: item.projectId }, `· ${item.title}${item.guess ? '（按名字猜的）' : ''}`),
                      ),
                      (jarDeps.missing ?? []).length
                        ? h('div', null, `· 没在 Modrinth 找到：${jarDeps.missing.join('、')}`)
                        : null,
                      (jarDeps.found ?? []).length > 0 && targetMc
                        ? h(
                            'button',
                            {
                              type: 'button',
                              style: { ...S.ghost, marginTop: 6, padding: '5px 10px', fontSize: 11 },
                              onClick: installJarDeps,
                            },
                            `安装这 ${jarDeps.found.length} 个前置`,
                          )
                        : null,
                    )
                  : null,
              )
            : h('p', { style: S.hint }, '选一个 .jar 或整合包，自动判断需要哪个模组框架、缺哪些前置。'),
        ),
      );
    }

    /* ---------- 浮窗 ---------- */

    function StatusDot({ tone }) {
      return h('span', { style: S.dot(tone) });
    }

    function MemoryMeter({ runtime, memory, running }) {
      const totalGb = memory?.totalGb ?? null;
      const freeGb = memory?.freeGb ?? null;
      const used = Number.isFinite(runtime?.rssMb) ? runtime.rssMb : null;
      const capGb = toGb(runtime?.memory);
      const capMb = capGb ? capGb * 1024 : null;
      const pct = used && capMb ? Math.min(100, (used / capMb) * 100) : 0;
      const width = pct > 0 ? Math.max(2, pct) : 0;
      const over = pct >= 90;

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
          h('span', null, running ? '游戏内存' : '游戏未运行'),
          h(
            'span',
            null,
            used !== null
              ? `${fmtMb(used)}${capMb ? ` / ${fmtMb(capMb)}` : ''}`
              : capMb
                ? `上限 ${fmtMb(capMb)}`
                : '',
          ),
        ),
        h(
          'div',
          {
            style: {
              height: 6,
              borderRadius: 999,
              background: 'var(--dsw-alias-border-l1)',
              overflow: 'hidden',
            },
          },
          h('div', {
            style: {
              width: `${width}%`,
              height: '100%',
              borderRadius: 999,
              background: over ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-brand-primary)',
              transition: 'width 400ms ease',
            },
          }),
        ),
        totalGb !== null
          ? h(
              'div',
              { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
              `系统空闲 ${freeGb}G / ${totalGb}G`,
              runtime?.uptimeSec ? ` · 已运行 ${fmtUptime(runtime.uptimeSec)}` : '',
            )
          : null,
      );
    }

    function LogBox({ lines, source }) {
      const box = useRef(null);
      const stick = useRef(true); // 用户手动往上翻时别硬拉回底部

      useEffect(() => {
        const el = box.current;
        if (!el || !stick.current) return undefined;
        const scroll = () => {
          el.scrollTop = el.scrollHeight;
        };
        scroll();
        // 容器是从隐藏变可见时首帧高度还是 0，下一帧再补一次
        const frame = requestAnimationFrame(scroll);
        return () => cancelAnimationFrame(frame);
      }, [lines]);

      const onScroll = () => {
        const el = box.current;
        if (!el) return;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      };

      return h(
        'div',
        {
          ref: box,
          onScroll,
          style: {
            height: 112,
            overflowY: 'auto',
            padding: '7px 9px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-base)', // 日志区用最深一层底，对比更清楚
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
            fontSize: 11,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          },
          title: source || '日志',
        },
        lines.length === 0
          ? h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '暂时没有日志')
          : lines.map((line, index) =>
              h('div', { key: `${index}-${line.slice(0, 12)}`, style: { color: lineColor(line) } }, line),
            ),
      );
    }

    /** 外层只判断显示/隐藏：隐藏时整块卸载，useLauncher / useEvents 的订阅和定时器一起停 */
    function LauncherPanel() {
      const embedded = useEmbedded();
      if (!embedded) return null;
      return h(PanelBody, null);
    }

    function PanelBody() {
      const embedded = useEmbedded();
      const theme = useLauncherTheme();
      const { state, error, reload } = useLauncher();
      const events = useEvents();
      const job = runningJob(events);
      const [version, setVersion] = useState('');
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      const [memory, setMemory] = useState(() => normalizeMemory(readPref('mcl.memory', '2G')) || '2G');
      const [collapsed, setCollapsed] = useState(() => readPref(COLLAPSED_KEY, '0') === '1');
      // 位置一开始就有值（右下角），面板永远不需要等测量才可见
      const [pos, setPos] = useState(() => {
        const saved = loadPos();
        if (saved) return saved;
        const mini = readPref(COLLAPSED_KEY, '0') === '1';
        const width = mini ? 268 : 336;
        const height = mini ? 96 : 420;
        return {
          x: Math.max(8, window.innerWidth - width - 20),
          y: Math.max(8, window.innerHeight - height - 20),
        };
      });
      const [dragging, setDragging] = useState(false);
      const [logs, setLogs] = useState({ lines: [], source: null });
      const [diag, setDiag] = useState(null);
      const [diagBusy, setDiagBusy] = useState(false);
      // 崩溃修复建议：SSE 推来的报告 + 展开/执行状态
      const [crashReport, setCrashReport] = useState(null);
      const [crashOpen, setCrashOpen] = useState(false);
      const [crashBusy, setCrashBusy] = useState(false);
      const [crashNotice, setCrashNotice] = useState('');
      const [login, setLogin] = useState(null);
      const [loginBusy, setLoginBusy] = useState(false);
      const [copied, setCopied] = useState('');
      const [highlight, setHighlight] = useState(true); // 刚挂载时描边 2.5 秒，方便一眼找到
      const panelRef = useRef(null);
      const dragRef = useRef(null);
      const dragFrame = useRef(0);

      const versions = (state?.versions ?? []).map((v) => v.id);
      const running = Boolean(state?.running);
      const runtime = state?.runtime ?? null;
      const auth = state?.auth ?? { loggedIn: false };

      const posRef = useRef(pos);
      posRef.current = pos;
      /**
       * 宿主容器带 transform / 偏移时，position:fixed 的坐标原点不是视口，
       * 这里用「面板真实 rect」和「写进 left/top 的值」反推容器偏移量，
       * 之后所有摆放、拖动、限位一律在"屏幕坐标"里算，再换算回容器坐标。
       */
      const deltaRef = useRef({ x: 0, y: 0 });

      function panelSize() {
        const el = panelRef.current;
        const rect = el ? el.getBoundingClientRect() : null;
        if (rect && rect.width > 40 && rect.height > 30) return { width: rect.width, height: rect.height };
        return { width: collapsed ? 268 : 336, height: collapsed ? 96 : 420 };
      }

      function syncDelta() {
        const el = panelRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 40 || rect.height <= 30) return; // 还没上屏，量不准
        const base = posRef.current ?? { x: 20, y: 20 };
        deltaRef.current = { x: rect.left - base.x, y: rect.top - base.y };
      }

      /** 按屏幕坐标摆放，自动夹在视口内 */
      function placeAt(left, top) {
        const { width, height } = panelSize();
        const maxLeft = Math.max(8, window.innerWidth - width - 8);
        const maxTop = Math.max(8, window.innerHeight - height - 8);
        const x = Math.min(Math.max(8, left), maxLeft);
        const y = Math.min(Math.max(8, top), maxTop);
        const delta = deltaRef.current;
        setPos({ x: Math.round(x - delta.x), y: Math.round(y - delta.y) });
      }

      /** 跑出视口就拉回来（屏幕坐标） */
      function ensureVisible() {
        const el = panelRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 40 || rect.height <= 30) return;
        const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
        const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
        const targetLeft = Math.min(Math.max(8, rect.left), maxLeft);
        const targetTop = Math.min(Math.max(8, rect.top), maxTop);
        if (Math.abs(targetLeft - rect.left) < 1.5 && Math.abs(targetTop - rect.top) < 1.5) return;
        placeAt(targetLeft, targetTop);
      }

      // 摆位：有存档位置就校验一次还在屏幕里；没有就默认右下角
      useEffect(() => {
        if (pos) {
          const frame = requestAnimationFrame(() => {
            syncDelta();
            ensureVisible();
          });
          return () => cancelAnimationFrame(frame);
        }
        const place = () => {
          syncDelta();
          const size = panelSize();
          placeAt(window.innerWidth - size.width - 20, window.innerHeight - size.height - 20);
        };
        const frame = requestAnimationFrame(place);
        // 首帧量不到（宿主容器 display:none / 还没布局）时的兜底
        const timer = window.setTimeout(place, 250);
        return () => {
          cancelAnimationFrame(frame);
          window.clearTimeout(timer);
        };
      }, [pos, collapsed]);

      useEffect(() => {
        if (pos && !dragging) savePos(pos);
      }, [pos, dragging]);

      useEffect(() => {
        writePref(COLLAPSED_KEY, collapsed ? '1' : '0');
      }, [collapsed]);

      // 内存档位记到本地偏好：浮窗和设置页启动时都读同一个键
      useEffect(() => {
        writePref('mcl.memory', memory);
      }, [memory]);

      // SSE 崩溃报告 → 本地状态；新一次启动（report:null）清空旧卡片
      useEffect(() => {
        setCrashReport(events.crash && typeof events.crash === 'object' ? events.crash : null);
        setCrashOpen(false);
        setCrashNotice('');
      }, [events.crash]);

      // 浮窗重新挂载时（页面刷新/重新显示），从 /api/state.lastCrash 恢复上次崩溃
      const panelCrashHydrated = useRef(false);
      useEffect(() => {
        if (panelCrashHydrated.current) return;
        if (events.crash && typeof events.crash === 'object') {
          panelCrashHydrated.current = true;
          return;
        }
        const summary = state?.lastCrash;
        if (!summary || !summary.instance) return;
        panelCrashHydrated.current = true;
        post('/api/crashfix', { instance: summary.instance }, 60000)
          .then((data) => {
            const report = data?.report;
            if (report && typeof report === 'object' && report.crashed !== false) {
              setCrashReport(report);
              setCrashOpen(false);
            }
          })
          .catch(() => {
            /* 拉不到就保持空 */
          });
      }, [events.crash, state?.lastCrash]);

      // 切实例后旧实例的崩溃卡片不再适用（首次自动选中实例不算切换）
      const panelPrevVersion = useRef('');
      useEffect(() => {
        if (
          panelPrevVersion.current &&
          panelPrevVersion.current !== version &&
          crashReport?.instance &&
          crashReport.instance !== version
        ) {
          setCrashReport(null);
          setCrashOpen(false);
          setCrashNotice('');
        }
        panelPrevVersion.current = version;
      }, [version, crashReport?.instance]);

      useEffect(() => {
        const onResize = () => {
          syncDelta();
          ensureVisible();
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

      // 保险丝：就算启动时宿主容器还没上屏把位置算歪了，这里每 2 秒兜回来（浮窗隐藏时不做）
      useEffect(() => {
        if (!embedded) return undefined;
        const timer = window.setInterval(() => {
          if (dragRef.current || document.hidden) return;
          syncDelta();
          ensureVisible();
        }, 4000);
        return () => window.clearInterval(timer);
      }, [embedded]);

      // 挂载信标 / 高亮：排查用，默认关闭；要排查时 localStorage.setItem('mcl.debug','1')
      const liveRef = useRef({});
      liveRef.current = { embedded, collapsed, version, hasState: Boolean(state), error };
      useEffect(() => {
        const blink = window.setTimeout(() => setHighlight(false), 2500);
        if (readPref('mcl.debug', '0') !== '1') {
          return () => window.clearTimeout(blink);
        }
        const ping = (tag) => {
          try {
            const live = liveRef.current || {};
            const el = panelRef.current;
            const rect = el ? el.getBoundingClientRect() : null;
            const params = new URLSearchParams({
              tag,
              embedded: live.embedded ? '1' : '0',
              collapsed: live.collapsed ? '1' : '0',
              version: live.version || '',
              hasState: live.hasState ? '1' : '0',
              err: live.error || '',
              w: rect ? String(Math.round(rect.width)) : '-1',
              h: rect ? String(Math.round(rect.height)) : '-1',
              x: rect ? String(Math.round(rect.left)) : '-1',
              y: rect ? String(Math.round(rect.top)) : '-1',
              dx: String(Math.round(deltaRef.current.x)),
              dy: String(Math.round(deltaRef.current.y)),
              pos: posRef.current ? `${Math.round(posRef.current.x)},${Math.round(posRef.current.y)}` : 'none',
              vw: String(window.innerWidth),
              vh: String(window.innerHeight),
            });
            fetch(`${originFor(resolvedPort)}/api/client/mount?${params}`).catch(() => {});
          } catch {
            /* ignore */
          }
        };
        ping('mount');
        const timer = window.setTimeout(() => ping('settled'), 2500);
        return () => {
          window.clearTimeout(timer);
          window.clearTimeout(blink);
        };
      }, []);

      // 选中项：没选就挑一个；选中的实例被删了就回退到第一个
      useEffect(() => {
        const ids = (state?.versions ?? []).map((v) => v.id);
        if (ids.length === 0) return;
        if (version && ids.includes(version)) return;
        const preferred = state?.runtime?.instance || state?.instance;
        setVersion(preferred && ids.includes(preferred) ? preferred : ids[0]);
      }, [state, version]);

      // 展开时拉日志尾巴：运行中 2.5s 一次，没跑就降到 10s（日志不会变）
      useEffect(() => {
        if (!embedded || collapsed || !version) return undefined;
        let alive = true;
        let timer = 0;

        const pull = async () => {
          try {
            const data = await api(`/api/logs?instance=${encodeURIComponent(version)}&lines=14`);
            if (!alive) return;
            const nextLines = data.lines ?? [];
            const nextSource = data.source ?? null;
            // 内容没变就不 setState，省掉一次无意义的重渲染
            setLogs((prev) => {
              if (prev.source === nextSource && prev.lines.length === nextLines.length) {
                let same = true;
                for (let i = 0; i < nextLines.length; i += 1) {
                  if (prev.lines[i] !== nextLines[i]) {
                    same = false;
                    break;
                  }
                }
                if (same) return prev;
              }
              return { lines: nextLines, source: nextSource };
            });
          } catch {
            /* 服务没起来就等下一轮 */
          }
        };

        const loop = () => {
          if (!alive) return;
          const delay = document.hidden ? 8000 : running ? 2500 : 10000;
          pull().then(() => {
            if (alive) timer = window.setTimeout(loop, delay);
          });
        };

        loop();
        return () => {
          alive = false;
          window.clearTimeout(timer);
        };
      }, [embedded, collapsed, version, running]);

      // 登录轮询（SSE 的 auth 事件会更快，这里只做兜底）
      useEffect(() => {
        if (!login?.userCode) return undefined;
        const timer = window.setInterval(async () => {
          try {
            const status = await api('/api/auth/status');
            if (status.loggedIn) {
              setLogin(null);
              await reload();
            }
          } catch {
            /* ignore */
          }
        }, 3000);
        // 设备码有效期按服务端给的来（微软一般 15 分钟），到期就收起面板
        const ttl = Number(login.expiresIn) > 0 ? Number(login.expiresIn) * 1000 : 900_000;
        const timeout = window.setTimeout(() => setLogin(null), ttl);
        return () => {
          window.clearInterval(timer);
          window.clearTimeout(timeout);
        };
      }, [login, reload]);

      // SSE 推来登录结果时立刻收掉设备码面板；只认本次登录发起之后的事件
      useEffect(() => {
        if (!login?.userCode) return;
        const event = events.auth;
        if (!event || !event.at || event.at < (login.startedAt ?? 0)) return;
        if (event.status === 'ok') {
          setLogin(null);
          reload();
        } else if (event.status === 'error') {
          setLogin({ error: event.message || '授权失败' });
        }
      }, [events.auth, login, reload]);

      if (!embedded) return null;

      function onHeaderPointerDown(event) {
        if (event.button !== 0) return;
        // 头部里的按钮不要被拖拽吞掉点击
        if (event.target && typeof event.target.closest === 'function' && event.target.closest('button, select, input, a')) {
          return;
        }
        const el = panelRef.current;
        if (!el) return;
        syncDelta();
        const rect = el.getBoundingClientRect();
        dragRef.current = {
          id: event.pointerId,
          dx: event.clientX - rect.left,
          dy: event.clientY - rect.top,
          clientX: event.clientX,
          clientY: event.clientY,
        };
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
        setDragging(true);
        if (event.cancelable) event.preventDefault();
      }

      function onHeaderPointerMove(event) {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        // 记最新坐标，一帧只写一次位置（pointermove 比屏幕刷新快得多）
        drag.clientX = event.clientX;
        drag.clientY = event.clientY;
        if (dragFrame.current) return;
        dragFrame.current = requestAnimationFrame(() => {
          dragFrame.current = 0;
          const current = dragRef.current;
          if (!current) return;
          placeAt(current.clientX - current.dx, current.clientY - current.dy);
        });
      }

      function onHeaderPointerUp(event) {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        if (dragFrame.current) {
          cancelAnimationFrame(dragFrame.current);
          dragFrame.current = 0;
          placeAt(drag.clientX - drag.dx, drag.clientY - drag.dy);
        }
        dragRef.current = null;
        setDragging(false);
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
      }

      /** 启动指定实例（不传就用当前下拉选中的）；retry-launch 修复动作也走这里 */
      async function launchInstance(instanceId) {
        const target = instanceId || version;
        if (!target) {
          setNotice('先选一个实例');
          return;
        }
        setBusy(true);
        setNotice('');
        try {
          await post('/api/launch', {
            version: target,
            username: readPref('mcl.player', 'Player'),
            memory: normalizeMemory(memory) || '2G',
            // 登录过期就退回离线，别让游戏卡在登录
            auth: authUsable(auth),
          });
        } catch (err) {
          setNotice(err.message);
        } finally {
          setBusy(false);
          await reload();
        }
      }

      async function toggleGame() {
        if (!running) {
          await launchInstance(version);
          return;
        }
        setBusy(true);
        setNotice('');
        try {
          await post('/api/stop');
        } catch (err) {
          setNotice(err.message);
        } finally {
          setBusy(false);
          await reload();
        }
      }

      /** 重新拉一次结构化报告（修完 mod 后刷新卡片；接口没就绪就保留旧报告） */
      async function refreshCrashReport() {
        try {
          const data = await post('/api/crashfix', { instance: crashReport?.instance || version });
          const next = data?.report;
          if (next && typeof next === 'object') setCrashReport(next);
        } catch {
          /* 后端还没实现就保持现状，不打扰用户 */
        }
      }

      /**
       * 崩溃修复按钮分发（契约里的 kind）：
       * set-memory 改本地内存档位；服务端 kind 走 /api/crashfix/apply；
       * retry-launch 重新启动；install-mod 提示去设置页模组库；copy-report 复制全文。
       */
      async function applyCrashFix(fix) {
        if (!fix || typeof fix !== 'object' || crashBusy) return;
        const kind = String(fix.kind ?? '');
        const payload = fixPayloadOf(fix);
        const report = crashReport;
        const target = String(payload.instance || report?.instance || version || '').trim();

        if (fix.executable === false) {
          setCrashNotice(String(fix.description || fix.label || ''));
          return;
        }

        if (kind === 'set-memory') {
          const next = normalizeMemory(payload.memory);
          if (!next) {
            setCrashNotice(`报告里的内存值看不懂：${String(payload.memory ?? '')}`);
            return;
          }
          setMemory(next);
          writePref('mcl.memory', next);
          setCrashNotice(`已把内存设为 ${next}，重启游戏后生效`);
          return;
        }

        if (kind === 'retry-launch') {
          setCrashReport(null);
          setCrashOpen(false);
          setCrashNotice('');
          if (target && versions.includes(target)) setVersion(target);
          await launchInstance(target || version);
          return;
        }

        if (kind === 'install-mod') {
          const query = String(payload.query ?? payload.q ?? '').trim();
          setCrashNotice(
            query
              ? `去「设置 → Minecraft → 模组库」搜索「${query}」安装（已复制关键词）`
              : '去「设置 → Minecraft → 模组库」搜索缺失的前置模组',
          );
          if (query) copyText(query).catch(() => {});
          return;
        }

        if (kind === 'copy-report') {
          const text = String(report?.text ?? '');
          if (!text) {
            setCrashNotice('报告还没有生成好，稍后再试');
            return;
          }
          const ok = await copy(text, 'crash-report');
          setCrashNotice(ok ? '报告已复制，可以直接贴给 AI 或群里' : '复制失败，请手动选中');
          return;
        }

        if (kind === 'open-settings') {
          const page = String(payload.page ?? '').trim();
          setCrashNotice(
            page === 'appearance' ? '去「设置 → 外观」调整显示相关设置' : `去设置页调整：${String(fix.label ?? '')}`,
          );
          return;
        }

        if (kind === 'update-loader' || kind === 'advisory') {
          setCrashNotice(String(payload.hint || fix.description || fix.label || ''));
          return;
        }

        // 剩下的应该都由服务端做（disable/remove mod、打开报告/日志、装 Java）
        const serverKinds = ['disable-mod', 'enable-mod', 'remove-mod', 'open-report', 'open-log', 'install-java'];
        if (!serverKinds.includes(kind)) {
          setCrashNotice(`不认识这个修复动作：${kind || '（缺少 kind）'}`);
          return;
        }
        if (kind === 'install-java') setCrashNotice('正在准备 Java，下载可能比较慢，请稍等…');
        setCrashBusy(true);
        try {
          const result = await post('/api/crashfix/apply', { instance: target, kind, payload }, 600000);
          if (result && result.ok === false) {
            setCrashNotice(String(result.message || '服务端没有执行这个动作'));
          } else {
            setCrashNotice(String(result?.message || `${fixLabel(fix)}：已执行`));
            if (kind.includes('mod')) await refreshCrashReport();
          }
        } catch (err) {
          setCrashNotice(`修复失败：${err.message}`);
        } finally {
          setCrashBusy(false);
        }
      }

      async function openWindow() {
        try {
          await post('/api/open-window');
          // 独立窗口起来了，收起内置浮窗（设置页还能再打开）
          setEmbedded(false);
        } catch (err) {
          setNotice(err.message);
        }
      }

      async function startLogin() {
        setLoginBusy(true);
        try {
          const info = await post('/api/auth/start');
          setLogin({
            userCode: info.userCode,
            verificationUri: info.verificationUri,
            expiresIn: info.expiresIn,
            // 时间点：只接受此后到达的 auth 事件
            startedAt: Date.now(),
          });
        } catch (err) {
          setLogin({ error: err.message });
        } finally {
          setLoginBusy(false);
        }
      }

      async function copy(text, token) {
        const ok = await copyText(text);
        if (ok) {
          setCopied(token || text);
          window.setTimeout(() => setCopied(''), 1500);
        } else {
          setNotice('复制失败，请手动选中');
        }
        return ok;
      }

      /**
       * 崩溃诊断：优先用新的结构化接口 /api/crashfix（causes + fixes）。
       * 后端没实现时回退旧的 /api/diagnose（findings），保持原功能可用。
       */
      async function runDiagnose() {
        if (!version) return;
        setDiagBusy(true);
        try {
          const data = await post('/api/crashfix', { instance: version });
          const report = data?.report && typeof data.report === 'object' ? data.report : null;
          if (!report) throw new Error('诊断接口没有返回报告');
          if (report.crashed !== false) {
            // 真崩溃：直接展开红色卡片（和自动分析共用一套渲染）
            setCrashReport(report);
            setCrashOpen(true);
            setDiag(null);
          } else {
            setDiag({ report });
          }
        } catch (crashErr) {
          try {
            const legacy = await post('/api/diagnose', { instance: version });
            setDiag({ legacy });
          } catch (err) {
            setDiag({ error: err.message || crashErr.message });
          }
        } finally {
          setDiagBusy(false);
        }
      }

      const tone = error
        ? 'var(--dsw-alias-state-warn-primary)'
        : running
          ? 'var(--dsw-alias-state-success-primary)'
          : 'var(--dsw-alias-state-idle-primary)';
      const statusText = error ? '离线' : running ? '运行中' : '待机';

      const shell = {
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        zIndex: 60,
        width: collapsed ? 268 : 336,
        pointerEvents: 'auto',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 14,
        background: 'var(--dsw-alias-bg-layer-1)', // 不透明面板底：浮窗透起来费眼睛
        boxShadow: highlight
          ? '0 0 0 2px var(--dsw-alias-brand-primary), 0 16px 40px rgba(0,0,0,0.35)'
          : '0 16px 40px rgba(0,0,0,0.35)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: 12,
        overflow: 'hidden',
        userSelect: dragging ? 'none' : 'auto',
      };

      const header = h(
        'div',
        {
          onPointerDown: onHeaderPointerDown,
          onPointerMove: onHeaderPointerMove,
          onPointerUp: onHeaderPointerUp,
          onPointerCancel: onHeaderPointerUp,
          onDoubleClick: (event) => {
            // 双击按钮不该顺手把面板收起
            if (event.target && typeof event.target.closest === 'function' && event.target.closest('button')) return;
            setCollapsed((prev) => !prev);
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 10px 9px 12px',
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            background: 'var(--dsw-alias-bg-layer-2)',
            borderBottom: collapsed ? 'none' : '1px solid var(--dsw-alias-border-l1)',
          },
        },
        h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, letterSpacing: 2, lineHeight: 1 } }, '⋮⋮'),
        h(StatusDot, { tone }),
        h('span', { style: { fontWeight: 600, fontSize: 13 } }, collapsed && version ? version : 'Minecraft'),
        h(
          'span',
          { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', flex: 1, textAlign: 'right' } },
          statusText,
        ),
        collapsed
          ? h(
              'button',
              {
                type: 'button',
                title: '展开',
                onClick: () => setCollapsed(false),
                style: { border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: 13, padding: '0 2px' },
              },
              '▾',
            )
          : h(
              'button',
              {
                type: 'button',
                title: '收起',
                onClick: () => setCollapsed(true),
                style: { border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: 13, padding: '0 2px' },
              },
              '▴',
            ),
      );

      if (collapsed) {
        return h(
          'div',
          { ref: panelRef, style: { ...shell, ...themeVars(theme) } },
          header,
          h(
            'div',
            { style: { display: 'flex', gap: 6, padding: '0 10px 9px' } },
            h(
              'button',
              {
                type: 'button',
                style: { ...(running ? S.danger : S.button), flex: 1, padding: '6px 10px', fontSize: 12, opacity: version || running ? 1 : 0.5 },
                onClick: toggleGame,
                disabled: busy || (!running && !version),
              },
              running ? '停止' : '启动',
            ),
            h(
              'button',
              { type: 'button', style: { ...S.ghost, padding: '6px 10px', fontSize: 12 }, onClick: openWindow, title: '打开完整界面' },
              '⤢',
            ),
          ),
        );
      }

      // 手动诊断结果：新接口给结构化报告（含 causes+fixes），旧接口回退 findings
      const diagView = diag
        ? h(
            'div',
            {
              style: {
                marginTop: 8,
                padding: '7px 9px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-layer-2)',
                fontSize: 11,
                lineHeight: 1.6,
                color: 'var(--dsw-alias-label-secondary)',
                maxHeight: diag.report ? 240 : 96,
                overflowY: 'auto',
              },
            },
            diag.error
              ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, diag.error)
              : diag.report
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600, marginBottom: 4 } },
                      `没有崩溃：${crashSummaryText(diag.report)}`,
                    ),
                    h(CrashReportBody, {
                      report: diag.report,
                      busy: crashBusy,
                      onFix: applyCrashFix,
                      maxCauses: 3,
                      maxEvidence: 2,
                    }),
                  )
                : diag.legacy?.findings && diag.legacy.findings.length > 0
                  ? diag.legacy.findings.slice(0, 2).map((finding, index) =>
                      h(
                        'div',
                        { key: `${index}-${finding.id}`, style: { marginBottom: index === 0 ? 4 : 0 } },
                        h('div', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, finding.title),
                        h('div', null, finding.suggestion),
                      ),
                    )
                  : h('div', null, diag.legacy?.message || '没命中已知规则'),
          )
        : null;

      // 红色崩溃卡片：有崩溃报告时插在日志框上方
      const crashFixes = dedupeFixes(crashReport?.fixes);
      const crashCard = crashReport
        ? h(
            'div',
            {
              style: {
                padding: '8px 9px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-state-error-primary)',
                background: 'rgba(255, 90, 90, 0.10)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'flex-start', gap: 6 } },
              h(
                'span',
                { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13, lineHeight: 1.25, flex: 'none' } },
                '⚠',
              ),
              h(
                'div',
                { style: { flex: 1, minWidth: 0 } },
                h(
                  'div',
                  {
                    style: {
                      fontSize: 12,
                      fontWeight: 600,
                      lineHeight: 1.45,
                      color: 'var(--dsw-alias-state-error-primary)',
                    },
                  },
                  `游戏崩溃：${crashSummaryText(crashReport)}`,
                ),
                crashMetaText(crashReport)
                  ? h(
                      'div',
                      { style: { fontSize: 10, marginTop: 2, color: 'var(--dsw-alias-label-secondary)' } },
                      crashMetaText(crashReport),
                    )
                  : null,
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => setCrashOpen((prev) => !prev),
                  style: {
                    flex: 'none',
                    padding: '3px 8px',
                    borderRadius: 6,
                    border: '1px solid var(--dsw-alias-border-l2)',
                    background: 'var(--dsw-alias-bg-layer-1)',
                    color: 'var(--dsw-alias-label-primary)',
                    fontSize: 10,
                    cursor: 'pointer',
                  },
                },
                crashOpen ? '收起' : '修复建议',
              ),
            ),
            crashOpen
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 230, overflowY: 'auto' } },
                  h(CrashReportBody, {
                    report: crashReport,
                    busy: crashBusy,
                    onFix: applyCrashFix,
                    maxCauses: 3,
                    maxEvidence: 2,
                  }),
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => {
                          const text = String(crashReport?.text ?? '');
                          if (!text) {
                            setCrashNotice('报告还没有生成好，稍后再试');
                            return;
                          }
                          copy(text, 'crash-report').then((ok) => {
                            setCrashNotice(ok ? '报告已复制，可以直接贴给 AI 或群里' : '复制失败，请手动选中');
                          });
                        },
                        style: { ...S.ghost, padding: '3px 8px', fontSize: 10 },
                      },
                      copied === 'crash-report' ? '已复制' : '复制报告',
                    ),
                    crashFixes.length > 0
                      ? h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, `${crashFixes.length} 条修复建议`)
                      : null,
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => {
                          setCrashReport(null);
                          setCrashOpen(false);
                          setCrashNotice('');
                        },
                        style: { ...S.ghost, padding: '3px 8px', fontSize: 10, marginLeft: 'auto' },
                      },
                      '忽略',
                    ),
                  ),
                )
              : null,
            crashNotice
              ? h(
                  'div',
                  { style: { fontSize: 10, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' } },
                  crashNotice,
                )
              : null,
          )
        : null;

      const loginView = login
        ? h(
            'div',
            {
              style: {
                marginTop: 6,
                padding: '7px 9px',
                borderRadius: 8,
                border: '1px dashed var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-bg-layer-2)',
                fontSize: 11,
                lineHeight: 1.6,
                color: 'var(--dsw-alias-label-secondary)',
              },
            },
            login.error
              ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, login.error)
              : h(
                  React.Fragment,
                  null,
                  h('div', null, '打开 microsoft.com/link 输入：'),
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' } },
                    h(
                      'code',
                      { style: { fontSize: 14, fontWeight: 700, letterSpacing: 1, color: 'var(--dsw-alias-label-primary)' } },
                      login.userCode,
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => copy(login.userCode, 'code'),
                        style: { ...S.ghost, padding: '2px 8px', fontSize: 11 },
                      },
                      copied === 'code' ? '已复制' : '复制',
                    ),
                  ),
                  h('div', null, '授权完成后这里会自动变成已登录'),
                  h(
                    'div',
                    { style: { marginTop: 4, opacity: 0.75 } },
                    '用自己的 Azure 应用：设置环境变量 MCL_CLIENT_ID 后重启 DSH',
                  ),
                ),
          )
        : null;

      return h(
        'div',
        { ref: panelRef, style: { ...shell, ...themeVars(theme) } },
        header,
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 9, padding: 12 } },
          h(VersionSelect, { versions, value: version, onChange: setVersion, compact: true }),
          h(
            'div',
            { style: { display: 'flex', gap: 8 } },
            h(
              'button',
              {
                type: 'button',
                style: {
                  ...(running ? S.danger : S.button),
                  flex: 1,
                  padding: '7px 12px',
                  fontSize: 12,
                  opacity: running || version ? 1 : 0.5,
                },
                onClick: toggleGame,
                disabled: busy || (!running && !version),
              },
              running ? '停止游戏' : '启动游戏',
            ),
            h(
              'button',
              { type: 'button', style: { ...S.ghost, padding: '7px 10px', fontSize: 12 }, onClick: openWindow, title: '打开完整界面' },
              '窗口',
            ),
          ),
          h(MemoryMeter, { runtime, memory: state?.memory, running }),
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11,
                color: 'var(--dsw-alias-label-secondary)',
              },
            },
            h('span', { style: { flex: 'none' } }, '启动内存'),
            h(
              'select',
              {
                style: { ...S.input, flex: 'none', width: 78, padding: '3px 6px', fontSize: 11 },
                value: memory,
                onChange: (event) => setMemory(event.target.value),
                title: '启动时传给游戏的 -Xmx',
              },
              memoryChoices(memory).map((size) => h('option', { key: size, value: size }, size)),
            ),
            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, running ? '重启后生效' : '崩溃后可按建议调整'),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
            h(StatusDot, {
              tone: auth.loggedIn
                ? auth.expired
                  ? 'var(--dsw-alias-state-warn-primary)'
                  : 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-state-idle-primary)',
            }),
            h(
              'span',
              { style: { flex: 1 } },
              auth.loggedIn
                ? auth.expired
                  ? `正版 · ${auth.name}（登录已过期）`
                  : `正版 · ${auth.name}`
                : '离线玩家（未登录）',
            ),
            authUsable(auth)
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    onClick: startLogin,
                    disabled: loginBusy,
                    style: { ...S.ghost, padding: '2px 8px', fontSize: 11, opacity: loginBusy ? 0.5 : 1 },
                  },
                  auth.loggedIn ? '重新登录' : '微软登录',
                ),
          ),
          loginView,
          job
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    flexWrap: 'wrap',
                    padding: '5px 8px',
                    borderRadius: 8,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-bg-layer-2)',
                    fontSize: 11,
                    color: 'var(--dsw-alias-label-secondary)',
                    lineHeight: 1.5,
                  },
                },
                h('span', {
                  className: 'mcl-pulse',
                  style: {
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--dsw-alias-brand-primary)',
                    flex: 'none',
                  },
                }),
                h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', flex: 'none' } }, job.label),
                h(
                  'span',
                  { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  job.last || '…',
                ),
                h(JobBar, { progress: job.progress }),
              )
            : null,
          crashCard,
          h(LogBox, { lines: logs.lines, source: logs.source }),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h(
              'button',
              {
                type: 'button',
                onClick: runDiagnose,
                disabled: diagBusy || !version,
                style: { ...S.ghost, padding: '5px 10px', fontSize: 11, opacity: diagBusy || !version ? 0.5 : 1 },
              },
              diagBusy ? '诊断中…' : '崩溃诊断',
            ),
            h(
              'button',
              { type: 'button', onClick: () => copy(logs.lines.join('\n'), 'logs'), style: { ...S.ghost, padding: '5px 10px', fontSize: 11 } },
              copied === 'logs' ? '已复制' : '复制日志',
            ),
            notice
              ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', flex: 1 } }, notice)
              : null,
          ),
          diagView,
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'mc-launcher', order: 60, label: 'Minecraft' },
            SettingsSection,
          ),
        );
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'mc-launcher-window', order: 600 }, LauncherPanel),
        );
      },
    };
  },
});
