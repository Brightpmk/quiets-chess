import type { Analysis, CandidateCount, Score } from './types.ts';

export function scoreLabel(score?: Score | null): string {
  if (!score) return '—';
  const bound = score.bound === 'lower' ? '≥ ' : score.bound === 'upper' ? '≤ ' : '';
  if (score.mate !== null) return `${bound}${score.winner === 'black' ? '−' : ''}M${Math.abs(score.mate)}`;
  if (score.cp === null) return '—';
  return bound + (score.cp > 0 ? '+' : '') + (score.cp / 100).toFixed(2);
}

export function whitePercentage(score?: Score | null): number {
  if (!score) return 50;
  if (score.mate !== null) return score.winner === 'white' ? 100 : 0;
  // A bounded visual scale, not a winning-probability claim.
  return Math.max(2, Math.min(98, 50 + 48 * Math.tanh((score.cp ?? 0) / 400)));
}

export function scoreDescription(score?: Score | null): string {
  if (!score) return 'Waiting for evaluation';
  if (score.mate !== null) return score.mate === 0 ? `${score.winner === 'white' ? 'White' : 'Black'} wins by checkmate`
    : `${score.winner === 'white' ? 'White' : 'Black'} mates in ${Math.abs(score.mate)}`;
  const cp = score.cp ?? 0;
  if (Math.abs(cp) < 20) return 'Approximately equal';
  return `${cp > 0 ? 'White' : 'Black'} is better`;
}

export function acceptsResult(activeId: string | null, expectedFen: string, message: {request_id?: string; fen?: string}) {
  return activeId !== null && message.request_id === activeId && (!message.fen || message.fen === expectedFen);
}

export function acceptsAnalysis(activeId: string | null, fen: string, multipv: CandidateCount,
  legalMoves: number, update: Analysis, previous?: Analysis | null) {
  if (!acceptsResult(activeId, fen, update) || update.fen !== fen || update.multipv !== multipv) return false;
  if (previous?.request_id === update.request_id && (previous.done || update.depth < previous.depth)) return false;
  if (!Array.isArray(update.candidates)) return false;
  if (update.terminal) return update.done && update.candidates.length === 0;
  return update.candidates.length > 0 && update.candidates.length === Math.min(multipv, legalMoves) &&
    new Set(update.candidates.map(line => line.best_move)).size === update.candidates.length &&
    update.candidates.every((line, index) => line.rank === index + 1 && line.depth === update.depth &&
      !line.score.bound && line.pv[0]?.uci === line.best_move);
}
