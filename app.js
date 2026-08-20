/**
 * Antigravity Mobile Control Deck - PWA Client Engine
 * Features:
 * - Dynamic Backend Tunnel Auto-Discovery (Permanent GitHub Pages PWA)
 * - Anti-Crop Viewport Transformation & Touch Coordinate Mapping
 * - Installed Applications Catalog & Real-Time Search
 * - Open Windows & Tasks Switcher
 * - File Search & Instant Launcher
 * - Toast Notifications & Fullscreen Toggle
 */

// Service Worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.log('SW registration failed:', err);
    });
  });
}

// State
const state = {
  authToken: new URLSearchParams(window.location.search).get('auth') || 'c85e4f126814fb14',
  touchMode: 'direct', // 'direct' | 'trackpad'
  zoomLevel: 'fit', // 'fit' | 1 | 1.5 | 2 | 3
  zoomScale: 1,
  panX: 0,
  panY: 0,
  isDragging: false,
  dragLocked: false,
  sensitivity: 1.0,
  nativeWidth: 1920,
  nativeHeight: 1080,
  lastFrameTime: performance.now(),
  frameCount: 0,
  fps: 0,
  connected: false,
};

// DOM Elements
const canvas = document.getElementById('screen-canvas');
const ctx = canvas.getContext('2d');
const wrapper = document.getElementById('canvas-wrapper');
const viewport = document.getElementById('viewport');
const cursorPointer = document.getElementById('cursor-pointer');
const statusDot = document.getElementById('status-dot');
const fpsBadge = document.getElementById('fps-badge');
const loadingOverlay = document.getElementById('loading-overlay');
const btnReconnect = document.getElementById('btn-reconnect');
const toastEl = document.getElementById('toast');

const btnModeTouch = document.getElementById('btn-mode-touch');
const btnModeTrackpad = document.getElementById('btn-mode-trackpad');
const trackpadBar = document.getElementById('trackpad-bar');
const btnZoomToggle = document.getElementById('btn-zoom-toggle');
const zoomLabel = document.getElementById('zoom-label');
const zoomMenu = document.getElementById('zoom-menu');
const btnToggleFullscreen = document.getElementById('btn-toggle-fullscreen');

const btnOpenLaunchers = document.getElementById('btn-open-launchers');
const btnCloseLaunchers = document.getElementById('btn-close-launchers');
const modalLaunchers = document.getElementById('modal-launchers');
const customAppInput = document.getElementById('custom-app-input');
const btnCustomLaunch = document.getElementById('btn-custom-launch');
const appSearchInput = document.getElementById('app-search-input');
const appsList = document.getElementById('apps-list');

const btnOpenWindows = document.getElementById('btn-open-windows');
const btnCloseWindows = document.getElementById('btn-close-windows');
const modalWindows = document.getElementById('modal-windows');
const btnRefreshWindows = document.getElementById('btn-refresh-windows');
const windowsList = document.getElementById('windows-list');

const btnOpenFiles = document.getElementById('btn-open-files');
const btnCloseFiles = document.getElementById('btn-close-files');
const modalFiles = document.getElementById('modal-files');
const fileSearchInput = document.getElementById('file-search-input');
const filesResults = document.getElementById('files-results');

const btnOpenSettings = document.getElementById('btn-open-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');
const modalSettings = document.getElementById('modal-settings');

const typeInput = document.getElementById('type-input');
const btnSendText = document.getElementById('btn-send-text');

// WebSockets & Backend Discovery
let wsScreen = null;
let wsControl = null;
let reconnectTimer = null;
const GIST_ID = '1e5db360ce0ae208bad1c26709c55462';

let backendUrl = localStorage.getItem('ag_backend_url') || '';
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('backend')) {
  backendUrl = urlParams.get('backend').replace(/\/$/, '');
  localStorage.setItem('ag_backend_url', backendUrl);
}

function showToast(message, isError = false) {
  if (!toastEl) return;
  toastEl.innerText = message;
  toastEl.style.borderColor = isError ? 'var(--accent-red)' : 'var(--accent-cyan)';
  toastEl.classList.remove('hidden');
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 2500);
}

