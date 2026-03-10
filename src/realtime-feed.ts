/**
 * Fetches real-time train data from the Amtraker v3 API and transforms
 * it into our standard FeedSnapshot format.
 *
 * Amtraker v3 API: https://api-v3.amtraker.com/v3/trains
 *   - No API key required
 *   - Returns JSON with all active Amtrak trains
 *   - Response shape: { "trainNum": [trainObj, ...], ... }
 *   - Each train has stations[] with scheduled/actual times
 *
 * Delay is computed by comparing scheduled vs actual departure/arrival
 * times at each station (schDep/schArr vs dep/arr fields).
 */

const AMTRAKER_URL = "https://api-v3.amtraker.com/v3/trains";

// -- Types ------------------------------------------------------------------

export interface TripUpdate {
  tripId: string;
  routeId: string;
  lineName: string; // e.g. "Acela 2151" or "Empire Builder 7"
  startDate: string; // YYYYMMDD
  startTime: string; // HH:MM:SS
  runId: string; // "Acela-2151-20260310-0630"
  cancelled: boolean;
  departureDelaySec: number | null;
  arrivalDelaySec: number | null;
  currentDelaySec: number | null;
  trainNumber: string | null;
}

export interface FeedSnapshot {
  meta: {
    updatedAt: string;
    feedTimestamp: string;
    tripCount: number;
    totalEntities: number;
    staticLoadedAt: string | null;
  };
  trips: Record<string, TripUpdate>;
}

// -- Amtraker API response types --------------------------------------------

interface AmtrakerStation {
  name: string;
  code: string;
  tz: string;
  bus: boolean;
  schArr: string; // ISO 8601 scheduled arrival
  schDep: string; // ISO 8601 scheduled departure
  arr: string; // ISO 8601 actual/estimated arrival
  dep: string; // ISO 8601 actual/estimated departure
  arrCmnt: string;
  depCmnt: string;
  status: string; // "Departed", "Enroute", "Station", ""
  platform: string;
}

interface AmtrakerTrain {
  routeName: string; // e.g. "Acela", "Empire Builder"
  trainNum: string;
  trainID: string;
  lat: number;
  lon: number;
  trainTimely: string;
  stations: AmtrakerStation[];
  heading: string;
  eventCode: string;
  origCode: string;
  origName: string;
  destCode: string;
  destName: string;
  trainState: string; // "Active", "Predeparture", etc.
  velocity: number;
  statusMsg: string;
  createdAt: string;
  updatedAt: string;
  lastValTS: string;
  objectID: number;
  provider: string;
  alerts: unknown[];
}

// -- State ------------------------------------------------------------------

let latest: { json: string; data: FeedSnapshot } | null = null;

export function getSnapshot() {
  return latest;
}

// -- Fetch & transform ------------------------------------------------------

