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
