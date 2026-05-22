/**
 * Page d'accueil de Hordes Revival — interactions légères.
 *
 * - Bascule jour / nuit du thème (gimmick fidèle au cycle du jeu).
 * - Mémorise le choix dans localStorage.
 * - Renseigne l'année courante dans le pied de page.
 */
'use strict';

(function () {
  var STORAGE_KEY = 'hordes-revival:theme';
  var body = document.body;
  var toggle = document.getElementById('theme-toggle');

  /** Applique le thème ('day' ou 'night') à la page et au bouton. */
  function applyTheme(theme) {
    var isDay = theme === 'day';
    body.classList.toggle('theme-day', isDay);

    if (toggle) {
      var icon = toggle.querySelector('.theme-toggle__icon');
      var label = toggle.querySelector('.theme-toggle__label');
      toggle.setAttribute('aria-pressed', isDay ? 'true' : 'false');
      if (icon) {
        icon.textContent = isDay ? '☀' : '☾';
      }
      if (label) {
        label.textContent = isDay ? 'Jour' : 'Nuit';
      }
    }
  }

  // Thème initial : choix mémorisé, sinon nuit (ambiance par défaut du jeu).
  var stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    stored = null;
  }
  applyTheme(stored === 'day' ? 'day' : 'night');

  if (toggle) {
    toggle.addEventListener('click', function () {
      var nextTheme = body.classList.contains('theme-day') ? 'night' : 'day';
      applyTheme(nextTheme);
      try {
        localStorage.setItem(STORAGE_KEY, nextTheme);
      } catch (err) {
        /* localStorage indisponible : on ignore, le thème reste appliqué. */
      }
    });
  }

  // Année du pied de page.
  var yearEl = document.getElementById('year');
  if (yearEl) {
    yearEl.textContent = String(new Date().getFullYear());
  }
})();