export async function fetchAndFilter(): Promise<void> {
  const t0 = Date.now();
  console.log("[rt] Fetching Amtraker v3 API...");

  const res = await fetch(AMTRAKER_URL, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: "application/json",
      "User-Agent": "BahnBet-Proxy-US/1.0",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Amtraker API failed: ${res.status} ${text.slice(0, 300)}`,
    );
  }

  const json: unknown = await res.json();
  if (!json || typeof json !== "object") {
    throw new Error("Amtraker API returned unexpected response format");
  }

  const trainGroups = json as Record<string, AmtrakerTrain[]>;
  const trips: Record<string, TripUpdate> = {};
  let totalEntities = 0;
  let tripCount = 0;

  for (const [_trainNum, trainList] of Object.entries(trainGroups)) {
    if (!Array.isArray(trainList)) continue;

    for (const train of trainList) {
      totalEntities++;

      if (!train.stations || !Array.isArray(train.stations) || train.stations.length === 0) {
        continue;
      }

      const trainNumber = String(train.trainNum);
      const routeName = train.routeName || "Amtrak";

      // Sanitize route name for use in runId (replace spaces with hyphens, remove special chars)
      const routeSlug = routeName.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

      const lineName = `${routeName} ${trainNumber}`;

      // First station = origin
      const firstStation = train.stations[0];
      // Last station = destination
      const lastStation = train.stations[train.stations.length - 1];

      // Extract startDate and startTime from first station's scheduled departure
      const schDepFirst = firstStation.schDep;
      const { dateStr, timeStr, hhmm } = parseISODateTime(schDepFirst);

      // Compute delays
      const departureDelaySec = computeStationDelaySec(firstStation, "dep");

      const arrivalDelaySec = computeStationDelaySec(lastStation, "arr");

      // Current delay = delay at the last station with actual tracking data
      const currentDelaySec = computeCurrentDelay(train.stations);

      // Check for cancellation
      const cancelled = train.trainState === "Cancelled" ||
        train.trainState === "Canceled";

      // Build runId: "{RouteName}-{trainNum}-{YYYYMMDD}-{HHMM}"
      const runId = routeSlug && trainNumber && dateStr
        ? `${routeSlug}-${trainNumber}-${dateStr}-${hhmm}`
        : "";

      // Use trainID from Amtraker as tripId (unique per train instance)
      const tripId = train.trainID || `amtk-${trainNumber}-${dateStr}`;

      trips[tripId] = {
        tripId,
        routeId: routeSlug,
        lineName,
        startDate: dateStr,
        startTime: timeStr,
        runId,
        cancelled,
        departureDelaySec,
        arrivalDelaySec,
        currentDelaySec,
        trainNumber,
      };
      tripCount++;
    }
  }

  const data: FeedSnapshot = {
    meta: {
      updatedAt: new Date().toISOString(),
      feedTimestamp: new Date().toISOString(),
      tripCount,
      totalEntities,
      staticLoadedAt: null, // No static feed for US
    },
    trips,
  };

  latest = { json: JSON.stringify(data), data };

  console.log(
    `[rt] ${tripCount} trains from ${totalEntities} entities in ${Date.now() - t0}ms`,
  );
}

// -- Helpers ----------------------------------------------------------------

/**
 * Parse an ISO 8601 datetime string into date and time components.
 * e.g. "2026-03-10T09:00:00-05:00" → { dateStr: "20260310", timeStr: "09:00:00", hhmm: "0900" }
 */
function parseISODateTime(iso: string): {
  dateStr: string;
  timeStr: string;
  hhmm: string;
} {
  if (!iso) return { dateStr: "", timeStr: "", hhmm: "0000" };

  // Parse the ISO string to get the local date/time parts
  // The Amtraker API returns times in local timezone, so we extract directly
  const match = iso.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/,
  );
  if (!match) return { dateStr: "", timeStr: "", hhmm: "0000" };

  const [, year, month, day, hour, min, sec] = match;
  return {
    dateStr: `${year}${month}${day}`,
    timeStr: `${hour}:${min}:${sec}`,
    hhmm: `${hour}${min}`,
  };
}

/**
 * Compute delay in seconds at a station by comparing scheduled vs actual time.
 * @param station - The station stop data
 * @param type - "dep" for departure delay, "arr" for arrival delay
 */
function computeStationDelaySec(
  station: AmtrakerStation,
  type: "dep" | "arr",
): number | null {
  const scheduled = type === "dep" ? station.schDep : station.schArr;
  const actual = type === "dep" ? station.dep : station.arr;

  if (!scheduled || !actual) return null;

  const schedMs = new Date(scheduled).getTime();
  const actualMs = new Date(actual).getTime();

  if (isNaN(schedMs) || isNaN(actualMs)) return null;

  // If actual equals scheduled exactly and station has no status, no real data yet
  if (actual === scheduled && !station.status) return null;

  return Math.round((actualMs - schedMs) / 1000);
}

/**
 * Find the current delay: walk backwards through stations to find
 * the last one with actual tracking data (status "Departed", "Station", or "Enroute").
 */
function computeCurrentDelay(stations: AmtrakerStation[]): number | null {
  for (let i = stations.length - 1; i >= 0; i--) {
    const s = stations[i];
    // A station has real data if it has a non-empty status
    if (!s.status || s.status.trim() === "") continue;

    // Try departure delay first (station was passed), then arrival
    const depDelay = computeStationDelaySec(s, "dep");
    if (depDelay != null) return depDelay;

    const arrDelay = computeStationDelaySec(s, "arr");
    if (arrDelay != null) return arrDelay;
  }
  return null;
}
