import { Chess, DEFAULT_POSITION } from 'chess.js';
import type { Square } from 'chess.js';

export type Line = { root: string; moves: string[]; cursor: number; headers: Record<string, string> };
export const initialLine = (): Line => ({ root: DEFAULT_POSITION, moves: [], cursor: 0, headers: {} });

export function gameAt(line: Line, cursor = line.cursor): Chess {
  const game = new Chess(line.root);
  for (const [name, value] of Object.entries(line.headers)) game.setHeader(name, value);
  for (const uci of line.moves.slice(0, cursor)) game.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
  return game;
}

export function playMove(line: Line, from: string, to: string, promotion?: string): Line | null {
  try {
    const game = gameAt(line);
    const move = game.move({ from, to, promotion });
    if (!move) return null;
    const headers = { ...line.headers, Result: '*' };
    return { ...line, headers, moves: [...line.moves.slice(0, line.cursor), move.from + move.to + (move.promotion ?? '')], cursor: line.cursor + 1 };
  } catch { return null; }
}

export function importPosition(text: string, kind: 'fen' | 'pgn'): Line {
  if (!text.trim()) throw new Error(`Paste a ${kind.toUpperCase()} first.`);
  if (text.length > 100_000) throw new Error('Import is limited to 100 KB.');
  const game = new Chess();
  if (kind === 'fen') game.load(text.trim());
  else {
    // One game only; accept standard headers, comments and mainline notation.
    if ((text.match(/\[Event\s+"/g) ?? []).length > 1 || /(?:1-0|0-1|1\/2-1\/2|\*)\s+(?:\[|1\.)/.test(text))
      throw new Error('Import one PGN game at a time.');
    game.loadPgn(text.trim(), { strict: true });
    if (game.history().length === 0 && !/^\s*(?:\[|\*|1-0|0-1|1\/2-1\/2)/.test(text))
      throw new Error('No valid PGN game found.');
  }
  const history = game.history({ verbose: true });
  if (history.length > 2000) throw new Error('A game can contain at most 2,000 plies.');
  const root = history[0]?.before ?? game.fen();
  return { root, moves: history.map(m => m.from + m.to + (m.promotion ?? '')), cursor: history.length, headers: game.getHeaders() };
}

export function automaticDraw(game: Chess): string | null {
  if (game.isStalemate()) return 'Stalemate';
  if (game.isInsufficientMaterial()) return 'Insufficient material';
  if (Number(game.fen().split(' ')[4]) >= 150) return '75-move draw';
  const history = game.history({verbose: true});
  const positions = [history[0]?.before ?? game.fen(), ...history.map(move => move.after)];
  const repetitionKey = (fen: string) => fen.split(' ').slice(0, 4).join(' ');
  if (positions.filter(fen => repetitionKey(fen) === repetitionKey(game.fen())).length >= 5)
    return 'Fivefold repetition';
  return null;
}

export function exportPgn(line: Line): string {
  const game = gameAt(line);
  if (game.isCheckmate()) game.setHeader('Result', game.turn() === 'w' ? '0-1' : '1-0');
  else if (automaticDraw(game)) game.setHeader('Result', '1/2-1/2');
  else if (line.cursor !== line.moves.length) game.setHeader('Result', '*');
  else if (!game.getHeaders().Result) game.setHeader('Result', '*');
  return game.pgn({ maxWidth: 80 });
}

export function moveList(line: Line) {
  const game = new Chess(line.root);
  return line.moves.map((uci, index) => {
    const number = game.moveNumber();
    const color = game.turn();
    const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return { index: index + 1, number, color, san: move.san, uci };
  });
}

export function legalTargets(line: Line, square: Square): Square[] {
  return gameAt(line).moves({ square, verbose: true }).map(move => move.to);
}
