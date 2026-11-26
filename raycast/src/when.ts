// Time phrases in the search text, like Raycast's calculator reads them:
// "today", "yesterday", "this morning", "last 3 hours", "past 2d", "4 days ago",
// "monday", "last friday", "since tuesday", "this week", "last month",
// "nov 20", "20 november", "11/20", "2026-11-20", "october 2025".
// Each phrase becomes a span of time; the rest of the text is searched as usual.

export type Span = { start: number; end: number; label: string };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const UNITS: Record<string, number> = { minute: MIN, hour: HOUR, day: DAY, week: 7 * DAY };
const unitOf = (u: string): string | null => {
  if (/^(m|mins?|minutes?)$/.test(u)) return "minute";
  if (/^(h|hrs?|hours?)$/.test(u)) return "hour";
  if (/^(d|days?)$/.test(u)) return "day";
  if (/^(w|wks?|weeks?)$/.test(u)) return "week";
  if (/^(mo|mos|months?)$/.test(u)) return "month";
  if (/^(y|yrs?|years?)$/.test(u)) return "year";
  return null;
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
// A word that is a weekday or month name or the start of one ("tues", "sept").
const weekdayOf = (w: string) => WEEKDAYS.findIndex((d) => w.length >= 3 && d.startsWith(w));
const monthOf = (w: string) => MONTHS.findIndex((m) => w.length >= 3 && m.startsWith(w));

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const addDays = (t: number, n: number) => {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
};
const addMonths = (t: number, n: number) => {
  const d = new Date(t);
  d.setMonth(d.getMonth() + n);
  return d.getTime();
};
// Weeks start on Monday.
const startOfWeek = (t: number) => {
  const day = startOfDay(t);
  return addDays(day, -((new Date(day).getDay() + 6) % 7));
};
const startOfMonth = (t: number) => {
  const d = new Date(startOfDay(t));
  d.setDate(1);
  return d.getTime();
};
const dayStart = (y: number, m: number, d: number) => new Date(y, m, d).getTime();

// The most recent of that weekday: today if it's today.
const lastWeekday = (now: number, wd: number) => {
  const today = startOfDay(now);
  return addDays(today, -((new Date(today).getDay() - wd + 7) % 7));
};

// A day or month with no year means its most recent one.
const pastYear = (now: number, m: number, d = 1) => {
  const y = new Date(now).getFullYear();
  return dayStart(y, m, d) > now ? y - 1 : y;
};

type Rule = { re: RegExp; span: (m: RegExpMatchArray, now: number) => Span | null };

const day = (start: number, label: string): Span => ({ start, end: addDays(start, 1), label });
const PARTS: Record<string, [number, number]> = {
  morning: [5, 12],
  afternoon: [12, 17],
  evening: [17, 24],
  tonight: [17, 24],
  night: [17, 24],
};
const partOf = (start: number, part: string, label: string): Span => {
  const [a, b] = PARTS[part];
  return { start: start + a * HOUR, end: start + b * HOUR, label };
};

const RULES: Rule[] = [
  // last 3 hours, past 2d, within 10 min, 3h, last an hour
  {
    re: /^(?:(?:last|past|previous|within(?: the)?(?: last| past)?)\s+)?(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|mos|months?|y|yrs?|years?)$|^(?:last|past|within)\s+an?\s+(minute|hour|day|week|month|year)$/,
    span: (m, now) => {
      const unit = unitOf(m[2] ?? m[3]);
      if (!unit) return null;
      const n = m[1] ? Number(m[1]) : 1;
      if (!(n > 0)) return null;
      const start =
        unit === "month" ? addMonths(now, -n) : unit === "year" ? addMonths(now, -12 * n) : now - n * UNITS[unit];
      return { start, end: now, label: `Last ${n === 1 ? "" : `${n} `}${unit}${n === 1 ? "" : "s"}` };
    },
  },
  // last hour, past day, past week (rolling)
  {
    re: /^(?:last|past)\s+(minute|hour|day)$|^past\s+(week|month|year)$/,
    span: (m, now) => {
      const unit = m[1] ?? m[2];
      const start = unit === "month" ? addMonths(now, -1) : unit === "year" ? addMonths(now, -12) : now - UNITS[unit];
      return { start, end: now, label: `Past ${unit}` };
    },
  },
  // 4 days ago, 2 hours ago, a week ago
  {
    re: /^(\d+|an?\s)\s*(h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|mos|months?)\s+ago$/,
    span: (m, now) => {
      const unit = unitOf(m[2]);
      const n = /^an?\s$/.test(m[1]) ? 1 : Number(m[1]);
      const plural = `${n} ${unit}${n === 1 ? "" : "s"} ago`;
      if (unit === "hour") return { start: now - (n + 0.5) * HOUR, end: now - (n - 0.5) * HOUR, label: plural };
      if (unit === "day") return day(addDays(startOfDay(now), -n), plural);
      if (unit === "week") {
        const start = addDays(startOfWeek(now), -7 * n);
        return { start, end: addDays(start, 7), label: plural };
      }
      const start = addMonths(startOfMonth(now), -n);
      return { start, end: addMonths(start, 1), label: plural };
    },
  },
  {
    re: /^(today|yesterday|day before yesterday)(?:\s+(morning|afternoon|evening|night))?$/,
    span: (m, now) => {
      const back = m[1] === "today" ? 0 : m[1] === "yesterday" ? 1 : 2;
      const start = addDays(startOfDay(now), -back);
      const name = m[1][0].toUpperCase() + m[1].slice(1);
      return m[2] ? partOf(start, m[2], `${name} ${m[2]}`) : day(start, name);
    },
  },
  {
    re: /^(?:this\s+)?(morning|afternoon|evening)$|^(tonight|last night)$/,
    span: (m, now) => {
      if (m[2] === "last night") return partOf(addDays(startOfDay(now), -1), "night", "Last night");
      const part = m[1] ?? m[2];
      return partOf(startOfDay(now), part, `This ${part === "tonight" ? "evening" : part}`);
    },
  },
  {
    re: /^(this|last|previous)\s+(week|month|year)$/,
    span: (m, now) => {
      const back = m[1] === "this" ? 0 : 1;
      const label = `${m[1] === "this" ? "This" : "Last"} ${m[2]}`;
      if (m[2] === "week") {
        const start = addDays(startOfWeek(now), -7 * back);
        return { start, end: back ? addDays(start, 7) : now, label };
      }
      if (m[2] === "month") {
        const start = addMonths(startOfMonth(now), -back);
        return { start, end: back ? addMonths(start, 1) : now, label };
      }
      const y = new Date(now).getFullYear() - back;
      return { start: dayStart(y, 0, 1), end: back ? dayStart(y + 1, 0, 1) : now, label };
    },
  },
  // monday, last friday, since tuesday, since yesterday
  {
    re: /^(?:(last|on|since)\s+)?([a-z]{3,9})$/,
    span: (m, now) => {
      const wd = weekdayOf(m[2]);
      // "sun", "sat" and "wed" alone are more likely words.
      if (wd < 0 || (!m[1] && ["sun", "sat", "wed"].includes(m[2]))) return null;
      let start = lastWeekday(now, wd);
      // "last friday" on a Friday is a week ago.
      if (m[1] === "last" && start === startOfDay(now)) start = addDays(start, -7);
      const name = WEEKDAYS[wd][0].toUpperCase() + WEEKDAYS[wd].slice(1);
      if (m[1] === "since") return { start, end: now, label: `Since ${name}` };
      return day(start, m[1] === "last" ? `Last ${name}` : name);
    },
  },
  {
    re: /^since\s+(today|yesterday)$/,
    span: (m, now) => ({
      start: addDays(startOfDay(now), m[1] === "today" ? 0 : -1),
      end: now,
      label: `Since ${m[1]}`,
    }),
  },
  // nov 20, november 20th, 20 nov, nov 20 2025
  {
    re: /^(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9}))(?:,?\s+(\d{4}))?$/,
    span: (m, now) => {
      const mo = monthOf(m[1] ?? m[4]);
      const d = Number(m[2] ?? m[3]);
      if (mo < 0 || d < 1 || d > 31) return null;
      const y = m[5] ? Number(m[5]) : pastYear(now, mo, d);
      const start = dayStart(y, mo, d);
      return day(
        start,
        new Date(start).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: m[5] ? "numeric" : undefined,
        }),
      );
    },
  },
  // 11/20, 11/20/2025, 2026-11-20
  {
    re: /^(?:(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?|(\d{4})-(\d{1,2})-(\d{1,2}))$/,
    span: (m, now) => {
      const mo = Number(m[1] ?? m[5]) - 1;
      const d = Number(m[2] ?? m[6]);
      if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
      let y = m[4] ? Number(m[4]) : m[3] ? Number(m[3]) : pastYear(now, mo, d);
      if (y < 100) y += 2000;
      const start = dayStart(y, mo, d);
      return day(
        start,
        new Date(start).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      );
    },
  },
  // november, in october, october 2025
  {
    re: /^(?:in\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*(?:\s+(\d{4}))?$/,
    span: (m, now) => {
      const word = m[0].replace(/^in\s+/, "").split(/\s/)[0];
      const mo = monthOf(word);
      // "may", "mar" and "jan" alone are more likely words or names.
      if (mo < 0 || (!m[2] && !m[0].startsWith("in ") && ["may", "mar", "jan"].includes(word))) return null;
      const y = m[2] ? Number(m[2]) : pastYear(now, mo);
      const start = dayStart(y, mo, 1);
      return {
        start,
        end: addMonths(start, 1),
        label: new Date(start).toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      };
    },
  },
];

const MAX_PHRASE_WORDS = 4;

// Pulls time phrases out of a list of words. Longest phrase wins at each
// position. Several phrases narrow to where they overlap.
export function extractSpan(words: string[], now = Date.now()): { span: Span | null; rest: string[] } {
  const rest: string[] = [];
  let span: Span | null = null;
  for (let i = 0; i < words.length;) {
    let found: { span: Span; length: number } | null = null;
    for (let n = Math.min(MAX_PHRASE_WORDS, words.length - i); n >= 1 && !found; n--) {
      const phrase = words
        .slice(i, i + n)
        .join(" ")
        .toLowerCase();
      for (const rule of RULES) {
        const m = phrase.match(rule.re);
        const s = m && rule.span(m, now);
        if (s) {
          found = { span: s, length: n };
          break;
        }
      }
    }
    if (!found) {
      rest.push(words[i]);
      i++;
      continue;
    }
    span = span
      ? {
          start: Math.max(span.start, found.span.start),
          end: Math.min(span.end, found.span.end),
          label: `${span.label}, ${found.span.label}`,
        }
      : found.span;
    i += found.length;
  }
  return { span, rest };
}

// "Nov 25", "Since 9:41 PM", "Nov 17 – Nov 23", for showing what a phrase meant.
export function describeSpan(span: Span, now = Date.now()): string {
  const time = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const date = (t: number) =>
    new Date(t).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: new Date(t).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
    });
  const endsNow = Math.abs(span.end - now) < MIN;
  const wholeDays = span.start === startOfDay(span.start) && (endsNow || span.end === startOfDay(span.end));
  if (endsNow) {
    if (span.start >= startOfDay(now)) return `Since ${time(span.start)}`;
    return wholeDays ? `Since ${date(span.start)}` : `Since ${date(span.start)}, ${time(span.start)}`;
  }
  if (wholeDays) {
    const last = span.end - DAY;
    return last <= span.start ? date(span.start) : `${date(span.start)} – ${date(last)}`;
  }
  return startOfDay(span.start) === startOfDay(span.end - 1)
    ? `${date(span.start)}, ${time(span.start)} – ${time(span.end)}`
    : `${date(span.start)}, ${time(span.start)} – ${date(span.end)}, ${time(span.end)}`;
}
