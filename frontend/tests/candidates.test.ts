import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptsAnalysis } from '../src/evaluation.ts';
import { candidateArrows } from '../src/candidates.ts';
import type { Analysis, Candidate } from '../src/types.ts';

const fen = '7k/P7/8/8/8/8/8/7K w - - 0 1';
const score = {cp: 85, mate: null, winner: null, stm_cp: 85, stm_mate: null, bound: null};

function line(rank: number, uci: string, san: string): Candidate {
  return {rank, score, best_move: uci, depth: 12, nodes: 22123, nps: 1200000, time: .5,
    pv: [{uci, san, number: 1, color: 'white'}]};
}

const candidates = [line(1, 'a7a8q', 'a8=Q+'), line(2, 'a7a8r', 'a8=R+'), line(3, 'h1h2', 'Kh2')];
const update: Analysis = {...candidates[0], type: 'analysis', request_id: 'new', fen, multipv: 3,
  candidates, done: false};

test('only accepts complete exact candidate sets for the active request and settings', () => {
  assert.equal(acceptsAnalysis('new', fen, 3, 7, update), true);
  assert.equal(acceptsAnalysis('old', fen, 3, 7, update), false);
  assert.equal(acceptsAnalysis(null, fen, 3, 7, update), false);
  assert.equal(acceptsAnalysis('new', 'another fen', 3, 7, update), false);
  assert.equal(acceptsAnalysis('new', fen, 1, 7, update), false);
  assert.equal(acceptsAnalysis('new', fen, 3, 7, {...update, candidates: candidates.slice(0, 2)}), false);
  assert.equal(acceptsAnalysis('new', fen, 3, 2, {...update, candidates: candidates.slice(0, 2)}), true);
  assert.equal(acceptsAnalysis('new', fen, 3, 7, {...update, candidates: [...candidates.slice(0, 2),
    {...candidates[2], depth: 11}]}), false);
  assert.equal(acceptsAnalysis('new', fen, 3, 7, update, {...update, depth: 13}), false);
  assert.equal(acceptsAnalysis('new', fen, 3, 7, update, {...update, done: true}), false);
});

test('distinct promotions keep their rank and SAN while sharing a single board arrow', () => {
  const arrows = candidateArrows(candidates);
  assert.deepEqual(arrows.map(arrow => [arrow.startSquare, arrow.endSquare, arrow.ranks]),
    [['a7', 'a8', [1, 2]], ['h1', 'h2', [3]]]);
  assert.notEqual(arrows[0].color, arrows[1].color);
  assert.deepEqual(candidates.map(candidate => candidate.pv[0].san), ['a8=Q+', 'a8=R+', 'Kh2']);
});
