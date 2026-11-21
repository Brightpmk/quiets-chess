import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function square(page: Page, name: string) {
  return page.getByTestId('chessboard').locator(`[data-square="${name}"]`).first();
}
async function loadFen(page: Page, fen: string) {
  await page.getByLabel('FEN to import').fill(fen);
  await page.getByRole('button', {name: 'Load FEN', exact: true}).click();
}

test('board interaction, illegal moves, drag, undo/redo and flip', async ({page}) => {
  await page.goto('/');
  await (await square(page, 'e2')).click(); await (await square(page, 'e5')).click();
  await expect(page.getByTestId('move-list')).toContainText('Make a move');
  // Actual pointer drag verifies the react-chessboard drop callback.
  const source = await (await square(page, 'e2')).boundingBox();
  const target = await (await square(page, 'e4')).boundingBox();
  if (!source || !target) throw new Error('Board squares missing');
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {steps: 10});
  await page.mouse.up();
  await expect(page.getByTestId('move-list')).toContainText('e4');
  await expect(page.getByTestId('position-status')).toHaveText('Black to move');
  await page.getByRole('button', {name: 'Undo move', exact: true}).click();
  await expect(page.getByTestId('position-status')).toHaveText('White to move');
  await page.getByRole('button', {name: 'Redo move', exact: true}).click();
  await expect(page.getByTestId('position-status')).toHaveText('Black to move');
  const before = await (await square(page, 'a1')).boundingBox();
  await page.getByRole('button', {name: 'Flip board', exact: true}).click();
  const after = await (await square(page, 'a1')).boundingBox();
  expect(after!.y).toBeLessThan(before!.y);
});

test('PGN import/export and invalid FEN feedback', async ({page}) => {
  await page.goto('/');
  await loadFen(page, 'invalid fen');
  await expect(page.getByRole('alert').filter({hasText: /fen/i})).toBeVisible();
  await page.locator('.import-tabs').getByRole('button', {name: 'PGN'}).click();
  await page.getByLabel('PGN to import').fill('[Event "Test"]\n\n1. e4 e5 2. Nf3 Nc6 *');
  await page.getByRole('button', {name: 'Load PGN', exact: true}).click();
  await expect(page.getByTestId('move-list')).toContainText('Nc6');
  const download = page.waitForEvent('download');
  await page.locator('.export-buttons').getByRole('button', {name: 'PGN', exact: true}).click();
  expect((await download).suggestedFilename()).toBe('analysis.pgn');
});

test('promotion lets the user choose a knight', async ({page}) => {
  await page.goto('/'); await loadFen(page, '7k/P7/8/8/8/8/8/7K w - - 0 1');
  const source = await square(page, 'a7');
  const target = await square(page, 'a8');
  await expect(target.locator('[data-piece]')).toHaveCount(0);
  await source.locator('[data-piece="wP"]').click();
  await target.click();
  await page.getByRole('button', {name: 'Promote to Knight'}).click();
  await expect(page.getByTestId('move-list')).toContainText('a8=N');
});

test('mobile layout fits the viewport', async ({page}) => {
  await page.setViewportSize({width: 375, height: 812}); await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByTestId('chessboard')).toBeVisible();
});

test('live native engine streams a PV after position changes', async ({page}) => {
  test.skip(process.env.RUN_STOCKFISH_TESTS !== '1', 'Requires running backend with Stockfish 19');
  await page.goto('/');
  await expect(page.getByTestId('principal-variation')).toBeVisible({timeout: 20000});
  await (await square(page, 'e2')).click(); await (await square(page, 'e4')).click();
  await expect(page.getByTestId('position-status')).toHaveText('Black to move');
  await expect(page.getByTestId('principal-variation')).toBeVisible({timeout: 10000});
  await expect(page.getByTestId('evaluation')).not.toHaveText('—');
});

