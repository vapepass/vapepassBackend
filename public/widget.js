/**
 * VapePass Assistant — embeddable chatbot widget (Shadow DOM).
 * Usage:
 *   <script src="https://api.example.com/widget.js" data-store-id="STORE_ID" async></script>
 */
(function () {
  'use strict';

  if (window.__VAPEPASS_ASSISTANT_LOADED__) return;
  window.__VAPEPASS_ASSISTANT_LOADED__ = true;

  var script =
    document.currentScript ||
    document.querySelector('script[data-store-id][src*="widget.js"]');

  if (!script) {
    console.error('[VapePass Assistant] Missing embed script element');
    return;
  }

  var storeId = script.getAttribute('data-store-id');
  if (!storeId) {
    console.error('[VapePass Assistant] data-store-id is required');
    return;
  }

  var apiBase = script.getAttribute('data-api-url');
  if (!apiBase) {
    try {
      apiBase = new URL(script.src).origin + '/api/v1';
    } catch (e) {
      apiBase = '/api/v1';
    }
  }
  apiBase = apiBase.replace(/\/+$/, '');

  var SESSION_KEY = 'vapepass_assistant_session_' + storeId;
  var AGE_GATE_KEY = 'vapepass_site_age_verified';

  var state = {
    config: null,
    sessionKey: null,
    messages: [],
    ageVerified: false,
    locked: false,
    open: false,
    minimized: false,
    sending: false,
    booting: true,
    showRestart: false,
  };

  /**
   * Step 1 — Website age gate (mandatory).
   * Widget stays completely hidden until the host site age verification is cleared.
   * Stores should set one of these after their age gate succeeds:
   *   localStorage.vapepass_site_age_verified = "true"
   *   localStorage.age_verified = "true"
   *   cookie age_verified=true
   * Dev/testing only: data-skip-site-age="true" on the embed script.
   */
  function siteAgeCleared() {
    if (script.getAttribute('data-skip-site-age') === 'true') return true;
    if (script.getAttribute('data-age-verified') === 'true') return true;

    try {
      if (localStorage.getItem(AGE_GATE_KEY) === 'true') return true;
      if (localStorage.getItem('age_verified') === 'true') return true;
      if (localStorage.getItem('ageVerified') === 'true') return true;
      if (localStorage.getItem('isAgeVerified') === 'true') return true;
      if (sessionStorage.getItem(AGE_GATE_KEY) === 'true') return true;
      if (sessionStorage.getItem('age_verified') === 'true') return true;
      if (document.cookie.match(/(?:^|;\s*)(?:age_verified|ageVerified|vapepass_site_age_verified)=true(?:;|$)/i)) {
        return true;
      }
      // Common Shopify age-gate apps
      if (document.cookie.match(/(?:^|;\s*)age_gate_passed=1(?:;|$)/i)) return true;
    } catch (e) {
      /* ignore */
    }

    return false;
  }

  function waitForSiteAgeGate() {
    return new Promise(function (resolve) {
      if (siteAgeCleared()) {
        resolve();
        return;
      }

      console.info('[VapePass Assistant] Waiting for website age verification…');

      var poll = setInterval(function () {
        if (siteAgeCleared()) {
          clearInterval(poll);
          window.removeEventListener('storage', onStorage);
          resolve();
        }
      }, 500);

      function onStorage() {
        if (siteAgeCleared()) {
          clearInterval(poll);
          window.removeEventListener('storage', onStorage);
          resolve();
        }
      }

      window.addEventListener('storage', onStorage);
    });
  }

  function api(path, options) {
    options = options || {};
    return fetch(apiBase + path, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || data.success === false) {
          throw new Error(data.message || 'Request failed');
        }
        return data;
      });
    });
  }

  function getStoredSessionKey() {
    try {
      return sessionStorage.getItem(SESSION_KEY);
    } catch (e) {
      return null;
    }
  }

  function setStoredSessionKey(key) {
    try {
      sessionStorage.setItem(SESSION_KEY, key);
    } catch (e) {
      /* ignore */
    }
  }

  // Host element + Shadow DOM (styles isolated from host page)
  var host = document.createElement('div');
  host.id = 'vapepass-assistant-host';
  host.setAttribute('data-vapepass-assistant', 'true');
  document.body.appendChild(host);

  var shadow = host.attachShadow({ mode: 'open' });

  var style = document.createElement('style');
  style.textContent = [
    ':host { all: initial; }',
    '* { box-sizing: border-box; font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }',
    '.vp-root { position: fixed; z-index: 2147483000; right: 20px; bottom: 20px; }',
    '.vp-hidden { display: none !important; }',
    '.vp-bubble {',
    '  width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer;',
    '  background: #8B5CF6; color: #fff;',
    '  box-shadow: 0 8px 24px rgba(124,58,237,0.35), 0 4px 8px rgba(76,29,149,0.2);',
    '  display: flex; align-items: center; justify-content: center;',
    '  transition: transform .15s ease;',
    '}',
    '.vp-bubble:hover { transform: scale(1.05); }',
    '.vp-bubble svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2; }',
    '.vp-panel {',
    '  position: absolute; right: 0; bottom: 72px; width: min(380px, calc(100vw - 32px));',
    '  height: min(520px, calc(100vh - 120px)); background: #fff; border-radius: 24px;',
    '  box-shadow: 0 20px 50px rgba(15,23,42,0.18), 0 8px 16px rgba(15,23,42,0.06);',
    '  display: flex; flex-direction: column; overflow: hidden; border: 1px solid #d1d5db;',
    '}',
    '.vp-header {',
    '  padding: 14px 16px; background: #7C3AED; color: #fff;',
    '  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-shrink: 0;',
    '}',
    '.vp-header-left { display: flex; align-items: center; gap: 12px; min-width: 0; }',
    '.vp-header-icon {',
    '  width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,0.2);',
    '  display: flex; align-items: center; justify-content: center; flex-shrink: 0;',
    '}',
    '.vp-header-icon svg { width: 17px; height: 17px; stroke: #fff; fill: none; stroke-width: 2; }',
    '.vp-header h2 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.25; }',
    '.vp-header p { margin: 2px 0 0; font-size: 12px; color: #DDD6FE; line-height: 1.25; }',
    '.vp-header-meta { margin: 4px 0 0; font-size: 11px; color: rgba(255,255,255,0.88); line-height: 1.35; }',
    '.vp-loading {',
    '  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;',
    '  gap: 14px; padding: 28px 24px; text-align: center; background: #fff;',
    '}',
    '.vp-loading h3 { margin: 0; font-size: 15px; font-weight: 700; color: #111827; }',
    '.vp-loading p { margin: 0; font-size: 13px; color: #6B7280; line-height: 1.5; }',
    '.vp-progress {',
    '  width: min(220px, 80%); height: 6px; border-radius: 9999px; background: #E5E7EB; overflow: hidden;',
    '}',
    '.vp-progress > span {',
    '  display: block; height: 100%; width: 30%; border-radius: 9999px; background: #8B5CF6;',
    '  animation: vp-progress 1.4s ease-in-out infinite;',
    '}',
    '@keyframes vp-progress {',
    '  0% { transform: translateX(-120%); }',
    '  100% { transform: translateX(320%); }',
    '}',
    '.vp-restart {',
    '  padding: 0 16px 12px; background: #fff; flex-shrink: 0;',
    '}',
    '.vp-restart button {',
    '  width: 100%; height: 40px; border: 1px solid #E5E7EB; border-radius: 9999px;',
    '  background: #F9FAFB; color: #374151; font-size: 13px; font-weight: 600; cursor: pointer;',
    '}',
    '.vp-restart button:hover { background: #F3F4F6; }',
    '.vp-options { padding: 4px 16px 12px; display: flex; flex-wrap: wrap; gap: 8px; background: #fff; flex-shrink: 0; }',
    '.vp-option-chip { border: 1px solid #E5E7EB; background: #F9FAFB; color: #374151; border-radius: 999px; padding: 8px 12px; font-size: 12px; font-weight: 600; cursor: pointer; }',
    '.vp-option-chip:hover { background: #F3F4F6; }',
    '.vp-option-chip:disabled { opacity: .5; cursor: not-allowed; }',
    '.vp-product-card {',
    '  margin: 4px 0 10px; padding: 12px; border: 1px solid #E5E7EB; border-radius: 16px;',
    '  background: linear-gradient(180deg, #fff, #faf9ff); max-width: 92%;',
    '}',
    '.vp-product-card h4 { margin: 0; font-size: 14px; font-weight: 650; color: #111827; }',
    '.vp-product-card p { margin: 6px 0 0; font-size: 12px; color: #4B5563; line-height: 1.45; }',
    '.vp-view-product {',
    '  display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 10px;',
    '  height: 38px; border-radius: 9999px; background: #8B5CF6; color: #fff; text-decoration: none;',
    '  font-size: 13px; font-weight: 600; transition: background .15s ease, transform .15s ease;',
    '}',
    '.vp-view-product:hover { background: #7C3AED; transform: translateY(-1px); }',
    '.vp-view-product:active { transform: translateY(0); }',
    '.vp-header-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }',
    '.vp-icon-btn {',
    '  background: transparent; border: none; color: rgba(255,255,255,.9);',
    '  width: 32px; height: 32px; cursor: pointer; display: flex; align-items: center; justify-content: center;',
    '  padding: 0; transition: color .15s ease;',
    '}',
    '.vp-icon-btn:hover { color: #fff; }',
    '.vp-icon-btn svg { width: 17px; height: 17px; stroke: currentColor; fill: none; stroke-width: 2; }',
    '.vp-warning {',
    '  background: #FFFBEB; color: #92400E; font-size: 12px; font-weight: 500;',
    '  line-height: 1.4; padding: 10px 16px; border-top: 1px solid #FDE68A; border-bottom: 1px solid #FDE68A;',
    '  display: flex; align-items: flex-start; gap: 8px; flex-shrink: 0;',
    '}',
    '.vp-warning svg { width: 14px; height: 14px; stroke: #F59E0B; fill: none; flex-shrink: 0; stroke-width: 2; }',
    '.vp-messages {',
    '  flex: 1; overflow-y: auto; padding: 16px; background: #fff;',
    '  display: flex; flex-direction: column; gap: 12px;',
    '  scrollbar-width: thin; scrollbar-color: #d1d5db transparent;',
    '}',
    '.vp-messages::-webkit-scrollbar { width: 6px; }',
    '.vp-messages::-webkit-scrollbar-track { background: transparent; }',
    '.vp-messages::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 9999px; }',
    '.vp-msg-wrap { display: flex; }',
    '.vp-msg-wrap.user { justify-content: flex-end; }',
    '.vp-msg-wrap.bot { justify-content: flex-start; }',
    '.vp-msg { max-width: 88%; padding: 14px 16px; border-radius: 16px 16px 16px 4px; font-size: 13px; line-height: 1.6; }',
    '.vp-msg.bot { background: #F3F4F6; color: #374151; }',
    '.vp-msg.user { background: #8B5CF6; color: #fff; border-radius: 16px 16px 4px 16px; }',
    '.vp-msg.locked { background: #FEF2F2; color: #DC2626; border: 1px solid #FECACA; }',
    '.vp-typing { display: flex; gap: 5px; align-items: center; height: 18px; }',
    '.vp-typing span {',
    '  width: 7px; height: 7px; border-radius: 50%; background: #9CA3AF;',
    '  animation: vp-bounce 1.2s infinite ease-in-out;',
    '}',
    '.vp-typing span:nth-child(2) { animation-delay: .15s; }',
    '.vp-typing span:nth-child(3) { animation-delay: .3s; }',
    '@keyframes vp-bounce {',
    '  0%, 60%, 100% { transform: translateY(0); opacity: .4; }',
    '  30% { transform: translateY(-4px); opacity: 1; }',
    '}',
    '.vp-age-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 8px 16px 20px; flex-shrink: 0; background: #fff; }',
    '.vp-age-yes {',
    '  height: 44px; border: none; border-radius: 9999px;',
    '  background: #7C3AED; color: #fff; font-size: 14px; font-weight: 700; cursor: pointer;',
    '  transition: background .15s ease, transform .15s ease;',
    '}',
    '.vp-age-yes:hover:not(:disabled) { background: #6D28D9; }',
    '.vp-age-no {',
    '  height: 44px; border: none; border-radius: 9999px;',
    '  background: #F3F4F6; color: #4B5563; font-size: 14px; font-weight: 700; cursor: pointer;',
    '  transition: background .15s ease, transform .15s ease;',
    '}',
    '.vp-age-no:hover:not(:disabled) { background: #E5E7EB; }',
    '.vp-age-yes:disabled, .vp-age-no:disabled { opacity: .5; cursor: not-allowed; }',
    '.vp-composer { display: flex; gap: 8px; padding: 4px 16px 16px; background: #fff; flex-shrink: 0; }',
    '.vp-composer input {',
    '  flex: 1; border: 1px solid #E5E7EB; border-radius: 9999px; padding: 0 16px; height: 44px;',
    '  font-size: 13px; outline: none; color: #1F2937;',
    '}',
    '.vp-composer input::placeholder { color: #9CA3AF; }',
    '.vp-composer input:focus { border-color: #8B5CF6; box-shadow: 0 0 0 3px rgba(139,92,246,.15); }',
    '.vp-composer button {',
    '  border: none; border-radius: 9999px; background: #8B5CF6; color: #fff;',
    '  width: 44px; height: 44px; font-weight: 600; cursor: pointer; flex-shrink: 0;',
    '  display: flex; align-items: center; justify-content: center;',
    '}',
    '.vp-composer button:disabled { opacity: .5; cursor: not-allowed; }',
    '.vp-composer button svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 2; }',
    '.vp-status { padding: 8px 16px; font-size: 11px; color: #9CA3AF; background: #fff; border-top: 1px solid #F3F4F6; flex-shrink: 0; }',
    '.vp-minimized {',
    '  position: absolute; right: 0; bottom: 72px; width: min(380px, calc(100vw - 32px));',
    '  padding: 14px 16px; background: #8B5CF6; border-radius: 24px; color: #fff;',
    '  box-shadow: 0 20px 50px rgba(15,23,42,0.18); display: flex; align-items: center; justify-content: space-between; gap: 12px;',
    '}',
    '.vp-minimized-restore { display: flex; align-items: center; gap: 12px; background: none; border: none; color: inherit; cursor: pointer; padding: 0; min-width: 0; flex: 1; text-align: left; }',
    '@media (max-width: 480px) {',
    '  .vp-root { right: 12px; bottom: 12px; }',
    '  .vp-panel { width: calc(100vw - 24px); height: min(70vh, 520px); }',
    '  .vp-minimized { width: calc(100vw - 24px); }',
    '}',
  ].join('\n');

  shadow.appendChild(style);

  var root = document.createElement('div');
  root.className = 'vp-root vp-hidden';
  root.innerHTML = [
    '<div class="vp-minimized vp-hidden" part="minimized">',
    '  <button type="button" class="vp-minimized-restore" aria-label="Restore chat">',
    '    <div class="vp-header-icon">',
    '      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M5 19l1 3 3-1-1-3-3 1z"/><path d="M19 13l1 3 3-1-1-3-3 1z"/></svg>',
    '    </div>',
    '    <div>',
    '      <h2>AI Flavor Sommelier</h2>',
    '      <p>Powered by VapePass</p>',
    '    </div>',
    '  </button>',
    '  <button type="button" class="vp-icon-btn vp-minimized-close" aria-label="Close chat">',
    '    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    '  </button>',
    '</div>',
    '<div class="vp-panel vp-hidden" part="panel">',
    '  <div class="vp-header">',
    '    <div class="vp-header-left">',
    '      <div class="vp-header-icon">',
    '        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M5 19l1 3 3-1-1-3-3 1z"/><path d="M19 13l1 3 3-1-1-3-3 1z"/></svg>',
    '      </div>',
    '      <div>',
    '        <h2>AI Flavor Sommelier</h2>',
    '        <p class="vp-powered">Powered by VapePass</p>',
    '        <div class="vp-header-meta">',
    '          <div class="vp-region"></div>',
    '          <div class="vp-min-age"></div>',
    '        </div>',
    '      </div>',
    '    </div>',
    '    <div class="vp-header-actions">',
    '      <button type="button" class="vp-icon-btn vp-minimize" aria-label="Minimize chat">',
    '        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14h6v6M14 4h6v6M20 10V4h-6M10 20H4v-6"/></svg>',
    '      </button>',
    '      <button type="button" class="vp-icon-btn vp-close" aria-label="Close chat">',
    '        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    '      </button>',
    '    </div>',
    '  </div>',
    '  <div class="vp-warning" role="note" aria-live="polite">',
    '    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>',
    '    <span class="vp-warning-text"></span>',
    '  </div>',
    '  <div class="vp-loading">',
    '    <h3 class="vp-loading-title">Syncing Inventory...</h3>',
    '    <p class="vp-loading-copy">Please wait...</p>',
    '    <div class="vp-progress" aria-hidden="true"><span></span></div>',
    '  </div>',
    '  <div class="vp-messages vp-hidden" role="log" aria-live="polite" aria-relevant="additions"></div>',
    '  <div class="vp-age-actions vp-hidden">',
    '    <button type="button" class="vp-age-yes"></button>',
    '    <button type="button" class="vp-age-no">No</button>',
    '  </div>',
    '  <div class="vp-options vp-hidden"></div>',
    '  <div class="vp-restart vp-hidden">',
    '    <button type="button" class="vp-restart-btn">Get Another Recommendation</button>',
    '  </div>',
    '  <div class="vp-composer-wrap vp-hidden">',
    '    <div class="vp-status"></div>',
    '    <form class="vp-composer">',
    '      <input type="text" placeholder="Type a message…" autocomplete="off" maxlength="2000" />',
    '      <button type="submit" aria-label="Send message">',
    '        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
    '      </button>',
    '    </form>',
    '  </div>',
    '</div>',
    '<button type="button" class="vp-bubble" aria-label="Open AI Flavor Sommelier">',
    '  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M5 19l1 3 3-1-1-3-3 1z"/><path d="M19 13l1 3 3-1-1-3-3 1z"/></svg>',
    '</button>',
  ].join('');

  shadow.appendChild(root);

  var panel = root.querySelector('.vp-panel');
  var minimizedBar = root.querySelector('.vp-minimized');
  var bubble = root.querySelector('.vp-bubble');
  var closeBtn = root.querySelector('.vp-close');
  var minimizeBtn = root.querySelector('.vp-minimize');
  var minimizedCloseBtn = root.querySelector('.vp-minimized-close');
  var minimizedRestoreBtn = root.querySelector('.vp-minimized-restore');
  var messagesEl = root.querySelector('.vp-messages');
  var warningEl = root.querySelector('.vp-warning-text');
  var statusEl = root.querySelector('.vp-status');
  var ageActionsEl = root.querySelector('.vp-age-actions');
  var composerWrapEl = root.querySelector('.vp-composer-wrap');
  var loadingEl = root.querySelector('.vp-loading');
  var loadingTitleEl = root.querySelector('.vp-loading-title');
  var loadingCopyEl = root.querySelector('.vp-loading-copy');
  var regionEl = root.querySelector('.vp-region');
  var minAgeEl = root.querySelector('.vp-min-age');
  var restartEl = root.querySelector('.vp-restart');
  var restartBtn = root.querySelector('.vp-restart-btn');
  var optionsEl = root.querySelector('.vp-options');
  var ageYesBtn = root.querySelector('.vp-age-yes');
  var ageNoBtn = root.querySelector('.vp-age-no');
  var form = root.querySelector('.vp-composer');
  var input = form.querySelector('input');
  var sendBtn = form.querySelector('button');

  state.currentOptions = [];
  state.replyType = null;
  state.recommendedProducts = [];

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function setLoadingStep(title, copy) {
    if (loadingTitleEl) loadingTitleEl.textContent = title;
    if (loadingCopyEl) loadingCopyEl.textContent = copy;
  }

  function setBooting(booting) {
    state.booting = booting;
    if (loadingEl) loadingEl.classList.toggle('vp-hidden', !booting);
    messagesEl.classList.toggle('vp-hidden', booting);
    if (booting) {
      ageActionsEl.classList.add('vp-hidden');
      composerWrapEl.classList.add('vp-hidden');
      restartEl.classList.add('vp-hidden');
      if (optionsEl) optionsEl.classList.add('vp-hidden');
    }
  }

  function looksLikeRecommendation(text) {
    return /\b(recommend|try|suggest|option|flavor|available|inventory|might enjoy|check out)\b/i.test(
      String(text || '')
    );
  }

  function updateRestartVisibility() {
    var lastAssistant = null;
    for (var i = state.messages.length - 1; i >= 0; i -= 1) {
      if (state.messages[i].role === 'assistant') {
        lastAssistant = state.messages[i].content;
        break;
      }
    }
    state.showRestart =
      state.ageVerified &&
      !state.locked &&
      !state.booting &&
      !state.sending &&
      state.replyType !== 'options' &&
      (state.replyType === 'recommendation' || looksLikeRecommendation(lastAssistant));
    restartEl.classList.toggle('vp-hidden', !state.showRestart);
  }

  function applyBrand(color) {
    if (!color) return;
    bubble.style.background = color;
    root.querySelector('.vp-header').style.background = color;
    minimizedBar.style.background = color;
    sendBtn.style.background = color;
    ageYesBtn.style.background = color;
  }

  function renderMessages() {
    messagesEl.innerHTML = '';
    state.messages.forEach(function (msg, index) {
      var wrap = document.createElement('div');
      wrap.className = 'vp-msg-wrap ' + (msg.role === 'user' ? 'user' : 'bot');
      var el = document.createElement('div');
      el.className =
        'vp-msg ' +
        (msg.role === 'user' ? 'user' : 'bot') +
        (state.locked && msg.role === 'assistant' ? ' locked' : '');
      el.textContent = msg.content;
      wrap.appendChild(el);
      messagesEl.appendChild(wrap);

      // Attach View Product CTA after the latest recommendation reply
      var isLast = index === state.messages.length - 1;
      if (
        isLast &&
        msg.role === 'assistant' &&
        Array.isArray(state.recommendedProducts) &&
        state.recommendedProducts.length &&
        (state.replyType === 'recommendation' || state.recommendedProducts[0]?.productUrl)
      ) {
        state.recommendedProducts.forEach(function (product) {
          if (!product) return;
          var card = document.createElement('div');
          card.className = 'vp-product-card';
          var title = document.createElement('h4');
          title.textContent = product.name || 'Recommended product';
          card.appendChild(title);
          if (product.description) {
            var desc = document.createElement('p');
            desc.textContent = String(product.description).slice(0, 220);
            card.appendChild(desc);
          }
          if (product.productUrl || product.originalProductUrl) {
            var link = document.createElement('a');
            link.className = 'vp-view-product';
            link.href = product.productUrl || product.originalProductUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = 'View Product';
            card.appendChild(link);
          }
          messagesEl.appendChild(card);
        });
      }
    });

    if (state.sending) {
      var typingWrap = document.createElement('div');
      typingWrap.className = 'vp-msg-wrap bot';
      var typingBubble = document.createElement('div');
      typingBubble.className = 'vp-msg bot';
      typingBubble.innerHTML = '<div class="vp-typing"><span></span><span></span><span></span></div>';
      typingWrap.appendChild(typingBubble);
      messagesEl.appendChild(typingWrap);
    }

    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setLockedUi() {
    if (state.booting) return;

    var showAgeButtons = !state.ageVerified && !state.locked;
    ageActionsEl.classList.toggle('vp-hidden', !showAgeButtons);
    composerWrapEl.classList.toggle('vp-hidden', showAgeButtons);

    var showOptions =
      !showAgeButtons &&
      !state.locked &&
      !state.sending &&
      Array.isArray(state.currentOptions) &&
      state.currentOptions.length > 0 &&
      state.replyType === 'options';

    if (optionsEl) {
      optionsEl.classList.toggle('vp-hidden', !showOptions);
      if (showOptions) {
        optionsEl.innerHTML = '';
        state.currentOptions.forEach(function (opt) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'vp-option-chip';
          btn.textContent = (opt.emoji ? opt.emoji + ' ' : '') + (opt.label || opt.value || '');
          btn.disabled = state.sending;
          btn.addEventListener('click', function () {
            sendMessage('::option::' + opt.id);
          });
          optionsEl.appendChild(btn);
        });
      }
    }

    input.disabled = state.locked || state.sending;
    sendBtn.disabled = state.locked || state.sending;
    ageYesBtn.disabled = state.sending;
    ageNoBtn.disabled = state.sending;

    statusEl.textContent = state.locked
      ? 'Conversation locked'
      : state.ageVerified
        ? 'Recommendations from this store only'
        : 'Age verification required';

    updateRestartVisibility();
  }

  function setOpen(open) {
    state.open = open;
    if (!open) {
      state.minimized = false;
      panel.classList.add('vp-hidden');
      minimizedBar.classList.add('vp-hidden');
    } else if (state.minimized) {
      panel.classList.add('vp-hidden');
      minimizedBar.classList.remove('vp-hidden');
    } else {
      panel.classList.remove('vp-hidden');
      minimizedBar.classList.add('vp-hidden');
      input.focus();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function setMinimized(minimized) {
    state.minimized = minimized;
    if (!state.open) return;
    panel.classList.toggle('vp-hidden', minimized);
    minimizedBar.classList.toggle('vp-hidden', !minimized);
    if (!minimized) {
      input.focus();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  async function bootstrap() {
    // Step 1: do not load chatbot UI until website age gate is passed
    await waitForSiteAgeGate();

    try {
      root.classList.remove('vp-hidden');
      setBooting(true);
      setLoadingStep('Syncing Inventory...', 'Please wait...');
      setOpen(true);

      await sleep(700);
      setLoadingStep('Fetching Products...', 'Loading your store catalog...');

      var configRes = await api('/assistant/widget/' + encodeURIComponent(storeId));
      state.config = configRes.data.config;

      if (!state.config.enabled) {
        console.info(
          '[VapePass Assistant] Not enabled:',
          state.config.disabledReason || 'unknown'
        );
        root.classList.add('vp-hidden');
        return;
      }

      warningEl.textContent = state.config.healthWarning;
      applyBrand(state.config.brandColor);
      if (regionEl) regionEl.textContent = state.config.regionLabel || '';
      if (minAgeEl) {
        minAgeEl.textContent =
          state.config.minimumAgeLabel ||
          (state.config.legalAge ? 'Minimum Age: ' + state.config.legalAge + '+' : '');
      }

      if (state.config.ageYesLabel) {
        ageYesBtn.textContent = state.config.ageYesLabel;
      }

      await sleep(500);
      setLoadingStep('Almost ready...', 'Starting your flavor assistant...');

      var existingKey = getStoredSessionKey();
      var sessionRes = await api('/assistant/session', {
        method: 'POST',
        body: { storeId: storeId, sessionKey: existingKey || undefined },
      });

      applySession(sessionRes.data.session);
      setBooting(false);
      setLockedUi();
      renderMessages();
    } catch (err) {
      console.error('[VapePass Assistant] Failed to initialize:', err.message);
      root.classList.add('vp-hidden');
    }
  }

  function applySession(session) {
    state.sessionKey = session.sessionKey;
    setStoredSessionKey(session.sessionKey);
    state.messages = session.messages || [];
    state.ageVerified = Boolean(session.ageVerified);
    state.locked = Boolean(session.locked);
    state.replyType = session.replyType || null;
    state.currentOptions = Array.isArray(session.options) ? session.options : [];
    state.recommendedProducts = Array.isArray(session.products) ? session.products : [];
    renderMessages();
    setLockedUi();
  }

  async function sendMessage(text) {
    if (!text || state.locked || state.sending) return;
    state.sending = true;
    state.currentOptions = [];
    setLockedUi();

    var display = text;
    if (text.indexOf('::option::') === 0) {
      display = 'Selected';
    }
    state.messages.push({ role: 'user', content: display });
    renderMessages();

    try {
      var res = await api('/assistant/chat', {
        method: 'POST',
        body: {
          storeId: storeId,
          sessionKey: state.sessionKey,
          message: text,
        },
      });
      applySession(res.data.session);
      if (res.data.session.locked && /^no\b/i.test(text)) {
        setTimeout(function () {
          setOpen(false);
        }, 1200);
      }
    } catch (err) {
      state.messages.push({
        role: 'assistant',
        content: 'Sorry, something went wrong. Please try again in a moment.',
      });
      renderMessages();
    } finally {
      state.sending = false;
      setLockedUi();
      renderMessages();
    }
  }

  bubble.addEventListener('click', function () {
    if (state.open) {
      setOpen(false);
    } else {
      state.minimized = false;
      setOpen(true);
    }
  });

  closeBtn.addEventListener('click', function () {
    setOpen(false);
  });

  minimizeBtn.addEventListener('click', function () {
    setMinimized(true);
  });

  minimizedRestoreBtn.addEventListener('click', function () {
    setMinimized(false);
  });

  minimizedCloseBtn.addEventListener('click', function () {
    setOpen(false);
  });

  ageYesBtn.addEventListener('click', function () {
    var label = (state.config && state.config.ageYesLabel) || ageYesBtn.textContent || 'Yes';
    sendMessage(label);
  });

  ageNoBtn.addEventListener('click', function () {
    sendMessage('No');
  });

  restartBtn.addEventListener('click', function () {
    sendMessage('I want another recommendation');
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendMessage(text);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
