/* Hordes Revival — page de statut publique.
   ───────────────────────────────────────────────────────────────
   Sonde, depuis le navigateur, la disponibilité des services publics :
     - API « live »   : GET {api}/health/live   (le process répond)
     - API « ready »  : GET {api}/health/ready   (la base est joignable)
     - Classement     : GET {api}/leaderboard?limit=1 (lecture métier réelle)
     - Site vitrine   : la page elle-même (servie = site up)

   Tout est en cross-origin (Pages → API Render). Les sondes posent
   `Access-Control-Allow-Origin: *` côté serveur. Aucun secret, aucune
   donnée sensible, aucune écriture. Vanilla JS, sans dépendance, à
   l'instar de main.js / game.js. */
(function () {
  'use strict';

  // Même clé localStorage que la landing et le terminal de jeu : on partage
  // l'URL de l'API entre les pages.
  var API_URL_KEY = 'hordes-revival:api-url';
  // Domaine de production cible (CNAME Render). Tant que le DNS n'est pas
  // posé, les sondes échoueront proprement (état « hors ligne »).
  var PROD_API = 'https://hordesrevival.com';
  var REFRESH_MS = 30000;
  var TIMEOUT_MS = 8000;

  function trimSlashes(s) {
    return String(s).replace(/\/+$/, '');
  }

  function detectApiUrl() {
    try {
      var stored = localStorage.getItem(API_URL_KEY);
      if (stored) return trimSlashes(stored);
    } catch (err) {
      /* localStorage indisponible : on continue avec la détection. */
    }
    var loc = window.location;
    if (loc.protocol === 'file:') return 'http://localhost:3000';
    if (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') {
      return loc.protocol + '//' + loc.hostname + ':3000';
    }
    // Sur le domaine de prod, l'API est servie sur la même origine.
    if (loc.hostname.indexOf('hordesrevival.com') !== -1) return loc.origin;
    // Ailleurs (ex. GitHub Pages), on vise le domaine de prod.
    return PROD_API;
  }

  // fetch avec timeout : un service muet ne doit pas figer la sonde.
  function fetchWithTimeout(url) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var opts = { method: 'GET', cache: 'no-store' };
    if (controller) opts.signal = controller.signal;
    var timer = controller
      ? setTimeout(function () {
          controller.abort();
        }, TIMEOUT_MS)
      : null;
    return fetch(url, opts).finally(function () {
      if (timer) clearTimeout(timer);
    });
  }

  // Sonde un endpoint JSON. Renvoie { state, latencyMs, detail }.
  //   state : 'up' (HTTP attendu) | 'degraded' (réponse mais code inattendu)
  //           | 'down' (réseau/timeout)
  function probe(url, opts) {
    opts = opts || {};
    var okCodes = opts.okCodes || [200];
    var t0 = (window.performance && performance.now ? performance.now() : Date.now());
    return fetchWithTimeout(url)
      .then(function (res) {
        var latency = Math.round(
          (window.performance && performance.now ? performance.now() : Date.now()) - t0,
        );
        return res
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            var up = okCodes.indexOf(res.status) !== -1;
            return {
              state: up ? 'up' : 'degraded',
              latencyMs: latency,
              detail: opts.describe ? opts.describe(res, body) : 'HTTP ' + res.status,
            };
          });
      })
      .catch(function () {
        var latency = Math.round(
          (window.performance && performance.now ? performance.now() : Date.now()) - t0,
        );
        return { state: 'down', latencyMs: latency, detail: 'injoignable' };
      });
  }

  var STATE_LABEL = {
    up: 'Opérationnel',
    degraded: 'Dégradé',
    down: 'Hors ligne',
    pending: 'Vérification…',
  };

  function setCard(id, result) {
    var card = document.getElementById('svc-' + id);
    if (!card) return;
    var dot = card.querySelector('.status-card__dot');
    var state = card.querySelector('.status-card__state');
    var meta = card.querySelector('.status-card__meta');
    card.setAttribute('data-state', result.state);
    if (dot) dot.setAttribute('data-state', result.state);
    if (state) state.textContent = STATE_LABEL[result.state] || result.state;
    if (meta) {
      if (result.state === 'pending') {
        meta.textContent = '…';
      } else if (result.state === 'down') {
        meta.textContent = result.detail;
      } else {
        meta.textContent = result.detail + ' · ' + result.latencyMs + ' ms';
      }
    }
  }

  function setGlobal(states) {
    var banner = document.getElementById('global-banner');
    if (!banner) return;
    var worst = 'up';
    states.forEach(function (s) {
      if (s === 'down') worst = 'down';
      else if (s === 'degraded' && worst !== 'down') worst = 'degraded';
    });
    banner.setAttribute('data-state', worst);
    var label = banner.querySelector('.global__label');
    var sub = banner.querySelector('.global__sub');
    if (worst === 'up') {
      if (label) label.textContent = 'Tous les systèmes sont opérationnels';
      if (sub) sub.textContent = 'La ville tient bon. Aucune anomalie détectée.';
    } else if (worst === 'degraded') {
      if (label) label.textContent = 'Service partiellement dégradé';
      if (sub) sub.textContent = 'Certains systèmes répondent anormalement — surveillance en cours.';
    } else {
      if (label) label.textContent = 'Incident en cours';
      if (sub) sub.textContent = 'Un ou plusieurs services sont injoignables. Les équipes sont alertées.';
    }
  }

  function stamp() {
    var el = document.getElementById('last-checked');
    if (!el) return;
    var now = new Date();
    var hh = String(now.getHours()).padStart(2, '0');
    var mm = String(now.getMinutes()).padStart(2, '0');
    var ss = String(now.getSeconds()).padStart(2, '0');
    el.textContent = 'Dernière vérification : ' + hh + ':' + mm + ':' + ss;
  }

  function refresh() {
    var api = detectApiUrl();
    var apiEl = document.getElementById('api-target');
    if (apiEl) apiEl.textContent = api;

    ['live', 'ready', 'leaderboard'].forEach(function (id) {
      setCard(id, { state: 'pending' });
    });
    // Le site vitrine est servi puisque cette page tourne.
    setCard('site', { state: 'up', latencyMs: 0, detail: 'page servie' });

    var p = [
      probe(api + '/health/live', {
        describe: function (res, body) {
          return body && body.status ? 'status ' + body.status : 'HTTP ' + res.status;
        },
      }).then(function (r) {
        setCard('live', r);
        return r.state;
      }),
      probe(api + '/health/ready', {
        okCodes: [200],
        describe: function (res, body) {
          if (body && body.store) return 'store ' + body.store;
          return 'HTTP ' + res.status;
        },
      }).then(function (r) {
        setCard('ready', r);
        return r.state;
      }),
      probe(api + '/leaderboard?limit=1', {
        describe: function (res, body) {
          if (body && typeof body.count === 'number') return body.count + ' partie(s) classée(s)';
          return 'HTTP ' + res.status;
        },
      }).then(function (r) {
        setCard('leaderboard', r);
        return r.state;
      }),
    ];

    Promise.all(p).then(function (states) {
      states.push('up'); // site
      setGlobal(states);
      stamp();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('refresh-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        refresh();
      });
    }
    refresh();
    setInterval(refresh, REFRESH_MS);
  });
})();
