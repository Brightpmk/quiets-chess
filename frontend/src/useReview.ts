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
};
export type Position = {score: Score; depth: number; terminal: string | null};
type Delta = {
  id: string; status: Status; error: string | null; analyzed: number; total: number;
  settings: {engine: string | null; preset: Preset; position_nodes: number; methodology: string};
  moves: Grade[]; positions: Position[];
  classification_counts: Record<Color, Record<Quality, number>>;
  accuracy: Record<Color, number | null> | null;
};
export type Review = Delta & {
  game: {root_fen: string; headers: Record<string, string>; moves: PVMove[]; terminal: string | null};
};

export const isActive = (status?: Status) => status === 'queued' || status === 'running';

class ReviewError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(path = '', config?: RequestInit): Promise<T> {
  const response = await fetch(`/api/reviews${path}`, config);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body)
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
    const id = job?.id;
    if (!id || !isActive(job?.status) || action) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const previous = current.current;
      if (!previous || previous.id !== id || operation.current) return;
      try {
        const delta = await request<Delta>(`/${id}?after=${previous.analyzed}&position_after=${previous.positions.length}`,
          {signal: controller.signal, cache: 'no-store'});
        if (controller.signal.aborted || operation.current || delta.id !== id || current.current !== previous) return;
        const updated = {...previous, ...delta, game: previous.game, moves: [...previous.moves, ...delta.moves],
          positions: [...previous.positions, ...delta.positions]};
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
      const stopped = await request<Review>(`/${id}`, {method: 'DELETE'});
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

  return {job, action, error, connectionError, start, cancel, retry};
}
