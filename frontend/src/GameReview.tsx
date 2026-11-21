import { useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Chessboard } from 'react-chessboard';
import { scoreDescription, scoreLabel, whitePercentage } from './evaluation.ts';
import { boardAppearance, download, Variation } from './chessDisplay.tsx';
import { gameAt } from './game.ts';
import type { Line } from './game.ts';
import { ReviewGraph } from './ReviewGraph.tsx';
import { isActive, useReview } from './useReview.ts';
import type { Grade, Preset, Quality, Review } from './useReview.ts';

const qualityDetails: Record<Quality, {icon: string; tooltip: string}> = {
  Best: {icon: '★', tooltip: 'Stockfish’s first choice or the only legal move.'},
  Excellent: {icon: '✓', tooltip: 'Very close to the engine’s recommended move.'},
  Good: {icon: '•', tooltip: 'Gave up a few winning-chance points.'},
  Inaccuracy: {icon: '?!', tooltip: 'Gave up a noticeable amount of winning chances.'},
  Mistake: {icon: '?', tooltip: 'Gave up substantial winning chances.'},
  Blunder: {icon: '??', tooltip: 'Gave up a large share of winning chances.'},
  Great: {icon: '!', tooltip: 'Deeper analysis found a uniquely adequate continuation.'},
  Brilliant: {icon: '!!', tooltip: 'Deeper analysis confirmed a sustained material sacrifice with compensation.'},
};
const qualities = Object.keys(qualityDetails) as Quality[];
const colors = ['white', 'black'] as const;

function QualityLabel({label}: {label: Quality}) {
  const {icon, tooltip} = qualityDetails[label];
  return <span className={`quality-label quality-${label.toLowerCase()}`} title={tooltip}>
    <span aria-hidden="true">{icon}</span> {label}
  </span>;
}