async function resolveBackendUrl() {
  if (window.location.hostname.includes('github.io')) {
    try {
      const res = await fetch(`https://api.github.com/gists/${GIST_ID}?t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data.files && data.files['tunnel.json']) {
          const parsed = JSON.parse(data.files['tunnel.json'].content);
          if (parsed.url) {
            backendUrl = parsed.url.replace(/\/$/, '');
            localStorage.setItem('ag_backend_url', backendUrl);
            console.log('[ControlDeck] Resolved live backend from Gist:', backendUrl);
            return backendUrl;
          }
        }
      }
    } catch (e) {
      console.warn('[ControlDeck] Gist resolution error:', e);
    }
  }
  if (!backendUrl) {
    backendUrl = `${window.location.protocol}//${window.location.host}`;
  }
  return backendUrl;
}

function getWsUrl(path) {
  const base = backendUrl || `${window.location.protocol}//${window.location.host}`;
  const isHttps = base.startsWith('https:');
  const wsProto = isHttps ? 'wss:' : 'ws:';
  const host = base.replace(/^https?:\/\//, '');
  return `${wsProto}//${host}${path}?auth=${encodeURIComponent(state.authToken)}`;
}

function getApiUrl(path) {
  const base = backendUrl || '';
  const delim = path.includes('?') ? '&' : '?';
  return `${base}${path}${delim}auth=${encodeURIComponent(state.authToken)}`;
}

// ==============================================================================
// WEBSOCKET CONNECTIONS & STREAMING
// ==============================================================================

async function connectWebSockets() {
  if (wsScreen) { wsScreen.close(); }
  if (wsControl) { wsControl.close(); }

  loadingOverlay.classList.remove('hidden');
  document.getElementById('loading-text').innerText = 'Connecting to Laptop Screen...';

  await resolveBackendUrl();

  // 1. Screen Stream WebSocket
  try {
    wsScreen = new WebSocket(getWsUrl('/ws/screen'));
  } catch (err) {
    console.error('WS Screen create error:', err);
    scheduleReconnect();
    return;
  }

  wsScreen.binaryType = 'blob';

  wsScreen.onopen = () => {
    state.connected = true;
    statusDot.classList.add('connected');
    loadingOverlay.classList.add('hidden');
    console.log('[ControlDeck] Screen stream connected!');
  };

  let rendering = false;
  wsScreen.onmessage = async (event) => {
    if (event.data instanceof Blob) {
      if (rendering) return;
      rendering = true;

      try {
        if ('createImageBitmap' in window) {
          const bitmap = await createImageBitmap(event.data);
          if (state.frameCount < 5 || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            state.nativeWidth = bitmap.width;
            state.nativeHeight = bitmap.height;
            updateViewportTransform();
          }
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
        } else {
          const url = URL.createObjectURL(event.data);
          const img = new Image();
          await new Promise((resolve) => {
            img.onload = () => {
              if (state.frameCount < 5 || canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                state.nativeWidth = img.naturalWidth;
                state.nativeHeight = img.naturalHeight;
                updateViewportTransform();
              }
              ctx.drawImage(img, 0, 0);
              URL.revokeObjectURL(url);
              resolve();
            };
            img.onerror = () => {
              URL.revokeObjectURL(url);
              resolve();
            };
            img.src = url;
          });
        }

        // Calculate FPS
        state.frameCount++;
        const now = performance.now();
        if (now - state.lastFrameTime >= 1000) {
          state.fps = Math.round((state.frameCount * 1000) / (now - state.lastFrameTime));
          fpsBadge.innerText = `${state.fps} FPS`;
          state.frameCount = 0;
          state.lastFrameTime = now;
        }
      } catch (err) {
        console.error('Frame render error:', err);
      } finally {
        rendering = false;
      }
    }
  };

  wsScreen.onclose = () => {
    state.connected = false;
    statusDot.classList.remove('connected');
    loadingOverlay.classList.remove('hidden');
    document.getElementById('loading-text').innerText = 'Disconnected from Laptop. Retrying in 3s...';
    scheduleReconnect();
  };

  // 2. Control Input WebSocket
  connectControlWebSocket();
}

function connectControlWebSocket() {
  if (wsControl && (wsControl.readyState === WebSocket.OPEN || wsControl.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    wsControl = new WebSocket(getWsUrl('/ws/control'));
    wsControl.onopen = () => {
      console.log('[ControlDeck] Control channel connected!');
    };
    wsControl.onclose = () => {
      console.log('[ControlDeck] Control channel closed.');
    };
  } catch (err) {
    console.error('WS Control create error:', err);
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connectWebSockets();
  }, 3000);
}

btnReconnect.addEventListener('click', connectWebSockets);

function sendControl(data) {
  if (wsControl && wsControl.readyState === WebSocket.OPEN) {
    wsControl.send(JSON.stringify(data));
  } else {
    connectControlWebSocket();
    setTimeout(() => {
      if (wsControl && wsControl.readyState === WebSocket.OPEN) {
        wsControl.send(JSON.stringify(data));
      }
    }, 250);
  }
}

// ==============================================================================
// VIEWPORT TRANSFORMATION & ANTI-CROP ENGINE
// ==============================================================================

function updateViewportTransform() {
  const vWidth = viewport.clientWidth || window.innerWidth;
  const vHeight = viewport.clientHeight || (window.innerHeight - 50);
  const nativeW = state.nativeWidth || 1920;
  const nativeH = state.nativeHeight || 1080;

  if (state.zoomLevel === 'fit') {
    const scaleX = vWidth / nativeW;
    const scaleY = vHeight / nativeH;
    state.zoomScale = Math.min(scaleX, scaleY);
    state.panX = Math.round((vWidth - nativeW * state.zoomScale) / 2);
    state.panY = Math.round((vHeight - nativeH * state.zoomScale) / 2);
  } else {
    state.zoomScale = parseFloat(state.zoomLevel) || 1;
    const minPanX = Math.min(0, vWidth - nativeW * state.zoomScale);
    const minPanY = Math.min(0, vHeight - nativeH * state.zoomScale);
    state.panX = Math.max(minPanX, Math.min(0, state.panX));
    state.panY = Math.max(minPanY, Math.min(0, state.panY));
  }

  wrapper.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoomScale})`;
}

window.addEventListener('resize', updateViewportTransform);
window.addEventListener('orientationchange', () => {
  setTimeout(updateViewportTransform, 150);
});

// Fullscreen Toggle
if (btnToggleFullscreen) {
  btnToggleFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      btnToggleFullscreen.innerText = '🗗';
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      btnToggleFullscreen.innerText = '⛶';
    }
  });
}

// Zoom Menu
btnZoomToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  zoomMenu.classList.toggle('hidden');
});

document.addEventListener('click', () => {
  zoomMenu.classList.add('hidden');
});

zoomMenu.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const level = btn.getAttribute('data-zoom');
    state.zoomLevel = level;
    zoomLabel.innerText = level === 'fit' ? 'Fit' : `${Math.round(level * 100)}%`;
    if (level === 'fit') {
      state.panX = 0;
      state.panY = 0;
    }
    updateViewportTransform();
  });
});

// Touch Mode Toggle
btnModeTouch.addEventListener('click', () => {
  state.touchMode = 'direct';
  btnModeTouch.classList.add('active');
  btnModeTrackpad.classList.remove('active');
  trackpadBar.classList.add('hidden');
  cursorPointer.classList.add('hidden');
});

btnModeTrackpad.addEventListener('click', () => {
  state.touchMode = 'trackpad';
  btnModeTrackpad.classList.add('active');
  btnModeTouch.classList.remove('active');
  trackpadBar.classList.remove('hidden');
  cursorPointer.classList.remove('hidden');
});

// ==============================================================================
// TOUCH & MOUSE INPUT CONTROLS
// ==============================================================================

let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;
let initialDistance = 0;
let initialScale = 1;
let longPressTimer = null;
let lastTapTime = 0;

function screenCoordsFromClient(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || canvas.clientWidth || window.innerWidth;
  const height = rect.height || canvas.clientHeight || (window.innerHeight - 50);
  const left = rect.left || 0;
  const top = rect.top || 0;

  const relX = (clientX - left) / width;
  const relY = (clientY - top) / height;
  return {
    normX: Math.max(0, Math.min(1, relX)),
    normY: Math.max(0, Math.min(1, relY)),
  };
}

viewport.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchStartTime = Date.now();

    if (state.touchMode === 'direct') {
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        const coords = screenCoordsFromClient(t.clientX, t.clientY);
        sendControl({ type: 'click', x: coords.normX, y: coords.normY, button: 'right' });
        if (navigator.vibrate) navigator.vibrate(50);
      }, 500);
    }
  } else if (e.touches.length === 2) {
    clearTimeout(longPressTimer);
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    initialDistance = Math.hypot(dx, dy);
    initialScale = state.zoomScale;
    touchStartY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
  }
}, { passive: false });

viewport.addEventListener('touchmove', (e) => {
  e.preventDefault();

  if (e.touches.length === 1) {
    const t = e.touches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;

    if (Math.hypot(dx, dy) > 10) {
      clearTimeout(longPressTimer);
    }

    if (state.touchMode === 'direct') {
      if (state.zoomLevel !== 'fit') {
        state.panX += dx;
        state.panY += dy;
        updateViewportTransform();
        touchStartX = t.clientX;
        touchStartY = t.clientY;
      }
    } else {
      const coords = screenCoordsFromClient(t.clientX, t.clientY);
      sendControl({ type: 'mousemove', x: coords.normX, y: coords.normY });
      touchStartX = t.clientX;
      touchStartY = t.clientY;
    }
  } else if (e.touches.length === 2) {
    const currentDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );

    if (Math.abs(currentDist - initialDistance) > 20) {
      const factor = currentDist / initialDistance;
      state.zoomLevel = Math.max(0.5, Math.min(3.5, initialScale * factor));
      zoomLabel.innerText = `${Math.round(state.zoomLevel * 100)}%`;
      updateViewportTransform();
    } else {
      const currentY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const scrollDy = currentY - touchStartY;
      if (Math.abs(scrollDy) > 6) {
        sendControl({ type: 'scroll', deltaY: scrollDy > 0 ? 1 : -1 });
        touchStartY = currentY;
      }
    }
  }
}, { passive: false });

viewport.addEventListener('touchend', (e) => {
  clearTimeout(longPressTimer);
  const elapsed = Date.now() - touchStartTime;

  if (e.changedTouches.length === 1 && elapsed < 350) {
    const t = e.changedTouches[0];
    const dist = Math.hypot(t.clientX - touchStartX, t.clientY - touchStartY);

    if (dist < 10 && state.touchMode === 'direct') {
      const now = Date.now();
      const coords = screenCoordsFromClient(t.clientX, t.clientY);

      if (now - lastTapTime < 300) {
        sendControl({ type: 'dblclick', x: coords.normX, y: coords.normY });
        lastTapTime = 0;
      } else {
        sendControl({ type: 'click', x: coords.normX, y: coords.normY, button: 'left' });
        lastTapTime = now;
      }
      if (navigator.vibrate) navigator.vibrate(20);
    }
  }
});

// Trackpad Action Buttons
document.getElementById('btn-left-click')?.addEventListener('click', () => {
  sendControl({ type: 'click', button: 'left' });
  if (navigator.vibrate) navigator.vibrate(20);
});
document.getElementById('btn-middle-click')?.addEventListener('click', () => {
  sendControl({ type: 'click', button: 'middle' });
  if (navigator.vibrate) navigator.vibrate(20);
});
document.getElementById('btn-right-click')?.addEventListener('click', () => {
  sendControl({ type: 'click', button: 'right' });
  if (navigator.vibrate) navigator.vibrate(30);
});

const btnDragToggle = document.getElementById('btn-drag-toggle');
if (btnDragToggle) {
  btnDragToggle.addEventListener('click', () => {
    state.dragLocked = !state.dragLocked;
    if (state.dragLocked) {
      btnDragToggle.classList.add('active');
      sendControl({ type: 'mousedown', button: 'left' });
    } else {
      btnDragToggle.classList.remove('active');
      sendControl({ type: 'mouseup', button: 'left' });
    }
  });
}

// Hotkey Chips
document.querySelectorAll('[data-key]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.getAttribute('data-key');
    sendControl({ type: 'key', key: key });
    if (navigator.vibrate) navigator.vibrate(30);
  });
});

document.querySelectorAll('[data-hotkey]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const hotkey = btn.getAttribute('data-hotkey').split(',');
    sendControl({ type: 'hotkey', keys: hotkey });
    if (navigator.vibrate) navigator.vibrate(30);
  });
});

// Text Typing Input
btnSendText.addEventListener('click', sendTypedText);
typeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    sendTypedText();
  }
});

async function sendTypedText() {
  const text = typeInput.value;
  if (!text) return;
  
  typeInput.value = '';
  if (navigator.vibrate) navigator.vibrate(30);

  if (wsControl && wsControl.readyState === WebSocket.OPEN) {
    sendControl({ type: 'type_text', text: text });
  } else {
    try {
      await fetch(getApiUrl('/api/type'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text })
      });
    } catch (err) {
      console.debug('HTTP type fallback error:', err);
    }
  }
}

// Toggle Keyboard Bar
document.getElementById('btn-toggle-keyboard').addEventListener('click', () => {
  typeInput.focus();
});

// ==============================================================================
// INSTALLED APPLICATIONS & LAUNCHERS
// ==============================================================================

btnOpenLaunchers.addEventListener('click', () => {
  modalLaunchers.classList.remove('hidden');
  fetchInstalledApps('');
});
btnCloseLaunchers.addEventListener('click', () => modalLaunchers.classList.add('hidden'));
modalLaunchers.addEventListener('click', (e) => {
  if (e.target === modalLaunchers) modalLaunchers.classList.add('hidden');
});

// App Search Debounce
let appSearchDebounce = null;
if (appSearchInput) {
  appSearchInput.addEventListener('input', () => {
    clearTimeout(appSearchDebounce);
    appSearchDebounce = setTimeout(() => {
      fetchInstalledApps(appSearchInput.value.trim());
    }, 250);
  });
}

async function fetchInstalledApps(query) {
  if (!appsList) return;
  appsList.innerHTML = '<div class="files-empty">Scanning installed PC software...</div>';
  try {
    const res = await fetch(getApiUrl(`/api/apps${query ? `?q=${encodeURIComponent(query)}` : ''}`));
    const data = await res.json();
    const apps = data.apps || [];

    if (apps.length === 0) {
      appsList.innerHTML = `<div class="files-empty">No applications found matching "${escapeHtml(query)}"</div>`;
      return;
    }

    appsList.innerHTML = '';
    apps.forEach((app) => {
      const item = document.createElement('div');
      item.className = 'app-item';
      
      let icon = app.icon || '🚀';
      const nameLower = app.name.toLowerCase();
      if (nameLower.includes('chrome') || nameLower.includes('edge') || nameLower.includes('browser')) icon = '🌐';
      else if (nameLower.includes('vlc') || nameLower.includes('media player') || nameLower.includes('video') || nameLower.includes('movies')) icon = '🎬';
      else if (nameLower.includes('wechat')) icon = '💬';
      else if (nameLower.includes('whatsapp')) icon = '📱';
      else if (nameLower.includes('telegram')) icon = '✈️';
      else if (nameLower.includes('code') || nameLower.includes('studio') || nameLower.includes('python')) icon = '💻';
      else if (nameLower.includes('terminal') || nameLower.includes('powershell') || nameLower.includes('cmd')) icon = '⬛';
      else if (nameLower.includes('word') || nameLower.includes('writer')) icon = '📄';
      else if (nameLower.includes('excel') || nameLower.includes('sheet') || nameLower.includes('calc')) icon = '📊';
      else if (nameLower.includes('powerpoint') || nameLower.includes('slide')) icon = '📽️';
      else if (nameLower.includes('bilibili') || nameLower.includes('哔哩哔哩')) icon = '📺';
      else if (nameLower.includes('douyin') || nameLower.includes('抖音') || nameLower.includes('tiktok')) icon = '🎵';
      else if (nameLower.includes('capcut') || nameLower.includes('剪映')) icon = '✂️';
      else if (nameLower.includes('calc') || nameLower.includes('calculator')) icon = '🔢';
      else if (nameLower.includes('notepad')) icon = '📝';
      else if (nameLower.includes('paint')) icon = '🎨';
      else if (nameLower.includes('winrar') || nameLower.includes('zip') || nameLower.includes('7-zip')) icon = '📦';

      item.innerHTML = `
        <div class="app-icon">${icon}</div>
        <div class="app-name" title="${escapeHtml(app.name)}">${escapeHtml(app.name)}</div>
      `;

      item.addEventListener('click', () => launchAppOnPC(app.path, app.name));
      appsList.appendChild(item);
    });
  } catch (err) {
    appsList.innerHTML = `<div class="files-empty">⚠️ Failed to load apps: ${err.message}</div>`;
  }
}

async function launchAppOnPC(appPathOrName, displayName) {
  if (navigator.vibrate) navigator.vibrate(40);
  showToast(`🚀 Launching ${displayName || appPathOrName}...`);
  try {
    const res = await fetch(getApiUrl('/api/launch'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: appPathOrName })
    });
    const data = await res.json();
    if (data.status === 'success') {
      showToast(`✅ ${displayName || appPathOrName} launched!`);
      modalLaunchers.classList.add('hidden');
    } else {
      showToast(`⚠️ Could not launch: ${data.message}`, true);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  }
}

// Custom App Launcher Input
btnCustomLaunch.addEventListener('click', triggerCustomLaunch);
customAppInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') triggerCustomLaunch();
});

async function triggerCustomLaunch() {
  const val = customAppInput.value.trim();
  if (!val) return;
  customAppInput.value = '';
  launchAppOnPC(val, val);
}

document.querySelectorAll('[data-launch]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const app = btn.getAttribute('data-launch');
    launchAppOnPC(app, app);
  });
});

document.querySelectorAll('[data-media]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.getAttribute('data-media');
    sendControl({ type: 'media', action: action });
    if (navigator.vibrate) navigator.vibrate(30);
  });
});

document.querySelectorAll('[data-power]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.getAttribute('data-power');
    if (confirm(`Are you sure you want to trigger '${action.toUpperCase()}' on PC?`)) {
      sendControl({ type: 'power', action: action });
      modalLaunchers.classList.add('hidden');
    }
  });
});

// ==============================================================================
// FILE SEARCH & EXPLORER
// ==============================================================================

let searchDebounceTimer = null;
let currentFileFilter = '';

btnOpenFiles.addEventListener('click', () => {
  modalFiles.classList.remove('hidden');
  fileSearchInput.focus();
  if (!fileSearchInput.value) {
    performFileSearch('');
  }
});

btnCloseFiles.addEventListener('click', () => modalFiles.classList.add('hidden'));
modalFiles.addEventListener('click', (e) => {
  if (e.target === modalFiles) modalFiles.classList.add('hidden');
});

// Filter Chips
document.querySelectorAll('.filter-chips .chip-btn').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chips .chip-btn').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    currentFileFilter = chip.getAttribute('data-filter') || '';
    performFileSearch(fileSearchInput.value.trim());
  });
});

// Search Input Debounce
fileSearchInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    performFileSearch(fileSearchInput.value.trim());
  }, 250);
});

async function performFileSearch(query) {
  filesResults.innerHTML = '<div class="files-empty">Searching files on PC...</div>';
  try {
    const url = getApiUrl(`/api/files/search?q=${encodeURIComponent(query)}&filter=${encodeURIComponent(currentFileFilter)}`);
    const res = await fetch(url);
    const data = await res.json();
    const results = data.results || [];

    if (results.length === 0) {
      filesResults.innerHTML = `<div class="files-empty">No files found matching "${escapeHtml(query)}"</div>`;
      return;
    }

    filesResults.innerHTML = '';
    results.forEach((file) => {
      const card = document.createElement('div');
      card.className = 'file-item';
      
      let icon = '📄';
      const ext = (file.ext || '').toLowerCase();
      if (['pdf'].includes(ext)) icon = '📕';
      else if (['doc', 'docx', 'txt', 'md'].includes(ext)) icon = '📝';
      else if (['xls', 'xlsx', 'csv'].includes(ext)) icon = '📊';
      else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) icon = '🖼️';
      else if (['mp4', 'mkv', 'avi', 'mov'].includes(ext)) icon = '🎬';
      else if (['mp3', 'wav', 'flac'].includes(ext)) icon = '🎵';
      else if (['py', 'js', 'html', 'css', 'json', 'ts', 'ps1', 'bat'].includes(ext)) icon = '💻';
      else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) icon = '📦';
      else if (['exe', 'msi'].includes(ext)) icon = '⚡';

      card.innerHTML = `
        <div class="file-icon">${icon}</div>
        <div class="file-details">
          <div class="file-name">${escapeHtml(file.name)}</div>
          <div class="file-meta"><span>${file.size}</span> • <span>${file.mtime}</span></div>
          <div class="file-path">${escapeHtml(file.path)}</div>
        </div>
      `;

      card.addEventListener('click', () => openFileOnPC(file.path, file.name));
      filesResults.appendChild(card);
    });
  } catch (err) {
    filesResults.innerHTML = `<div class="files-empty">⚠️ Search failed: ${err.message}</div>`;
  }
}

async function openFileOnPC(filePath, fileName) {
  if (navigator.vibrate) navigator.vibrate(50);
  showToast(`📂 Opening ${fileName || filePath}...`);
  try {
    const res = await fetch(getApiUrl('/api/files/open'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath })
    });
    const data = await res.json();
    if (data.status === 'success') {
      showToast(`✅ Opened ${fileName || filePath}`);
      modalFiles.classList.add('hidden');
    } else {
      showToast(`⚠️ Error: ${data.message}`, true);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  }
}

// ==============================================================================
// RUNNING WINDOWS & TASK SWITCHER
// ==============================================================================

btnOpenWindows.addEventListener('click', () => {
  modalWindows.classList.remove('hidden');
  fetchWindowsList();
});

btnCloseWindows.addEventListener('click', () => modalWindows.classList.add('hidden'));
btnRefreshWindows.addEventListener('click', fetchWindowsList);
modalWindows.addEventListener('click', (e) => {
  if (e.target === modalWindows) modalWindows.classList.add('hidden');
});

async function fetchWindowsList() {
  windowsList.innerHTML = '<div class="files-empty">Scanning open applications...</div>';
  try {
    const res = await fetch(getApiUrl('/api/windows'));
    const data = await res.json();
    const wins = data.windows || [];

    if (wins.length === 0) {
      windowsList.innerHTML = '<div class="files-empty">No open application windows found.</div>';
      return;
    }

    windowsList.innerHTML = '';
    wins.forEach((w) => {
      const item = document.createElement('div');
      item.className = 'window-item';

      let icon = '🪟';
      const titleLower = w.title.toLowerCase();
      if (titleLower.includes('chrome') || titleLower.includes('edge') || titleLower.includes('browser')) icon = '🌐';
      else if (titleLower.includes('vlc') || titleLower.includes('media player') || titleLower.includes('video')) icon = '🎬';
      else if (titleLower.includes('code') || titleLower.includes('studio')) icon = '💻';
      else if (titleLower.includes('terminal') || titleLower.includes('powershell') || titleLower.includes('cmd')) icon = '⬛';
      else if (titleLower.includes('task manager')) icon = '📊';
      else if (titleLower.includes('notepad')) icon = '📝';
      else if (titleLower.includes('telegram')) icon = '✈️';
      else if (titleLower.includes('wechat')) icon = '💬';
      else if (titleLower.includes('antigravity')) icon = '⚡';

      item.innerHTML = `
        <div class="win-info">
          <span class="win-icon">${icon}</span>
          <span class="win-title" title="${escapeHtml(w.title)}">${escapeHtml(w.title)}</span>
        </div>
        <button class="win-btn-close" title="Close Window">✕</button>
      `;

      item.querySelector('.win-info').addEventListener('click', () => {
        focusWindowOnPC(w.hwnd, w.title);
      });

      item.querySelector('.win-btn-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeWindowOnPC(w.hwnd, item);
      });

      windowsList.appendChild(item);
    });
  } catch (err) {
    windowsList.innerHTML = `<div class="files-empty">⚠️ Failed to list windows: ${err.message}</div>`;
  }
}

async function focusWindowOnPC(hwnd, title) {
  if (navigator.vibrate) navigator.vibrate(40);
  showToast(`🪟 Switched to ${title || 'window'}`);
  try {
    await fetch(getApiUrl('/api/windows/focus'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hwnd: hwnd })
    });
    modalWindows.classList.add('hidden');
  } catch (err) {
    console.debug('Error focusing window:', err);
  }
}

async function closeWindowOnPC(hwnd, itemEl) {
  if (navigator.vibrate) navigator.vibrate(30);
  showToast('❌ Closing window...');
  try {
    await fetch(getApiUrl('/api/windows/close'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hwnd: hwnd })
    });
    itemEl.style.opacity = '0.3';
    setTimeout(fetchWindowsList, 400);
  } catch (err) {
    console.debug('Error closing window:', err);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str;
  return div.innerHTML;
}

// ==============================================================================
// SETTINGS MODAL
// ==============================================================================

btnOpenSettings.addEventListener('click', async () => {
  modalSettings.classList.remove('hidden');
  try {
    const res = await fetch(getApiUrl('/api/info'));
    const info = await res.json();
    document.getElementById('host-details').innerText =
      `Host: ${info.hostname}\nOS: ${info.os}\nResolution: ${info.screen.width}x${info.screen.height}\nViewers: ${info.active_viewers}\nBackend: ${backendUrl || 'Direct'}`;
  } catch (err) {
    document.getElementById('host-details').innerText = 'Host info unavailable';
  }
});

btnCloseSettings.addEventListener('click', () => modalSettings.classList.add('hidden'));
modalSettings.addEventListener('click', (e) => {
  if (e.target === modalSettings) modalSettings.classList.add('hidden');
});

// Initialize
connectWebSockets();
