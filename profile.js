/**
 * Hordes Revival — page profil publique (`profile.html`).
 *
 * Page statique autonome (aucune dépendance externe) : lit `?id=<uuid>` dans
 * l'URL, interroge l'endpoint public `GET /players/:id` et affiche l'identité
 * anonymisée du survivant, ses hauts faits, ses statistiques globales et son
 * historique de parties. Sans `id`, tente d'afficher le profil du compte
 * connecté (token en localStorage → `/auth/me` pour récupérer son userId).
 *
 * La résolution de l'URL d'API reprend la convention de `game.js`
 * (localStorage `hordes-revival:api-url`, sinon même origine / localhost:3000).
 */
'use strict';

(function () {
  var API_KEY = 'hordes-revival:api-url';
  var TOKEN_KEY = 'hordes-revival:access-token';
  var DEFAULT_LOCAL_API = 'http://localhost:3000';

  var DIFFICULTY_LABELS = { normal: 'Normal', hard: 'Difficile', hardcore: 'Hardcore' };

  function $(id) {
    return document.getElementById(id);
  }

  function lsGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function detectApiUrl() {
    var stored = lsGet(API_KEY);
    if (stored) return String(stored).replace(/\/+$/, '');
    var loc = window.location;
    if (loc.protocol === 'file:') return DEFAULT_LOCAL_API;
    if (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') {
      return loc.protocol + '//' + loc.hostname + ':3000';
    }
    return loc.origin;
  }

  var apiUrl = detectApiUrl();

  function getParam(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
  }

  function fetchJson(path, options) {
    return fetch(apiUrl + path, options || {}).then(function (res) {
      if (!res.ok) {
        var err = new Error('HTTP ' + res.status);
        err.status = res.status;
        return res
          .json()
          .catch(function () { return null; })
          .then(function (body) {
            err.body = body;
            throw err;
          });
      }
      return res.json();
    });
  }

  function setState(msg, isError) {
    var el = $('profile-state');
    if (!el) return;
    el.hidden = false;
    el.textContent = msg;
    el.className = isError ? 'profile-loading profile-loading--error' : 'profile-loading';
  }

  function hide(el) { if (el) el.hidden = true; }
  function show(el) { if (el) el.hidden = false; }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('fr-FR', {
        day: '2-digit', month: 'short', year: 'numeric',
      });
    } catch (err) {
      return '—';
    }
  }

  /* --------------------------- Rendu ------------------------------------- */

  function renderProfile(profile) {
    hide($('profile-state'));

    $('profile-title').textContent = profile.displayName || 'Survivant';
    $('profile-sub').textContent =
      'Survivant inscrit le ' + formatDate(profile.memberSince) +
      ' · id ' + String(profile.userId || '').slice(0, 8) + '…';
    document.title = 'Hordes Revival — Profil de ' + (profile.displayName || 'survivant');

    var stats = profile.stats || {};
    $('stat-total').textContent = String(stats.totalGames || 0);
    $('stat-victories').textContent = String(stats.victories || 0);
    $('stat-alive').textContent = String(stats.aliveGames || 0);
    $('stat-deaths').textContent = String(stats.deathsCount || 0);
    $('stat-best-day').textContent = stats.bestDay > 0 ? 'Jour ' + stats.bestDay : '—';
    show($('profile-stats'));

    renderAchievements(profile.achievements || []);
    renderHistory(profile.history || []);
  }

  function renderAchievements(achievements) {
    var listEl = $('profile-achievements-list');
    var countEl = $('profile-achievements-count');
    show($('profile-achievements-section'));
    var unlocked = achievements.filter(function (a) { return a.unlocked; }).length;
    if (countEl) countEl.textContent = unlocked + ' / ' + achievements.length;
    listEl.innerHTML = achievements
      .map(function (a) {
        var cls = 'achievement' + (a.unlocked ? ' achievement--unlocked' : ' achievement--locked');
        var meta = a.unlocked && a.unlockedAt
          ? 'Débloqué le ' + formatDate(a.unlockedAt)
          : escapeHtml(a.hint || '');
        return '<li class="' + cls + '" title="' + escapeHtml(a.description || '') + '">' +
          '<span class="achievement__icon" aria-hidden="true">' + escapeHtml(a.icon || '🏅') + '</span>' +
          '<span class="achievement__body">' +
          '<span class="achievement__name">' + escapeHtml(a.name || '') + '</span>' +
          '<span class="achievement__meta">' + meta + '</span>' +
          '</span>' +
          (a.unlocked ? '<span class="achievement__check" aria-hidden="true">✔</span>' : '') +
          '</li>';
      })
      .join('');
  }

  function renderHistory(history) {
    var listEl = $('profile-history-list');
    show($('profile-history-section'));
    if (!history.length) {
      listEl.innerHTML =
        '<li class="profile-history__empty">Aucune partie enregistrée pour l\'instant.</li>';
      return;
    }
    listEl.innerHTML = history
      .map(function (entry) {
        var statusLabel, statusClass;
        if (entry.outcome === 'victory') {
          statusLabel = 'Victoire'; statusClass = 'history-entry__status--alive';
        } else if (entry.gameOver || entry.closed) {
          statusLabel = 'Partie perdue'; statusClass = 'history-entry__status--over';
        } else if (entry.citizen && entry.citizen.alive) {
          statusLabel = 'En vie'; statusClass = 'history-entry__status--alive';
        } else {
          statusLabel = 'Disparu'; statusClass = 'history-entry__status--dead';
        }
        var diffLabel = DIFFICULTY_LABELS[entry.difficulty] || entry.difficulty;
        var citizenName = entry.citizen ? entry.citizen.name : '—';
        return '<li class="history-entry">' +
          '<div class="history-entry__name">' +
          '<span>' + escapeHtml(entry.townName) + '</span>' +
          '<span class="badge badge--' + escapeHtml(entry.difficulty) + '">' + escapeHtml(diffLabel) + '</span>' +
          '<span class="history-entry__status ' + statusClass + '">' + escapeHtml(statusLabel) + '</span>' +
          '</div>' +
          '<span class="history-entry__resume" aria-hidden="true">—</span>' +
          '<div class="history-entry__meta">' +
          '<span>Citoyen <strong>' + escapeHtml(citizenName) + '</strong></span>' +
          '<span>Jour atteint <strong>' + (entry.currentDay || 0) + '</strong></span>' +
          '<span>Rejointe le <strong>' + escapeHtml(formatDate(entry.joinedAt)) + '</strong></span>' +
          '</div>' +
          '</li>';
      })
      .join('');
  }

  /* --------------------------- Chargement -------------------------------- */

  function loadById(id) {
    setState('Chargement du profil…');
    fetchJson('/players/' + encodeURIComponent(id))
      .then(renderProfile)
      .catch(function (err) {
        if (err.status === 404) {
          setState('Aucun survivant ne correspond à cet identifiant.', true);
        } else if (err.status === 400) {
          setState('Identifiant de profil invalide.', true);
        } else {
          setState('Impossible de charger le profil (API injoignable).', true);
        }
      });
  }

  function boot() {
    var id = getParam('id');
    if (id) {
      loadById(id);
      return;
    }
    // Pas d'id : on tente le profil du compte connecté via son token.
    var token = lsGet(TOKEN_KEY);
    if (!token) {
      setState('Aucun profil demandé. Ajoutez ?id=<identifiant> à l\'URL, ou connectez-vous depuis le jeu.', true);
      return;
    }
    setState('Résolution de votre profil…');
    fetchJson('/auth/me', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (me) {
        if (me && me.userId) loadById(me.userId);
        else setState('Session expirée : reconnectez-vous depuis le jeu.', true);
      })
      .catch(function () {
        setState('Session expirée : reconnectez-vous depuis le jeu.', true);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
