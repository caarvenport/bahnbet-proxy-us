/**
 * No GTFS static feed for US — data comes from the Amtraker v3 API.
 * This module exports a no-op getStopName for interface compatibility.
 */

export function getStopName(_stopId: string): string | undefined {
  return undefined;
}
