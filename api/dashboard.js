// Vercel serverless function — GET /api/dashboard
// Reads live counts from Airtable and returns them as JSON.
// Requires one environment variable in Vercel: AIRTABLE_TOKEN

const BASE_ID = 'apppa13eZWePKHLjA';
const TABLE_ID = 'tbl7uQu7o1FyI1tPT';

// These are real, curated Airtable views (Data tab of the Dealflow base) —
// each one already encodes the exact business logic Anurat's team uses for that stage.
// If the team changes what counts as e.g. "To reject" in Airtable, this dashboard
// picks it up automatically — no code change needed.
const VIEWS = {
  allFA26: 'viwgahGy9wonT8DGU',        // All applications FA26
  leftToReview: 'viwKvbGbwUfnu1l1I',   // Applications to review FA26
  upcoming1st: 'viwNlqPAz0DBhh7IK',    // Upcoming 1st interview
  upcoming2nd: 'viw0FBP0wR5GQZgnx',    // Upcoming 2nd Interview
  post2ndDecide: 'viw9tADrsekv31Lgc',  // Post 2nd Interview to Decide
  toAccept: 'viw37vqR6NT3E96Wh',       // To accept
  toReject: 'viwNYs3TmY1Wh7wrx',       // To reject
};

const CREATED_TIME_FIELD = 'created_time';
const ANURATS_CALL_FIELD = "Anurat's Call";

async function countRecords(viewId, filterByFormula) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error('Missing AIRTABLE_TOKEN environment variable');

  let count = 0;
  let offset;

  do {
    const params = new URLSearchParams();
    params.set('view', viewId);
    params.set('pageSize', '100');
    params.set('fields[]', CREATED_TIME_FIELD); // minimal payload, we only need counts
    if (filterByFormula) params.set('filterByFormula', filterByFormula);
    if (offset) params.set('offset', offset);

    const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}?${params.toString()}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Airtable API error ${resp.status}: ${body}`);
    }

    const data = await resp.json();
    count += data.records.length;
    offset = data.offset;
  } while (offset);

  return count;
}

// Monday 00:00 of the current week, in Europe/Paris local time, as a Date object.
function mondayOfThisWeek() {
  const now = new Date();
  const parisNow = new Date(
    now.toLocaleString('en-US', { timeZone: 'Europe/Paris' })
  );
  const day = parisNow.getDay(); // 0 = Sun ... 6 = Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(parisNow);
  monday.setDate(parisNow.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

// Formats a Date as the "YYYY-MM-DDTHH:MM:SS" string Airtable's DATETIME_PARSE expects.
function toAirtableISO(date) {
  return date.toISOString().slice(0, 19);
}

module.exports = async (req, res) => {
  try {
    const monday = mondayOfThisWeek();
    const mondayISO = toAirtableISO(monday);

    const lastMonday = new Date(monday);
    lastMonday.setDate(monday.getDate() - 7);
    const lastMondayISO = toAirtableISO(lastMonday);

    const newThisWeekFormula = `IS_AFTER({${CREATED_TIME_FIELD}}, DATETIME_PARSE("${mondayISO}", "YYYY-MM-DDTHH:mm:ss"))`;

    // Applications created during the previous Monday–Sunday window, for the
    // "vs __ last week" comparison — so Monday mornings (when "this week" is
    // always 0 or close to it) still show useful context.
    const lastWeekFormula = `AND(IS_AFTER({${CREATED_TIME_FIELD}}, DATETIME_PARSE("${lastMondayISO}", "YYYY-MM-DDTHH:mm:ss")), IS_BEFORE({${CREATED_TIME_FIELD}}, DATETIME_PARSE("${mondayISO}", "YYYY-MM-DDTHH:mm:ss")))`;

    // "Left to review" isn't pulled from the "Applications to review FA26" view —
    // that view turned out to include more than intended (153 vs. a hand-verified 100).
    // Instead we replicate the verified logic directly: Anurat's Call is empty or
    // "Review", restricted to the same FA26 scope as "All applications FA26"
    // (the same scope that correctly gave 1 for "new this week").
    const leftToReviewFormula = `OR({${ANURATS_CALL_FIELD}} = "", {${ANURATS_CALL_FIELD}} = "Review")`;

    const [
      newThisWeek,
      lastWeek,
      leftToReview,
      upcoming1st,
      upcoming2nd,
      post2ndDecide,
      toAccept,
      toReject,
    ] = await Promise.all([
      countRecords(VIEWS.allFA26, newThisWeekFormula),
      countRecords(VIEWS.allFA26, lastWeekFormula),
      countRecords(VIEWS.allFA26, leftToReviewFormula),
      countRecords(VIEWS.upcoming1st),
      countRecords(VIEWS.upcoming2nd),
      countRecords(VIEWS.post2ndDecide),
      countRecords(VIEWS.toAccept),
      countRecords(VIEWS.toReject),
    ]);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json({
      newThisWeek,
      lastWeek,
      leftToReview,
      upcoming1st,
      upcoming2nd,
      post2ndDecide,
      toAccept,
      toReject,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
