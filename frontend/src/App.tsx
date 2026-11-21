import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Chessboard, defaultArrowOptions } from 'react-chessboard';
import type { Square } from 'chess.js';
import { automaticDraw, exportPgn, gameAt, importPosition, initialLine, legalTargets, moveList, playMove } from './game.ts';
import type { Line } from './game.ts';
import { scoreDescription, scoreLabel, whitePercentage } from './evaluation.ts';
import { useAnalysis } from './useAnalysis.ts';
import type { CandidateCount, Mode } from './types.ts';
import { candidateArrows, candidateColors } from './candidates.ts';
import { boardAppearance, download, Variation } from './chessDisplay.tsx';
import { GameReview } from './GameReview.tsx';

const arrowPreference = 'quiet-chess.show-best-move-arrows';

function Icon({name, size = 18}: {name: string; size?: number}) {
  const paths: Record<string, ReactNode> = {
    flip: <><path d="M4 7h15l-4-4M20 17H5l4 4"/><path d="M4 7v5m16 5v-5"/></>,
    left: <path d="m14 6-6 6 6 6"/>, right: <path d="m10 6 6 6-6 6"/>,
    first: <><path d="m16 6-6 6 6 6M5 5v14"/></>, last: <><path d="m8 6 6 6-6 6M19 5v14"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V4H4v11h4"/></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/></>,
    upload: <><path d="M12 16V4m-5 5 5-5 5 5M4 15v5h16v-5"/></>,
    bolt: <path d="m13 2-9 12h7l-1 8 10-13h-8z"/>,
    chip: <><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4M10 10h4v4h-4z"/></>,
    pause: <><path d="M9 5v14M15 5v14"/></>, play: <path d="m8 4 12 8-12 8z"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export default function App() {
  const [workflow, setWorkflow] = useState<'analysis' | 'review'>('analysis');
  const [line, setLine] = useState<Line>(initialLine);
  const [mode, setMode] = useState<Mode>('fast');
  const [multipv, setMultipv] = useState<CandidateCount>(1);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [selected, setSelected] = useState<Square | null>(null);
  const [promotion, setPromotion] = useState<{from: string; to: string} | null>(null);
  const [importKind, setImportKind] = useState<'fen' | 'pgn'>('fen');
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [notice, setNotice] = useState('');
  const [arrows, setArrows] = useState(() => {
    try { return localStorage.getItem(arrowPreference) !== 'false'; }
    catch { return true; }
  });
  const [confirmNew, setConfirmNew] = useState(false);
  const promotionDialog = useRef<HTMLDialogElement>(null);
  const resetDialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const currentMove = useRef<HTMLButtonElement>(null);
  const game = useMemo(() => gameAt(line), [line]);
  const history = useMemo(() => moveList(line), [line]);
  const legalMoves = useMemo(() => game.moves().length, [game]);
  const fen = game.fen();
  const key = JSON.stringify([line.root, line.moves.slice(0, line.cursor), mode, multipv]);
  const engine = useAnalysis({root_fen: line.root, moves: line.moves.slice(0, line.cursor), fen, mode, multipv, legalMoves, key}, workflow === 'analysis');
  const result = engine.result;
  const candidates = result?.candidates ?? [];
  const routes = candidateArrows(candidates);
  const best = result?.best_move;
  const last = history[line.cursor - 1];
  const draw = automaticDraw(game);
  const status = game.isCheckmate() ? 'Checkmate' : draw ? draw : game.isThreefoldRepetition() ? 'Threefold repetition · draw claim available'
    : game.isDrawByFiftyMoves() ? '50-move draw claim available'
    : `${game.turn() === 'w' ? 'White' : 'Black'} to move${game.isCheck() ? ' · Check' : ''}`;

  function change(next: Line) {
    engine.invalidate(); setLine(next); setSelected(null); setPromotion(null); setImportError('');
  }
  function navigate(cursor: number) {
    if (cursor < 0 || cursor > line.moves.length || cursor === line.cursor) return;
    change({...line, cursor});
  }
  function attemptMove(from: string, to: string, piece?: string): boolean {
    if (line.cursor >= 2000) { setNotice('Move limit reached. Export the position as FEN to continue.'); return false; }
    const candidates = game.moves({verbose: true}).filter(m => m.from === from && m.to === to);
    if (!candidates.length) return false;
    if (!piece && candidates.some(m => m.promotion)) { setPromotion({from, to}); return false; }
    const next = playMove(line, from, to, piece);
    if (!next) return false;
    change(next); return true;
  }
  function squareClick(square: string) {
    if (promotion) return;
    if (selected && attemptMove(selected, square)) return;
    const piece = game.get(square as Square);
    setSelected(piece?.color === game.turn() && square !== selected ? square as Square : null);
  }
  function doImport(text = importText, kind = importKind) {
    try { const next = importPosition(text, kind); change(next); setImportText(''); setNotice(`${kind.toUpperCase()} loaded`); }
    catch (error) { setImportError(error instanceof Error ? error.message : 'Could not parse this position.'); }
  }
  async function copyFen() {
    try { await navigator.clipboard.writeText(fen); setNotice('FEN copied to clipboard'); }
    catch { setImportKind('fen'); setImportText(fen); setNotice('Clipboard unavailable. FEN is in the text box below.'); }
  }
  function reset() { change(initialLine()); setConfirmNew(false); setNotice('New analysis board'); }

  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    const button = currentMove.current;
    const list = button?.closest('.move-list');
    if (!button || !list) return;
    const item = button.getBoundingClientRect(), viewport = list.getBoundingClientRect();
    if (item.top < viewport.top) list.scrollTop -= viewport.top - item.top;
    else if (item.bottom > viewport.bottom) list.scrollTop += item.bottom - viewport.bottom;
  }, [line.cursor]);
  useEffect(() => {
    if (promotion) promotionDialog.current?.showModal(); else promotionDialog.current?.close();
  }, [promotion]);
  useEffect(() => {
    if (confirmNew) resetDialog.current?.showModal(); else resetDialog.current?.close();
  }, [confirmNew]);
  useEffect(() => {
    if (workflow !== 'analysis') return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, dialog') || target.isContentEditable || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(line.cursor - 1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); navigate(line.cursor + 1); }
      if (event.key === 'Home') { event.preventDefault(); navigate(0); }
      if (event.key === 'End') { event.preventDefault(); navigate(line.moves.length); }
      if (event.key.toLowerCase() === 'f') setOrientation(value => value === 'white' ? 'black' : 'white');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const squareStyles: Record<string, CSSProperties> = {};
  if (last) for (const square of [last.uci.slice(0, 2), last.uci.slice(2, 4)]) squareStyles[square] = {backgroundColor: '#d5cd6e70'};
  if (selected) {
    squareStyles[selected] = {backgroundColor: '#d8d97a99'};
    for (const target of legalTargets(line, selected)) squareStyles[target] = {
      background: game.get(target) ? 'radial-gradient(transparent 58%, #21322465 60%)' : 'radial-gradient(#21322460 22%, transparent 24%)',
    };
  }
  const rows = Array.from(new Set(history.map(m => m.number))).map(number => ({number, moves: history.filter(m => m.number === number)}));
  const engineState = engine.connection === 'connected' ? engine.error ? 'Needs attention' : engine.running ? 'Analyzing' : 'Connected'
    : engine.connection === 'busy' ? 'Engine in use' : engine.connection === 'connecting' ? 'Connecting' : 'Offline';

  return <div className="app-shell">
    <header className="site-header">
      <a className="brand" href="/" aria-label="Quiet Chess home"><span className="brand-mark">♞</span><span>quiet<span className="brand-light">chess</span></span></a>
      <span className="header-divider"/><span className="workspace-label">Personal analysis</span>
      <div className="header-right"><span className="local-label"><span className="tiny-dot"/> Runs on your computer</span><span className="version-tag">NATIVE ENGINE</span></div>
    </header>

    <nav className="workflow-nav" aria-label="Chess workflows">
      <button aria-pressed={workflow === 'analysis'} onClick={() => setWorkflow('analysis')}>Analysis Board</button>
      <button aria-pressed={workflow === 'review'} onClick={() => setWorkflow('review')}>Game Review</button>
    </nav>
    <GameReview visible={workflow === 'review'} onOpenPosition={next => { change(next); setWorkflow('analysis'); }}/>
    <main className="workspace" hidden={workflow !== 'analysis'}>
      <div className="page-heading"><div><div className="eyebrow">YOUR NEXT MOVE, UNDERSTOOD</div><h1>Analysis board</h1></div>
        <button className="button secondary" onClick={() => line.moves.length ? setConfirmNew(true) : reset()}><Icon name="plus"/>New board</button>
      </div>
      <div className="analysis-grid">
        <section className="board-column" aria-label="Chess board and navigation">
          <div className="player-line"><div className="player-info"><span className={`player-dot ${orientation === 'white' ? 'black' : 'white'}`}/><span>{orientation === 'white' ? 'Black' : 'White'}</span></div><span className="muted text-xs">Standard chess</span></div>
          <div className="board-row">
            <div className={`eval-bar ${orientation === 'black' ? 'flipped' : ''}`} role="meter" aria-label={`Evaluation: ${scoreDescription(result?.score)}. White perspective.`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={whitePercentage(result?.score)} aria-valuetext={scoreLabel(result?.score)}>
              <div className="white-eval" style={{height: `${whitePercentage(result?.score)}%`}}/><span className="bar-midline"/>
            </div>
            <div className="board-frame" data-testid="chessboard">
              <Chessboard options={{
                id: 'analysis-board', position: fen, boardOrientation: orientation,
                ...boardAppearance, squareStyles,
                animationDurationInMs: 160, allowDrawingArrows: false, allowDragOffBoard: false,
                allowDragging: !promotion, onSquareClick: ({square}) => squareClick(square),
                onPieceDrop: ({sourceSquare, targetSquare}) => !!targetSquare && attemptMove(sourceSquare, targetSquare),
                canDragPiece: ({square}) => !!square && game.get(square as Square)?.color === game.turn(),
                arrows: arrows ? routes : [],
                arrowOptions: {...defaultArrowOptions, opacity: 0.9, arrowStartOffset: 0.22, arrowWidthDenominator: 7},
              }}/>
            </div>
          </div>
          <div className="player-line bottom-player"><div className="player-info"><span className={`player-dot ${orientation === 'white' ? 'white' : 'black'}`}/><span>{orientation === 'white' ? 'White' : 'Black'}</span></div><span className="turn-status" data-testid="position-status">{status}</span></div>
          <div className="board-toolbar">
            <button className="button ghost" title="Flip board (F)" onClick={() => setOrientation(value => value === 'white' ? 'black' : 'white')}><Icon name="flip"/>Flip board</button>
            <div className="navigation"><button className="icon-button" aria-label="First position" title="First position (Home)" disabled={!line.cursor} onClick={() => navigate(0)}><Icon name="first"/></button><button className="icon-button" aria-label="Undo move" title="Undo (←)" disabled={!line.cursor} onClick={() => navigate(line.cursor - 1)}><Icon name="left"/></button><span className="ply-counter">{line.cursor}<span> / {line.moves.length}</span></span><button className="icon-button" aria-label="Redo move" title="Redo (→)" disabled={line.cursor === line.moves.length} onClick={() => navigate(line.cursor + 1)}><Icon name="right"/></button><button className="icon-button" aria-label="Last position" title="Last position (End)" disabled={line.cursor === line.moves.length} onClick={() => navigate(line.moves.length)}><Icon name="last"/></button></div>
          </div>
          <label className="arrow-toggle board-arrow-toggle">
            <input type="checkbox" checked={arrows} onChange={event => {
              const visible = event.target.checked;
              setArrows(visible);
              try { localStorage.setItem(arrowPreference, String(visible)); }
              catch { /* Keep the choice for this page if storage is unavailable. */ }
            }}/>Show best-move arrows
          </label>
          <p className="board-hint">Drag a piece or select two squares. <kbd>←</kbd> <kbd>→</kbd> to explore your line.</p>
        </section>

        <aside className="analysis-panel" aria-label="Engine analysis">
          <section className="panel engine-panel">
            <div className="panel-top"><div className="engine-name"><div className="engine-icon"><Icon name="chip" size={21}/></div><div><h2>Stockfish 19</h2><p>Native · full strength</p></div></div><span className={`connection-badge ${engine.connection === 'connected' && !engine.error ? 'online' : ''}`}><span className={engine.running ? 'pulse-dot' : 'tiny-dot'}/>{engineState}</span></div>
            <div className="mode-selector" aria-label="Analysis time">{(['fast', 'strong', 'deep'] as Mode[]).map((value, index) => <button key={value} aria-pressed={mode === value} className={mode === value ? 'active' : ''} onClick={() => { if (value !== mode) { engine.invalidate(); setMode(value); } }}><span>{value === 'fast' && <Icon name="bolt" size={14}/>} {value[0].toUpperCase() + value.slice(1)}</span><small>{[1, 3, 10][index]} second{index ? 's' : ''}</small></button>)}</div>
            <div className="evaluation-row"><div><div className="numeric-eval" data-testid="evaluation">{scoreLabel(result?.score)}</div><div className="eval-description">{result?.terminal ?? scoreDescription(result?.score)}</div></div><div className="evaluation-actions"><span className="perspective-label">WHITE PERSPECTIVE</span><button className="button ghost compact" onClick={engine.running ? engine.stop : engine.retry}><Icon name={engine.running ? 'pause' : 'play'} size={14}/>{engine.running ? 'Stop' : 'Analyze'}</button></div></div>
            <div className="search-progress"><span className={engine.running ? 'searching' : ''}/></div>
            <div className="engine-metrics"><span>Depth <b>{result?.depth ?? '—'}</b></span><span><b>{result ? Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1}).format(result.nodes) : '—'}</b> nodes</span><span><b>{result ? (result.nps / 1000).toFixed(0) : '—'}</b> kN/s</span></div>
            {engine.error && <div className="error-box" role="alert"><p>{engine.error}</p><button className="text-button" onClick={engine.retry}>Retry connection / analysis</button></div>}
            <div className="continuation">
              <div className="candidate-controls">
                <label>Candidate lines <select value={multipv} onChange={event => {
                  engine.invalidate();
                  setMultipv(event.target.value === '3' ? 3 : 1);
                }}><option value={1}>1 line</option><option value={3}>3 lines</option></select></label>
              </div>
              {multipv === 3 && <p className="candidate-note">MultiPV 3 shares the search budget across candidates and can reduce search strength per line.</p>}
              <div className="section-label candidate-heading">CANDIDATE MOVES<span>{result?.done ? 'SEARCH COMPLETE' : engine.running ? 'LATEST COMPLETE DEPTH' : result ? 'STOPPED' : ''}</span></div>
              {candidates.length ? <ol className="candidate-list">{candidates.map(candidate => {
                const route = routes.find(item => item.ranks.includes(candidate.rank));
                const sharedRank = route?.ranks[0];
                return <li className="candidate-item" key={candidate.rank}>
                  <div className="candidate-line">
                    <span className="candidate-rank" style={{color: candidateColors[candidate.rank - 1]}}>#{candidate.rank}</span>
                    <strong>{candidate.pv[0].san}</strong>
                    <span className="candidate-score">{scoreLabel(candidate.score)}</span>
                    <span className="muted">Depth {candidate.depth}</span>
                    {candidate.rank === 1 && <button className="text-button ml-auto" onClick={() => best && attemptMove(best.slice(0, 2), best.slice(2, 4), best[4])}>Play move</button>}
                  </div>
                  {route && route.ranks.length > 1 && <small className="candidate-note">
                    {sharedRank === candidate.rank ? `Arrow shared by ranks ${route.ranks.map(rank => `#${rank}`).join(', ')}.` : `Uses arrow #${sharedRank}.`}
                  </small>}
                  <Variation moves={candidate.pv} testId={candidate.rank === 1 ? 'principal-variation' : undefined}/>
                </li>;
              })}</ol> : <p className="empty-pv">{result?.terminal ? 'This position is finished. There is no continuation.' : 'Candidates appear when Stockfish completes a depth.'}</p>}
            </div>
          </section>

          <section className="panel moves-panel"><div className="panel-section-heading"><h2>Move list</h2><span>{history.length} {history.length === 1 ? 'ply' : 'plies'}</span></div>
            <div className="move-list" data-testid="move-list">{rows.length ? rows.map(row => <div className="move-row" key={row.number}><span>{row.number}.</span>{(['w', 'b'] as const).map(color => {
              const move = row.moves.find(m => m.color === color);
              return move ? <button key={color} ref={move.index === line.cursor ? currentMove : undefined} className={move.index === line.cursor ? 'current' : ''} aria-current={move.index === line.cursor ? 'step' : undefined} aria-label={`Go to ${row.number}${color === 'w' ? '.' : '...'} ${move.san}`} onClick={() => navigate(move.index)}>{move.san}</button> : <span key={color}/>;
            })}</div>) : <div className="empty-moves"><span>♙</span><p>A fresh perspective.<br/><small>Make a move or import a game to begin.</small></p></div>}</div>
          </section>
        </aside>
      </div>

      <section className="panel position-panel" aria-label="Import and export"><div className="position-intro"><div className="eyebrow">PICK UP WHERE YOU LEFT OFF</div><h2>Position & game</h2><p>Load a FEN position or a PGN game.<br/>Export the line up to the selected move.</p><div className="export-buttons"><button className="button secondary compact" onClick={copyFen}><Icon name="copy" size={15}/>Copy FEN</button><button className="button secondary compact" onClick={() => download(fen + '\n', 'position.fen')}><Icon name="download" size={15}/>FEN</button><button className="button secondary compact" onClick={() => download(exportPgn(line), 'analysis.pgn')}><Icon name="download" size={15}/>PGN</button></div></div>
        <div className="position-form"><div className="import-heading"><div className="import-tabs">{(['fen', 'pgn'] as const).map(kind => <button key={kind} aria-pressed={kind === importKind} className={kind === importKind ? 'active' : ''} onClick={() => {setImportKind(kind); setImportError('');}}>{kind.toUpperCase()}</button>)}</div><button className="text-button" onClick={() => fileInput.current?.click()}><Icon name="upload" size={14}/>Open file</button></div>
          <label className="sr-only" htmlFor="position-input">{importKind.toUpperCase()} to import</label><textarea id="position-input" spellCheck={false} value={importText} onChange={event => setImportText(event.target.value)} placeholder={importKind === 'fen' ? 'Paste a FEN position…' : '[Event "My game"]\n\n1. e4 e5 2. Nf3 Nc6…'} maxLength={100001}/>
          <div className="import-footer"><span className="form-feedback" role={importError ? 'alert' : undefined}>{importError || 'Import replaces the current line.'}</span><button className="button primary compact" onClick={() => doImport()} disabled={!importText.trim()}>Load {importKind.toUpperCase()}<Icon name="right" size={15}/></button></div>
          <input className="sr-only" ref={fileInput} type="file" accept=".pgn,.fen,.txt" aria-label="Open FEN or PGN file" onChange={async event => {
            const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
            if (file.size > 100000) { setImportError('Import is limited to 100 KB.'); return; }
            try { const text = await file.text(); const kind = file.name.toLowerCase().endsWith('.pgn') || text.trim().startsWith('[') ? 'pgn' : file.name.toLowerCase().endsWith('.fen') ? 'fen' : importKind; setImportKind(kind); setImportText(text); setImportError(''); }
            catch { setImportError('Could not read this file.'); }
          }}/>
        </div>
      </section>
      <footer className="site-footer"><span>Just you, the board, and the next move.</span><span>{engine.info ? `${engine.info.threads} threads · ${engine.info.hash_mb} MB hash · MultiPV ${multipv}` : 'Local analysis · No account required'}</span></footer>
    </main>
    <div className={`toast ${notice ? 'visible' : ''}`} role="status">{notice}</div>
    <dialog ref={promotionDialog} onCancel={() => setPromotion(null)} className="modal"><h2>Promote your pawn</h2><p>Choose a piece for {promotion?.to}.</p><div className="promotion-options">{[['q', 'Queen', '♛'], ['r', 'Rook', '♜'], ['b', 'Bishop', '♝'], ['n', 'Knight', '♞']].map(([piece, label, symbol]) => <button key={piece} aria-label={`Promote to ${label}`} onClick={() => promotion && attemptMove(promotion.from, promotion.to, piece)}><span>{symbol}</span>{label}</button>)}</div><button className="button ghost" onClick={() => setPromotion(null)}>Cancel</button></dialog>
    <dialog ref={resetDialog} onCancel={() => setConfirmNew(false)} className="modal"><h2>Start a new board?</h2><p>This replaces your current line. Export PGN first if you want to keep it.</p><div className="flex gap-3 mt-5"><button className="button secondary" onClick={() => setConfirmNew(false)}>Keep analyzing</button><button className="button primary" onClick={reset}>New board</button></div></dialog>
  </div>;
}
