// Seaman-declared AVAILABILITY — a client-safe (Node-free) shared vocabulary, so the
// seaman self-service editor, the agent review override, the roster talent-search
// filter AND the search-row projection all agree on ONE model. This is the seaman's
// OWN "am I free to take a berth" signal — deliberately SEPARATE from the agent
// pipeline stage (lib/pipeline.ts `SeafarerState`, the agent's workflow position).
// The two dimensions must never be conflated again.

export const AVAILABILITY_VALUES = ["open", "open_from", "occupied"] as const;
export type Availability = (typeof AVAILABILITY_VALUES)[number];

export function isAvailability(v: unknown): v is Availability {
  return typeof v === "string" && (AVAILABILITY_VALUES as readonly string[]).includes(v);
}

// Seaman-facing labels for the three declarable states.
export const AVAILABILITY_LABELS: Record<Availability, string> = {
  open: "Open now",
  open_from: "Open from a date",
  occupied: "Occupied / Employed",
};

// The talent-search filter dimension. "open_by" is a DERIVED query (open now, or an
// open_from whose date is on/before the chosen date), so it is NOT an Availability
// value — it exists only as a search option.
export const AVAILABILITY_FILTERS = ["open", "open_by", "occupied"] as const;
export type AvailabilityFilter = (typeof AVAILABILITY_FILTERS)[number];

export const AVAILABILITY_FILTER_LABELS: Record<AvailabilityFilter, string> = {
  open: "Open now",
  open_by: "Open by a date",
  occupied: "Occupied",
};

/** A yyyy-mm-dd slice for a safe lexicographic date compare (both sides same shape). */
function day(iso: string | null | undefined): string {
  return (iso ?? "").slice(0, 10);
}

/**
 * Does a row match an availability filter? `by` is an optional yyyy-mm-dd bound used
 * ONLY by the "open_by" filter:
 *   - open      -> availability === "open"
 *   - occupied  -> availability === "occupied"
 *   - open_by   -> "open", OR an "open_from" whose availableFrom is on/before `by`
 *                  (when `by` is blank, ANY open / open_from counts as "open").
 * A row with no declared availability ("Not set") matches none of the filters.
 */
export function matchesAvailabilityFilter(
  row: { availability?: Availability | null; availableFrom?: string | null },
  filter: AvailabilityFilter,
  by: string = ""
): boolean {
  const a = row.availability;
  if (filter === "open") return a === "open";
  if (filter === "occupied") return a === "occupied";
  // open_by
  if (a === "open") return true;
  if (a === "open_from") {
    const from = day(row.availableFrom);
    if (!by) return true; // no bound: any open_from counts as available
    if (!from) return true; // open_from with no date on file: treat as available
    return from <= day(by);
  }
  return false;
}
