/**
 * VapePass Assistant — embeddable chatbot loader.
 * Loads the same Next.js chat UI used on the marketing site inside a transparent iframe.
 *
 * Usage:
 *   <script src="https://api.example.com/widget.js" data-store-id="STORE_ID" async></script>
 *
 * Optional:
 *   data-skip-site-age="true"  — skip host-site age gate (dev/testing)
 *   data-client-url="https://..." — override embed app URL (defaults to injected CLIENT_URL)
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

  // Injected at serve time by the API (see app.js GET /widget.js).
  var CLIENT_URL = script.getAttribute('data-client-url') || '__VAPEPASS_CLIENT_URL__';
  if (!CLIENT_URL || CLIENT_URL.indexOf('__VAPEPASS_') === 0) {
    CLIENT_URL = 'http://localhost:3000';
  }
  CLIENT_URL = String(CLIENT_URL).replace(/\/+$/, '');

  var AGE_GATE_KEY = 'vapepass_site_age_verified';

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
      if (
        document.cookie.match(
          /(?:^|;\s*)(?:age_verified|ageVerified|vapepass_site_age_verified)=true(?:;|$)/i
        )
      ) {
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

  function mountIframe() {
    if (document.getElementById('vapepass-assistant-host')) return;

    var host = document.createElement('div');
    host.id = 'vapepass-assistant-host';
    host.setAttribute('data-vapepass-assistant', 'true');
    host.style.cssText =
      'all:initial;position:fixed;z-index:2147483646;bottom:0;right:0;width:88px;height:88px;border:0;margin:0;padding:0;overflow:hidden;background:transparent;pointer-events:none;';

    var iframe = document.createElement('iframe');
    iframe.title = 'VapePass AI Shopping Assistant';
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.setAttribute('loading', 'eager');
    iframe.style.cssText =
      'border:0;width:100%;height:100%;background:transparent;color-scheme:normal;pointer-events:auto;display:block;';
    iframe.setAttribute('aria-label', 'VapePass AI Shopping Assistant');

    var parentOrigin = window.location.origin;
    var src =
      CLIENT_URL +
      '/embed?storeId=' +
      encodeURIComponent(storeId) +
      '&parentOrigin=' +
      encodeURIComponent(parentOrigin);

    iframe.src = src;
    host.appendChild(iframe);
    document.body.appendChild(host);

    function applySize(width, height) {
      var w = Math.max(72, Math.min(Number(width) || 88, window.innerWidth || 420));
      var h = Math.max(72, Math.min(Number(height) || 88, window.innerHeight || 720));
      host.style.width = w + 'px';
      host.style.height = h + 'px';
    }

    window.addEventListener('message', function (event) {
      if (!event || !event.data || event.data.source !== 'vapepass-assistant') return;
      if (CLIENT_URL) {
        try {
          if (event.origin !== new URL(CLIENT_URL).origin) return;
        } catch (e) {
          return;
        }
      }
      if (event.data.type === 'resize') {
        applySize(event.data.width, event.data.height);
      }
    });
  }

  waitForSiteAgeGate().then(mountIframe);
})();
