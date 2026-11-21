import { scoreLabel } from './evaluation.ts';
import type { Position } from './useReview.ts';

const WIDTH = 440;
const HEIGHT = 150;
const LEFT = 36;
const RIGHT = 423;
const TOP = 15;
const BOTTOM = 126;

export function ReviewGraph({positions, total, selected, onSelect}: {
  positions: Position[]; total: number; selected: number; onSelect: (ply: number) => void;
}) {
  const limit = Math.min(10, Math.max(2, ...positions.map(({score}) => Math.ceil(Math.abs(score.cp ?? 0) / 100))));
  const x = (ply: number) => LEFT + (RIGHT - LEFT) * ply / Math.max(1, total);
  const y = (pawns: number) => TOP + (BOTTOM - TOP) * (limit - pawns) / (2 * limit);
  const points = positions.map(({score}, ply) => ({
    x: x(ply),
    y: y(score.mate !== null ? (score.winner === 'white' ? limit : -limit)
      : Math.max(-limit, Math.min(limit, (score.cp ?? 0) / 100))),
  }));
  const selectedPoint = points[selected];
  return <section className="panel review-card review-graph" aria-label="Evaluation graph">
    <div className="review-card-heading"><h2>Evaluation graph</h2><span>White perspective · pawns</span></div>
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true" data-testid="evaluation-graph"
      onClick={event => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const position = (event.clientX - bounds.left) / bounds.width * WIDTH;
        const ply = Math.round((position - LEFT) / (RIGHT - LEFT) * total);
        if (points.length) onSelect(Math.min(points.length - 1, Math.max(0, ply)));
      }}>
      {[limit, 0, -limit].map(tick => <g key={tick}>
        <line x1={LEFT} x2={RIGHT} y1={y(tick)} y2={y(tick)} className={tick ? 'graph-gridline' : 'graph-midline'}/>
        <text x={28} y={y(tick) + 4} textAnchor="end">{tick > 0 ? `+${tick}` : tick}</text>
      </g>)}
      <text x={LEFT} y={144}>Start</text>
      {!!total && <text x={RIGHT} y={144} textAnchor="end">Ply {total}</text>}
      <polyline points={points.map(point => `${point.x},${point.y}`).join(' ')} className="graph-line"/>
      {points.map((point, ply) => <circle key={ply} cx={point.x} cy={point.y} r={points.length < 65 ? 3 : 1.5}
        className="graph-point"><title>{ply ? `Ply ${ply}` : 'Start'} · {scoreLabel(positions[ply].score)}</title></circle>)}
      {selectedPoint && <g className="graph-selection">
        <line x1={selectedPoint.x} x2={selectedPoint.x} y1={TOP} y2={BOTTOM}/>
        <circle cx={selectedPoint.x} cy={selectedPoint.y} r={5}/>
      </g>}
    </svg>
    <div className="graph-controls">
      <input type="range" aria-label="Evaluated ply" aria-valuetext={selectedPoint
        ? `Ply ${selected}, ${scoreLabel(positions[selected].score)}` : 'Select an evaluated position'}
        min={0} max={Math.max(1, positions.length - 1)}
        value={selectedPoint ? selected : Math.max(0, positions.length - 1)}
        disabled={positions.length < 2} onChange={event => onSelect(Number(event.target.value))}/>
      <output>{selectedPoint ? `Ply ${selected} · ${scoreLabel(positions[selected].score)}` : 'Awaiting evaluation'}</output>
    </div>
    <p className="review-note">Mate scores appear at the edges. The graph clips evaluations beyond ±10 pawns.</p>
  </section>;
}
