import asyncio
from contextlib import asynccontextmanager
import json
import logging
from pathlib import Path
import time

import chess
import chess.engine
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import ValidationError

from .engine import EngineManager
from .latest import LatestJob
from .protocol import AnalyzeRequest, MODES, PositionValidationRequest, info_payload, terminal_score
from .review import ReviewAnalyzer
from .review_jobs import ReviewJobs, review_routes
from .search import Iterations
from .settings import Settings

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
logger = logging.getLogger(__name__)


def create_app(settings=None, manager=None):
    settings = settings or Settings.from_env()
    manager = manager or EngineManager(settings)
    reviews = ReviewJobs(ReviewAnalyzer(manager, settings))

    @asynccontextmanager
    async def lifespan(app):
        try:
            await manager.ensure()
        except RuntimeError as exc:
            logger.warning("%s", exc)
        reviews.open()
        try:
            yield
        finally:
            await reviews.close()
            await manager.close()

    app = FastAPI(title="Quiet Chess — local analysis", lifespan=lifespan)
    app.state.engine = manager
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "[::1]", "testserver"])
    app.include_router(review_routes(reviews, settings.origins))

    @app.get("/api/health")
    async def health():
        return {"ready": manager.protocol is not None, "engine": manager.name,
                "error": manager.error, "threads": settings.threads, "hash_mb": settings.hash_mb,
                "multipv": [1, 3], "limit_strength": False}

    @app.post("/api/positions/validate")
    async def validate_position(payload: PositionValidationRequest, request: Request):
        origin = request.headers.get("origin")
        if origin is not None and origin not in settings.origins:
            raise HTTPException(403, "Local origin required.")
        try:
            board = payload.board()
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"fen": board.fen(en_passant="fen")}

    @app.websocket("/ws/analysis")
    async def websocket(ws: WebSocket):
        # CORS does not protect WebSockets. Reject nonlocal browser origins explicitly.
        if ws.headers.get("origin") not in settings.origins:
            await ws.close(code=1008, reason="Local origin required")
            return
        await ws.accept()
        if manager.owner is not None:
            await ws.send_json({"type": "error", "code": "busy",
                                "message": "Another tab is using the engine. Close it, then reconnect."})
            await ws.close(code=1013)
            return
        manager.owner = ws
        send_lock = asyncio.Lock()
        alive = True

        async def send(message):
            async with send_lock:
                if alive:
                    await ws.send_json(message)

        async def work(token, request):
            last_sent = 0.0
            board = request.board()
            base = {"request_id": request.request_id, "fen": board.fen(), "multipv": request.multipv}
            iterations = Iterations(min(request.multipv, board.legal_moves.count()))

            async def publish(message):
                if runner.is_current(token):
                    await send({**base, **message})

            async def emit(info, done):
                nonlocal last_sent
                lines = iterations.latest if done else iterations.feed(info)
                now = time.monotonic()
                if lines and (done or now - last_sent >= 0.08):
                    last_sent = now
                    candidates = [{"rank": line["multipv"], **info_payload(board, line)} for line in lines]
                    await publish({"type": "analysis", **candidates[0], "candidates": candidates, "done": done})
                if done:
                    if not lines:
                        await publish({"type": "error", "code": "engine",
                                       "message": "Stockfish returned no complete candidate iteration. Try again."})
                        return
                    await publish({"type": "complete"})

            try:
                await publish({"type": "started"})
                outcome = board.outcome(claim_draw=False)
                if outcome is not None:
                    await publish({"type": "analysis", "done": True, "depth": 0, "nodes": 0,
                                   "nps": 0, "time": 0, "pv": [], "best_move": None,
                                   "candidates": [],
                                   "terminal": outcome.termination.name.lower().replace("_", " "),
                                   "score": terminal_score(board, outcome)})
                    await publish({"type": "complete"})
                    return
                await manager.stream(board, MODES[request.mode], emit, multipv=request.multipv)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception("Analysis failed")
                await publish({"type": "error", "code": "engine", "message": str(exc)})

        runner = LatestJob(work)
        try:
            await send({"type": "hello", "engine": manager.name, "threads": settings.threads,
                        "hash_mb": settings.hash_mb, "multipv": [1, 3]})
            while True:
                raw = await ws.receive_text()
                if len(raw.encode("utf-8")) > 65536:
                    await ws.close(code=1009, reason="Request too large")
                    break
                request_id = None
                try:
                    data = json.loads(raw)
                    if not isinstance(data, dict):
                        raise ValueError("Expected an object")
                    candidate = data.get("request_id")
                    request_id = candidate if isinstance(candidate, str) and len(candidate) <= 80 else None
                    # Invalidate before validation: an invalid new position must not retain an old score.
                    runner.stop()
                    if data.get("type") == "stop":
                        await send({"type": "stopped", "request_id": request_id})
                        continue
                    request = AnalyzeRequest.model_validate(data)
                    request.board()
                    runner.replace(request)
                except (ValueError, ValidationError) as exc:
                    await send({"type": "error", "code": "invalid_request", "request_id": request_id,
                                "message": str(exc)[:600]})
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            alive = False
            try:
                await runner.close()
            finally:
                manager.owner = None

    dist = ROOT / "frontend" / "dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
    else:
        @app.get("/")
        async def index():
            return JSONResponse({"message": "Run npm run dev in frontend, or npm run build and restart the backend."})
    return app


app = create_app()
