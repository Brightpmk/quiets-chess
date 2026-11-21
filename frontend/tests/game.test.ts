import test from 'node:test';
import assert from 'node:assert/strict';
import { exportPgn, gameAt, importPosition, initialLine, playMove } from '../src/game.ts';
test('legal moves accepted; illegal moves leave state untouched', () => {
  const initial = initialLine(); assert.equal(playMove(initial, 'e2', 'e5'), null);
  const next = playMove(initial, 'e2', 'e4')!;
  assert.equal(next.cursor, 1); assert.equal(initial.moves.length, 0); assert.equal(gameAt(next).turn(), 'b');
});
test('pinned pieces cannot expose their king', () => {
  const line = importPosition('4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1', 'fen'); assert.equal(playMove(line, 'e2', 'd2'), null);
});
test('undo, redo and branching preserve a single legal line', () => {
  let line = playMove(initialLine(), 'e2', 'e4')!; line = playMove(line, 'e7', 'e5')!;
  const end = gameAt(line).fen(), undone = {...line, cursor: 1};
  assert.equal(gameAt(undone).turn(), 'b'); assert.equal(gameAt({...undone, cursor: 2}).fen(), end);
  assert.deepEqual(playMove(undone, 'c7', 'c5')!.moves, ['e2e4', 'c7c5']);
});
test('castling moves both king and rook', () => {
  const line = importPosition('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'fen');
  const game = gameAt(playMove(line, 'e1', 'g1')!); assert.equal(game.get('f1')?.type, 'r'); assert.equal(game.get('g1')?.type, 'k');
});
test('en passant removes the captured pawn', () => {
  const line = importPosition('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'fen');
  const game = gameAt(playMove(line, 'e5', 'd6')!); assert.equal(game.get('d5'), undefined); assert.equal(game.get('d6')?.type, 'p');
});
test('underpromotion survives PGN round trip', () => {
  const line = importPosition('7k/P7/8/8/8/8/8/7K w - - 0 1', 'fen'), next = playMove(line, 'a7', 'a8', 'n')!;
  assert.equal(gameAt(next).get('a8')?.type, 'n'); assert.equal(gameAt(importPosition(exportPgn(next), 'pgn')).fen(), gameAt(next).fen());
});
test('PGN headers and moves survive mainline round trip', () => {
  const line = importPosition('[Event "Local test"]\n\n1. e4 e5 2. Nf3 Nc6 *', 'pgn');
  assert.equal(line.headers.Event, 'Local test'); assert.equal(gameAt(importPosition(exportPgn(line), 'pgn')).fen(), gameAt(line).fen());
});
test('invalid FEN, PGN, empty input and multiple games fail', () => {
  for (const text of ['', 'garbage', '8/8/8/8/8/8/8/8 w - - 0 1']) assert.throws(() => importPosition(text, 'fen'));
  assert.throws(() => importPosition('1. e4 e5 2. Ke5', 'pgn'));
  assert.throws(() => importPosition('[Event "A"]\n1. e4 *\n[Event "B"]\n1. d4 *', 'pgn'));
});
test('full history detects repetition after navigation', () => {
  const line = importPosition('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 *', 'pgn'); assert.equal(gameAt(line).isThreefoldRepetition(), true);
});
test('PGN exports only through the selected move', () => {
  const line = importPosition('1. e4 e5 2. Nf3 Nc6 *', 'pgn'); assert.equal(importPosition(exportPgn({...line, cursor: 2}), 'pgn').moves.length, 2);
});

test('an unclaimed threefold draw is not exported as a completed draw', () => {
  const line = importPosition('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 *', 'pgn');
  assert.equal(importPosition(exportPgn(line), 'pgn').headers.Result, '*');
});