function ReviewSummary({job}: {job: Review}) {
  const header = job.game.headers;
  const metadata = Object.entries(header).filter(([key, value]) => !['White', 'Black', 'Result'].includes(key) && value !== '?');
  return <section className="panel review-card" aria-label="Review summary">
    <div className="review-card-heading"><h2>Game summary</h2><span>Result {header.Result}</span></div>
    <div className="review-players">{colors.map(color => {
      const side = color === 'white' ? 'White' : 'Black';
      const name = header[side];
      const none = job.accuracy?.[color] == null;
      return <div className="review-player" key={color}>
        <div className="player-info"><span className={`player-dot ${color}`} aria-hidden="true"/>{side}{name && name !== '?' ? ` · ${name}` : ''}</div>
        <strong>{none ? '—' : `${job.accuracy?.[color]?.toFixed(1)}%`}</strong>
        <small>{job.status !== 'complete' ? 'Accuracy pending' : none ? 'No moves to score' : 'Accuracy'}</small>
      </div>;
    })}</div>
    <table className="review-counts">
      <caption>{job.status === 'complete' ? 'Move classifications' : 'Provisional move classifications'}</caption>
      <thead><tr><th scope="col">Classification</th><th scope="col">White</th><th scope="col">Black</th></tr></thead>
      <tbody>{qualities.map(label => <tr key={label}><th scope="row"><QualityLabel label={label}/></th>
        {colors.map(color => <td key={color}>{job.classification_counts[color][label]}</td>)}</tr>)}</tbody>
    </table>
    {metadata.length > 0 && <details className="review-metadata"><summary>PGN metadata</summary>
      <dl>{metadata.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
    </details>}
    <p className="review-note">Accuracy uses Lichess’s curve and aggregation with local engine comparisons. Scores can differ from Chess.com.</p>
  </section>;
}

function SelectedMove({move, grade}: {move?: Review['game']['moves'][number]; grade?: Grade}) {
  return <section className="panel review-card" aria-label="Selected move">
    <div className="review-card-heading"><h2>{move ? `${move.number}${move.color === 'white' ? '.' : '…'} ${move.san}` : 'Starting position'}</h2>
      {grade && <QualityLabel label={grade.classification}/>}</div>
    {!move && <p className="review-note">Select a move or a point on the evaluation graph to inspect it.</p>}
    {move && !grade && <p className="review-note">This move has not been analyzed yet.</p>}
    {grade && <>
      <p className="review-explanation">{grade.explanation}</p>
      {grade.comparison?.disagreement && <p className="review-note">
        The paired search and the position evaluations disagree. The move grade uses the paired search.
      </p>}
      <dl className="review-move-details">
        <div><dt>Played move</dt><dd>{move?.san} <span>{scoreLabel(grade.played_line.score)} · depth {grade.played_line.depth}</span></dd></div>
        <div><dt>Move accuracy</dt><dd>{grade.accuracy.toFixed(1)}%</dd></div>
        <div><dt>Best alternative</dt><dd>{grade.best_alternative ? <>
          {grade.best_alternative.pv[0].san} <span>{scoreLabel(grade.best_alternative.score)} · depth {grade.best_alternative.depth}</span>
        </> : 'Only legal move'}</dd></div>
      </dl>
      <h3>Recommended continuation</h3>
      <Variation moves={grade.recommendation.pv}/>
    </>}
  </section>;
}

export function GameReview({visible, onOpenPosition}: {visible: boolean; onOpenPosition: (line: Line) => void}) {
  const review = useReview();
  const {job} = review;
  const [pgn, setPgn] = useState('');
  const [preset, setPreset] = useState<Preset>('quick');
  const [cursor, setCursor] = useState(0);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [fileError, setFileError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const fileRead = useRef(0);
  const game = job?.game;
  const evaluated = job?.positions[cursor];
  const line = useMemo(() => game && ({root: game.root_fen, moves: game.moves.map(move => move.uci),
    cursor, headers: game.headers}), [game, cursor]);
  const fen = useMemo(() => evaluated?.fen ?? (line && gameAt(line).fen()), [line, evaluated?.fen]);
  const selected = game?.moves[cursor - 1];
  const squareStyles: Record<string, CSSProperties> = {};
  if (selected) for (const square of [selected.uci.slice(0, 2), selected.uci.slice(2, 4)])
    squareStyles[square] = {backgroundColor: '#d5cd6e70'};
  const active = isActive(job?.status);
  const status = {queued: 'Queued', running: 'Analyzing', complete: 'Complete', cancelled: 'Cancelled', failed: 'Review failed'};
  function changePgn(text: string) {
    setPgn(text);
    setFileError('');
  }

  return <main className="workspace review-workspace" hidden={!visible}>
    <div className="page-heading"><h1>Game Review</h1>
      {job && <button className="button secondary"
        onClick={() => download(JSON.stringify(job, null, 2), 'quiet-chess-review.json', 'application/json;charset=utf-8')}>Export JSON</button>}
    </div>
    <form className="panel review-import" onSubmit={async event => {
      event.preventDefault();
      setFileError('');
      if (await review.start(pgn, preset)) setCursor(0);
    }}>
      <div className="review-source">
        <div className="review-card-heading"><label htmlFor="review-pgn">Game PGN</label>
          <button className="text-button" type="button" onClick={() => fileInput.current?.click()}>Open PGN file</button></div>
        <textarea id="review-pgn" placeholder={'[White "Player 1"]\n[Black "Player 2"]\n\n1. e4 e5 2. Nf3 …'}
          value={pgn} onChange={event => { fileRead.current++; changePgn(event.target.value); }} spellCheck={false}/>
        <input className="sr-only" type="file" ref={fileInput} accept=".pgn,.txt" tabIndex={-1} aria-label="Choose a game PGN file"
          onChange={async event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            const read = ++fileRead.current;
            try {
              const text = await file.text();
              if (read === fileRead.current) changePgn(text);
            } catch {
              if (read === fileRead.current) setFileError('Could not read this PGN file.');
            }
          }}/>
      </div>
      <div className="review-run-settings">
        <div className="review-actions">
          <label>Analysis quality <select value={preset} onChange={event => setPreset(event.target.value as Preset)}>
            <option value="quick">Quick review</option><option value="deep">Deeper review</option>
          </select></label>
          <button className="button primary" disabled={!pgn.trim() || !!review.action} type="submit">
            {review.action === 'starting' ? 'Submitting PGN…' : active ? 'Replace review' : 'Run review'}</button>
          {active && <button className="button secondary" type="button" disabled={!!review.action}
            onClick={review.cancel}>{review.action === 'cancelling' ? 'Cancelling…' : 'Cancel review'}</button>}
          {job && review.canRetry && ['failed', 'cancelled'].includes(job.status) && <button className="button secondary" type="button"
            disabled={!!review.action} onClick={async () => { if (await review.retry()) setCursor(0); }}>Retry previous review</button>}
        </div>
        <p className="review-note">{preset === 'quick' ? 'Quick review uses smaller per-position search budgets.' : 'Deeper review searches more nodes and may take several minutes.'} Import one standard-chess game at a time.</p>
        {(fileError || review.error) && <p className="review-error" role="alert">{fileError || review.error}</p>}
        {job && <div className="review-progress" role="status">
          <div><strong>{status[job.status]}</strong><span>{job.analyzed} / {job.total} plies · {job.settings.preset === 'quick' ? 'Quick' : 'Deeper'} review</span></div>
          <progress aria-label="Review progress" max={Math.max(1, job.total)} value={job.total || job.status !== 'complete' ? job.analyzed : 1}/>
          <p className="review-note">{job.position_count} / {job.total + 1} positions evaluated. {active && job.position_count > job.analyzed + 1 && 'Comparing the next move.'}</p>
          <p className="review-note">{job.settings.engine ?? 'Stockfish'} · {job.settings.position_nodes.toLocaleString()} nodes per main search</p>
          {job.status !== 'complete' && <p className="review-note">{job.position_count > 0 ? 'Partial results · whole-game accuracy is pending.' : 'Whole-game accuracy appears after all moves are analyzed.'}</p>}
          {active && <p className="review-note">Board analysis pauses on this tab. Analysis Board requests can wait for the current review search.</p>}
          {job.game.ending.kind === 'position' && job.status === 'complete' && <p className="review-note">Final position · {job.game.ending.reason}</p>}
          {job.game.ending.kind === 'recorded' && <p className="review-note">
            Recorded PGN result{job.game.ending.reason ? ` · ${job.game.ending.reason}` : ''}. The final board position remains playable.
          </p>}
        </div>}
        {review.connectionError && <p className="review-error" role="status">{review.connectionError}</p>}
        {job?.error && <p className="review-error" role="alert">{job.error}</p>}
      </div>
    </form>
    {job && line && fen && <div className="analysis-grid review-grid">
      <div className="board-column">
        <div className="board-row">
          <div className={`eval-bar ${orientation === 'black' ? 'flipped' : ''}`} role="meter"
            aria-label={`Evaluation. ${scoreDescription(evaluated?.score)}. White perspective.`}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={whitePercentage(evaluated?.score)}
            aria-valuetext={scoreLabel(evaluated?.score)}>
            <div className="white-eval" style={{height: `${whitePercentage(evaluated?.score)}%`}}/><span className="bar-midline"/>
          </div>
          <div className="board-frame" data-testid="review-board"><Chessboard options={{id: 'review-board', position: fen,
            boardOrientation: orientation, ...boardAppearance, squareStyles, allowDragging: false, allowDrawingArrows: false}}/></div>
        </div>
        <div className="review-board-actions">
          <button className="button ghost compact" onClick={() => setOrientation(value => value === 'white' ? 'black' : 'white')}>Flip board</button>
          <button className="button ghost compact" onClick={() => onOpenPosition(line)}>Analyze position</button>
          <button className="icon-button" aria-label="Previous review position" disabled={!cursor} onClick={() => setCursor(cursor - 1)}>‹</button>
          <span className="ply-counter">{cursor} / {job.total}</span>
          <button className="icon-button" aria-label="Next review position" disabled={cursor >= job.total} onClick={() => setCursor(cursor + 1)}>›</button>
        </div>
        <ReviewGraph positions={job.positions} total={job.total} selected={cursor} onSelect={setCursor}/>
      </div>
      <aside className="review-sidebar" aria-label="Game review details">
        <ReviewSummary job={job}/>
        <section className="panel review-card"><div className="review-card-heading"><h2>Review moves</h2>
          <button className="text-button" onClick={() => setCursor(0)} aria-current={!cursor ? 'step' : undefined}>Starting position</button></div>
          <ol className="review-moves" aria-label="Review move list">{job.game.moves.map((move, index) => {
            const grade = job.moves[index];
            return <li key={index}><button aria-current={cursor === index + 1 ? 'step' : undefined} onClick={() => setCursor(index + 1)}>
              <span>{move.number}{move.color === 'white' ? '.' : '…'} <b>{move.san}</b></span>
              {grade ? <QualityLabel label={grade.classification}/> : <span className="muted">Pending</span>}
            </button></li>;
          })}</ol>
          {!job.total && <p className="review-note">This PGN contains no moves.</p>}
        </section>
        <SelectedMove move={selected} grade={job.moves[cursor - 1]}/>
      </aside>
    </div>}
  </main>;
}
