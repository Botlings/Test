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
    refreshing: false,
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

    $('zone-town').addEventListener('click', function () { performMove('town'); });
    $('zone-desert').addEventListener('click', function () { performMove('desert'); });
    ['zone-town', 'zone-desert'].forEach(function (id) {
      $(id).addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          performMove(id === 'zone-town' ? 'town' : 'desert');
        }
      });
    });

    var actionsEl = $('actions');
    actionsEl.addEventListener('click', function (event) {
      var btn = event.target.closest('button[data-action]');
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      handleAction(action);
    });

    $('trigger-night-btn').addEventListener('click', triggerNight);
    $('close-night-modal-btn').addEventListener('click', closeNightModal);
    $('night-modal-overlay').addEventListener('click', closeNightModal);
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
  }

  function leaveTown() {
    closeSocket();
    state.currentTownId = null;
    state.town = null;
    state.yourCitizenId = null;
    lsSet(TOWN_KEY, null);
    var logList = $('event-log');
    if (logList) {
      logList.innerHTML = '<li class="log__empty">Le journal est vide. Agissez pour le remplir.</li>';
    }
    enterLobby();
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

  function renderMap(town) {
    var townTokens = $('zone-town-tokens');
    var desertTokens = $('zone-desert-tokens');
    townTokens.innerHTML = '';
    desertTokens.innerHTML = '';

    var citizens = town.citizens || [];
    var self = citizens.find(function (c) { return c.id === state.yourCitizenId; });

    citizens.forEach(function (c) {
      var token = document.createElement('span');
      var classes = 'token';
      if (c.id === state.yourCitizenId) classes += ' is-self';
      if (!c.alive) classes += ' is-dead';
      token.className = classes;
      token.innerHTML =
        '<span class="token__avatar">' + escapeHtml(initials(c.name)) + '</span>' +
        '<span class="token__name">' + escapeHtml(c.name) + '</span>';
      token.title = c.name + ' — ' + (c.alive ? (c.location === 'desert' ? 'dans le désert' : 'en ville') : (c.causeOfDeath || 'mort'));
      var container = c.location === 'desert' ? desertTokens : townTokens;
      container.appendChild(token);
    });

    var townZone = $('zone-town');
    var desertZone = $('zone-desert');
    townZone.classList.toggle('is-current', !!self && self.location === 'town');
    desertZone.classList.toggle('is-current', !!self && self.location === 'desert');

    var canMove = !!self && self.alive && town.phase === 'day' && !town.closed;
    townZone.classList.toggle('is-disabled', !canMove);
    desertZone.classList.toggle('is-disabled', !canMove);

    var hint = $('map-hint');
    if (town.phase === 'night') {
      hint.textContent = 'La nuit est tombée — les portes sont scellées.';
    } else if (!self || !self.alive) {
      hint.textContent = 'Aucun citoyen actif pour cette partie.';
    } else if (self.location === 'town') {
      hint.textContent = 'Vous êtes en ville. Sortez dans le désert pour fouiller.';
    } else {
      hint.textContent = 'Vous êtes dans le désert. Rentrez avant la nuit !';
    }
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
            logEvent('Vous avez fouillé : +' + 4 + ' bois, +2 métal, +1 eau.', 'success');
            break;
          case 'build':
            logEvent('Vous avez bâti une défense (+6).', 'success');
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
      '<div class="report-row"><span>Défense de la ville</span><strong>' + report.townDefense + '</strong></div>' +
      '<div class="report-row"><span>Survivants après la nuit</span><strong>' + report.survivors + '</strong></div>';
    var deathsHtml = '';
    if (report.deaths && report.deaths.length) {
      deathsHtml = '<h3 style="margin-top:0.6rem">Pertes (' + report.deaths.length + ')</h3><ul class="report-deaths">';
      report.deaths.forEach(function (d) {
        deathsHtml += '<li><strong>' + escapeHtml(d.name) + '</strong> — ' + escapeHtml(d.cause) + '</li>';
      });
      deathsHtml += '</ul>';
    }
    body.innerHTML = verdict + rows + deathsHtml;
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
      case 'build.completed':
        applyBuildCompleted(msg);
        break;
      case 'night.start':
        logEvent('☾ La nuit du jour ' + msg.day + ' commence — les portes se referment.', 'warning');
        break;
      case 'night.report':
        logEvent('Rapport de la nuit ' + msg.day + ' : ' + msg.report.deaths.length + ' pertes.',
          msg.report.breached ? 'danger' : 'success');
        showNightReport(msg.report);
        // Le snapshot serveur arrivera ensuite et rafraîchira l'état complet.
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

  function applyBuildCompleted(msg) {
    if (!state.town) return;
    state.town.townDefense = msg.defense;
    $('defense-value').textContent = String(msg.defense);
    logEvent('Un chantier est terminé. Défense : ' + msg.defense + '.', 'success');
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
