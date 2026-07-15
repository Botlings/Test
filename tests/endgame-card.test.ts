/**
 * Carte de fin de partie partageable (src/domain/endgame-card.ts).
 *
 * Vérifie la synthèse pure : titre déterministe selon l'issue, agrégation des
 * objets / bâtiments (ids inconnus ignorés, tri par abondance), libellés de
 * rôle et de difficulté, et texte de partage cohérent avec l'issue.
 */
import { describe, expect, it } from 'vitest';
import {
  buildEndgameCard,
  survivorTitle,
  difficultyLabel,
  type EndgameCardInput,
} from '../src/domain/endgame-card.js';

function makeInput(overrides: Partial<EndgameCardInput> = {}): EndgameCardInput {
  return {
    townName: 'Fort Aride',
    difficulty: 'hard',
    outcome: 'ongoing',
    gameOver: false,
    daysSurvived: 4,
    survivalDays: 7,
    survivors: 12,
    population: 20,
    role: 'citizen',
    citizenName: 'Alia',
    citizenAlive: true,
    causeOfDeath: null,
    buildings: {},
    items: {},
    ...overrides,
  };
}

describe('survivorTitle — paliers déterministes', () => {
  it('donne un titre de victoire selon la survie du citoyen', () => {
    expect(survivorTitle('victory', 7, true)).toBe('Sauveur légendaire');
    expect(survivorTitle('victory', 7, false)).toBe('Martyr triomphant');
  });

  it('monte par paliers de nuits hors victoire', () => {
    expect(survivorTitle('ongoing', 0, true)).toBe('Recrue du désert');
    expect(survivorTitle('ongoing', 1, true)).toBe('Survivant');
    expect(survivorTitle('defeat', 3, false)).toBe('Éclaireur endurci');
    expect(survivorTitle('defeat', 5, false)).toBe('Survivant aguerri');
    expect(survivorTitle('defeat', 9, false)).toBe('Vétéran des hordes');
  });
});

describe('difficultyLabel', () => {
  it('traduit les difficultés connues et retombe sur la valeur brute', () => {
    expect(difficultyLabel('normal')).toBe('Normal');
    expect(difficultyLabel('hard')).toBe('Difficile');
    expect(difficultyLabel('hardcore')).toBe('Extrême');
    expect(difficultyLabel('inconnu')).toBe('inconnu');
  });
});

describe('buildEndgameCard — agrégation objets / bâtiments', () => {
  it('résout les ids connus, ignore les inconnus et trie par abondance', () => {
    const card = buildEndgameCard(
      makeInput({
        items: { rope: 3, 'steel-beam': 1, 'ghost-item': 99 },
        buildings: { watchtower: 2, 'phantom-hall': 5 },
      }),
    );
    expect(card.totalItems).toBe(4); // 3 + 1 ; l'id inconnu est ignoré
    expect(card.items.map((e) => e.id)).toEqual(['rope', 'steel-beam']);
    expect(card.items[0]).toMatchObject({ id: 'rope', count: 3, name: 'Corde' });
    expect(card.totalBuildings).toBe(2);
    expect(card.buildings.map((e) => e.id)).toEqual(['watchtower']);
    expect(card.buildings[0]).toMatchObject({ id: 'watchtower', name: 'Tour de guet' });
  });

  it('ignore les compteurs nuls ou négatifs', () => {
    const card = buildEndgameCard(makeInput({ items: { rope: 0, toolbox: -2 } }));
    expect(card.totalItems).toBe(0);
    expect(card.items).toHaveLength(0);
  });
});

describe('buildEndgameCard — rôles et libellés', () => {
  it('expose un libellé de rôle lisible', () => {
    expect(buildEndgameCard(makeInput({ role: 'founder' })).roleLabel).toBe('Fondateur');
    expect(buildEndgameCard(makeInput({ role: 'manager' })).roleLabel).toBe('Gestionnaire de banque');
    expect(buildEndgameCard(makeInput({ role: 'citizen' })).roleLabel).toBe('Citoyen');
  });
});

describe('buildEndgameCard — texte de partage selon l\'issue', () => {
  it('victoire : met en avant le sauvetage et le titre', () => {
    const card = buildEndgameCard(makeInput({ outcome: 'victory', daysSurvived: 7 }));
    expect(card.title).toBe('Sauveur légendaire');
    expect(card.shareText).toContain('sauvé Fort Aride');
    expect(card.shareText).toContain('7 nuits');
    expect(card.shareText).toContain('Sauveur légendaire');
    expect(card.shareText).toContain('#HordesRevival');
    expect(card.subtitle).toContain('victoire');
  });

  it('défaite : annonce la chute de la ville', () => {
    const card = buildEndgameCard(
      makeInput({ outcome: 'defeat', daysSurvived: 3, citizenAlive: false, causeOfDeath: 'percée' }),
    );
    expect(card.title).toBe('Éclaireur endurci');
    expect(card.shareText).toContain('est tombée après 3 nuits');
    expect(card.subtitle).toContain('tombée à la nuit 3');
    expect(card.flavor.length).toBeGreaterThan(0);
  });

  it('partie en cours : invite à rejoindre', () => {
    const card = buildEndgameCard(makeInput({ outcome: 'ongoing', daysSurvived: 1 }));
    expect(card.shareText).toContain('1 nuit');
    expect(card.shareText).not.toContain('1 nuits');
    expect(card.subtitle).toContain('Toujours en vie');
  });
});
