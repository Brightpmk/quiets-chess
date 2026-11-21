import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

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
  await (await square(page, 'a7')).click(); await (await square(page, 'a8')).click();
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
