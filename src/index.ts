/**
 * United States (Amtrak) Train Delay Proxy
 *
 * Realtime: Queries the Amtraker v3 API every 90s for all active Amtrak trains.
 *           No API key required. No static feed needed — Amtraker returns
 *           complete train data including route names, station stops, and delays.
 *
 * Designed for Railway free tier: 0.5 vCPU, 512 MB RAM.
 */

import http from "node:http";
import { fetchAndFilter, getSnapshot } from "./realtime-feed.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const RT_INTERVAL = 90_000; // fetch from Amtraker every 90s

// -- Main -------------------------------------------------------------------

async function main() {
  console.log("[proxy-us] Amtrak Proxy starting...");

  // 1. Start HTTP server immediately so healthcheck passes during data load
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    // GET /feed -- Amtrak train data in standard FeedSnapshot format
    if (url.pathname === "/feed" && req.method === "GET") {
      const snap = getSnapshot();
      if (!snap) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end('{"error":"No data available yet"}');
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=30",
      });
      res.end(snap.json);
      return;
    }

    // GET /health -- service status
    if (url.pathname === "/health") {
      const snap = getSnapshot();
      const now = Date.now();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          country: "US",
          uptime: Math.floor(process.uptime()),
          lastUpdate: snap?.data.meta.updatedAt ?? null,
          tripCount: snap?.data.meta.tripCount ?? 0,
          ageSeconds: snap
            ? Math.floor(
                (now - new Date(snap.data.meta.updatedAt).getTime()) / 1000,
              )
            : null,
          memoryMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"Not found"}');
  });

  server.listen(PORT, () => {
    console.log(`[proxy-us] Listening on :${PORT}`);
  });

  // 2. First Amtraker fetch
  try {
    await fetchAndFilter();
  } catch (err) {
    console.error("[rt] Initial fetch failed (will retry on schedule):", err);
  }

  // 3. Periodic refresh
  setInterval(async () => {
    try {
      await fetchAndFilter();
    } catch (err) {
      console.error("[rt] Fetch error:", (err as Error).message);
    }
  }, RT_INTERVAL);
}

main().catch((err) => {
  console.error("[proxy-us] Fatal:", err);
  process.exit(1);
});
