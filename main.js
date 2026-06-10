/**
 * Page d'accueil de Hordes Revival — interactions client.
 *
 * - Année courante dans le pied de page.
 * - Capture des inscriptions newsletter : validation client, anti-doublon
 *   et stockage local des emails capturés en attendant un vrai backend.
 *
 * Note : la landing publique est en thème Vault-Tec 60's (pas de bascule
 * CRT vert/ambre). Le skin PipBoy est réservé au terminal de jeu.
 */
'use strict';

(function () {
  var SUBS_KEY = 'hordes-revival:newsletter-subs';
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  // ── Année du pied de page ───────────────────────────────────
  var yearEl = document.getElementById('year');
  if (yearEl) {
    yearEl.textContent = String(new Date().getFullYear());
  }

  // ── Formulaire newsletter ───────────────────────────────────
  var form = document.getElementById('newsletter-form');
  var emailInput = document.getElementById('newsletter-email');
  var statusEl = document.getElementById('newsletter-status');
  var submitBtn = form ? form.querySelector('.newsletter__submit') : null;
  var submitLabel = submitBtn
    ? submitBtn.querySelector('.newsletter__submit-label')
    : null;

  function setStatus(message, state) {
    if (!statusEl) return;
    statusEl.textContent = message;
    if (state) {
      statusEl.setAttribute('data-state', state);
    } else {
      statusEl.removeAttribute('data-state');
    }
  }

  function readSubs() {
    try {
      var raw = localStorage.getItem(SUBS_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  function saveSub(email) {
    var subs = readSubs();
    subs.push({ email: email, at: new Date().toISOString() });
    try {
      localStorage.setItem(SUBS_KEY, JSON.stringify(subs));
      return true;
    } catch (err) {
      return false;
    }
  }

  function alreadySubscribed(email) {
    var subs = readSubs();
    for (var i = 0; i < subs.length; i++) {
      if (subs[i] && typeof subs[i].email === 'string' &&
          subs[i].email.toLowerCase() === email.toLowerCase()) {
        return true;
      }
    }
    return false;
  }

  // ── Classement global des villes ────────────────────────────
  // La landing étant statique (GitHub Pages), l'API de jeu vit sur une autre
  // origine. On réutilise la même clé localStorage que le terminal de jeu pour
  // connaître son URL ; à défaut, on tente l'origine courante. En cas d'échec
  // (API absente / hors-ligne), la section se replie proprement sur un message.
  var API_URL_KEY = 'hordes-revival:api-url';
  var DIFFICULTY_LABELS = { normal: 'Normal', hard: 'Difficile', hardcore: 'Hardcore' };

  function detectApiUrl() {
    try {
      var stored = localStorage.getItem(API_URL_KEY);
      if (stored) return String(stored).replace(/\/+$/, '');
    } catch (err) {
      /* localStorage indisponible : on continue avec la détection. */
    }
    var loc = window.location;
    if (loc.protocol === 'file:') return 'http://localhost:3000';
    if (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') {
      return loc.protocol + '//' + loc.hostname + ':3000';
    }
    return loc.origin;
  }

  function outcomeCell(outcome) {
    var span = document.createElement('span');
    span.className =
      'leaderboard__badge ' +
      (outcome === 'victory' ? 'leaderboard__badge--win' : 'leaderboard__badge--loss');
    span.textContent = outcome === 'victory' ? '★ Sauvée' : '☠ Tombée';
    return span;
  }

  function renderLeaderboard(entries) {
    var statusEl = document.getElementById('leaderboard-status');
    var table = document.getElementById('leaderboard-table');
    var body = document.getElementById('leaderboard-body');
    if (!statusEl || !table || !body) return;

    if (!entries.length) {
      statusEl.hidden = false;
      statusEl.textContent =
        'Aucune partie terminée pour l’instant — soyez la première ville à entrer dans la légende.';
      table.hidden = true;
      return;
    }

    body.textContent = '';
    entries.forEach(function (e) {
      var tr = document.createElement('tr');
      if (e.outcome === 'victory') tr.className = 'is-victory';

      var rank = document.createElement('td');
      rank.className = 'leaderboard__rank';
      rank.textContent = String(e.rank);

      var name = document.createElement('td');
      name.className = 'leaderboard__town';
      name.textContent = String(e.townName);

      var outcome = document.createElement('td');
      outcome.appendChild(outcomeCell(e.outcome));

      var nights = document.createElement('td');
      nights.className = 'leaderboard__num';
      nights.textContent = String(e.daysSurvived);

      var survivors = document.createElement('td');
      survivors.className = 'leaderboard__num';
      survivors.textContent = e.survivors + ' / ' + e.population;

      var diff = document.createElement('td');
      diff.textContent = DIFFICULTY_LABELS[e.difficulty] || e.difficulty;

      tr.appendChild(rank);
      tr.appendChild(name);
      tr.appendChild(outcome);
      tr.appendChild(nights);
      tr.appendChild(survivors);
      tr.appendChild(diff);
      body.appendChild(tr);
    });

    statusEl.hidden = true;
    table.hidden = false;
  }

  function loadLeaderboard() {
    var statusEl = document.getElementById('leaderboard-status');
    var table = document.getElementById('leaderboard-table');
    if (!statusEl || !table) return;

    var url = detectApiUrl() + '/leaderboard?limit=10';
    fetch(url, { method: 'GET' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var entries = data && Array.isArray(data.entries) ? data.entries : [];
        renderLeaderboard(entries);
      })
      .catch(function () {
        statusEl.hidden = false;
        statusEl.textContent =
          'Classement momentanément indisponible — le serveur de parties est hors ligne.';
        table.hidden = true;
      });
  }

  loadLeaderboard();

  if (form && emailInput) {
    emailInput.addEventListener('input', function () {
      if (emailInput.getAttribute('aria-invalid') === 'true') {
        emailInput.setAttribute('aria-invalid', 'false');
        setStatus('', null);
      }
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();

      var raw = emailInput.value;
      var email = typeof raw === 'string' ? raw.trim() : '';

      if (!email) {
        emailInput.setAttribute('aria-invalid', 'true');
        setStatus('Renseignez une adresse email pour vous inscrire.', 'error');
        emailInput.focus();
        return;
      }

      if (!EMAIL_RE.test(email)) {
        emailInput.setAttribute('aria-invalid', 'true');
        setStatus('Cette adresse email ne semble pas valide.', 'error');
        emailInput.focus();
        return;
      }

      if (alreadySubscribed(email)) {
        emailInput.setAttribute('aria-invalid', 'false');
        setStatus(
          'Cette adresse est déjà inscrite — on vous tient au courant.',
          'success'
        );
        return;
      }

      // Pseudo-soumission : feedback visuel court puis confirmation.
      if (submitBtn) submitBtn.disabled = true;
      if (submitLabel) submitLabel.textContent = 'Inscription…';
      setStatus('Enrôlement en cours…', null);

      window.setTimeout(function () {
        var saved = saveSub(email);

        if (submitBtn) submitBtn.disabled = false;
        if (submitLabel) submitLabel.textContent = 'M’inscrire';

        if (saved) {
          setStatus(
            'Bienvenue dans la ville. On vous écrit dès l’ouverture des portes.',
            'success'
          );
          form.reset();
        } else {
          setStatus(
            'Inscription enregistrée pour cette session. (Stockage local indisponible.)',
            'success'
          );
          form.reset();
        }
      }, 450);
    });
  }
})();
