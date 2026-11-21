import { SQUARES, validateFen } from 'chess.js';
import type { Color, Square } from 'chess.js';

const files = 'abcdefgh';
export const castlingRights = ['K', 'Q', 'k', 'q'] as const;
type CastlingRight = typeof castlingRights[number];
type Pieces = Partial<Record<Square, string>>;
export type Draft = {
  pieces: Pieces; turn: Color; castling: CastlingRight[];
  ep: string; halfmove: string; fullmove: string;
};

export function positionDraft(fen: string): Draft {
  const [placement, turn, castling, ep, halfmove, fullmove] = fen.split(' ');
  const pieces: Pieces = {};
  for (const [rank, row] of placement.split('/').entries()) {
    let file = 0;
    for (const value of row) {
      if (/^[1-8]$/.test(value)) file += Number(value);
      else pieces[`${files[file++]}${8 - rank}` as Square] = value;
    }
  }
  return {pieces, turn: turn as Color, castling: castlingRights.filter(right => castling.includes(right)), ep, halfmove, fullmove};
}

export function draftFen(draft: Draft): string {
  const ranks = Array.from({length: 8}, (_, rank) => [...files]
    .map(file => draft.pieces[`${file}${8 - rank}` as Square] ?? '1').join('')
    .replace(/1+/g, empty => String(empty.length)));
  const rights = castlingRights.filter(right => draft.castling.includes(right)).join('') || '-';
  return [ranks.join('/'), draft.turn, rights, draft.ep, draft.halfmove, draft.fullmove].join(' ');
}

export function draftError(draft: Draft, fen = draftFen(draft)): string | undefined {
  if (!/^\d+$/.test(draft.halfmove) || !Number.isSafeInteger(Number(draft.halfmove)))
    return 'Enter a nonnegative whole number for the halfmove clock.';
  if (!/^[1-9]\d*$/.test(draft.fullmove) || !Number.isSafeInteger(Number(draft.fullmove)))
    return 'Enter a positive whole number for the fullmove number.';
  const {pieces} = draft;
  if (SQUARES.some(square => /[18]$/.test(square) && pieces[square]?.toLowerCase() === 'p'))
    return 'Pawns cannot be on ranks 1 or 8.';
  const validation = validateFen(fen);
  if (!validation.ok) return validation.error;
  const white = SQUARES.findIndex(square => draft.pieces[square] === 'K');
  const black = SQUARES.findIndex(square => draft.pieces[square] === 'k');
  if (Math.abs(white % 8 - black % 8) <= 1 && Math.abs(Math.floor(white / 8) - Math.floor(black / 8)) <= 1)
    return 'The kings cannot be adjacent.';
  for (const [right, king, rook, kingPiece, rookPiece] of [
    ['K', 'e1', 'h1', 'K', 'R'], ['Q', 'e1', 'a1', 'K', 'R'],
    ['k', 'e8', 'h8', 'k', 'r'], ['q', 'e8', 'a8', 'k', 'r'],
  ] as const) {
    if (draft.castling.includes(right) && (pieces[king] !== kingPiece || pieces[rook] !== rookPiece))
      return `Castling right ${right} requires the king on ${king} and rook on ${rook}.`;
  }
  if (draft.ep !== '-') {
    const file = draft.ep[0];
    const whiteToMove = draft.turn === 'w';
    const pawn = `${file}${whiteToMove ? 5 : 4}` as Square;
    const source = `${file}${whiteToMove ? 7 : 2}` as Square;
    if (pieces[draft.ep as Square] || pieces[source] || pieces[pawn] !== (whiteToMove ? 'p' : 'P'))
      return 'The en passant target must match a pawn that just advanced two squares.';
    if (Number(draft.halfmove) !== 0) return 'An en passant target requires a halfmove clock of zero.';
  }
}
