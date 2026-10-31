/* 外观：主题（A/B/C）+ 背景（图片 + 4 套预设 + 4 个滑杆）
   配置存服务端（~/.mcl/ui/appearance.json），浏览器版和 DSH 插件共用。 */
(() => {
  const DEFAULTS = { theme: 'minimal', preset: 'dark', blur: 8, dim: 35, glass: 62, pos: 30 };
  const PRESETS = {
    'light-fog': { blur: 10, dim: 30, glass: 66 },
    deepsea: { blur: 20, dim: 42, glass: 42 },
    gradient: { blur: 6, dim: 100, glass: 60 },
    dark: { blur: 8, dim: 52, glass: 58 },
  };
  const THEMES = ['minimal', 'deepsea', 'pixel'];

  let state = { ...DEFAULTS, hasBg: false, hasFile: false, bgEnabled: true, bgVersion: '' };
  let saveTimer = 0;

  const $ = (sel) => document.querySelector(sel);
  const body = document.body;

  function clamp(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
  }

  function apply() {
    body.dataset.theme = THEMES.includes(state.theme) ? state.theme : 'minimal';
    body.dataset.preset = PRESETS[state.preset] ? state.preset : 'dark';
    const showBg = Boolean(state.hasFile && state.bgEnabled);
    body.dataset.bg = showBg ? 'image' : 'none';
    const style = body.style;
    style.setProperty('--bg-blur', `${state.blur}px`);
    style.setProperty('--bg-pos', `${state.pos}%`);
    style.setProperty('--glass-alpha', (state.glass / 100).toFixed(2));
    style.setProperty('--scrim-opacity', (state.dim / 100).toFixed(2));
    if (state.hasFile) style.setProperty('--bg-image', `url("/api/ui/background?v=${encodeURIComponent(state.bgVersion || '1')}")`);
    else style.removeProperty('--bg-image');

    for (const button of document.querySelectorAll('#ap-themes [data-theme]')) {
      button.classList.toggle('active', button.dataset.theme === body.dataset.theme);
    }
    for (const button of document.querySelectorAll('#ap-presets [data-preset]')) {
      button.classList.toggle('active', button.dataset.preset === body.dataset.preset);
    }
    const setSlider = (id, value) => {
      const input = $(id);
      if (!input) return;
      input.value = String(value);
      const out = document.getElementById(`${id.replace('#ap-', 'ap-')}-v`);
      if (out) out.textContent = String(value);
    };
    setSlider('#ap-blur', state.blur);
    setSlider('#ap-dim', state.dim);
    setSlider('#ap-glass', state.glass);
    setSlider('#ap-pos', state.pos);
    const useButton = $('#ap-bg-use');
    if (useButton) useButton.hidden = !(state.hasFile && !state.bgEnabled);
    const status = $('#ap-status');
    if (status) {
      status.textContent = showBg
        ? `背景图只存在本机（~/.mcl/ui/），当前样式：${body.dataset.preset}`
        : state.hasFile
          ? '背景图已关闭，点「使用背景」恢复。'
          : '还没有背景图。上传一张本地图片，壁纸和 UI 都会跟着变。';
    }
  }

  async function save(patch) {
    Object.assign(state, patch);
    apply();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fetch('/api/ui/appearance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          theme: state.theme,
          preset: state.preset,
          blur: state.blur,
          dim: state.dim,
          glass: state.glass,
          pos: state.pos,
          bgEnabled: state.bgEnabled,
        }),
      }).catch(() => {});
    }, 250);
  }

  async function load() {
    try {
      const res = await fetch('/api/ui/appearance', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        state = {
          ...state,
          theme: THEMES.includes(data.theme) ? data.theme : DEFAULTS.theme,
          preset: PRESETS[data.preset] ? data.preset : DEFAULTS.preset,
          blur: clamp(data.blur, 0, 30, DEFAULTS.blur),
          dim: clamp(data.dim, 0, 80, DEFAULTS.dim),
          glass: clamp(data.glass, 30, 95, DEFAULTS.glass),
          pos: clamp(data.pos, 0, 100, DEFAULTS.pos),
          hasFile: Boolean(data.hasFile),
          hasBg: Boolean(data.hasBg),
          bgEnabled: data.bgEnabled !== false,
          bgVersion: String(data.bgVersion || ''),
        };
      }
    } catch {
      /* 服务没起来就用默认外观 */
    }
    apply();
  }

  function openPanel(open) {
    const panel = $('#appearance-panel');
    const mask = $('#appearance-mask');
    if (!panel || !mask) return;
    panel.hidden = !open;
    mask.hidden = !open;
  }

  async function uploadBackground(file) {
    const status = $('#ap-status');
    if (status) status.textContent = '正在处理图片…';
    try {
      const bitmap = await createImageBitmap(file);
      const max = 2560;
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
      if (bitmap.close) bitmap.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      if (!blob) throw new Error('图片处理失败');
      const res = await fetch('/api/ui/background', {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '上传失败');
      state.hasFile = true;
      state.hasBg = true;
      state.bgEnabled = true;
      state.bgVersion = data.version;
      apply();
      if (status) status.textContent = `已更新背景（${width}×${height}）`;
    } catch (error) {
      if (status) status.textContent = `背景处理失败：${error.message}`;
    }
  }

  function wire() {
    $('#btn-appearance')?.addEventListener('click', () => openPanel(true));
    $('#ap-close')?.addEventListener('click', () => openPanel(false));
    $('#appearance-mask')?.addEventListener('click', () => openPanel(false));

    for (const button of document.querySelectorAll('#ap-themes [data-theme]')) {
      button.addEventListener('click', () => save({ theme: button.dataset.theme }));
    }
    for (const button of document.querySelectorAll('#ap-presets [data-preset]')) {
      button.addEventListener('click', () => {
        const preset = button.dataset.preset;
        const defaults = PRESETS[preset] || PRESETS.dark;
        save({ preset, blur: defaults.blur, dim: defaults.dim, glass: defaults.glass });
      });
    }

    const slider = (id, key, min, max) => {
      const input = $(id);
      if (!input) return;
      input.addEventListener('input', () => {
        const value = clamp(input.value, min, max, DEFAULTS[key]);
        save({ [key]: value });
      });
    };
    slider('#ap-blur', 'blur', 0, 30);
    slider('#ap-dim', 'dim', 0, 80);
    slider('#ap-glass', 'glass', 30, 95);
    slider('#ap-pos', 'pos', 0, 100);

    $('#ap-bg-file')?.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) uploadBackground(file);
      event.target.value = '';
    });
    $('#ap-bg-none')?.addEventListener('click', () => {
      state.bgEnabled = false;
      save({ bgEnabled: false });
    });
    $('#ap-bg-use')?.addEventListener('click', () => {
      state.bgEnabled = true;
      save({ bgEnabled: true });
    });
    $('#ap-bg-clear')?.addEventListener('click', async () => {
      try {
        await fetch('/api/ui/background', { method: 'DELETE' });
      } catch {
        /* ignore */
      }
      state.hasFile = false;
      state.hasBg = false;
      state.bgVersion = '';
      apply();
    });
    $('#ap-reset')?.addEventListener('click', () => {
      save({ ...DEFAULTS });
    });

    for (const button of document.querySelectorAll('[data-jump]')) {
      button.addEventListener('click', () => {
        for (const item of document.querySelectorAll('[data-jump]')) item.classList.toggle('active', item === button);
        document.getElementById(button.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') openPanel(false);
    });
  }

  wire();
  load();
  window.MCLAppearance = {
    get state() {
      return { ...state };
    },
    setTheme: (theme) => save({ theme }),
    setPreset: (preset) => save({ preset, ...(PRESETS[preset] || {}) }),
  };
})();
