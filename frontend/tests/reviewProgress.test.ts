import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeReviewProgress } from '../src/useReview.ts';
import type { Grade, Position, Review } from '../src/useReview.ts';

const game = {moves: [{uci: 'e7e5', color: 'black'}]} as Review['game'];
const grade = {ply: 1, uci: 'e7e5', color: 'black'} as Grade;
const root = {ply: 0, complete: true} as Position;
const child = {ply: 1, complete: true} as Position;
const active = {id: 'current', status: 'running', total: 1, analyzed: 0, game,
  move_from: 0, position_from: 0, position_count: 1, positions: [root], moves: [], accuracy: null} as Review;

test('accepts position progress during grading and combines the following move delta', () => {
  const positionDelta = {...active, position_from: 1, position_count: 2, positions: [child]};
  const partial = mergeReviewProgress(active, positionDelta);
  assert.ok(partial);
  assert.deepEqual(partial.positions, [root, child]);
  assert.equal(partial.moves.length, 0);
  const complete = mergeReviewProgress(partial, {...positionDelta, status: 'complete', analyzed: 1,
    position_from: 2, position_count: 2, positions: [], moves: [grade]});
  assert.ok(complete);
  assert.deepEqual(complete.moves, [grade]);
  assert.equal(complete.position_from, 0);
});

test('rejects replaced jobs, stale offsets, false completion and bad ply identities', () => {
  const batch = {...active, analyzed: 1, position_from: 1, position_count: 2, positions: [child], moves: [grade]};
  assert.ok(mergeReviewProgress(active, batch));
  assert.equal(mergeReviewProgress(active, {...batch, id: 'cancelled-job'}), null);
  assert.equal(mergeReviewProgress(active, {...batch, status: 'queued'}), null);
  assert.equal(mergeReviewProgress(active, {...batch, position_from: 0}), null);
  assert.equal(mergeReviewProgress({...active, status: 'cancelled'}, batch), null);
  assert.equal(mergeReviewProgress(active, {...batch, status: 'complete', analyzed: 0, moves: []}), null);
  assert.equal(mergeReviewProgress(active, {...batch, moves: [{...grade, color: 'white'}]}), null);
  assert.equal(mergeReviewProgress(active, {...batch, positions: [{...child, ply: 2}]}), null);
});
