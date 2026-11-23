import { expect, test } from "bun:test";
import { inQuiet, notificationFor } from "../app/notify";

const at = (hm: string) => new Date(`2026-11-05T${hm}:00Z`);
const quiet = { start: "22:00", end: "08:00" };

test("quiet hours are read in both the app's shape and a hand-written range", () => {
  for (const range of [quiet, "22:00-08:00"]) {
    expect(inQuiet(range, "UTC", at("23:30"))).toBe(true);
    expect(inQuiet(range, "UTC", at("07:59"))).toBe(true);
    expect(inQuiet(range, "UTC", at("08:00"))).toBe(false);
  }
  expect(inQuiet(null, "UTC", at("23:30"))).toBe(false);
  expect(inQuiet(quiet, "Asia/Shanghai", at("23:30"))).toBe(true); // 07:30 there
  expect(inQuiet(quiet, "Asia/Shanghai", at("01:00"))).toBe(false); // 09:00 there
});

test("quiet hours hold back all but logins and urgent decisions", () => {
  const prefs = { quiet_hours: quiet, tz: "UTC" };
  const now = at("23:30");
  expect(notificationFor({ kind: "decision", text: "merge?" }, prefs, now)).toBe(null);
  expect(notificationFor({ kind: "decision", text: "merge?", priority: "urgent" }, prefs, now)?.title).toBe("Needs your call");
  expect(notificationFor({ kind: "login", text: "code" }, prefs, now)?.title).toBe("Login reminder");
});

test("the settings' switches reach their kinds, notices being the results", () => {
  const off = (kind: string) => ({ kinds: { [kind]: false } });
  expect(notificationFor({ kind: "notice", from: "lead@mac", text: "done" }, off("result"))).toBe(null);
  expect(notificationFor({ kind: "decision", text: "merge?" }, off("decision"))).toBe(null);
  expect(notificationFor({ kind: "notice", from: "lead@mac", text: "done" }, off("decision"))?.body).toBe("done");
});

test("the owner's own words and the hub's housekeeping never notify", () => {
  expect(notificationFor({ kind: "owner", text: "hi" }, {})).toBe(null);
  expect(notificationFor({ kind: "system", text: "x" }, {})).toBe(null);
  expect(notificationFor({ kind: "notice", from: "hub@mac", text: "x" }, {})).toBe(null);
});

test("the body is plain and short", () => {
  const body = notificationFor({ kind: "decision", text: `*merge* \`#1\` [pr](https://x.test/1) ${"y".repeat(200)}` }, {})!.body;
  expect(body.startsWith("merge 1 pr y")).toBe(true);
  expect(body.length).toBe(140);
});

// A hub with no ntfy / Slack / Discord has no way to reach the owner: every message lands only in the timeline,
// which needs a web login. On the owner's own Mac, show a local banner instead (evidence: 11 days / 0 answers).
import { bannerScript, bannerWanted } from "../src/notify";

const mac = { kind: "decision", platform: "darwin", primary: true, tz: "UTC", now: at("12:00") };

test("the local banner is the last resort, on the owner's own Mac only", () => {
  expect(bannerWanted(undefined, mac)).toBe(true);
  expect(bannerWanted({ macos: false }, mac)).toBe(false);
  expect(bannerWanted({ ntfy_url: "https://ntfy.test/x" }, mac)).toBe(false);
  expect(bannerWanted({ slack_webhook: "https://hooks.test/x" }, mac)).toBe(false);
  expect(bannerWanted({ discord_channel: "1", discord_bot_token: "t" }, mac)).toBe(false);
  expect(bannerWanted(undefined, { ...mac, platform: "linux" })).toBe(false);
  expect(bannerWanted(undefined, { ...mac, primary: false })).toBe(false);
});

test("only the kinds that need the owner banner; routine results and housekeeping never do", () => {
  for (const kind of ["notice", "system", "owner", "", undefined])
    expect(bannerWanted(undefined, { ...mac, kind: kind as any })).toBe(false);
  for (const kind of ["decision", "proposals", "menu", "login"])
    expect(bannerWanted(undefined, { ...mac, kind })).toBe(true);
});

test("the local banner respects the hub's quiet hours", () => {
  expect(bannerWanted(undefined, { ...mac, quiet: "22:00-08:00", now: at("23:30") })).toBe(false);
  expect(bannerWanted(undefined, { ...mac, quiet: "22:00-08:00", now: at("08:30") })).toBe(true);
});

test("a banner body can never break out into a second AppleScript statement", () => {
  const s = bannerScript('merge "x"?\n tell application "Finder" to quit \\ hard', "Noop · 需要你拍板");
  expect(s.startsWith('display notification "')).toBe(true);
  expect(s.endsWith('" with title "Noop · 需要你拍板"')).toBe(true);
  expect(s).not.toContain("\n");
  expect(s.replace(/\\"/g, "").split('"').length - 1).toBe(4); // four delimiters; every inner quote is escaped
  expect(s).toContain('\\"x\\"?');
  const long = bannerScript("y".repeat(400));
  expect(long.length).toBeLessThan(260);
});
