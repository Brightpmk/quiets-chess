import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const SHORT_PGN = '[Event "Example match"]\n[White "Ada"]\n[Black "Ben"]\n[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1';
const LONG_PGN = '[White "Paul Morphy"]\n\n1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0';

test('native candidate controls switch count and arrows, including a forced reply', async ({page}) => {
  test.skip(process.env.RUN_STOCKFISH_TESTS !== '1', 'Requires running backend with Stockfish 19');
  await page.goto('/');
  const rows = page.locator('.candidate-item');
  const arrows = page.getByTestId('chessboard').locator('path[marker-end]');
  const count = page.getByLabel('Candidate lines');
  await count.selectOption('3');
  await expect(rows).toHaveCount(3);
  await expect(arrows).toHaveCount(3);
  expect(new Set(await arrows.evaluateAll(paths => paths.map(path => path.getAttribute('stroke')))).size).toBe(3);
  expect(await page.evaluate(() => {
    const headline = document.querySelector('[data-testid="evaluation"]')?.textContent;
    const best = document.querySelector('.candidate-item .candidate-score')?.textContent;
    return !!best && headline === best;
  })).toBe(true);
  await page.getByLabel('Show best-move arrows').uncheck();
  await expect(arrows).toHaveCount(0);
  await expect(rows).toHaveCount(3);
  await page.getByLabel('Show best-move arrows').check();
  await count.selectOption('1');
  await expect(rows).toHaveCount(1);
  await count.selectOption('3');
  await page.getByLabel('FEN to import').fill('7k/6Q1/4K3/8/8/8/8/8 b - - 0 1');
  await page.getByRole('button', {name: 'Load FEN'}).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Kxg7');
  await expect(arrows).toHaveCount(1);
});

test('hides streaming arrows without restarting analysis and remembers the choice', async ({page}) => {
  test.skip(process.env.RUN_STOCKFISH_TESTS !== '1', 'Requires running backend with Stockfish 19');
  await page.setViewportSize({width: 375, height: 812});
  const requests: string[] = [];
  page.on('websocket', ws => ws.on('framesent', ({payload}) => {
    const packet = JSON.parse(payload.toString());
    if (packet.type === 'analyze') requests.push(packet.request_id);
  }));
  const connecting = page.waitForEvent('websocket');
  await page.goto('/');
  const ws = await connecting;
  await page.getByRole('button', {name: 'Deep 10 seconds'}).click();
  const arrows = page.getByTestId('chessboard').locator('path[marker-end]');
  const toggle = page.getByRole('checkbox', {name: 'Show best-move arrows'});
  await expect(arrows).toHaveCount(1);
  const active = requests.at(-1);
  await toggle.uncheck();
  await expect(arrows).toHaveCount(0);
  await ws.waitForEvent('framereceived', {predicate: ({payload}) => {
    const packet = JSON.parse(payload.toString());
    return packet.type === 'analysis' && packet.request_id === active && !packet.done;
  }});
  expect(requests.at(-1)).toBe(active);
  await expect(page.getByTestId('principal-variation')).toBeVisible();
  await expect(page.getByTestId('evaluation')).not.toHaveText('—');
  await page.getByTestId('chessboard').locator('[data-square="e2"]').click();
  await page.getByTestId('chessboard').locator('[data-square="e4"]').click();
  await expect(page.getByTestId('principal-variation')).toBeVisible();
  await expect(arrows).toHaveCount(0);
  await page.reload();
  await expect(toggle).not.toBeChecked();
});

