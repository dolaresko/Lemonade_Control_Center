"""Metrics endpoints and WebSocket stream."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse

from app.services.metrics.collector import buffer, collect_once, subscribe, unsubscribe
from app.services.metrics.store import RANGE_WINDOWS, resolve_range
from app.services.metrics.task_history import TaskHistory, task_history
from app.services.security import (
    auth_required_for_host,
    key_configured,
    key_from_websocket,
    verify_key,
)

router = APIRouter(prefix="/api/metrics", tags=["metrics"])
ws_router = APIRouter()

# Exported for callers that used to reach the history through this module.
__all__ = ["TaskHistory", "router", "task_history", "ws_router"]


@router.get("/history")
async def get_history(minutes: int = Query(default=30, ge=1, le=60)):
    if buffer.size == 0:
        await collect_once()
    return {"points": buffer.get_range(minutes), "total": buffer.size, "retention_minutes": 30}


@router.get("/latest")
async def get_latest():
    if buffer.size == 0:
        await collect_once()
    return {"point": buffer.get_latest()}


@router.get("/tasks")
async def get_tasks(
    n: int = Query(default=100, ge=1, le=5000),
    since: str | None = Query(default=None, description="ISO-8601 lower bound, inclusive"),
    until: str | None = Query(default=None, description="ISO-8601 upper bound, inclusive"),
):
    """Recent task records, oldest first.

    The response shape is unchanged; `since` / `until` narrow the window and
    `n` now reaches far beyond the old 50-record ceiling.
    """
    window_start = _parse_boundary(since, "since")
    window_end = _parse_boundary(until, "until")
    tasks = await asyncio.to_thread(
        task_history.get_recent, n, window_start, window_end, True
    )
    return {"tasks": tasks}


@router.get("/tasks/series")
async def get_tasks_series(
    range: str = Query(default="24h", description="|".join(RANGE_WINDOWS)),
):
    """Time-bucketed generation-speed aggregates over a long window."""
    key, window, bucket_seconds = resolve_range(range)
    end = datetime.now(timezone.utc)
    start = end - window
    window = await asyncio.to_thread(task_history.window, start, end, bucket_seconds)
    return {
        "range": key,
        "bucket_seconds": bucket_seconds,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "buckets": window["buckets"],
        "summary": window["summary"],
    }


@router.get("/hardware/series")
async def get_hardware_series(
    range: str = Query(default="24h", description="|".join(RANGE_WINDOWS)),
):
    """Time-bucketed hardware aggregates from the persisted per-minute rows."""
    key, window, bucket_seconds = resolve_range(range)
    end = datetime.now(timezone.utc)
    start = end - window
    buckets = await asyncio.to_thread(
        task_history.store.hardware_series, start, end, bucket_seconds
    )
    return {
        "range": key,
        "bucket_seconds": bucket_seconds,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "buckets": buckets,
    }


@router.get("/tasks/csv")
async def export_tasks_csv(
    since: str | None = Query(default=None),
    until: str | None = Query(default=None),
    range: str | None = Query(default=None),
):
    """CSV export, optionally narrowed by the same window the charts use."""
    window_start = _parse_boundary(since, "since")
    window_end = _parse_boundary(until, "until")
    if range and window_start is None:
        _, window, _bucket = resolve_range(range)
        window_start = datetime.now(timezone.utc) - window

    body = await asyncio.to_thread(
        task_history.export_csv, window_start, window_end, 100_000, True
    )
    return PlainTextResponse(
        body,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=lcc-tasks.csv"},
    )


@router.post("/clear")
async def clear_metrics():
    buffer.clear()
    await asyncio.to_thread(task_history.clear)
    return {"cleared": True}


def _parse_boundary(value: str | None, field: str) -> datetime | None:
    """Parse an ISO-8601 query bound, defaulting a naive value to UTC."""
    if value is None or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip())
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field} must be an ISO-8601 timestamp")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


@ws_router.websocket("/ws/metrics")
async def ws_metrics(websocket: WebSocket):
    host = websocket.client.host if websocket.client else None
    if auth_required_for_host(host):
        if not key_configured() or not verify_key(key_from_websocket(websocket)):
            await websocket.close(code=1008)
            return

    await websocket.accept()
    queue = subscribe()
    try:
        while True:
            data = await queue.get()
            await websocket.send_json({"type": "metric", "data": data})
    except WebSocketDisconnect:
        pass
    finally:
        unsubscribe(queue)
