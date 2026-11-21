import type { Candidate } from './types.ts';

export const candidateColors = ['#ffce61', '#63ddf0', '#e89bff'] as const;

export function candidateArrows(candidates: Candidate[]) {
  const routes = new Map<string, {startSquare: string; endSquare: string; color: string; ranks: number[]}>();
  for (const {rank, best_move} of candidates) {
    if (!best_move) continue;
    const path = best_move.slice(0, 4);
    const route = routes.get(path);
    if (route) route.ranks.push(rank);
    else routes.set(path, {
      startSquare: path.slice(0, 2), endSquare: path.slice(2, 4),
      color: candidateColors[rank - 1], ranks: [rank],
    });
  }
  return [...routes.values()];
}
