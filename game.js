/**
 * Hordes Revival — client web du jeu.
 *
 * Trois écrans principaux :
 *   1. AUTH  : inscription / connexion (POST /auth/register, /auth/login)
 *   2. LOBBY : liste des villes ouvertes + création (GET/POST /towns)
 *   3. TOWN  : tableau de bord d'une ville (carte, inventaire, actions,
 *              roster, journal) avec synchronisation temps réel via /ws.
 *
 * Aucune logique métier ici : le client affiche l'état renvoyé par le
 * serveur et émet des actions. Les règles de jeu vivent dans
 * `src/domain/game.ts`.
 */
'use strict';

(function () {
  /* =========================================================================
   *  Configuration et constantes
   * =======================================================================*/

  var API_KEY = 'hordes-revival:api-url';
  var TOKEN_KEY = 'hordes-revival:access-token';
  var TOWN_KEY = 'hordes-revival:current-town';
  var EMAIL_KEY = 'hordes-revival:account-email';

  /** URL par défaut quand on tourne en local. */
  var DEFAULT_LOCAL_API = 'http://localhost:3000';

  var DIFFICULTY_LABELS = {
    normal: 'Normal',
    hard: 'Difficile',
    hardcore: 'Hardcore',
  };

  /* =========================================================================
   *  État applicatif
   * =======================================================================*/

  var state = {
    apiUrl: null,
    accessToken: null,
    accountEmail: null,
    currentTownId: null,
    town: null,
    yourCitizenId: null,
    ws: null,
    wsReconnectTimer: null,
    nextNightTicker: null,
    refreshing: false,
    buildingsCatalog: null,
    buildingsCatalogLoading: null,
    forum: {
      activeTab: 'threads',
      threads: [],
      threadsLoadedFor: null,
      activity: [],
      activityLoadedFor: null,
      openThreadId: null,
      openThreadDetail: null,
      createKind: 'discussion',
    },
  };

  /* =========================================================================
   *  Utilitaires
   * =======================================================================*/

  function $(id) {
    return document.getElementById(id);
  }

  function show(el) {
    if (el) el.hidden = false;
  }

  function hide(el) {
    if (el) el.hidden = true;
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

  function initials(name) {
    if (!name) return '?';
    var parts = String(name).trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function lsGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function lsSet(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (err) {
      /* localStorage indisponible : silent fallback. */
    }
  }

  /* =========================================================================
   *  Détection de l'URL d'API
   * =======================================================================*/

  function detectDefaultApiUrl() {
    var stored = lsGet(API_KEY);
    if (stored) return stored;
    if (typeof window === 'undefined') return DEFAULT_LOCAL_API;
    var loc = window.location;
    if (loc.protocol === 'file:') return DEFAULT_LOCAL_API;
    if (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') {
      return loc.protocol + '//' + loc.hostname + ':3000';
    }
    // Sur GitHub Pages : l'API n'est pas servie par la même origine, on tente
    // tout de même la même origine puis on bascule sur le bandeau de config
    // si elle ne répond pas.
    return loc.origin;
  }

  function setApiUrl(url) {
    var trimmed = String(url || '').trim().replace(/\/+$/, '');
    if (!trimmed) return;
    state.apiUrl = trimmed;
    lsSet(API_KEY, trimmed);
  }

  /* =========================================================================
   *  Requêtes HTTP
   * =======================================================================*/

  function authHeaders() {
    var h = { 'Content-Type': 'application/json' };
    if (state.accessToken) h.Authorization = 'Bearer ' + state.accessToken;
    return h;
  }

  function apiFetch(path, options) {
    options = options || {};
    var url = state.apiUrl + path;
    var init = {
      method: options.method || 'GET',
      headers: Object.assign(authHeaders(), options.headers || {}),
      credentials: 'include',
    };
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }
    return fetch(url, init).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      var parseJson = ct.indexOf('application/json') !== -1
        ? res.json().catch(function () { return null; })
        : Promise.resolve(null);
      return parseJson.then(function (data) {
        if (!res.ok) {
          var err = new Error('Erreur API');
          err.status = res.status;
          err.payload = data;
          err.code = data && data.error && data.error.code;
          err.message =
            (data && data.error && data.error.message) ||
            'Erreur réseau (HTTP ' + res.status + ')';
          throw err;
        }
        return data;
      });
    });
  }

  function tryRefreshAndRetry(originalCall) {
    if (state.refreshing) {
      // Évite la rafale : on attend la fin du refresh puis on retente.
      return new Promise(function (resolve) {
        var iv = setInterval(function () {
          if (!state.refreshing) {
            clearInterval(iv);
            resolve(originalCall());
          }
        }, 60);
      });
    }
    state.refreshing = true;
    return fetch(state.apiUrl + '/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    })
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (data) {
        state.refreshing = false;
        if (data && data.accessToken) {
          state.accessToken = data.accessToken;
          lsSet(TOKEN_KEY, data.accessToken);
          return originalCall();
        }
        return Promise.reject(new Error('Session expirée'));
      })
      .catch(function (err) {
        state.refreshing = false;
        return Promise.reject(err);
      });
  }

  function apiCall(path, options) {
    return apiFetch(path, options).catch(function (err) {
      if (err.status === 401 && state.accessToken) {
        return tryRefreshAndRetry(function () {
          return apiFetch(path, options);
        });
      }
      throw err;
    });
  }

  /* =========================================================================
   *  Routage (écrans)
   * =======================================================================*/

  var screens = {
    auth: null,
    lobby: null,
    town: null,
  };

  function showScreen(name) {
    Object.keys(screens).forEach(function (key) {
      var el = screens[key];
      if (!el) return;
      if (key === name) show(el); else hide(el);
    });
    if (name === 'town') {
      show($('game-header-status'));
    } else {
      hide($('game-header-status'));
    }
  }

  /* =========================================================================
   *  Toast & journal
   * =======================================================================*/

  var toastTimer = null;
  function toast(message, state_) {
    var el = $('toast');
    if (!el) return;
    el.textContent = message;
    if (state_) el.setAttribute('data-state', state_);
    else el.removeAttribute('data-state');
    el.hidden = false;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      el.hidden = true;
    }, 3200);
  }

  function logEvent(message, kind) {
    var list = $('event-log');
    if (!list) return;
    var empty = list.querySelector('.log__empty');
    if (empty) empty.remove();
    var li = document.createElement('li');
    li.className = 'log__item' + (kind ? ' log__item--' + kind : '');
    var time = new Date();
    var hh = String(time.getHours()).padStart(2, '0');
    var mm = String(time.getMinutes()).padStart(2, '0');
    li.innerHTML =
      '<span class="log__time">' + hh + ':' + mm + '</span>' +
      '<span class="log__text">' + escapeHtml(message) + '</span>';
    list.insertBefore(li, list.firstChild);
    // Garde un historique court (50 entrées).
    while (list.children.length > 50) {
      list.removeChild(list.lastChild);
    }
  }

  /* =========================================================================
   *  AUTH
   * =======================================================================*/

  function setupAuthUI() {
    var tabLogin = $('tab-login');
    var tabRegister = $('tab-register');
    var loginForm = $('login-form');
    var registerForm = $('register-form');

    function activate(tab) {
      var isLogin = tab === 'login';
      tabLogin.classList.toggle('is-active', isLogin);
      tabRegister.classList.toggle('is-active', !isLogin);
      tabLogin.setAttribute('aria-selected', isLogin ? 'true' : 'false');
      tabRegister.setAttribute('aria-selected', !isLogin ? 'true' : 'false');
      if (isLogin) {
        show(loginForm);
        hide(registerForm);
      } else {
        show(registerForm);
        hide(loginForm);
      }
    }

    tabLogin.addEventListener('click', function () { activate('login'); });
    tabRegister.addEventListener('click', function () { activate('register'); });

    loginForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var data = new FormData(loginForm);
      var email = String(data.get('email') || '').trim();
      var password = String(data.get('password') || '');
      var errorEl = $('login-error');
      errorEl.hidden = true;
      if (!email || password.length < 8) {
        errorEl.textContent = 'Renseignez un email valide et un mot de passe d\'au moins 8 caractères.';
        errorEl.hidden = false;
        return;
      }
      apiCall('/auth/login', {
        method: 'POST',
        body: { email: email, password: password },
      })
        .then(handleAuthSuccess)
        .catch(function (err) {
          errorEl.textContent = err.message || 'Connexion impossible.';
          errorEl.hidden = false;
        });
    });

    registerForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var data = new FormData(registerForm);
      var email = String(data.get('email') || '').trim();
      var password = String(data.get('password') || '');
      var confirm = String(data.get('passwordConfirm') || '');
      var errorEl = $('register-error');
      errorEl.hidden = true;
      if (!email) {
        errorEl.textContent = 'Adresse email obligatoire.';
        errorEl.hidden = false;
        return;
      }
      if (password.length < 8) {
        errorEl.textContent = 'Le mot de passe doit contenir au moins 8 caractères.';
        errorEl.hidden = false;
        return;
      }
      if (password !== confirm) {
        errorEl.textContent = 'Les deux mots de passe ne correspondent pas.';
        errorEl.hidden = false;
        return;
      }
      apiCall('/auth/register', {
        method: 'POST',
        body: { email: email, password: password },
      })
        .then(handleAuthSuccess)
        .catch(function (err) {
          errorEl.textContent = err.message || 'Inscription impossible.';
          errorEl.hidden = false;
        });
    });
  }

  function handleAuthSuccess(payload) {
    if (!payload || !payload.accessToken) {
      toast('Réponse serveur invalide', 'error');
      return;
    }
    state.accessToken = payload.accessToken;
    state.accountEmail = payload.email || state.accountEmail;
    lsSet(TOKEN_KEY, payload.accessToken);
    if (state.accountEmail) lsSet(EMAIL_KEY, state.accountEmail);
    refreshAccountUI();
    enterLobby();
  }

  function refreshAccountUI() {
    var emailEl = $('account-email');
    var logoutBtn = $('logout-btn');
    var profileBtn = $('profile-btn');
    if (state.accessToken && state.accountEmail) {
      emailEl.textContent = state.accountEmail;
      show(emailEl);
      show(logoutBtn);
      show(profileBtn);
    } else {
      hide(emailEl);
      hide(logoutBtn);
      hide(profileBtn);
    }
  }

  function logout() {
    apiCall('/auth/logout', { method: 'POST' }).catch(function () { /* ignore */ });
    state.accessToken = null;
    state.accountEmail = null;
    state.currentTownId = null;
    state.town = null;
    state.yourCitizenId = null;
    lsSet(TOKEN_KEY, null);
    lsSet(TOWN_KEY, null);
    lsSet(EMAIL_KEY, null);
    closeSocket();
    refreshAccountUI();
    showScreen('auth');
  }

  /* =========================================================================
   *  PROFIL JOUEUR & HISTORIQUE
   * =======================================================================*/

  var DIFFICULTY_BADGE = {
    normal: 'Normal',
    hard: 'Difficile',
    hardcore: 'Hardcore',
  };

  function setupProfileUI() {
    var profileBtn = $('profile-btn');
    var closeBtn = $('close-profile-modal-btn');
    var overlay = $('profile-modal-overlay');
    if (profileBtn) profileBtn.addEventListener('click', openProfileModal);
    if (closeBtn) closeBtn.addEventListener('click', closeProfileModal);
    if (overlay) overlay.addEventListener('click', closeProfileModal);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        var modal = $('profile-modal');
        if (modal && !modal.hidden) closeProfileModal();
      }
    });
  }

  function openProfileModal() {
    var modal = $('profile-modal');
    if (!modal) return;
    show(modal);
    renderProfileLoading();
    Promise.all([apiCall('/auth/me'), apiCall('/auth/me/history')])
      .then(function (results) {
        renderProfile(results[0], (results[1] && results[1].history) || []);
      })
      .catch(function (err) {
        $('profile-identity').innerHTML =
          '<p class="profile-loading">Impossible de charger le profil : ' +
          escapeHtml(err.message || 'erreur réseau') + '</p>';
        hide($('profile-stats'));
        $('profile-history-list').innerHTML =
          '<li class="profile-history__empty">—</li>';
      });
  }

  function closeProfileModal() {
    hide($('profile-modal'));
  }

  function renderProfileLoading() {
    $('profile-identity').innerHTML =
      '<p class="profile-loading">Chargement…</p>';
    hide($('profile-stats'));
    $('profile-history-list').innerHTML =
      '<li class="profile-history__empty">Chargement de l\'historique…</li>';
  }

  function renderProfile(me, history) {
    if (!me) return;
    state.accountEmail = me.email || state.accountEmail;
    if (state.accountEmail) lsSet(EMAIL_KEY, state.accountEmail);
    refreshAccountUI();

    var createdLabel = me.createdAt
      ? new Date(me.createdAt).toLocaleDateString('fr-FR', {
          day: '2-digit', month: 'short', year: 'numeric',
        })
      : '—';
    $('profile-identity').innerHTML =
      '<span class="profile-identity__email">' + escapeHtml(me.email || '') + '</span>' +
      '<span class="profile-identity__meta">Compte créé le ' + escapeHtml(createdLabel) +
      ' · id <code>' + escapeHtml((me.userId || '').slice(0, 8)) + '…</code></span>';

    var stats = me.stats || { totalGames: 0, aliveGames: 0, deathsCount: 0, bestDay: 0 };
    $('stat-total').textContent = String(stats.totalGames);
    $('stat-alive').textContent = String(stats.aliveGames);
    $('stat-deaths').textContent = String(stats.deathsCount);
    $('stat-best-day').textContent = stats.bestDay > 0 ? 'Jour ' + stats.bestDay : '—';
    show($('profile-stats'));

    renderProfileHistory(history);
  }

  function renderProfileHistory(history) {
    var listEl = $('profile-history-list');
    if (!history.length) {
      listEl.innerHTML =
        '<li class="profile-history__empty">Aucune partie pour le moment. Rejoignez une ville depuis le lobby.</li>';
      return;
    }
    listEl.innerHTML = '';
    history.forEach(function (entry) {
      var li = document.createElement('li');
      li.className = 'history-entry';
      var statusLabel;
      var statusClass;
      if (entry.gameOver || entry.closed) {
        statusLabel = 'Partie terminée';
        statusClass = 'history-entry__status--over';
      } else if (entry.citizen.alive) {
        statusLabel = 'En vie';
        statusClass = 'history-entry__status--alive';
      } else {
        statusLabel = 'Disparu';
        statusClass = 'history-entry__status--dead';
      }
      var joinedLabel = entry.joinedAt
        ? new Date(entry.joinedAt).toLocaleDateString('fr-FR', {
            day: '2-digit', month: 'short', year: 'numeric',
          })
        : '—';
      var diffLabel = DIFFICULTY_BADGE[entry.difficulty] || entry.difficulty;
      var phaseLabel = entry.phase === 'night' ? 'nuit' : 'jour';
      var canResume = !entry.gameOver && !entry.closed && entry.citizen.alive;
      var resumeBtn = canResume
        ? '<button type="button" class="history-entry__resume" data-town-id="' +
          escapeHtml(entry.townId) + '">Reprendre →</button>'
        : '<span class="history-entry__resume" aria-hidden="true">—</span>';
      li.innerHTML =
        '<div class="history-entry__name">' +
        '  <span>' + escapeHtml(entry.townName) + '</span>' +
        '  <span class="badge badge--' + escapeHtml(entry.difficulty) + '">' +
        escapeHtml(diffLabel) + '</span>' +
        '  <span class="history-entry__status ' + statusClass + '">' +
        escapeHtml(statusLabel) + '</span>' +
        '</div>' +
        resumeBtn +
        '<div class="history-entry__meta">' +
        '  <span>Citoyen <strong>' + escapeHtml(entry.citizen.name) + '</strong></span>' +
        '  <span>Jour atteint <strong>' + entry.currentDay + '</strong> (' + phaseLabel + ')</span>' +
        '  <span>Rejointe le <strong>' + escapeHtml(joinedLabel) + '</strong></span>' +
        '</div>' +
        (entry.citizen.causeOfDeath
          ? '<div class="history-entry__cause">☠ ' + escapeHtml(entry.citizen.causeOfDeath) + '</div>'
          : '');
      var btn = li.querySelector('button[data-town-id]');
      if (btn) {
        btn.addEventListener('click', function () {
          closeProfileModal();
          var townId = btn.getAttribute('data-town-id');
          apiCall('/towns/' + encodeURIComponent(townId))
            .then(function (town) { enterTown(town.id, town); })
            .catch(function (err) { toast(err.message || 'Reprise impossible', 'error'); });
        });
      }
      listEl.appendChild(li);
    });
  }

  /* =========================================================================
   *  LOBBY
   * =======================================================================*/

  function setupLobbyUI() {
    $('refresh-towns-btn').addEventListener('click', loadTowns);
    $('create-town-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var data = new FormData(event.currentTarget);
      var name = String(data.get('name') || '').trim();
      var difficulty = String(data.get('difficulty') || 'normal');
      var errorEl = $('create-town-error');
      errorEl.hidden = true;
      if (name.length < 3 || name.length > 30) {
        errorEl.textContent = 'Le nom de la ville doit faire entre 3 et 30 caractères.';
        errorEl.hidden = false;
        return;
      }
      apiCall('/towns', {
        method: 'POST',
        body: { name: name, difficulty: difficulty },
      })
        .then(function (town) {
          toast('Ville fondée : ' + town.name, 'success');
          event.currentTarget.reset();
          enterTown(town.id, town);
        })
        .catch(function (err) {
          errorEl.textContent = err.message || 'Création impossible.';
          errorEl.hidden = false;
        });
    });
  }

  function enterLobby() {
    showScreen('lobby');
    loadTowns();
  }

  function loadTowns() {
    var listEl = $('towns-list');
    listEl.innerHTML = '<li class="lobby-empty">Chargement…</li>';
    apiCall('/towns')
      .then(function (data) {
        renderTowns((data && data.towns) || []);
      })
      .catch(function (err) {
        if (err.status === 401) {
          logout();
          return;
        }
        listEl.innerHTML =
          '<li class="lobby-empty">Impossible de charger les villes : ' +
          escapeHtml(err.message) +
          '</li>';
      });
  }

  function renderTowns(towns) {
    var listEl = $('towns-list');
    if (!towns.length) {
      listEl.innerHTML =
        '<li class="lobby-empty">Aucune ville ouverte pour le moment. Fondez la première.</li>';
      return;
    }
    listEl.innerHTML = '';
    towns.forEach(function (town) {
      var li = document.createElement('li');
      li.className = 'town-row';
      var diffClass = 'badge badge--' + (town.difficulty || 'normal');
      var diffLabel = DIFFICULTY_LABELS[town.difficulty] || town.difficulty;
      var phaseLabel = town.phase === 'night' ? '☾ nuit' : '☀ jour';
      li.innerHTML =
        '<div class="town-row__main">' +
        '  <span class="town-row__name">' + escapeHtml(town.name) + '</span>' +
        '  <span class="town-row__meta">' +
        '    <span class="' + diffClass + '">' + escapeHtml(diffLabel) + '</span>' +
        '    <span>Jour <strong>' + town.day + '</strong></span>' +
        '    <span>' + phaseLabel + '</span>' +
        '    <span><strong>' + town.aliveCitizens + '</strong>/' + town.capacity + ' citoyens</span>' +
        '    <span>Déf. <strong>' + town.townDefense + '</strong></span>' +
        '  </span>' +
        '</div>' +
        '<button type="button" class="btn btn--primary btn--sm">Rejoindre</button>';
      li.querySelector('button').addEventListener('click', function () {
        joinTown(town.id);
      });
      listEl.appendChild(li);
    });
  }

  function joinTown(townId) {
    apiCall('/towns/' + encodeURIComponent(townId) + '/join', { method: 'POST' })
      .then(function (town) {
        enterTown(town.id, town);
      })
      .catch(function (err) {
        if (err.code === 'already-joined') {
          // Déjà citoyen : on tente simplement de récupérer l'état.
          apiCall('/towns/' + encodeURIComponent(townId))
            .then(function (town) { enterTown(town.id, town); })
            .catch(function (err2) { toast(err2.message, 'error'); });
          return;
        }
        toast(err.message || 'Impossible de rejoindre la ville', 'error');
      });
  }

  /* =========================================================================
   *  TOWN (tableau de bord)
   * =======================================================================*/

  function setupTownUI() {
    $('leave-town-btn').addEventListener('click', leaveTown);

    var actionsEl = $('actions');
    actionsEl.addEventListener('click', function (event) {
      var btn = event.target.closest('button[data-action]');
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      handleAction(action);
    });

    // Panneau de la zone courante : fouille / combat / retour ville.
    $('zone-scavenge-btn').addEventListener('click', function () {
      sendAction({ type: 'scavenge-zone' });
    });
    $('zone-fight-btn').addEventListener('click', function () {
      sendAction({ type: 'fight' });
    });
    $('zone-return-btn').addEventListener('click', function () {
      sendAction({ type: 'move-zone', x: 0, y: 0 });
    });

    $('trigger-night-btn').addEventListener('click', triggerNight);
    $('close-night-modal-btn').addEventListener('click', closeNightModal);
    $('night-modal-overlay').addEventListener('click', closeNightModal);

    setupForumUI();
  }

  function enterTown(townId, payload) {
    state.currentTownId = townId;
    state.town = payload;
    state.yourCitizenId = payload && payload.yourCitizenId;
    lsSet(TOWN_KEY, townId);
    showScreen('town');
    renderTown(payload);
    openSocket(townId);
    logEvent('Vous avez rejoint la ville.', 'success');
    resetForumState();
    loadForumThreads();
    loadActivity();
  }

  function leaveTown() {
    closeSocket();
    stopNextNightTicker();
    state.currentTownId = null;
    state.town = null;
    state.yourCitizenId = null;
    lsSet(TOWN_KEY, null);
    var logList = $('event-log');
    if (logList) {
      logList.innerHTML = '<li class="log__empty">Le journal est vide. Agissez pour le remplir.</li>';
    }
    resetForumState();
    closeThreadView();
    closeThreadCreate();
    renderForumThreads();
    renderActivityFeed();
    enterLobby();
  }

  function formatScheduledFor(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatCountdown(iso) {
    if (!iso) return '';
    var ms = new Date(iso).getTime() - Date.now();
    if (!isFinite(ms)) return '';
    if (ms <= 0) return 'imminente';
    var totalSec = Math.floor(ms / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    if (h > 0) return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
    if (m > 0) return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
    return s + 's';
  }

  function renderNextNightPill(iso) {
    var pill = $('status-next-night');
    var value = $('status-next-night-value');
    if (!pill || !value) return;
    if (!iso) {
      pill.hidden = true;
      stopNextNightTicker();
      return;
    }
    pill.hidden = false;
    var update = function () {
      var countdown = formatCountdown(iso);
      value.textContent = countdown
        ? countdown + ' (' + formatScheduledFor(iso) + ')'
        : formatScheduledFor(iso);
    };
    update();
    stopNextNightTicker();
    state.nextNightTicker = window.setInterval(update, 1000);
  }

  function stopNextNightTicker() {
    if (state.nextNightTicker) {
      window.clearInterval(state.nextNightTicker);
      state.nextNightTicker = null;
    }
  }

  function renderTown(town) {
    if (!town) return;
    state.town = town;

    // Header
    $('town-name').textContent = town.name;
    var diffEl = $('town-difficulty');
    diffEl.textContent = DIFFICULTY_LABELS[town.difficulty] || town.difficulty;
    diffEl.className = 'badge badge--' + (town.difficulty || 'normal');
    var alive = (town.citizens || []).filter(function (c) { return c.alive; }).length;
    $('town-population').textContent =
      alive + ' citoyen' + (alive > 1 ? 's' : '') +
      ' / ' + (town.citizens ? town.citizens.length : 0) + ' au total';

    // Status pills
    $('status-day').textContent = 'Jour ' + town.day;
    $('status-phase').textContent = town.phase === 'night' ? '☾ Nuit' : '☀ Jour';
    $('status-threat-value').textContent = String(town.hordePowerTonight);
    document.body.setAttribute('data-phase', town.phase);
    renderNextNightPill(town.nextNightAt || null);

    // Inventaire
    updateBank(town.bank || {}, false);

    // Défense
    var def = town.townDefense;
    var horde = town.hordePowerTonight;
    $('defense-value').textContent = String(def);
    $('horde-value').textContent = String(horde);
    var max = Math.max(def, horde, 1) * 1.4;
    var fillEl = $('defense-bar-fill');
    var hordeEl = $('defense-bar-horde');
    fillEl.style.width = Math.min(100, (def / max) * 100) + '%';
    hordeEl.style.left = Math.min(100, (horde / max) * 100) + '%';
    var defValueEl = $('defense-value');
    defValueEl.style.color = def >= horde ? 'var(--success)' : 'var(--danger)';

    // Carte (zones + tokens)
    renderMap(town);

    // Mon citoyen + activation des actions
    renderCitizenCard(town);

    // Roster
    renderRoster(town);

    // Catalogue de constructions
    renderBuildings(town);
  }

  function updateBank(bank, animate) {
    var entries = [
      ['wood', bank.wood],
      ['metal', bank.metal],
      ['water', bank.water],
    ];
    entries.forEach(function (kv) {
      var el = $('bank-' + kv[0]);
      if (!el) return;
      var prev = Number(el.textContent || 0);
      el.textContent = String(kv[1] || 0);
      if (animate && Number(kv[1] || 0) !== prev) {
        var item = el.closest('.bank__item');
        if (item) {
          item.classList.remove('is-flash');
          // reflow pour relancer l'animation
          // eslint-disable-next-line no-unused-expressions
          item.offsetWidth;
          item.classList.add('is-flash');
        }
      }
    });
  }

  var TERRAIN_ICONS = {
    plain: '🌾',
    ruins: '🏚',
    highway: '🛣',
    wasteland: '☢',
  };
  var TERRAIN_LABELS = {
    plain: 'Plaine',
    ruins: 'Ruines',
    highway: 'Route',
    wasteland: 'Friche radioactive',
  };

  function isAdjacentCell(ax, ay, bx, by) {
    if (ax === bx && ay === by) return false;
    return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1;
  }

  function renderMap(town) {
    var grid = $('desert-grid');
    if (!grid) return;
    var desert = town && town.desert ? town.desert : null;
    var citizens = town.citizens || [];
    var self = citizens.find(function (c) { return c.id === state.yourCitizenId; });
    var canMove = !!self && self.alive && town.phase === 'day' && !town.closed;

    if (!desert || !desert.zones || !desert.zones.length) {
      grid.innerHTML = '<p class="desert-grid__empty">Carte indisponible.</p>';
      hideZoneDetail();
      return;
    }

    var radius = desert.radius || 3;
    var side = 2 * radius + 1;
    grid.style.gridTemplateColumns = 'repeat(' + side + ', minmax(0, 1fr))';

    // Index zones par clé "x,y" pour accès rapide.
    var zoneByKey = {};
    desert.zones.forEach(function (z) { zoneByKey[z.x + ',' + z.y] = z; });

    // Compte les citoyens présents par case.
    var citizensByCell = {};
    citizens.forEach(function (c) {
      if (!c.alive) return;
      var key = 'town';
      if (c.location === 'desert' && c.position) {
        key = c.position.x + ',' + c.position.y;
      }
      if (!citizensByCell[key]) citizensByCell[key] = [];
      citizensByCell[key].push(c);
    });

    var selfX = self && self.position ? self.position.x : 0;
    var selfY = self && self.position ? self.position.y : 0;
    var selfInTown = !!self && self.location === 'town';

    var html = '';
    for (var y = -radius; y <= radius; y++) {
      for (var x = -radius; x <= radius; x++) {
        if (x === 0 && y === 0) {
          html += renderTownCell(citizensByCell.town || [], selfInTown);
          continue;
        }
        var zone = zoneByKey[x + ',' + y];
        if (!zone) {
          html += '<div class="desert-cell desert-cell--undiscovered" aria-hidden="true"></div>';
          continue;
        }
        var here = citizensByCell[x + ',' + y] || [];
        var isCurrent = !!self && self.location === 'desert' && self.position
          && self.position.x === x && self.position.y === y;
        var fromX = selfInTown ? 0 : selfX;
        var fromY = selfInTown ? 0 : selfY;
        var accessible = canMove && !isCurrent
          && isAdjacentCell(fromX, fromY, x, y);
        html += renderDesertCell(zone, { isCurrent: isCurrent, accessible: accessible, citizens: here, selfId: state.yourCitizenId });
      }
    }
    grid.innerHTML = html;

    Array.prototype.forEach.call(grid.querySelectorAll('.desert-cell--accessible'), function (cell) {
      cell.addEventListener('click', function () {
        var tx = Number(cell.getAttribute('data-x'));
        var ty = Number(cell.getAttribute('data-y'));
        if (tx === 0 && ty === 0) {
          sendAction({ type: 'move-zone', x: 0, y: 0 });
        } else {
          sendAction({ type: 'move-zone', x: tx, y: ty });
        }
      });
      cell.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          cell.click();
        }
      });
    });

    var hint = $('map-hint');
    if (town.phase === 'night') {
      hint.textContent = 'La nuit est tombée — les portes sont scellées.';
    } else if (!self || !self.alive) {
      hint.textContent = 'Aucun citoyen actif pour cette partie.';
    } else if (selfInTown) {
      hint.textContent = 'Vous êtes à l\'abri. Cliquez une case adjacente pour sortir.';
    } else {
      hint.textContent = 'Distance ville : ' + Math.max(Math.abs(selfX), Math.abs(selfY))
        + ' — gourde : ' + (self.waterCanteen || 0) + ' unité(s).';
    }

    renderZoneDetail(town, self, zoneByKey);
  }

  function renderTownCell(here, isCurrent) {
    var tokens = here.length
      ? '<span class="desert-cell__token' + (isCurrent ? '' : ' desert-cell__token--others') + '" title="' + here.length + ' citoyen(s)">' + (isCurrent ? '★' : here.length) + '</span>'
      : '';
    var classes = 'desert-cell desert-cell--town';
    if (isCurrent) classes += ' desert-cell--current';
    return (
      '<div class="' + classes + '" data-x="0" data-y="0" role="gridcell" aria-label="La Ville">' +
      '  <span class="desert-cell__terrain" aria-hidden="true">🏛</span>' +
      '  <span class="desert-cell__loot">Ville</span>' +
         tokens +
      '</div>'
    );
  }

  function renderDesertCell(zone, opts) {
    var classes = 'desert-cell';
    if (!zone.discovered) classes += ' desert-cell--undiscovered';
    if (opts.isCurrent) classes += ' desert-cell--current';
    if (opts.accessible) classes += ' desert-cell--accessible';
    if (zone.zombies > 0) classes += ' desert-cell--has-zombies';
    if (zone.distance === 2) classes += ' desert-cell--danger-2';
    if (zone.distance >= 3) classes += ' desert-cell--danger-3';

    var icon = TERRAIN_ICONS[zone.terrain] || '·';
    var lootCount = (zone.loot.wood || 0) + (zone.loot.metal || 0) + (zone.loot.water || 0);
    var lootLine = zone.discovered ? (lootCount + ' obj.') : '?';
    var zombiesLine = zone.discovered && zone.zombies > 0 ? '🧟 × ' + zone.zombies : '';
    var label = 'Zone (' + zone.x + ',' + zone.y + ') — ' + (TERRAIN_LABELS[zone.terrain] || zone.terrain);

    var here = opts.citizens || [];
    var selfPresent = here.some(function (c) { return c.id === opts.selfId; });
    var others = here.filter(function (c) { return c.id !== opts.selfId; });
    var tokensHtml = '';
    if (selfPresent) {
      tokensHtml += '<span class="desert-cell__token" title="Vous êtes ici">★</span>';
    }
    if (others.length) {
      tokensHtml += '<span class="desert-cell__token desert-cell__token--others" title="' + others.length + ' autre(s) citoyen(s)">' + others.length + '</span>';
    }

    var tabindex = opts.accessible ? ' tabindex="0"' : '';
    return (
      '<div class="' + classes + '" data-x="' + zone.x + '" data-y="' + zone.y + '"' +
      ' role="gridcell" aria-label="' + escapeHtml(label) + '"' + tabindex + '>' +
      '  <span class="desert-cell__terrain" aria-hidden="true">' + icon + '</span>' +
      '  <span class="desert-cell__loot">' + escapeHtml(lootLine) + '</span>' +
         (zombiesLine ? '  <span class="desert-cell__zombies">' + zombiesLine + '</span>' : '') +
         tokensHtml +
      '</div>'
    );
  }

  function renderZoneDetail(town, self, zoneByKey) {
    var detail = $('zone-detail');
    if (!detail) return;
    if (!self || self.location !== 'desert' || !self.position) {
      hideZoneDetail();
      return;
    }
    var zone = zoneByKey[self.position.x + ',' + self.position.y];
    if (!zone) {
      hideZoneDetail();
      return;
    }
    detail.hidden = false;
    var title = 'Zone (' + zone.x + ', ' + zone.y + ') — distance ' + zone.distance;
    $('zone-detail-title').textContent = title;
    $('zone-detail-terrain').textContent = TERRAIN_LABELS[zone.terrain] || zone.terrain;
    $('zone-stock-wood').textContent = String(zone.loot.wood || 0);
    $('zone-stock-metal').textContent = String(zone.loot.metal || 0);
    $('zone-stock-water').textContent = String(zone.loot.water || 0);
    var zombiesWrap = $('zone-stock-zombies-wrap');
    if (zone.zombies > 0) {
      zombiesWrap.hidden = false;
      $('zone-stock-zombies').textContent = String(zone.zombies);
    } else {
      zombiesWrap.hidden = true;
    }

    var canPlay = !!self && self.alive && town.phase === 'day' && !town.closed;
    var ap = self.actionPoints || 0;
    var canteen = self.waterCanteen || 0;
    var loot = (zone.loot.wood || 0) + (zone.loot.metal || 0) + (zone.loot.water || 0);

    var scavBtn = $('zone-scavenge-btn');
    scavBtn.disabled = !(canPlay && zone.zombies === 0 && canteen > 0 && ap >= 2 && loot > 0);
    if (zone.zombies > 0) scavBtn.textContent = '🔎 Fouille bloquée (zombies)';
    else if (canteen <= 0) scavBtn.textContent = '🔎 Fouille bloquée (gourde vide)';
    else if (loot === 0) scavBtn.textContent = '🔎 Zone vide';
    else scavBtn.textContent = '🔎 Fouiller (2 PA + 1 gourde)';

    var fightBtn = $('zone-fight-btn');
    fightBtn.hidden = zone.zombies === 0;
    fightBtn.disabled = !(canPlay && zone.zombies > 0 && ap >= 1);
    fightBtn.textContent = '⚔ Chasser un zombie (' + zone.zombies + ' restant)';

    var returnBtn = $('zone-return-btn');
    var canReturn = canPlay && Math.max(Math.abs(zone.x), Math.abs(zone.y)) === 1 && ap >= 1;
    returnBtn.disabled = !canReturn;
    returnBtn.textContent = canReturn ? '🏛 Rentrer en ville (1 PA)' : '🏛 Trop loin de la ville';
  }

  function hideZoneDetail() {
    var detail = $('zone-detail');
    if (detail) detail.hidden = true;
  }

  function renderCitizenCard(town) {
    var card = $('citizen-card');
    var citizens = town.citizens || [];
    var self = citizens.find(function (c) { return c.id === state.yourCitizenId; });

    if (!self) {
      card.innerHTML = '<p class="citizen-card__placeholder">Aucun citoyen rattaché à votre compte.</p>';
      disableAllActions();
      return;
    }

    var statusLine = self.alive
      ? (self.location === 'desert' ? 'Dans le désert' : 'En ville')
      : 'Mort — ' + (self.causeOfDeath || 'cause inconnue');

    var thirstCls = self.consecutiveThirstDays >= 1 ? ' stat--warning' : '';
    if (self.consecutiveThirstDays >= 2) thirstCls = ' stat--danger';
    var apCls = self.actionPoints <= 0 ? ' stat--danger' : '';

    var canteenCap = 3;
    var canteen = Math.max(0, Math.min(canteenCap, Number(self.waterCanteen || 0)));
    var pips = '';
    for (var i = 0; i < canteenCap; i++) {
      pips += '<span class="canteen__pip' + (i < canteen ? ' is-full' : '') + '" aria-hidden="true"></span>';
    }
    var canteenCls = canteen === 0 ? ' is-empty' : '';

    card.innerHTML =
      '<div class="citizen-card__head">' +
      '  <span class="citizen-card__avatar">' + escapeHtml(initials(self.name)) + '</span>' +
      '  <div>' +
      '    <div class="citizen-card__name">' + escapeHtml(self.name) + '</div>' +
      '    <div class="citizen-card__location">' + escapeHtml(statusLine) + '</div>' +
      '  </div>' +
      '</div>' +
      '<div class="citizen-card__stats">' +
      '  <div class="stat' + apCls + '"><span class="stat__label">Points d\'action</span><span class="stat__value">' + self.actionPoints + '</span></div>' +
      '  <div class="stat' + thirstCls + '"><span class="stat__label">Jours sans eau</span><span class="stat__value">' + self.consecutiveThirstDays + '</span></div>' +
      '</div>' +
      '<div class="canteen' + canteenCls + '">' +
      '  <span class="canteen__label">Gourde</span>' + pips +
      '  <span class="canteen__value">' + canteen + ' / ' + canteenCap + '</span>' +
      '</div>';

    updateActionAvailability(town, self);
  }

  function updateActionAvailability(town, self) {
    var canPlay = self && self.alive && town.phase === 'day' && !town.closed;
    var inTown = canPlay && self.location === 'town';
    var inDesert = canPlay && self.location === 'desert';
    var ap = self ? self.actionPoints : 0;
    var bank = town.bank || {};

    function setBtn(actionName, enabled) {
      var btn = document.querySelector('[data-action="' + actionName + '"]');
      if (btn) btn.disabled = !enabled;
    }

    setBtn('move-town', canPlay && self.location !== 'town');
    setBtn('move-desert', canPlay && self.location !== 'desert');
    setBtn('scavenge', inDesert && ap >= 2);
    setBtn('build', inTown && ap >= 1 && (bank.wood || 0) >= 3 && (bank.metal || 0) >= 1);

    $('trigger-night-btn').disabled = !(canPlay && !town.closed);
  }

  function disableAllActions() {
    document.querySelectorAll('.action').forEach(function (btn) {
      btn.disabled = true;
    });
    $('trigger-night-btn').disabled = true;
  }

  function renderRoster(town) {
    var list = $('roster-list');
    var citizens = town.citizens || [];
    $('roster-count').textContent = citizens.length;
    list.innerHTML = '';
    citizens.forEach(function (c) {
      var li = document.createElement('li');
      var classes = 'roster__item';
      if (c.id === state.yourCitizenId) classes += ' is-self';
      if (!c.alive) classes += ' is-dead';
      if (c.location === 'desert') classes += ' is-desert';
      li.className = classes;
      var loc = c.alive
        ? (c.location === 'desert' ? 'Désert' : 'Ville')
        : (c.causeOfDeath || 'Mort');
      li.innerHTML =
        '<span class="roster__dot" aria-hidden="true"></span>' +
        '<span class="roster__name">' + escapeHtml(c.name) + '<br>' +
        '  <span class="roster__location">' + escapeHtml(loc) + '</span>' +
        '</span>' +
        '<span class="roster__ap" title="Points d\'action">' +
        (c.alive ? (c.actionPoints + ' PA') : '—') +
        '</span>';
      list.appendChild(li);
    });
  }

  /* =========================================================================
   *  Constructions (catalogue de bâtiments)
   * =======================================================================*/

  function ensureBuildingsCatalog() {
    if (state.buildingsCatalog) return Promise.resolve(state.buildingsCatalog);
    if (state.buildingsCatalogLoading) return state.buildingsCatalogLoading;
    state.buildingsCatalogLoading = apiCall('/buildings/catalog', { method: 'GET' })
      .then(function (data) {
        var list = (data && data.buildings) || [];
        state.buildingsCatalog = list;
        state.buildingsCatalogLoading = null;
        return list;
      })
      .catch(function (err) {
        state.buildingsCatalogLoading = null;
        throw err;
      });
    return state.buildingsCatalogLoading;
  }

  function renderBuildings(town) {
    var list = $('buildings-list');
    var count = $('buildings-count');
    if (!list) return;
    var counters = (town && town.buildings) || {};
    var total = 0;
    Object.keys(counters).forEach(function (id) { total += Number(counters[id]) || 0; });
    if (count) count.textContent = String(total);

    if (!state.buildingsCatalog) {
      ensureBuildingsCatalog()
        .then(function () { renderBuildings(state.town); })
        .catch(function () {
          list.innerHTML = '<li class="buildings__empty">Catalogue indisponible.</li>';
        });
      return;
    }

    var catalog = state.buildingsCatalog;
    if (!catalog.length) {
      list.innerHTML = '<li class="buildings__empty">Aucun bâtiment disponible.</li>';
      return;
    }

    var citizens = (town && town.citizens) || [];
    var self = citizens.find(function (c) { return c.id === state.yourCitizenId; });
    var bank = (town && town.bank) || {};
    var canPlay = !!self && self.alive && town.phase === 'day' && !town.closed;
    var inTown = canPlay && self.location === 'town';

    var fragments = catalog.map(function (def) {
      var current = Number(counters[def.id] || 0);
      var maxed = current >= def.maxCount;
      var apOk = !!self && self.actionPoints >= def.actionPointCost;
      var woodMissing = (bank.wood || 0) < def.cost.wood;
      var metalMissing = (bank.metal || 0) < def.cost.metal;
      var resourcesOk = !woodMissing && !metalMissing;
      var available = inTown && !maxed && apOk && resourcesOk;
      var blocked = !available && !maxed;

      var effects = [];
      if (def.wallDefense > 0) effects.push('Défense +' + def.wallDefense);
      if (def.watchBonusPerCitizen > 0) effects.push('+' + def.watchBonusPerCitizen + ' déf./guetteur');
      if (def.waterPerDawn > 0) effects.push('+' + def.waterPerDawn + ' eau / aube');
      if (!effects.length) effects.push('Effet narratif');

      var classes = 'building';
      if (maxed) classes += ' is-maxed';
      else if (available) classes += ' is-available';
      else if (blocked) classes += ' is-blocked';

      var costHtml =
        '<span class="building__cost-item' + (woodMissing ? ' is-missing' : '') + '">🪵 ' + def.cost.wood + '</span>' +
        '<span class="building__cost-item' + (metalMissing ? ' is-missing' : '') + '">⚙ ' + def.cost.metal + '</span>' +
        '<span class="building__cost-item">⏱ ' + def.actionPointCost + ' PA</span>';

      var disabled = !available;
      var label = maxed
        ? 'Au maximum (' + def.maxCount + ')'
        : (current > 0 ? 'Bâtir un de plus (' + current + '/' + def.maxCount + ')'
                       : 'Bâtir');

      return (
        '<li class="' + classes + '" data-building="' + escapeHtml(def.id) + '">' +
        '  <div class="building__head">' +
        '    <span class="building__icon" aria-hidden="true">' + escapeHtml(def.icon || '🏗') + '</span>' +
        '    <span class="building__name">' + escapeHtml(def.name) + '</span>' +
        '    <span class="building__count">' + current + ' / ' + def.maxCount + '</span>' +
        '  </div>' +
        '  <p class="building__desc">' + escapeHtml(def.description) + '</p>' +
        '  <ul class="building__effects">' +
             effects.map(function (e) { return '<li>' + escapeHtml(e) + '</li>'; }).join('') +
        '  </ul>' +
        '  <div class="building__cost">' + costHtml + '</div>' +
        '  <button type="button" class="building__action" data-action="construct"' +
             (disabled ? ' disabled' : '') + '>' + escapeHtml(label) + '</button>' +
        '</li>'
      );
    });

    list.innerHTML = fragments.join('');
    Array.prototype.forEach.call(list.querySelectorAll('.building__action'), function (btn) {
      btn.addEventListener('click', function () {
        var li = btn.closest('.building');
        if (!li) return;
        var id = li.getAttribute('data-building');
        if (!id) return;
        sendAction({ type: 'construct', buildingId: id });
      });
    });
  }

  /* =========================================================================
   *  Actions de jeu
   * =======================================================================*/

  function performMove(destination) {
    if (!state.town || !state.yourCitizenId) return;
    var self = (state.town.citizens || []).find(function (c) { return c.id === state.yourCitizenId; });
    if (!self || !self.alive) return;
    if (self.location === destination) return;
    sendAction({ type: 'move', to: destination });
  }

  function handleAction(actionName) {
    switch (actionName) {
      case 'move-town': performMove('town'); break;
      case 'move-desert': performMove('desert'); break;
      case 'scavenge': sendAction({ type: 'scavenge' }); break;
      case 'build': sendAction({ type: 'build' }); break;
    }
  }

  function sendAction(body) {
    if (!state.currentTownId || !state.yourCitizenId) return;
    var path =
      '/towns/' + encodeURIComponent(state.currentTownId) +
      '/citizens/' + encodeURIComponent(state.yourCitizenId) + '/action';
    apiCall(path, { method: 'POST', body: body })
      .then(function (res) {
        if (!res) return;
        // L'événement WebSocket va aussi déclencher un re-render. En attendant,
        // on met à jour localement les compteurs principaux.
        if (state.town && res.citizen) {
          state.town.bank = res.bank || state.town.bank;
          state.town.townDefense = res.townDefense || state.town.townDefense;
          if (res.buildings) state.town.buildings = res.buildings;
          if (res.desert) state.town.desert = res.desert;
          state.town.citizens = state.town.citizens.map(function (c) {
            return c.id === res.citizen.id ? Object.assign({}, c, res.citizen) : c;
          });
          renderTown(state.town);
        }
        switch (body.type) {
          case 'move':
            logEvent('Vous êtes parti vers ' + (body.to === 'desert' ? 'le désert' : 'la ville') + '.', 'info');
            break;
          case 'scavenge':
            logEvent('Vous avez fouillé la zone.', 'success');
            break;
          case 'build':
            logEvent('Vous avez bâti une défense (+6).', 'success');
            break;
          case 'construct':
            var def = (state.buildingsCatalog || []).find(function (b) { return b.id === body.buildingId; });
            logEvent('Vous avez érigé ' + (def ? def.name : body.buildingId) + '.', 'success');
            break;
          case 'move-zone':
            if (body.x === 0 && body.y === 0) {
              logEvent('Vous êtes rentré en ville.', 'info');
            } else {
              logEvent('Vous avez exploré la case (' + body.x + ', ' + body.y + ').', 'info');
            }
            break;
          case 'scavenge-zone':
            logEvent('Vous avez fouillé la zone.', 'success');
            break;
          case 'fight':
            logEvent('Vous avez chassé un zombie errant.', 'warning');
            break;
        }
      })
      .catch(function (err) {
        toast(err.message || 'Action refusée', 'error');
      });
  }

  function triggerNight() {
    if (!state.currentTownId) return;
    var path = '/towns/' + encodeURIComponent(state.currentTownId) + '/night';
    $('trigger-night-btn').disabled = true;
    apiCall(path, { method: 'POST' })
      .then(function (res) {
        if (!res || !res.report) return;
        // Le rapport sera également broadcasté par WS ; on affiche la modale ici
        // pour donner un feedback immédiat au joueur qui a lancé la nuit.
        showNightReport(res.report);
      })
      .catch(function (err) {
        toast(err.message || 'Résolution de nuit impossible', 'error');
        // Le bouton se ré-active au prochain rendu.
        if (state.town) renderTown(state.town);
      });
  }

  function showNightReport(report) {
    var modal = $('night-modal');
    var body = $('night-modal-body');
    var verdict = report.gameOver
      ? '<p class="report-breach">☠ La ville est tombée. Tous vos citoyens sont morts.</p>'
      : (report.breached
          ? '<p class="report-breach">⚠ La horde a percé les défenses.</p>'
          : '<p class="report-safe">✓ Les murs ont tenu.</p>');
    var rows =
      '<div class="report-row"><span>Jour</span><strong>' + report.day + '</strong></div>' +
      '<div class="report-row"><span>Puissance de la horde</span><strong>' + report.hordePower + '</strong></div>' +
      '<div class="report-row"><span>Défense totale de la ville</span><strong>' + report.townDefense + '</strong></div>' +
      '<div class="report-row"><span>Survivants après la nuit</span><strong>' + report.survivors + '</strong></div>';

    var defenseHtml = '';
    if (report.defense) {
      defenseHtml =
        '<h3 style="margin-top:0.6rem">Sources de défense</h3>' +
        '<ul class="report-deaths">' +
        '<li>Murs et constructions <strong>+' + report.defense.walls + '</strong></li>' +
        '<li>Citoyens en faction (' + report.defense.watcherCount + ') <strong>+' + report.defense.watchers + '</strong></li>' +
        '<li>Total <strong>' + report.defense.total + '</strong></li>' +
        '</ul>';
    }

    var wavesHtml = '';
    if (report.waves && report.waves.length) {
      wavesHtml = '<h3 style="margin-top:0.6rem">Vagues d\'assaut</h3><ul class="report-deaths">';
      report.waves.forEach(function (w) {
        var label = w.overflow > 0
          ? 'a débordé de <strong>' + w.overflow + '</strong>'
          : 'absorbée par les défenses';
        wavesHtml += '<li>Vague ' + w.index + ' — attaque <strong>' + w.attack + '</strong>, ' + label + '</li>';
      });
      wavesHtml += '</ul>';
    }

    var deathsHtml = '';
    if (report.deaths && report.deaths.length) {
      var bySource = report.deathsBySource || {};
      var summary = [];
      if (bySource.desert) summary.push(bySource.desert + ' dans le désert');
      if (bySource.watch) summary.push(bySource.watch + ' tombé(s) en faction');
      if (bySource.breach) summary.push(bySource.breach + ' lors de la percée');
      if (bySource.dehydration) summary.push(bySource.dehydration + ' de soif');
      var summaryText = summary.length ? ' — ' + summary.join(', ') : '';
      deathsHtml = '<h3 style="margin-top:0.6rem">Pertes (' + report.deaths.length + ')' + summaryText + '</h3><ul class="report-deaths">';
      report.deaths.forEach(function (d) {
        deathsHtml += '<li><strong>' + escapeHtml(d.name) + '</strong> — ' + escapeHtml(d.cause) + '</li>';
      });
      deathsHtml += '</ul>';
    }
    body.innerHTML = verdict + rows + defenseHtml + wavesHtml + deathsHtml;
    show(modal);
  }

  function closeNightModal() {
    hide($('night-modal'));
  }

  /* =========================================================================
   *  WebSocket
   * =======================================================================*/

  function wsUrlFor(townId) {
    var apiUrl = state.apiUrl;
    var wsProtocol = apiUrl.indexOf('https://') === 0 ? 'wss://' : 'ws://';
    var host = apiUrl.replace(/^https?:\/\//, '');
    return wsProtocol + host + '/ws?townId=' + encodeURIComponent(townId) +
      '&token=' + encodeURIComponent(state.accessToken || '');
  }

  function openSocket(townId) {
    closeSocket();
    if (!state.accessToken) return;
    var url = wsUrlFor(townId);
    var ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      logEvent('Connexion temps réel indisponible.', 'warning');
      return;
    }
    state.ws = ws;

    ws.addEventListener('open', function () {
      logEvent('Connexion temps réel établie.', 'info');
    });

    ws.addEventListener('message', function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (err) { return; }
      handleServerMessage(msg);
    });

    ws.addEventListener('close', function () {
      if (state.currentTownId === townId) {
        logEvent('Connexion temps réel perdue, reconnexion…', 'warning');
        // Reconnexion exponentielle bornée.
        if (state.wsReconnectTimer) window.clearTimeout(state.wsReconnectTimer);
        state.wsReconnectTimer = window.setTimeout(function () {
          if (state.currentTownId === townId) openSocket(townId);
        }, 2500);
      }
    });

    ws.addEventListener('error', function () {
      // 'close' suit habituellement : on délègue la reconnexion là-bas.
    });
  }

  function closeSocket() {
    if (state.wsReconnectTimer) {
      window.clearTimeout(state.wsReconnectTimer);
      state.wsReconnectTimer = null;
    }
    if (state.ws) {
      try { state.ws.close(); } catch (err) { /* ignore */ }
      state.ws = null;
    }
  }

  function handleServerMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'town.snapshot':
        applySnapshot(msg);
        break;
      case 'citizen.moved':
        applyCitizenMoved(msg);
        break;
      case 'citizen.exploring':
        applyCitizenExploring(msg);
        break;
      case 'build.completed':
        applyBuildCompleted(msg);
        break;
      case 'night.start':
        logEvent('☾ La nuit du jour ' + msg.day + ' commence — les portes se referment.', 'warning');
        break;
      case 'night.scheduled':
        if (state.town) {
          state.town.nextNightAt = msg.scheduledFor;
          renderTown(state.town);
        }
        logEvent('⏰ Prochaine résolution prévue à ' + formatScheduledFor(msg.scheduledFor) + '.', 'info');
        break;
      case 'night.report':
        var triggerLabel = msg.trigger === 'scheduler' ? 'automatique' : 'déclenchée';
        logEvent('Rapport ' + triggerLabel + ' de la nuit ' + msg.day + ' : ' + msg.report.deaths.length + ' pertes.',
          msg.report.breached ? 'danger' : 'success');
        showNightReport(msg.report);
        // Le snapshot serveur arrivera ensuite et rafraîchira l'état complet.
        break;
      case 'forum.thread.created':
        onForumThreadCreated(msg.thread);
        break;
      case 'forum.thread.closed':
        onForumThreadClosed(msg.threadId);
        break;
      case 'forum.message.posted':
        onForumMessagePosted(msg.threadId, msg.message);
        break;
      case 'forum.vote.cast':
        onForumVoteCast(msg.threadId, msg.tally);
        break;
      case 'activity.recorded':
        onActivityRecorded(msg.entry);
        break;
      case 'error':
        toast(msg.message || 'Erreur serveur', 'error');
        break;
    }
  }

  function applySnapshot(snapshot) {
    if (!state.town) return;
    // On ne reçoit pas les compteurs détaillés par citoyen (PA, soif) dans le
    // snapshot WS : on récupère donc l'état complet via REST pour synchroniser
    // précisément l'UI.
    apiCall('/towns/' + encodeURIComponent(state.currentTownId))
      .then(function (town) {
        state.town = town;
        state.yourCitizenId = town.yourCitizenId || state.yourCitizenId;
        renderTown(town);
        updateBank(town.bank || {}, true);
      })
      .catch(function () {
        // Fallback : on rejoue le snapshot WS pour les éléments connus.
        state.town.day = snapshot.day;
        state.town.phase = snapshot.phase;
        state.town.bank = Object.assign({}, state.town.bank, snapshot.resources);
        if (snapshot.citizens) {
          state.town.citizens = snapshot.citizens.map(function (c) {
            var prev = (state.town.citizens || []).find(function (x) { return x.id === c.id; }) || {};
            return Object.assign({}, prev, c);
          });
        }
        renderTown(state.town);
      });
  }

  function applyCitizenMoved(msg) {
    if (!state.town) return;
    var moved = (state.town.citizens || []).find(function (c) { return c.id === msg.citizenId; });
    if (moved) {
      moved.location = msg.to;
      renderTown(state.town);
      if (msg.citizenId !== state.yourCitizenId) {
        logEvent(moved.name + ' est parti vers ' + (msg.to === 'desert' ? 'le désert' : 'la ville') + '.', 'info');
      }
    }
  }

  function applyCitizenExploring(msg) {
    if (!state.town) return;
    var c = (state.town.citizens || []).find(function (x) { return x.id === msg.citizenId; });
    if (c) {
      c.location = 'desert';
      c.position = { x: msg.x, y: msg.y };
      renderTown(state.town);
    }
    if (msg.citizenId !== state.yourCitizenId) {
      var who = c ? c.name : 'Un citoyen';
      logEvent(who + ' explore la case (' + msg.x + ', ' + msg.y + ')'
        + (msg.discovered ? ' (zone inconnue).' : '.'), 'info');
    }
  }

  function applyBuildCompleted(msg) {
    if (!state.town) return;
    state.town.townDefense = msg.defense;
    $('defense-value').textContent = String(msg.defense);
    logEvent('Un chantier est terminé. Défense : ' + msg.defense + '.', 'success');
  }

  /* =========================================================================
   *  FORUM & JOURNAL D'ACTIVITÉ
   * =======================================================================*/

  var ACTIVITY_KIND_META = {
    'town.create':           { icon: '🏗', label: 'a fondé la ville' },
    'citizen.join':          { icon: '⛺', label: 'a rejoint la ville' },
    'citizen.move':          { icon: '🚶', label: 'se déplace' },
    'citizen.scavenge':      { icon: '🔎', label: 'a fouillé' },
    'citizen.build':         { icon: '🛠', label: 'a construit' },
    'citizen.construct':     { icon: '🏗', label: 'a érigé un bâtiment' },
    'citizen.explore':       { icon: '🧭', label: 'a exploré une zone' },
    'citizen.scavenge-zone': { icon: '🔎', label: 'a fouillé une zone' },
    'citizen.fight':         { icon: '⚔', label: 'a chassé un zombie' },
    'citizen.died':          { icon: '☠', label: 'est mort' },
    'night.resolved':        { icon: '☾', label: 'Nuit résolue' },
    'forum.thread.created':  { icon: '💬', label: 'a ouvert une discussion' },
    'forum.vote.created':    { icon: '☑', label: 'a lancé un vote' },
    'forum.vote.cast':       { icon: '✔', label: 'a voté' },
    'forum.message.posted':  { icon: '✉', label: 'a posté un message' },
  };

  function resetForumState() {
    state.forum.threads = [];
    state.forum.threadsLoadedFor = null;
    state.forum.activity = [];
    state.forum.activityLoadedFor = null;
    state.forum.openThreadId = null;
    state.forum.openThreadDetail = null;
    state.forum.activeTab = 'threads';
  }

  function setupForumUI() {
    var tabs = document.querySelectorAll('.forum-tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        selectForumTab(tab.getAttribute('data-forum-tab'));
      });
    });

    $('forum-refresh-btn').addEventListener('click', function () {
      loadForumThreads(true);
    });
    $('activity-refresh-btn').addEventListener('click', function () {
      loadActivity(true);
    });

    $('forum-new-discussion-btn').addEventListener('click', function () {
      openThreadCreate('discussion');
    });
    $('forum-new-vote-btn').addEventListener('click', function () {
      openThreadCreate('vote');
    });

    $('thread-create-overlay').addEventListener('click', closeThreadCreate);
    $('thread-create-close-btn').addEventListener('click', closeThreadCreate);
    $('thread-create-cancel-btn').addEventListener('click', closeThreadCreate);
    $('thread-create-form').addEventListener('submit', onSubmitThreadCreate);

    $('vote-option-add-btn').addEventListener('click', function () {
      var list = $('vote-options-list');
      var inputs = list.querySelectorAll('.vote-option-input');
      if (inputs.length >= 6) {
        toast('6 options maximum.', 'error');
        return;
      }
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'vote-option-input';
      input.maxLength = 60;
      input.placeholder = 'Option ' + (inputs.length + 1);
      list.appendChild(input);
      input.focus();
    });

    $('thread-view-overlay').addEventListener('click', closeThreadView);
    $('thread-view-close-btn').addEventListener('click', closeThreadView);
    $('thread-reply-form').addEventListener('submit', onSubmitReply);
    $('thread-close-btn').addEventListener('click', onClickCloseThread);
  }

  function selectForumTab(tab) {
    if (!tab) return;
    state.forum.activeTab = tab;
    document.querySelectorAll('.forum-tab').forEach(function (el) {
      var isActive = el.getAttribute('data-forum-tab') === tab;
      el.classList.toggle('is-active', isActive);
      el.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    document.querySelectorAll('[data-forum-panel]').forEach(function (el) {
      var match = el.getAttribute('data-forum-panel') === tab;
      el.hidden = !match;
    });
    if (tab === 'activity' && state.currentTownId &&
        state.forum.activityLoadedFor !== state.currentTownId) {
      loadActivity();
    }
  }

  /* ----------------------------- Threads ---------------------------------- */

  function loadForumThreads(force) {
    var townId = state.currentTownId;
    if (!townId) return;
    if (!force && state.forum.threadsLoadedFor === townId) return;
    apiCall('/towns/' + encodeURIComponent(townId) + '/forum/threads')
      .then(function (data) {
        if (state.currentTownId !== townId) return;
        state.forum.threads = (data && data.threads) || [];
        state.forum.threadsLoadedFor = townId;
        renderForumThreads();
      })
      .catch(function (err) {
        if (err.status === 401) return;
        toast(err.message || 'Forum indisponible', 'error');
      });
  }

  function renderForumThreads() {
    var list = $('forum-threads-list');
    if (!list) return;
    var threads = state.forum.threads || [];
    if (!threads.length) {
      list.innerHTML =
        '<li class="forum-threads__empty">' +
        'Aucun sujet pour le moment. Lancez la discussion ou ouvrez un vote.' +
        '</li>';
      return;
    }
    list.innerHTML = '';
    threads.forEach(function (t) {
      var li = document.createElement('li');
      li.className = 'thread-row' + (t.closed ? ' is-closed' : '');
      li.setAttribute('role', 'button');
      li.setAttribute('tabindex', '0');
      var kindBadge = t.kind === 'vote'
        ? '<span class="thread-row__badge thread-row__badge--vote">Vote</span>'
        : '<span class="thread-row__badge thread-row__badge--discussion">Discussion</span>';
      var closedBadge = t.closed
        ? '<span class="thread-row__badge thread-row__badge--closed">Clos</span>'
        : '';
      var voteMeta = t.kind === 'vote'
        ? '<span><strong>' + (t.voteCount || 0) + '</strong> votes</span>'
        : '';
      li.innerHTML =
        '<div class="thread-row__head">' +
        kindBadge +
        '  <span class="thread-row__title">' + escapeHtml(t.title) + '</span>' +
        closedBadge +
        '</div>' +
        '<div class="thread-row__meta">' +
        '  <span>Par <strong>' + escapeHtml(t.authorCitizenName) + '</strong></span>' +
        '  <span>' + formatRelativeTime(t.createdAt) + '</span>' +
        '  <span><strong>' + (t.messageCount || 0) + '</strong> message' + ((t.messageCount || 0) > 1 ? 's' : '') + '</span>' +
        voteMeta +
        '</div>';
      li.addEventListener('click', function () { openThreadView(t.id); });
      li.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openThreadView(t.id);
        }
      });
      list.appendChild(li);
    });
  }

  function upsertThreadSummary(summary) {
    if (!summary) return;
    var idx = (state.forum.threads || []).findIndex(function (t) { return t.id === summary.id; });
    if (idx >= 0) {
      state.forum.threads[idx] = summary;
    } else {
      state.forum.threads = [summary].concat(state.forum.threads || []);
    }
    renderForumThreads();
  }

  function onForumThreadCreated(thread) {
    if (!thread || thread.townId !== state.currentTownId) return;
    upsertThreadSummary(thread);
  }

  function onForumThreadClosed(threadId) {
    if (!threadId) return;
    var t = (state.forum.threads || []).find(function (x) { return x.id === threadId; });
    if (t) {
      t.closed = true;
      renderForumThreads();
    }
    if (state.forum.openThreadId === threadId && state.forum.openThreadDetail) {
      state.forum.openThreadDetail.thread.closed = true;
      renderThreadView();
    }
  }

  function onForumMessagePosted(threadId, message) {
    if (!threadId || !message) return;
    var t = (state.forum.threads || []).find(function (x) { return x.id === threadId; });
    if (t) {
      t.messageCount = (t.messageCount || 0) + 1;
      t.lastMessageAt = message.createdAt;
      renderForumThreads();
    }
    if (state.forum.openThreadId === threadId && state.forum.openThreadDetail) {
      var detail = state.forum.openThreadDetail;
      if (!detail.messages.some(function (m) { return m.id === message.id; })) {
        detail.messages.push(message);
        detail.thread.messageCount = (detail.thread.messageCount || 0) + 1;
        detail.thread.lastMessageAt = message.createdAt;
      }
      renderThreadView();
    }
  }

  function onForumVoteCast(threadId, tally) {
    if (!threadId || !tally) return;
    var t = (state.forum.threads || []).find(function (x) { return x.id === threadId; });
    if (t) {
      t.voteCount = tally.total;
      renderForumThreads();
    }
    if (state.forum.openThreadId === threadId && state.forum.openThreadDetail) {
      state.forum.openThreadDetail.tally = tally;
      state.forum.openThreadDetail.thread.voteCount = tally.total;
      renderThreadView();
    }
  }

  /* ----------------------------- Activité --------------------------------- */

  function loadActivity(force) {
    var townId = state.currentTownId;
    if (!townId) return;
    if (!force && state.forum.activityLoadedFor === townId) return;
    apiCall('/towns/' + encodeURIComponent(townId) + '/activity?limit=80')
      .then(function (data) {
        if (state.currentTownId !== townId) return;
        state.forum.activity = (data && data.entries) || [];
        state.forum.activityLoadedFor = townId;
        renderActivityFeed();
      })
      .catch(function (err) {
        if (err.status === 401) return;
        // Silencieux : l'activité n'est pas critique.
      });
  }

  function onActivityRecorded(entry) {
    if (!entry || entry.townId !== state.currentTownId) return;
    state.forum.activity = [entry].concat(state.forum.activity || []);
    if (state.forum.activity.length > 200) {
      state.forum.activity.length = 200;
    }
    renderActivityFeed();
  }

  function renderActivityFeed() {
    var list = $('activity-feed');
    if (!list) return;
    var entries = state.forum.activity || [];
    if (!entries.length) {
      list.innerHTML =
        '<li class="activity-feed__empty">' +
        'Aucune activité enregistrée pour le moment.' +
        '</li>';
      return;
    }
    list.innerHTML = '';
    entries.forEach(function (entry) {
      var li = document.createElement('li');
      li.className = 'activity-feed__item';
      var meta = ACTIVITY_KIND_META[entry.kind] || { icon: '•', label: entry.kind };
      var who = entry.citizenName
        ? '<strong>' + escapeHtml(entry.citizenName) + '</strong> '
        : '';
      var detailHtml = formatActivityDetails(entry);
      li.innerHTML =
        '<span class="activity-feed__icon" aria-hidden="true">' + meta.icon + '</span>' +
        '<span class="activity-feed__text">' + who + escapeHtml(meta.label) + detailHtml + '</span>' +
        '<span class="activity-feed__time" title="' + escapeHtml(new Date(entry.createdAt).toLocaleString()) + '">' +
        escapeHtml(formatRelativeTime(entry.createdAt)) +
        '</span>';
      list.appendChild(li);
    });
  }

  function formatActivityDetails(entry) {
    var d = entry.details || {};
    switch (entry.kind) {
      case 'town.create':
        return d.townName ? ' « ' + escapeHtml(String(d.townName)) + ' »' : '';
      case 'citizen.move':
        return ' vers ' + (d.to === 'desert' ? 'le désert' : 'la ville');
      case 'citizen.scavenge': {
        var parts = [];
        ['wood', 'metal', 'water'].forEach(function (k) {
          if (typeof d[k] === 'number' && d[k] !== 0) {
            parts.push((d[k] > 0 ? '+' : '') + d[k] + ' ' + translateResource(k));
          }
        });
        return parts.length ? ' (' + parts.join(', ') + ')' : '';
      }
      case 'citizen.build':
        return typeof d.defense === 'number' ? ' (défense ' + d.defense + ')' : '';
      case 'citizen.died':
        return d.cause ? ' — ' + escapeHtml(String(d.cause)) : '';
      case 'night.resolved': {
        var info = [];
        if (typeof d.day === 'number') info.push('jour ' + d.day);
        if (typeof d.deaths === 'number') info.push(d.deaths + ' pertes');
        if (d.breached) info.push('mur percé');
        if (d.gameOver) info.push('ville tombée');
        return info.length ? ' — ' + info.join(', ') : '';
      }
      case 'forum.thread.created':
      case 'forum.vote.created':
        return d.title ? ' « ' + escapeHtml(String(d.title)) + ' »' : '';
      case 'forum.vote.cast':
        return d.optionId ? ' (' + escapeHtml(String(d.optionId)) + ')' : '';
      default:
        return '';
    }
  }

  function translateResource(key) {
    if (key === 'wood') return 'bois';
    if (key === 'metal') return 'métal';
    if (key === 'water') return 'eau';
    return key;
  }

  function formatRelativeTime(iso) {
    if (!iso) return '';
    var diff = Date.now() - new Date(iso).getTime();
    if (!isFinite(diff)) return '';
    if (diff < 0) diff = 0;
    var sec = Math.floor(diff / 1000);
    if (sec < 45) return 'à l\'instant';
    var min = Math.floor(sec / 60);
    if (min < 60) return 'il y a ' + min + ' min';
    var hr = Math.floor(min / 60);
    if (hr < 24) return 'il y a ' + hr + ' h';
    var day = Math.floor(hr / 24);
    if (day < 7) return 'il y a ' + day + ' j';
    return new Date(iso).toLocaleDateString();
  }

  /* ---------------------- Modale création de sujet ------------------------ */

  function openThreadCreate(kind) {
    state.forum.createKind = kind === 'vote' ? 'vote' : 'discussion';
    var modal = $('thread-create-modal');
    var title = $('thread-create-title');
    var voteField = $('thread-create-vote-field');
    var bodyField = $('thread-create-body-field');
    var form = $('thread-create-form');
    var error = $('thread-create-error');
    form.reset();
    error.hidden = true;
    error.textContent = '';
    if (state.forum.createKind === 'vote') {
      title.textContent = 'Nouveau vote';
      show(voteField);
      hide(bodyField);
      var list = $('vote-options-list');
      list.innerHTML = '';
      [1, 2].forEach(function (n) {
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'vote-option-input';
        input.maxLength = 60;
        input.placeholder = 'Option ' + n;
        list.appendChild(input);
      });
    } else {
      title.textContent = 'Nouvelle discussion';
      hide(voteField);
      show(bodyField);
    }
    show(modal);
    var titleInput = form.querySelector('input[name="title"]');
    if (titleInput) titleInput.focus();
  }

  function closeThreadCreate() {
    hide($('thread-create-modal'));
  }

  function onSubmitThreadCreate(event) {
    event.preventDefault();
    if (!state.currentTownId) return;
    var form = event.target;
    var title = form.title.value.trim();
    var error = $('thread-create-error');
    error.hidden = true;
    if (title.length < 3) {
      error.textContent = 'Le titre doit faire au moins 3 caractères.';
      error.hidden = false;
      return;
    }
    var payload = { title: title, kind: state.forum.createKind };
    if (state.forum.createKind === 'vote') {
      var options = [];
      document.querySelectorAll('#vote-options-list .vote-option-input').forEach(function (input) {
        var v = input.value.trim();
        if (v) options.push(v);
      });
      if (options.length < 2) {
        error.textContent = 'Un vote demande au moins 2 options remplies.';
        error.hidden = false;
        return;
      }
      payload.options = options;
    } else {
      var body = form.body.value.trim();
      if (body) payload.body = body;
    }
    var submitBtn = $('thread-create-submit-btn');
    submitBtn.disabled = true;
    apiCall('/towns/' + encodeURIComponent(state.currentTownId) + '/forum/threads', {
      method: 'POST',
      body: payload,
    })
      .then(function (detail) {
        submitBtn.disabled = false;
        if (!detail) return;
        upsertThreadSummary(detail.thread);
        state.forum.openThreadDetail = detail;
        state.forum.openThreadId = detail.thread.id;
        closeThreadCreate();
        renderThreadView();
        show($('thread-view-modal'));
        toast('Sujet publié.', 'success');
      })
      .catch(function (err) {
        submitBtn.disabled = false;
        error.textContent = err.message || 'Création impossible';
        error.hidden = false;
      });
  }

  /* ---------------------- Modale lecture de sujet ------------------------- */

  function openThreadView(threadId) {
    if (!state.currentTownId) return;
    apiCall('/towns/' + encodeURIComponent(state.currentTownId) +
            '/forum/threads/' + encodeURIComponent(threadId))
      .then(function (detail) {
        if (!detail) return;
        state.forum.openThreadId = threadId;
        state.forum.openThreadDetail = detail;
        upsertThreadSummary(detail.thread);
        renderThreadView();
        show($('thread-view-modal'));
      })
      .catch(function (err) {
        toast(err.message || 'Sujet introuvable', 'error');
      });
  }

  function closeThreadView() {
    hide($('thread-view-modal'));
    state.forum.openThreadId = null;
    state.forum.openThreadDetail = null;
  }

  function renderThreadView() {
    var detail = state.forum.openThreadDetail;
    if (!detail) return;
    var t = detail.thread;
    $('thread-view-title').textContent = t.title;
    $('thread-view-meta').textContent =
      'Par ' + t.authorCitizenName + ' • ' +
      (t.kind === 'vote' ? 'Vote' : 'Discussion') + ' • ' +
      formatRelativeTime(t.createdAt) +
      (t.closed ? ' • Clos' : '');

    var voteEl = $('thread-view-vote');
    if (t.kind === 'vote') {
      show(voteEl);
      renderVoteBlock(voteEl, t, detail.tally);
    } else {
      hide(voteEl);
      voteEl.innerHTML = '';
    }

    var msgList = $('thread-view-messages');
    var messages = detail.messages || [];
    if (!messages.length) {
      msgList.innerHTML =
        '<li class="thread-view__messages-empty">' +
        'Aucun message pour le moment. Posez la première pierre.' +
        '</li>';
    } else {
      msgList.innerHTML = '';
      messages.forEach(function (m) {
        var li = document.createElement('li');
        li.className = 'thread-view__message';
        li.innerHTML =
          '<div class="thread-view__message-head">' +
          '<strong>' + escapeHtml(m.authorCitizenName) + '</strong>' +
          '<span>' + escapeHtml(formatRelativeTime(m.createdAt)) + '</span>' +
          '</div>' +
          '<div class="thread-view__message-body">' + escapeHtml(m.body) + '</div>';
        msgList.appendChild(li);
      });
    }

    var form = $('thread-reply-form');
    var closedHint = $('thread-view-closed');
    if (t.closed) {
      form.hidden = true;
      closedHint.hidden = false;
    } else {
      form.hidden = false;
      closedHint.hidden = true;
    }

    var closeBtn = $('thread-close-btn');
    var isOwner = !t.closed && state.accessToken && t.authorAccountId &&
      currentAccountId() === t.authorAccountId;
    closeBtn.hidden = !isOwner;
  }

  function renderVoteBlock(container, thread, tally) {
    var total = tally && typeof tally.total === 'number' ? tally.total : 0;
    var my = tally && tally.myChoice;
    var counts = (tally && tally.counts) || {};
    var html = '<div class="thread-view__vote-title">Vote — choisissez une option</div>';
    thread.options.forEach(function (opt) {
      var count = counts[opt.id] || 0;
      var pct = total > 0 ? Math.round((count / total) * 100) : 0;
      var isMy = my === opt.id;
      html +=
        '<div class="vote-option-row' + (isMy ? ' is-my-choice' : '') + '" data-option-id="' + escapeHtml(opt.id) + '">' +
        '  <label class="vote-option-row__label">' +
        '    <input type="radio" class="vote-option-row__radio" name="thread-view-vote" value="' + escapeHtml(opt.id) + '"' +
                (isMy ? ' checked' : '') + (thread.closed ? ' disabled' : '') + '>' +
        '    <span>' + escapeHtml(opt.label) + '</span>' +
        '    <span class="vote-option-row__bar"><span class="vote-option-row__bar-fill" style="width:' + pct + '%"></span></span>' +
        '  </label>' +
        '  <span class="vote-option-row__count">' + count + ' (' + pct + '%)</span>' +
        '</div>';
    });
    html += '<div class="thread-view__vote-total">Total : ' + total + ' vote' + (total > 1 ? 's' : '') + '</div>';
    container.innerHTML = html;

    container.querySelectorAll('input[type="radio"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (radio.checked) castVote(radio.value);
      });
    });
  }

  function castVote(optionId) {
    var detail = state.forum.openThreadDetail;
    if (!detail || !state.currentTownId) return;
    var threadId = detail.thread.id;
    apiCall('/towns/' + encodeURIComponent(state.currentTownId) +
            '/forum/threads/' + encodeURIComponent(threadId) + '/votes', {
      method: 'POST',
      body: { optionId: optionId },
    })
      .then(function (res) {
        if (!res || !res.tally) return;
        detail.tally = res.tally;
        detail.thread.voteCount = res.tally.total;
        upsertThreadSummary(detail.thread);
        renderThreadView();
        toast('Vote enregistré.', 'success');
      })
      .catch(function (err) {
        toast(err.message || 'Vote refusé', 'error');
      });
  }

  function onSubmitReply(event) {
    event.preventDefault();
    var detail = state.forum.openThreadDetail;
    if (!detail || !state.currentTownId) return;
    var textarea = event.target.body;
    var body = textarea.value.trim();
    var error = $('thread-reply-error');
    error.hidden = true;
    if (!body) {
      error.textContent = 'Votre message ne peut pas être vide.';
      error.hidden = false;
      return;
    }
    apiCall('/towns/' + encodeURIComponent(state.currentTownId) +
            '/forum/threads/' + encodeURIComponent(detail.thread.id) + '/messages', {
      method: 'POST',
      body: { body: body },
    })
      .then(function (res) {
        if (!res || !res.message) return;
        // Le WS va aussi notifier ; on évite le doublon en s'appuyant sur
        // onForumMessagePosted qui contrôle l'unicité via l'id.
        onForumMessagePosted(detail.thread.id, res.message);
        textarea.value = '';
      })
      .catch(function (err) {
        error.textContent = err.message || 'Envoi impossible';
        error.hidden = false;
      });
  }

  function onClickCloseThread() {
    var detail = state.forum.openThreadDetail;
    if (!detail || !state.currentTownId) return;
    if (!window.confirm('Clore ce sujet ? Plus aucune réponse ni vote ne sera accepté.')) return;
    apiCall('/towns/' + encodeURIComponent(state.currentTownId) +
            '/forum/threads/' + encodeURIComponent(detail.thread.id) + '/close', {
      method: 'POST',
    })
      .then(function (res) {
        if (!res || !res.thread) return;
        detail.thread = Object.assign({}, detail.thread, res.thread);
        upsertThreadSummary(detail.thread);
        renderThreadView();
        toast('Sujet clos.', 'success');
      })
      .catch(function (err) {
        toast(err.message || 'Fermeture impossible', 'error');
      });
  }

  /**
   * Récupère le subject (accountId) du JWT courant en décodant son payload.
   * Le serveur reste la source de vérité pour les autorisations — on ne s'en
   * sert que pour décider d'afficher ou non le bouton « Clore le sujet ».
   */
  function currentAccountId() {
    var token = state.accessToken;
    if (!token) return null;
    var parts = token.split('.');
    if (parts.length < 2) return null;
    try {
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      var pad = b64.length % 4;
      if (pad) b64 += new Array(5 - pad).join('=');
      var payload = JSON.parse(atob(b64));
      return payload && payload.sub ? String(payload.sub) : null;
    } catch (err) {
      return null;
    }
  }

  /* =========================================================================
   *  Bandeau de configuration de l'API
   * =======================================================================*/

  function setupApiBanner() {
    var form = $('api-config-form');
    var hint = $('api-banner-hint');
    var input = $('api-url-input');
    input.value = state.apiUrl || DEFAULT_LOCAL_API;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var url = String(input.value || '').trim();
      if (!url) return;
      hint.textContent = 'Test en cours…';
      hint.removeAttribute('data-state');
      fetch(url.replace(/\/+$/, '') + '/health', { method: 'GET' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function () {
          setApiUrl(url);
          hint.textContent = 'Backend joignable. Vous pouvez vous connecter.';
          hint.setAttribute('data-state', 'success');
          hide($('api-banner'));
          maybeRouteToScreen();
        })
        .catch(function (err) {
          hint.textContent = 'Échec : ' + (err && err.message ? err.message : 'serveur injoignable');
          hint.setAttribute('data-state', 'error');
        });
    });
  }

  function probeApi() {
    return fetch(state.apiUrl + '/health', { method: 'GET' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
  }

  /* =========================================================================
   *  Démarrage
   * =======================================================================*/

  /**
   * Tente une reconnexion silencieuse via le cookie HTTPonly de refresh, puis
   * récupère le profil pour vérifier la validité du token et resynchroniser
   * l'email affiché. Renvoie une promesse qui résout en `true` si on dispose
   * d'un accessToken utilisable, `false` sinon.
   */
  function ensureAuthenticated() {
    if (state.accessToken) {
      return apiCall('/auth/me')
        .then(function (me) {
          if (me && me.email) {
            state.accountEmail = me.email;
            lsSet(EMAIL_KEY, me.email);
            refreshAccountUI();
          }
          return true;
        })
        .catch(function () {
          // Le retry via tryRefreshAndRetry est déjà tenté dans apiCall.
          // Si on échoue ici, on considère la session perdue.
          state.accessToken = null;
          state.accountEmail = null;
          lsSet(TOKEN_KEY, null);
          lsSet(EMAIL_KEY, null);
          refreshAccountUI();
          return false;
        });
    }
    // Pas d'accessToken : on tente d'en obtenir un via le cookie refresh.
    return fetch(state.apiUrl + '/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    })
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.accessToken) return false;
        state.accessToken = data.accessToken;
        lsSet(TOKEN_KEY, data.accessToken);
        return apiCall('/auth/me').then(function (me) {
          if (me && me.email) {
            state.accountEmail = me.email;
            lsSet(EMAIL_KEY, me.email);
          }
          refreshAccountUI();
          return true;
        });
      })
      .catch(function () { return false; });
  }

  function maybeRouteToScreen() {
    var savedTown = lsGet(TOWN_KEY);
    ensureAuthenticated().then(function (ok) {
      if (!ok) {
        showScreen('auth');
        return;
      }
      if (savedTown) {
        apiCall('/towns/' + encodeURIComponent(savedTown))
          .then(function (town) {
            if (town && town.yourCitizenId) {
              enterTown(town.id, town);
            } else {
              enterLobby();
            }
          })
          .catch(function (err) {
            if (err.status === 401) {
              logout();
            } else {
              lsSet(TOWN_KEY, null);
              enterLobby();
            }
          });
      } else {
        enterLobby();
      }
    });
  }

  function boot() {
    screens.auth = $('screen-auth');
    screens.lobby = $('screen-lobby');
    screens.town = $('screen-town');

    state.apiUrl = detectDefaultApiUrl();
    state.accessToken = lsGet(TOKEN_KEY);
    state.accountEmail = lsGet(EMAIL_KEY);

    setupAuthUI();
    setupProfileUI();
    setupLobbyUI();
    setupTownUI();
    setupApiBanner();
    refreshAccountUI();

    $('logout-btn').addEventListener('click', logout);

    probeApi()
      .then(function () {
        maybeRouteToScreen();
      })
      .catch(function () {
        show($('api-banner'));
        // On affiche tout de même l'écran d'auth pour donner du contexte
        // au visiteur en attendant la configuration du backend.
        showScreen('auth');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
