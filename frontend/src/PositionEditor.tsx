import { useEffect, useRef, useState } from 'react';
import { DEFAULT_POSITION, SQUARES } from 'chess.js';
import type { Square } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { boardAppearance } from './chessDisplay.tsx';
import { castlingRights, draftError, draftFen, positionDraft } from './positionDraft.ts';

const pieceTypes = ['King', 'Queen', 'Rook', 'Bishop', 'Knight', 'Pawn'];
const symbols = '♔♕♖♗♘♙♚♛♜♝♞♟';
const pieceCodes = 'KQRBNPkqrbnp';
const rightsLabels = ['White kingside', 'White queenside', 'Black kingside', 'Black queenside'];

export function PositionEditor({fen, orientation, onApply, onCancel}: {
  fen: string; orientation: 'white' | 'black'; onApply: (fen: string) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => positionDraft(fen));
  const [tool, setTool] = useState('move');
  const [source, setSource] = useState<Square | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copyNote, setCopyNote] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const fenInput = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const output = draftFen(draft);

  useEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    return () => { pending.current?.abort(); modal?.close(); };
  }, []);
  useEffect(() => { setError(''); setCopyNote(''); }, [output]);

  function move(from: string, to: string | null) {
    const piece = draft.pieces[from as Square];
    if (pending.current || !to || to === from || !piece) return false;
    const pieces = {...draft.pieces, [to]: piece};
    delete pieces[from as Square];
    setDraft({...draft, pieces});
    setSource(null);
    return true;
  }

  function click(square: Square) {
    if (pending.current) return;
    if (tool === 'move') {
      if (source && move(source, square)) return;
      setSource(draft.pieces[square] && square !== source ? square : null);
    } else {
      const pieces = {...draft.pieces};
      if (tool === 'remove') delete pieces[square];
      else pieces[square] = tool;
      setDraft({...draft, pieces});
    }
  }

  async function apply() {
    if (pending.current) return;
    const issue = draftError(draft, output);
    if (issue) { setError(issue); return; }
    const controller = new AbortController();
    pending.current = controller;
    setError('');
    setBusy(true);
    try {
      const response = await fetch('/api/positions/validate', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({fen: output}), signal: controller.signal,
      });
      if (response.status === 404) throw new Error('Restart the backend to enable position validation.');
      const data = await response.json();
      if (!response.ok || typeof data.fen !== 'string')
        throw new Error(typeof data.detail === 'string' ? data.detail : 'The backend could not validate this position.');
      if (!controller.signal.aborted) onApply(data.fen);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof TypeError
        ? 'Could not reach the backend for validation. Check that it is running and try again.'
        : cause instanceof Error ? cause.message : 'Could not validate the position.');
    } finally {
      if (!controller.signal.aborted) { pending.current = null; setBusy(false); }
    }
  }

  function cancel() {
    pending.current?.abort();
    onCancel();
  }

  return <dialog ref={dialog} className="modal position-editor" aria-labelledby="position-editor-title"
    onCancel={event => { event.preventDefault(); cancel(); }}>
    <h2 id="position-editor-title">Set up position</h2>
    <p>Drag pieces or select a tool and tap a square. Analysis is paused while you edit.</p>
    <div className="editor-layout">
      <div className="board-frame" data-testid="editor-board">
        <Chessboard options={{...boardAppearance, id: 'position-editor-board', boardOrientation: orientation,
          position: output.split(' ')[0], allowDrawingArrows: false, allowDragOffBoard: false,
          allowDragging: tool === 'move' && !busy, animationDurationInMs: 0,
          squareStyles: source ? {[source]: {backgroundColor: '#d8d97a99'}} : {},
          onSquareClick: ({square}) => click(square as Square),
          onPieceDrop: ({sourceSquare, targetSquare}) => move(sourceSquare, targetSquare)}}/>
      </div>
      <fieldset className="editor-settings" disabled={busy}>
        <div className="editor-tools" aria-label="Piece tools">
          <button className="button secondary compact" type="button" aria-pressed={tool === 'move'}
            onClick={() => { setTool('move'); setSource(null); }}>Move pieces</button>
          <button className="button secondary compact" type="button" aria-pressed={tool === 'remove'}
            onClick={() => { setTool('remove'); setSource(null); }}>Remove piece</button>
        </div>
        <div className="editor-palette" role="group" aria-label="Piece palette">
          {[...pieceCodes].map((piece, index) => <button type="button" key={piece}
            aria-label={`${index < 6 ? 'White' : 'Black'} ${pieceTypes[index % 6]}`}
            aria-pressed={tool === piece} onClick={() => { setTool(piece); setSource(null); }}>{symbols[index]}</button>)}
        </div>
        <div className="editor-tools">
          <button className="button secondary compact" type="button" onClick={() => {
            setDraft({...positionDraft('8/8/8/8/8/8/8/8 w - - 0 1'), turn: draft.turn});
            setTool('move'); setSource(null);
          }}>Clear board</button>
          <button className="button secondary compact" type="button" onClick={() => {
            setDraft(positionDraft(DEFAULT_POSITION)); setTool('move'); setSource(null);
          }}>Starting position</button>
        </div>
        <label>Side to move<select value={draft.turn} onChange={event => setDraft({...draft,
          turn: event.target.value === 'w' ? 'w' : 'b', ep: '-'})}><option value="w">White</option><option value="b">Black</option></select></label>
        <fieldset className="editor-castling"><legend>Castling rights</legend>
          {castlingRights.map((right, index) => <label key={right}><input type="checkbox"
            checked={draft.castling.includes(right)} onChange={event => setDraft({...draft, castling: event.target.checked
              ? [...draft.castling, right] : draft.castling.filter(value => value !== right)})}/>{rightsLabels[index]}</label>)}
        </fieldset>
        <label>En passant target<select value={draft.ep} onChange={event => setDraft({...draft, ep: event.target.value})}>
          <option value="-">None</option>{SQUARES.filter(square => square[1] === (draft.turn === 'w' ? '6' : '3'))
            .map(square => <option key={square}>{square}</option>)}
        </select></label>
        <div className="editor-counters">
          <label>Halfmove clock<input type="number" min={0} value={draft.halfmove}
            onChange={event => setDraft({...draft, halfmove: event.target.value})}/></label>
          <label>Fullmove number<input type="number" min={1} value={draft.fullmove}
            onChange={event => setDraft({...draft, fullmove: event.target.value})}/></label>
        </div>
      </fieldset>
    </div>
    <label className="editor-fen">Draft FEN<input ref={fenInput} value={output} readOnly spellCheck={false}/></label>
    <div className="editor-footer">
      <button className="button secondary compact" type="button" onClick={async () => {
        try { await navigator.clipboard.writeText(output); setCopyNote('FEN copied.'); }
        catch { fenInput.current?.focus(); fenInput.current?.select(); setCopyNote('Select and copy the FEN from the field.'); }
      }}>Copy FEN</button>
      <button className="button secondary compact" type="button" onClick={cancel}>Cancel</button>
      <button className="button primary compact" type="button" disabled={busy} onClick={apply}>{busy ? 'Validating…' : 'Apply position'}</button>
    </div>
    {copyNote && <p role="status">{copyNote}</p>}
    {error && <p className="editor-error" role="alert">{error}</p>}
    <p>Applying starts a new line. Position checks cover standard chess rules and cannot prove the full move history.</p>
  </dialog>;
}
