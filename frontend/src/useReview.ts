import { useEffect, useRef, useState } from 'react';
import type { PVMove, Score } from './types.ts';

export type Preset = 'quick' | 'deep';
export type Quality = 'Best' | 'Excellent' | 'Good' | 'Inaccuracy' | 'Mistake' | 'Blunder' | 'Great' | 'Brilliant';
type Color = 'white' | 'black';
type Status = 'queued' | 'running' | 'complete' | 'cancelled' | 'failed';
type ReviewLine = {score: Score; pv: PVMove[]; depth: number; best_move: string | null};
export type Grade = PVMove & {
  ply: number; classification: Quality; explanation: string; accuracy: number;
  played_line: ReviewLine; best_alternative: ReviewLine | null; recommendation: ReviewLine;
  comparison: {paired_loss: number; adjacent_loss: number; disagreement: boolean} | null;
};
export type Position = {
  ply: number; fen: string; turn: Color; score: Score; depth: number; complete: boolean;
  source: 'engine' | 'rules'; nodes: number | null; time: number | null; terminal?: string;
};
type Delta = {
  id: string; status: Status; error: string | null; analyzed: number; total: number;
  move_from: number; position_from: number; position_count: number;
  settings: {engine: string | null; preset: Preset; position_nodes: number; methodology: string};
  moves: Grade[]; positions: Position[];
  classification_counts: Record<Color, Record<Quality, number>>;
  accuracy: Record<Color, number | null> | null;
};
export type Review = Delta & {
  game: {root_fen: string; headers: Record<string, string>; moves: PVMove[]; terminal: string | null;
    ending: {kind: 'position' | 'recorded' | 'unfinished'; reason: string | null}};
};

export const isActive = (status?: Status) => status === 'queued' || status === 'running';

export function mergeReviewProgress(previous: Review, delta: Delta): Review | null {
  if (previous.id !== delta.id || !isActive(previous.status) || previous.total !== delta.total ||
      (previous.status === 'running' && delta.status === 'queued') ||
      delta.move_from !== previous.moves.length || delta.position_from !== previous.positions.length ||
      delta.analyzed !== delta.move_from + delta.moves.length ||
      delta.position_count !== delta.position_from + delta.positions.length ||
      delta.analyzed > previous.total || delta.position_count > previous.total + 1 ||
      delta.analyzed > Math.max(0, delta.position_count - 1) ||
      (delta.status === 'complete' && (delta.analyzed !== previous.total || delta.position_count !== previous.total + 1))) return null;
  if (delta.moves.some((move, index) => {
    const source = previous.game.moves[delta.move_from + index];
    return move.ply !== delta.move_from + index + 1 || move.uci !== source?.uci || move.color !== source.color;
  }) || delta.positions.some((position, index) => position.ply !== delta.position_from + index || !position.complete)) return null;
  return {...previous, ...delta, game: previous.game, move_from: 0, position_from: 0,
    accuracy: delta.status === 'complete' ? delta.accuracy : null,
    moves: [...previous.moves, ...delta.moves], positions: [...previous.positions, ...delta.positions]};
}

class ReviewError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

async function request<T>(path = '', config?: RequestInit): Promise<T> {
  const response = await fetch(`/api/reviews${path}`, config);
  const body = await response.json().catch(() => undefined);
  if (!response.ok || body === undefined)
    throw new ReviewError(body?.detail ?? 'The review server could not respond. Check that the backend is running.', response.status);
  return body;
}

export function useReview() {
  const [job, setJob] = useState<Review | null>(null);
  const [action, setAction] = useState<'starting' | 'cancelling' | null>(null);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const operation = useRef(false);
  const current = useRef(job);
  const lastRequest = useRef<{pgn: string; preset: Preset} | null>(null);

  function setSnapshot(value: Review) {
    current.current = value;
    setJob(value);
  }

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    void request<Review | null>('/active', {signal, cache: 'no-store'}).then(active => {
      if (active && !signal.aborted && !current.current && !operation.current) setSnapshot(active);
    }).catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const id = job?.id;
    if (!id || !isActive(job?.status) || action) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const previous = current.current;
      if (!previous || previous.id !== id || operation.current) return;
      try {
        const delta = await request<Delta>(`/${id}?after=${previous.analyzed}&position_after=${previous.positions.length}`,
          {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), cache: 'no-store'});
        if (controller.signal.aborted || operation.current || current.current !== previous) return;
        const updated = mergeReviewProgress(previous, delta);
        if (!updated) {
          setConnectionError('Waiting for current review progress…');
          timer = setTimeout(poll, 500);
          return;
        }
        setSnapshot(updated);
        setConnectionError('');
        if (isActive(updated.status)) timer = setTimeout(poll, 500);
      } catch (cause) {
        if (controller.signal.aborted || operation.current || current.current !== previous) return;
        if (cause instanceof ReviewError && cause.status === 404) {
          setConnectionError('');
          setSnapshot({...previous, status: 'failed', error: cause.message});
        } else {
          setConnectionError('Review connection interrupted. Reconnecting…');
          timer = setTimeout(poll, 1250);
        }
      }
    }
    timer = setTimeout(poll, 0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.id, job?.status, action]);

  async function start(pgn: string, preset: Preset) {
    if (operation.current) return false;
    operation.current = true;
    setAction('starting');
    setError('');
    try {
      const replacement = await request<Review>('', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({pgn, preset, replace: current.current?.id}),
      });
      lastRequest.current = {pgn, preset};
      setSnapshot(replacement);
      setConnectionError('');
      return true;
    } catch (cause) {
      setError(cause instanceof ReviewError ? cause.message : 'Could not start the review. Check that the backend is running.');
      if (!(cause instanceof ReviewError) || cause.status === 409) {
        try {
          const active = await request<Review | null>('/active', {signal: AbortSignal.timeout(5_000), cache: 'no-store'});
          if (active && active.id !== current.current?.id) {
            lastRequest.current = null;
            setSnapshot(active);
            setError('');
            return true;
          }
        } catch { /* Retain the original error if recovery also fails. */ }
      }
      return false;
    } finally {
      operation.current = false;
      setAction(null);
    }
  }

  async function cancel() {
    const id = current.current?.id;
    if (!id || operation.current) return;
    operation.current = true;
    setAction('cancelling');
    setError('');
    try {
      const stopped = await request<Review>(`/${id}`, {method: 'DELETE', signal: AbortSignal.timeout(10_000)});
      if (stopped.id === id) setSnapshot(stopped);
      setConnectionError('');
    } catch (cause) {
      setError(cause instanceof ReviewError ? cause.message : 'Could not reach the server to cancel. Try again.');
    } finally {
      operation.current = false;
      setAction(null);
    }
  }

  async function retry() {
    const previous = lastRequest.current;
    return previous ? start(previous.pgn, previous.preset) : false;
  }

  return {job, action, error, connectionError, start, cancel, retry, canRetry: lastRequest.current !== null};
}