test('imports a PGN file, reviews it, navigates with the graph, and exports JSON on mobile', async ({page}) => {
  test.skip(process.env.RUN_STOCKFISH_TESTS !== '1', 'Requires running backend with Stockfish 19');
  await page.setViewportSize({width: 375, height: 812});
  await page.goto('/');
  await page.getByRole('button', {name: 'Game Review', exact: true}).click();
  await page.getByLabel('Choose a game PGN file').setInputFiles({name: 'game.pgn', mimeType: 'application/x-chess-pgn',
    buffer: Buffer.from(SHORT_PGN)});
  await expect(page.getByRole('textbox', {name: 'Game PGN', exact: true})).toHaveValue(SHORT_PGN);
  await page.getByRole('button', {name: 'Run review', exact: true}).click();
  await expect(page.getByRole('progressbar', {name: 'Review progress'})).toHaveAttribute('value', '4', {timeout: 20000});
  const summary = page.getByRole('region', {name: 'Review summary'});
  await expect(summary).toContainText('Ada');
  await expect(summary).toContainText('Ben');
  await expect(summary).toContainText(/\d+\.\d+%/);
  await page.getByText('PGN metadata').click();
  await expect(summary).toContainText('Example match');
  await expect(page.getByTestId('review-board')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const graph = page.getByTestId('evaluation-graph');
  await expect(graph.locator('.graph-point')).toHaveCount(5);
  await graph.locator('.graph-point').last().click();
  const selected = page.getByRole('region', {name: 'Selected move'});
  await expect(selected).toContainText('Qh4#');
  await expect(selected).toContainText('Recommended continuation');
  await page.getByRole('list', {name: 'Review move list'}).getByRole('button', {name: /f3/}).click();
  await expect(selected).toContainText('Best alternative');
  await expect(page.getByRole('slider', {name: 'Evaluated ply'})).toHaveValue('1');
  const download = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Export JSON'}).click();
  const file = await download;
  const result = JSON.parse(await readFile(await file.path(), 'utf8'));
  expect(result.status).toBe('complete');
  expect(result.moves).toHaveLength(4);
  expect(result.settings.engine).toContain('Stockfish 19');
  expect(result.accuracy.white).toBeLessThan(result.accuracy.black);
  await page.getByRole('button', {name: 'Analyze position'}).click();
  await expect(page.getByTestId('position-status')).toHaveText('Black to move');
  await expect(page.getByTestId('principal-variation')).toBeVisible({timeout: 10000});
  await page.getByRole('button', {name: 'Game Review', exact: true}).click();
  await expect(summary).toContainText('Ada');
});

test('cancels live review, reports invalid PGN, and replaces provisional results', async ({page}) => {
  test.skip(process.env.RUN_STOCKFISH_TESTS !== '1', 'Requires running backend with Stockfish 19');
  await page.goto('/');
  await page.getByRole('button', {name: 'Game Review', exact: true}).click();
  const pgn = page.getByRole('textbox', {name: 'Game PGN', exact: true});
  // Keep the chess position and legal moves while avoiding a warmed game-review cache.
  const now = Date.now();
  const offset = now % 73;
  const halfmove = Math.floor(now / 73) % 24;
  const uncached = LONG_PGN.replace(/\b(\d+)\./g, (_, number) => `${Number(number) + offset}.`)
    .replace('\n\n', `\n[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - ${halfmove} ${offset + 1}"]\n\n`);
  await pgn.fill(uncached);
  await page.getByLabel('Analysis quality').selectOption('deep');
  await page.getByRole('button', {name: 'Run review', exact: true}).click();
  await page.getByRole('button', {name: 'Cancel review'}).click();
  await expect(page.getByText('Cancelled', {exact: true})).toBeVisible();
  const summary = page.getByRole('region', {name: 'Review summary'});
  await expect(summary).toContainText('Accuracy pending');
  await page.getByRole('button', {name: 'Retry previous review'}).click();
  await expect(page.getByRole('button', {name: 'Replace review'})).toBeVisible();
  await pgn.fill('1. z9 *');
  await page.getByRole('button', {name: 'Replace review'}).click();
  await expect(page.getByRole('alert').filter({hasText: 'Invalid move'})).toBeVisible();
  await pgn.fill(SHORT_PGN);
  await page.getByLabel('Analysis quality').selectOption('quick');
  await page.getByRole('button', {name: 'Replace review'}).click();
  await expect(page.getByText('Complete', {exact: true})).toBeVisible({timeout: 20000});
  await expect(summary).toContainText('Ada');
  await expect(summary).not.toContainText('Paul Morphy');
});
