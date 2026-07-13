/**
 * Cycle jour / nuit — Hordes Revival (DA « Lonesome Road / CRT », 2026-07-12).
 *
 * Pose l'attribut `data-phase` ("day" | "night") sur <body>. Ce seul attribut
 * commute la TEMPÉRATURE du monde (pas un assombrissement) : JOUR = désert
 * brûlant sable/rouille, NUIT = apocalypse rouge sang/cimetière. Tout vit dans
 * styles.css (tokens réécrits par phase).
 *
 * ⚠ RÉPARTITION DES RÔLES sur `data-phase` :
 *   • Landing publique → CE module pilote la phase (horloge « auto » + bascule
 *     manuelle auto → jour → nuit → auto, mémorisée en localStorage).
 *   • Ville (game.html, présence de `.game-body`) → c'est game.js qui pose
 *     `data-phase` depuis la phase de jeu RÉELLE. Ce module se met alors en
 *     retrait (ni application horloge, ni bascule, ni intervalle) pour ne pas
 *     entrer en conflit avec la partie.
 *
 * Les panneaux .terminal (vert phosphore) déclarent leurs propres tokens et
 * ne dépendent pas de ce cycle.
 */
'use strict';

(function () {
  var PREF_KEY = 'hordes-revival:phase'; // '' / absent = auto ; sinon 'day' | 'night'
  var DAY_START = 6; // 06:00 → jour (désert brûlant)
  var NIGHT_START = 20; // 20:00 → nuit (invasion zombie) ; nuit = 20 h → 6 h

  /** Phase d'ambiance déduite de l'heure locale du joueur. */
  function clockDaytime() {
    var h = new Date().getHours();
    return h >= DAY_START && h < NIGHT_START ? 'day' : 'night';
  }

  function readPref() {
    try {
      var v = localStorage.getItem(PREF_KEY);
      return v === 'day' || v === 'night' ? v : 'auto';
    } catch (err) {
      return 'auto';
    }
  }

  function writePref(mode) {
    try {
      if (mode === 'auto') localStorage.removeItem(PREF_KEY);
      else localStorage.setItem(PREF_KEY, mode);
    } catch (err) {
      /* localStorage indisponible : la session reste cohérente en mémoire. */
    }
  }

  /** Phase effective à appliquer selon le mode courant. */
  function resolve(mode) {
    return mode === 'auto' ? clockDaytime() : mode;
  }

  function apply(daytime) {
    if (document.body) document.body.setAttribute('data-phase', daytime);
  }

  /** Sur la page « ville », game.js pilote data-phase : on ne fait rien. */
  function isGamePage() {
    return !!(document.body && document.body.classList.contains('game-body'));
  }

  // ── Bouton de bascule ─────────────────────────────────────────
  // Cycle : auto → jour → nuit → auto.
  var ORDER = ['auto', 'day', 'night'];
  var ICON = { day: '☀', night: '☾' };

  function describe(mode, daytime) {
    var icon = ICON[daytime] || '☀';
    if (mode === 'auto') return { icon: icon, label: 'Auto', aria: 'Ambiance : automatique (heure locale). Cliquer pour forcer le jour.' };
    if (mode === 'day') return { icon: '☀', label: 'Jour', aria: 'Ambiance : jour forcé. Cliquer pour forcer la nuit.' };
    return { icon: '☾', label: 'Nuit', aria: 'Ambiance : nuit forcée. Cliquer pour repasser en automatique.' };
  }

  function findSlot() {
    return (
      document.querySelector('[data-daynight-slot]') ||
      document.querySelector('.site-nav') ||
      document.querySelector('.game-header__account') ||
      document.querySelector('header') ||
      document.body
    );
  }

  function buildToggle() {
    var slot = findSlot();
    if (!slot) return null;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'daynight-toggle';

    var iconEl = document.createElement('span');
    iconEl.className = 'daynight-toggle__icon';
    iconEl.setAttribute('aria-hidden', 'true');

    var labelEl = document.createElement('span');
    labelEl.className = 'daynight-toggle__label';

    btn.appendChild(iconEl);
    btn.appendChild(labelEl);

    // Sur la ville, on place la bascule en tête de la zone compte ;
    // ailleurs (nav publique, header générique) on l'ajoute en fin.
    if (slot.classList && slot.classList.contains('game-header__account') && slot.firstChild) {
      slot.insertBefore(btn, slot.firstChild);
    } else {
      slot.appendChild(btn);
    }

    return { btn: btn, iconEl: iconEl, labelEl: labelEl };
  }

  // ── Orchestration ─────────────────────────────────────────────
  function init() {
    // En ville, game.js est seul maître de data-phase : on se retire.
    if (isGamePage()) return;

    var mode = readPref();
    apply(resolve(mode));

    var ui = buildToggle();

    function refreshUi() {
      if (!ui) return;
      var daytime = resolve(mode);
      var d = describe(mode, daytime);
      ui.iconEl.textContent = d.icon;
      ui.labelEl.textContent = d.label;
      ui.btn.setAttribute('aria-label', d.aria);
      ui.btn.title = d.aria;
    }

    refreshUi();

    if (ui) {
      ui.btn.addEventListener('click', function () {
        var next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
        mode = next;
        writePref(mode);
        apply(resolve(mode));
        refreshUi();
      });
    }

    // En mode auto, suivre l'horloge (passage jour/nuit sans recharger).
    window.setInterval(function () {
      if (mode !== 'auto') return;
      apply(resolve(mode));
      refreshUi();
    }, 60 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
