import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsResult, scoreDescription, scoreLabel, whitePercentage } from '../src/evaluation.ts';
import type { Score } from '../src/types.ts';
const score = (overrides: Partial<Score> = {}): Score => ({cp: 34, mate: null, winner: null, stm_cp: 34, stm_mate: null, bound: null, ...overrides});
test('centipawns display as pawns from White perspective', () => {
  assert.equal(scoreLabel(score()), '+0.34'); assert.equal(scoreLabel(score({cp: -127})), '-1.27'); assert.equal(scoreLabel(score({cp: 0})), '0.00');
});
test('mate signs remain unambiguous at mate zero', () => {
  assert.equal(scoreLabel(score({cp: null, mate: 3, winner: 'white'})), 'M3');
  assert.equal(scoreLabel(score({cp: null, mate: -2, winner: 'black'})), '−M2');
  assert.equal(scoreLabel(score({cp: null, mate: 0, winner: 'black'})), '−M0');
  assert.equal(scoreDescription(score({cp: null, mate: 0, winner: 'white'})), 'White wins by checkmate');
});
test('bounds differ from exact evaluations', () => {
  assert.equal(scoreLabel(score({bound: 'lower'})), '≥ +0.34'); assert.equal(scoreLabel(score({cp: -100, bound: 'upper'})), '≤ -1.00');
});
test('missing scores are not presented as equal', () => {
  assert.equal(scoreLabel(null), '—'); assert.equal(scoreDescription(null), 'Waiting for evaluation');
});
test('bar follows White advantage independently of turn', () => {
  assert.equal(whitePercentage(score({cp: 0})), 50); assert.ok(whitePercentage(score({cp: 100, stm_cp: -100})) > 50); assert.ok(whitePercentage(score({cp: -100, stm_cp: 100})) < 50);
});
test('mate fills the bar for the winning color', () => {
  assert.equal(whitePercentage(score({mate: 0, winner: 'white'})), 100); assert.equal(whitePercentage(score({mate: -4, winner: 'black'})), 0);
});
test('same FEN from an older search is rejected', () => {
  assert.equal(acceptsResult('new', 'FEN', {request_id: 'old', fen: 'FEN'}), false);
});
test('wrong FEN with current ID is rejected', () => {
  assert.equal(acceptsResult('new', 'FEN', {request_id: 'new', fen: 'different'}), false);
});
test('stopped search cannot update the board', () => {
  assert.equal(acceptsResult(null, 'FEN', {request_id: 'new', fen: 'FEN'}), false);
});
test('current result and error without FEN are accepted', () => {
  assert.equal(acceptsResult('new', 'FEN', {request_id: 'new', fen: 'FEN'}), true); assert.equal(acceptsResult('new', 'FEN', {request_id: 'new'}), true);
});
