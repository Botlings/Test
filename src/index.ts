/**
 * Démonstration jouable en console du moteur de jeu de Hordes Revival.
 *
 * Lance une partie scriptée de quelques jours : deux bâtisseurs renforcent la
 * ville pendant qu'un éclaireur fouille le désert pour réapprovisionner la
 * banque, puis chaque nuit la horde est résolue.
 *
 * Exécution : `npm run demo`
 */
import { Game, GameRuleError } from './domain/index.js';

function printStatus(game: Game): void {
  const s = game.status();
  const alive = s.citizens.filter((c) => c.alive).map((c) => c.name);
  console.log(
    `  Jour ${s.day} | défense ${s.townDefense} | horde cette nuit ${s.hordePowerTonight} | ` +
      `banque bois:${s.bank.wood} métal:${s.bank.metal} eau:${s.bank.water}`,
  );
  console.log(`  Survivants (${alive.length}) : ${alive.join(', ') || '—'}`);
}

function main(): void {
  const game = new Game();
  const builders = [game.addCitizen('Alia'), game.addCitizen('Bjorn')];
  const scout = game.addCitizen('Cyrus');

  console.log('=== Hordes Revival — partie de démonstration ===\n');

  for (let turn = 0; turn < 6 && !game.gameOver; turn++) {
    printStatus(game);

    // L'éclaireur part fouiller le désert puis rentre se mettre à l'abri.
    if (scout.alive) {
      game.setLocation(scout.id, 'desert');
      while (game.status().citizens.find((c) => c.id === scout.id)!.actionPoints >= 2) {
        game.scavenge(scout.id);
      }
      game.setLocation(scout.id, 'town');
    }

    // Les bâtisseurs renforcent la ville tant qu'ils ont des PA et des ressources.
    for (const builder of builders) {
      if (!builder.alive) {
        continue;
      }
      try {
        let live = game.status().citizens.find((c) => c.id === builder.id)!;
        while (live.alive && live.actionPoints >= 1) {
          game.build(builder.id);
          live = game.status().citizens.find((c) => c.id === builder.id)!;
        }
      } catch (err) {
        if (!(err instanceof GameRuleError)) {
          throw err;
        }
        // Plus de ressources pour construire : on passe la main.
      }
    }

    const report = game.endDay();
    const verdict = report.breached ? 'PERCÉE' : 'tenue';
    console.log(
      `  >> Nuit ${report.day} : horde ${report.hordePower} vs défense ${report.townDefense} — ${verdict}.`,
    );
    for (const death of report.deaths) {
      console.log(`     ✝ ${death.name} — ${death.cause}.`);
    }
    console.log('');
  }

  if (game.gameOver) {
    console.log(`La ville est tombée. Elle aura tenu ${game.day} jour(s).`);
  } else {
    console.log(`La ville tient toujours au jour ${game.day}. ${game.aliveCount} survivant(s).`);
  }
}

main();
