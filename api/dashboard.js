// Vercel serverless function — GET /api/dashboard
// Reads live counts from Airtable and returns them as JSON.
// Requires one environment variable in Vercel: AIRTABLE_TOKEN

const BASE_ID = 'apppa13eZWePKHLjA';
const TABLE_ID = 'tbl7uQu7o1FyI1tPT';

// These are real, curated Airtable views (Data tab of the Dealflow base) —
// each one already encodes the exact business logic Anurat's team uses for that stage.
// If the team changes what counts as e.g. "upcoming 2nd interview" in Airtable,
// this dashboard picks it up automatically — no code change needed.
//
// Two tiles deliberately do NOT come from a view: "Left to review" and
// "Accepted" / "Waitlisted". See the formulas further down for why.
const VIEWS = {
  allFA26: 'viwgahGy9wonT8DGU',        // All applications FA26
  upcoming1st: 'viwNlqPAz0DBhh7IK',    // 1st interview - booked
  upcoming2nd: 'viw0FBP0wR5GQZgnx',    // 2nd Interview - upcoming
  post2ndDecide: 'viw9tADrsekv31Lgc',  // 2nd Interview - to decide
};

const CREATED_TIME_FIELD = 'created_time';
const ANURATS_CALL_FIELD = "Anurat's Call";
const FINAL_STATUS_FIELD = 'Final Status';
const FIRST_MEETING_STATUS_FIELD = '1st Meeting Status';
const SENT_ACCEPTANCE_FIELD = 'Sent Acceptance';
const STATUS_MAXIME_FIELD = 'Status Maxime';
const MAXIME_CALL_FIELD = "Maxime/Dominika's Call";

// Fields used to put names (and a LinkedIn link) on the person-level tiles.
const FIRST_NAME_FIELD = 'first_name';
const LAST_NAME_FIELD = 'Last Name';
const LINKEDIN_FIELD = 'LinkedIn';
const ELO_FIELD = 'Elo Score';
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
// `dateField` puts a scheduled time on the row (interview tiles); `withElo`
// puts the Elo score there instead (the waitlist, which is worked in rank order).
function toPeople(records, dateField, withElo) {
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
      elo: withElo ? (f[ELO_FIELD] !== undefined ? f[ELO_FIELD] : null) : null,
    };
  });
}

// Alphabetical, for the lists that have no natural order of their own.
function byName(people) {
  return people.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
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

    // "Left to review" is computed here rather than read from the
    // "To review - Anurat" view, so the number can't drift if someone edits
    // that view's filters. The logic: nobody has decided anything yet —
    // Anurat's Call is blank or "Review", no first meeting has happened, and
    // no final status has been set. Scoped to FA26 by the view it runs against.
    const leftToReviewFormula = `AND(OR({${ANURATS_CALL_FIELD}} = "", {${ANURATS_CALL_FIELD}} = "Review"), {${FINAL_STATUS_FIELD}} = "", {${FIRST_MEETING_STATUS_FIELD}} = "")`;

    // "Accepted" — everyone sent an acceptance who hasn't since dropped out,
    // whether or not they've finished onboarding. This is the number Maxime
    // means when he asks "how many do we have".
    //
    // Computed rather than read from the "Accepted - onboarding" / "Onboarded"
    // views because those two scope the batch differently, so the pair would
    // silently pull in founders from previous cohorts.
    const acceptedFormula = `AND({${SENT_ACCEPTANCE_FIELD}} = 1, {${STATUS_MAXIME_FIELD}} != "Desist", {${STATUS_MAXIME_FIELD}} != "duplicate", {${FINAL_STATUS_FIELD}} != "Desisted", {${FINAL_STATUS_FIELD}} != "Declined")`;

    // "Waitlisted" — the verdict lives on Maxime/Dominika's Call, NOT on
    // Final Status (which stays blank for waitlisted founders). This is the
    // same condition the "Waitlisted" view uses. Returned ranked by Elo,
    // which is the order the list actually gets worked through.
    const waitlistedFormula = `{${MAXIME_CALL_FIELD}} = "Waitlist"`;

    const [
      newThisWeek,
      lastWeek,
      leftToReview,
      upcoming1stRecords,
      upcoming2ndRecords,
      post2ndDecideRecords,
      acceptedRecords,
      waitlistedRecords,
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
      fetchRecords(VIEWS.allFA26, {
        fields: PERSON_FIELDS,
        filterByFormula: acceptedFormula,
      }),
      fetchRecords(VIEWS.allFA26, {
        fields: PERSON_FIELDS.concat(ELO_FIELD),
        filterByFormula: waitlistedFormula,
        sort: { field: ELO_FIELD, direction: 'desc' },
      }),
    ]);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json({
      newThisWeek,
      lastWeek,
      leftToReview,
      upcoming1st: upcoming1stRecords.length,
      upcoming2nd: upcoming2ndRecords.length,
      post2ndDecide: post2ndDecideRecords.length,
      accepted: acceptedRecords.length,
      waitlisted: waitlistedRecords.length,
      // Names behind the person-level tiles. Interview tiles carry the
      // scheduled date so the front end can show it and keep them in order;
      // the waitlist carries Elo and comes back ranked.
      people: {
        upcoming1st: toPeople(upcoming1stRecords, FIRST_INTERVIEW_FIELD),
        upcoming2nd: toPeople(upcoming2ndRecords, SECOND_INTERVIEW_FIELD),
        post2ndDecide: byName(toPeople(post2ndDecideRecords)),
        accepted: byName(toPeople(acceptedRecords)),
        waitlisted: toPeople(waitlistedRecords, null, true),
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
