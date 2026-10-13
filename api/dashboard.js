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
const FINAL_STATUS_FIELD = 'Final Status';
const FIRST_MEETING_STATUS_FIELD = '1st Meeting Status';

// Fields used to put names (and a LinkedIn link) on the person-level tiles.
const FIRST_NAME_FIELD = 'first_name';
const LAST_NAME_FIELD = 'Last Name';
const LINKEDIN_FIELD = 'LinkedIn';
const FIRST_INTERVIEW_FIELD = '1st interview date & time';
const SECOND_INTERVIEW_FIELD = '2nd interview date & time';

const PERSON_FIELDS = [FIRST_NAME_FIELD, LAST_NAME_FIELD, LINKEDIN_FIELD];

// Fetches every record in a view (following pagination) and returns them raw.
// `fields` keeps the payload small — ask only for what the tile needs.
// `sort` lets the upcoming-interview tiles come back soonest-first.
async function fetchRecords(viewId, options) {
  const opts = options || {};
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error('Missing AIRTABLE_TOKEN environment variable');

  const fields = opts.fields && opts.fields.length ? opts.fields : [CREATED_TIME_FIELD];
  const records = [];
  let offset;

  do {
    const params = new URLSearchParams();
    params.set('view', viewId);
    params.set('pageSize', '100');
    fields.forEach(function (f) { params.append('fields[]', f); });
    if (opts.filterByFormula) params.set('filterByFormula', opts.filterByFormula);
    if (opts.sort) {
      params.set('sort[0][field]', opts.sort.field);
      params.set('sort[0][direction]', opts.sort.direction || 'asc');
    }
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
    records.push.apply(records, data.records);
    offset = data.offset;
  } while (offset);

  return records;
}

async function countRecords(viewId, filterByFormula) {
  const records = await fetchRecords(viewId, { filterByFormula: filterByFormula });
  return records.length;
}

// The LinkedIn column is free text — sometimes a full URL, sometimes just a
// handle. Normalise it so the dashboard always renders a working link, and
// return null when there's nothing usable (the name then renders as plain text).
function normaliseLinkedIn(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^(www\.)?linkedin\.com/i.test(v)) return 'https://' + v.replace(/^https?:\/\//i, '');
  return 'https://www.linkedin.com/in/' + v.replace(/^\/+|\/+$/g, '');
}

// Reduces raw Airtable records to the small shape the front end renders.
function toPeople(records, dateField) {
  return records.map(function (r) {
    const f = r.fields || {};
    const name = [f[FIRST_NAME_FIELD], f[LAST_NAME_FIELD]]
      .filter(Boolean)
      .join(' ')
      .trim();
    return {
      name: name || 'Unnamed',
      linkedin: normaliseLinkedIn(f[LINKEDIN_FIELD]),
      when: dateField ? (f[dateField] || null) : null,
    };
  });
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
    //
    // Also require Final Status to be blank. Older records from before the
    // "Anurat's Call" field existed can have a Final Status already set
    // (Declined, Onboarded, Waitlist, etc.) but no Anurat's Call value —
    // without this check they get miscounted as still needing review even
    // though they were already decided (this was inflating the count vs.
    // Anurat's hand count).
    //
    // And require 1st Meeting Status to be blank. Final Status is only set at
    // the very end of the funnel, so someone who has already had their first
    // call — done, no show, no response, followed up — and is now sitting with
    // Maxime still has a blank Final Status. Without this check they reappear
    // in the review queue every time the Anurat's Call tag is left unset after
    // a call, which is what built up a backlog of 11 stale records.
    const leftToReviewFormula = `AND(OR({${ANURATS_CALL_FIELD}} = "", {${ANURATS_CALL_FIELD}} = "Review"), {${FINAL_STATUS_FIELD}} = "", {${FIRST_MEETING_STATUS_FIELD}} = "")`;

    const [
      newThisWeek,
      lastWeek,
      leftToReview,
      upcoming1stRecords,
      upcoming2ndRecords,
      post2ndDecideRecords,
      toAcceptRecords,
      toReject,
    ] = await Promise.all([
      countRecords(VIEWS.allFA26, newThisWeekFormula),
      countRecords(VIEWS.allFA26, lastWeekFormula),
      countRecords(VIEWS.allFA26, leftToReviewFormula),
      fetchRecords(VIEWS.upcoming1st, {
        fields: PERSON_FIELDS.concat(FIRST_INTERVIEW_FIELD),
        sort: { field: FIRST_INTERVIEW_FIELD, direction: 'asc' },
      }),
      fetchRecords(VIEWS.upcoming2nd, {
        fields: PERSON_FIELDS.concat(SECOND_INTERVIEW_FIELD),
        sort: { field: SECOND_INTERVIEW_FIELD, direction: 'asc' },
      }),
      fetchRecords(VIEWS.post2ndDecide, { fields: PERSON_FIELDS }),
      fetchRecords(VIEWS.toAccept, { fields: PERSON_FIELDS }),
      countRecords(VIEWS.toReject),
    ]);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json({
      newThisWeek,
      lastWeek,
      leftToReview,
      upcoming1st: upcoming1stRecords.length,
      upcoming2nd: upcoming2ndRecords.length,
      post2ndDecide: post2ndDecideRecords.length,
      toAccept: toAcceptRecords.length,
      toReject,
      // Names behind the four person-level tiles. Interview tiles carry the
      // scheduled date so the front end can show it and keep them in order.
      people: {
        upcoming1st: toPeople(upcoming1stRecords, FIRST_INTERVIEW_FIELD),
        upcoming2nd: toPeople(upcoming2ndRecords, SECOND_INTERVIEW_FIELD),
        post2ndDecide: toPeople(post2ndDecideRecords),
        toAccept: toPeople(toAcceptRecords),
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
