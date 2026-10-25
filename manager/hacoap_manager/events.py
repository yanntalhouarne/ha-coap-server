"""Live events for the browser (device changes, update progress), over a WebSocket."""

import asyncio
import contextlib
import time


class EventBus:
    def __init__(self):
        self._queues = set()

    def publish(self, kind, **data):
        event = {"type": kind, "time": time.time(), **data}
        for queue in list(self._queues):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass  # a stalled browser tab misses events; it reloads the state on reconnect

    @contextlib.contextmanager
    def subscribe(self, size=500):
        queue = asyncio.Queue(size)
        self._queues.add(queue)
        try:
            yield queue
        finally:
            self._queues.discard(queue)
