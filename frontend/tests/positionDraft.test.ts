import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_POSITION } from 'chess.js';
import { draftError, draftFen, positionDraft } from '../src/positionDraft.ts';

test('keeps piece placement and FEN metadata independent from the live board', () => {
  const draft = positionDraft(DEFAULT_POSITION);
  assert.equal(draftFen(draft), DEFAULT_POSITION);
  const empty = {...draft, pieces: {}, castling: []};
  assert.equal(draftFen(empty), '8/8/8/8/8/8/8/8 w - - 0 1');
  assert.match(draftError(empty) ?? '', /missing white king/);
  assert.equal(draftFen(draft), DEFAULT_POSITION);
});

test('validates adjacent kings, castling rights, pawn ranks and en passant state', () => {
  const draft = positionDraft('4k3/8/8/3p4/8/8/8/4K2R w K d6 0 31');
  assert.equal(draftError(draft), undefined);
  assert.match(draftError({...draft, turn: 'b'}) ?? '', /en-passant/);
  assert.match(draftError({...draft, halfmove: '1'}) ?? '', /halfmove clock of zero/);
  assert.match(draftError({...draft, pieces: {...draft.pieces, d7: 'p'}}) ?? '', /advanced two squares/);
  assert.match(draftError({...draft, pieces: {...draft.pieces, h1: undefined}}) ?? '', /Castling right K/);
  assert.match(draftError({...draft, pieces: {...draft.pieces, a1: 'p'}}) ?? '', /ranks 1 or 8/);
  assert.match(draftError(positionDraft('8/8/8/8/8/8/4k3/4K3 w - - 0 1')) ?? '', /adjacent/);
});
