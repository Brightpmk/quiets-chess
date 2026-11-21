"""One running review, with at most one replacement pending UCI stop cleanup."""
import asyncio
from collections import OrderedDict
from dataclasses import dataclass, field
import logging
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .latest import LatestJob
from .review import counts_for_moves
from .review_pgn import ReviewGame, parse_pgn

logger = logging.getLogger(__name__)
ACTIVE = {"queued", "running"}
RETAINED_JOBS = 4


class ReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    pgn: str
    preset: Literal["quick", "deep"] = "quick"
    replace: str | None = Field(default=None, max_length=32)


@dataclass
class ReviewJob:
    game: ReviewGame
    preset: str
    settings: dict
    id: str = field(default_factory=lambda: uuid4().hex)
    status: str = "queued"
    moves: list = field(default_factory=list)
    positions: list = field(default_factory=list)
    accuracy: dict | None = None
    error: str | None = None

    async def checkpoint(self):
        await asyncio.sleep(0)
        if self.status != "running":
            raise asyncio.CancelledError

    def snapshot(self, after=0, position_after=0, include_game=True):
        return {"id": self.id, "status": self.status, "settings": self.settings,
                "error": self.error, "game": {"root_fen": self.game.root_fen, "headers": self.game.headers,
                                              "moves": self.game.moves, "terminal": self.game.terminal,
                                              "ending": self.game.ending}
                if include_game else None,
                "analyzed": len(self.moves), "total": len(self.game.moves), "moves": self.moves[after:],
                "positions": self.positions[position_after:], "position_count": len(self.positions),
                "move_from": after, "position_from": position_after,
                "classification_counts": counts_for_moves(self.moves),
                "accuracy": self.accuracy if self.status == "complete" else None}


class ReviewJobs:
    def __init__(self, analyzer):
        self.analyzer = analyzer
        self.jobs = OrderedDict()
        self.active = None
        self.runner = None
        self.import_lock = asyncio.Lock()

    def open(self):
        self.runner = LatestJob(self.run)

    async def close(self):
        if self.active:
            self.cancel(self.active)
        await self.runner.close()

    def check_replacement(self, request):
        if self.active and request.replace != self.active.id:
            raise HTTPException(409, "A review is already running. Resume it here or cancel it before starting another.")

    async def submit(self, request):
        self.check_replacement(request)
        if self.import_lock.locked():
            raise HTTPException(409, "Another PGN is being imported. Try again when that import finishes.")
        async with self.import_lock:
            try:
                game = await asyncio.to_thread(parse_pgn, request.pgn)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
        self.check_replacement(request)
        if self.active:
            self.cancel(self.active)
        job = ReviewJob(game, request.preset, self.analyzer.metadata(request.preset))
        self.jobs[job.id] = self.active = job
        if len(self.jobs) > RETAINED_JOBS:
            self.jobs.popitem(last=False)
        self.runner.replace(job)
        return job

    def get(self, job_id):
        job = self.jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "This review is no longer available. Run it again from your PGN.")
        return job

    def cancel(self, job):
        if job is self.active and job.status in ACTIVE:
            job.status = "cancelled"
            self.active = None
            self.runner.stop()
        return job

    async def run(self, token, job):
        job.status = "running"
        try:
            await self.analyzer.run(job)
            await job.checkpoint()
            if len(job.moves) != len(job.game.moves) or len(job.positions) != len(job.moves) + 1:
                raise RuntimeError("Review stopped before all positions and moves were evaluated. Retry the PGN.")
            if self.runner.is_current(token):
                job.status = "complete"
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if self.runner.is_current(token):
                logger.exception("Review failed")
                job.status = "failed"
                job.error = str(exc) if isinstance(exc, RuntimeError) else "Review could not finish. Retry the PGN."
        finally:
            if job is self.active:
                self.active = None


def review_routes(jobs, allowed_origins):
    router = APIRouter(prefix="/api/reviews")

    def check_origin(request):
        origin = request.headers.get("origin")
        if origin is not None and origin not in allowed_origins:
            raise HTTPException(403, "Local origin required.")

    @router.post("", status_code=202)
    async def submit(request: Request):
        check_origin(request)
        if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
            raise HTTPException(415, "Send the review request as JSON.")
        try:
            payload = ReviewRequest.model_validate_json(await request.body())
        except ValidationError as exc:
            raise HTTPException(422, "Invalid review request. Supply a PGN and select a preset.") from exc
        return (await jobs.submit(payload)).snapshot()

    @router.get("/active")
    async def active(request: Request):
        check_origin(request)
        return jobs.active.snapshot() if jobs.active else None

    @router.get("/{job_id}")
    async def status(job_id: str, request: Request, after: int | None = None, position_after: int = 0):
        check_origin(request)
        job = jobs.get(job_id)
        if not 0 <= (after or 0) <= len(job.moves) or not 0 <= position_after <= len(job.positions):
            raise HTTPException(422, "Invalid review progress offset.")
        return job.snapshot(after or 0, position_after, include_game=after is None)

    @router.delete("/{job_id}")
    async def cancel(job_id: str, request: Request):
        check_origin(request)
        return jobs.cancel(jobs.get(job_id)).snapshot()

    return router
