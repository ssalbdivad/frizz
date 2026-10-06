// ---- THE LOCAL SCHEDULE GRAMMAR -----------------------------------------------------------------------
// plans/schedule-live-reading.md §3. Reads a schedule phrase out of what the human typed, with no model,
// in the browser, in node tests and on the server alike. (Stub: the grammar lands in the next commit.)

/** Bumped whenever a phrase could read differently. A local reading carries it to the server, which
 *  refuses a skew rather than re-reading with a different grammar (§1.3.4, §10.1). */
export const SCHEDULE_GRAMMAR_VERSION = 1