test('edits an earlier position independently and validates a new custom root', async ({page}) => {
  test.skip(process.env.RUN_STOCKFISH_TESTS !== '1', 'Requires running backend with Stockfish 19');
  await page.setViewportSize({width: 390, height: 844});
  const packets: {type: string; root_fen?: string; moves?: string[]}[] = [];
  page.on('websocket', ws => ws.on('framesent', ({payload}) => packets.push(JSON.parse(payload.toString()))));
  await page.goto('/');
  await page.locator('.import-tabs').getByRole('button', {name: 'PGN'}).click();
  await page.getByLabel('PGN to import').fill('1. e4 e5 *');
  await page.getByRole('button', {name: 'Load PGN'}).click();
  await page.getByRole('button', {name: 'Undo move'}).click();
  await page.getByRole('button', {name: 'Deep 10 seconds'}).click();
  await expect(page.getByRole('button', {name: 'Stop', exact: true})).toBeVisible();
  const openEditor = page.getByRole('button', {name: 'Set up position'});
  const editor = page.getByRole('dialog', {name: 'Set up position'});
  const draft = editor.getByLabel('Draft FEN');
  await openEditor.click();
  await expect(draft).toHaveValue(/4P3.* b KQkq - 0 1$/);
  await expect.poll(() => packets.at(-1)?.type).toBe('stop');
  const requestsBeforeEdits = packets.filter(packet => packet.type === 'analyze').length;
  await editor.getByRole('button', {name: 'Clear board'}).click();
  await editor.getByRole('button', {name: 'Apply position'}).click();
  await expect(editor.getByRole('alert')).toHaveText(/missing white king/);
  expect(packets.filter(packet => packet.type === 'analyze')).toHaveLength(requestsBeforeEdits);
  await editor.getByRole('button', {name: 'Starting position'}).click();
  await expect(draft).toHaveValue(/ w KQkq - 0 1$/);
  await editor.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(page.getByTestId('position-status')).toHaveText('Black to move');
  await expect(page.getByRole('button', {name: 'Redo move'})).toBeEnabled();
  await expect.poll(() => packets.at(-1)?.moves).toEqual(['e2e4']);

  await openEditor.click();
  await editor.getByRole('button', {name: 'Clear board'}).click();
  const choose = (name: string) => editor.getByRole('button', {name, exact: true}).click();
  const tap = (square: string) => editor.getByTestId('editor-board').locator(`[data-square="${square}"]`).click();
  await choose('White King'); await tap('e1');
  await choose('Black King'); await tap('e8');
  await choose('White Rook'); await tap('a3');
  await choose('Move pieces'); await tap('a3'); await tap('h1');
  await choose('Remove piece'); await tap('h1');
  await choose('White Rook'); await tap('h1');
  await choose('Black Pawn'); await tap('d5');
  await choose('White Pawn'); await tap('e5');
  await editor.getByLabel('White kingside').check();
  await editor.getByLabel('Side to move').selectOption('w');
  await editor.getByLabel('En passant target').selectOption('d6');
  await editor.getByLabel('Fullmove number').fill('31');
  const root = '4k3/8/8/3pP3/8/8/8/4K2R w K d6 0 31';
  await expect(draft).toHaveValue(root);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await editor.getByRole('button', {name: 'Copy FEN'}).click();
  await expect(editor.getByText('FEN copied.', {exact: true})).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(root);
  await editor.getByRole('button', {name: 'Apply position'}).click();
  await expect(editor).toBeHidden();
  await expect(page.getByTestId('position-status')).toHaveText('White to move');
  await expect(page.getByRole('button', {name: 'Redo move'})).toBeDisabled();
  await expect(page.getByTestId('move-list')).not.toContainText('e4');
  await expect.poll(() => packets.at(-1)).toMatchObject({type: 'analyze', root_fen: root, moves: []});
  await expect(page.getByTestId('principal-variation')).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.locator('.export-buttons').getByRole('button', {name: 'PGN', exact: true}).click();
  expect(await readFile(await (await downloaded).path(), 'utf8')).toContain(`[FEN "${root}"]`);

  await page.getByRole('button', {name: 'Stop', exact: true}).click();
  const count = packets.filter(packet => packet.type === 'analyze').length;
  await openEditor.click();
  await editor.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Analyze', exact: true})).toBeVisible();
  await expect(page.getByTestId('principal-variation')).toBeVisible();
  expect(packets.filter(packet => packet.type === 'analyze')).toHaveLength(count);
  await openEditor.click();
  await editor.getByRole('button', {name: 'Apply position'}).click();
  await expect(editor).toBeHidden();
  await expect.poll(() => packets.filter(packet => packet.type === 'analyze')).toHaveLength(count + 1);
});
