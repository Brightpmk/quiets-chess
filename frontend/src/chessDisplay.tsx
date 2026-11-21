import type { PVMove } from './types.ts';

export const boardAppearance = {
  darkSquareStyle: {backgroundColor: '#6e8270'},
  lightSquareStyle: {backgroundColor: '#dfe3cf'},
  darkSquareNotationStyle: {color: '#e5eadb'},
  lightSquareNotationStyle: {color: '#506452'},
  boardStyle: {borderRadius: '3px', overflow: 'hidden'},
};

export function Variation({moves, testId}: {moves: PVMove[]; testId?: string}) {
  return <div className="pv-line" data-testid={testId}>{moves.map((move, index) =>
    <span key={`${index}-${move.uci}`}><span className="move-number">
      {move.color === 'white' ? `${move.number}. ` : index === 0 ? `${move.number}… ` : ''}
    </span>{move.san} </span>)}</div>;
}

export function download(text: string, name: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], {type}));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
