// Slack / Discord: outbound notifications + polling owner replies (no public webhook server needed).
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { type Cfg, P, fileId, hostName, isPrimary, list } from "./core";
import { appendEvent, type Event, forwardEvent, storeMedia, uploadMedia } from "./server";
import { inQuiet } from "../app/notify";

export type NotifyOpts = { kind?: Event["kind"]; ref?: string; options?: string[]; attachments?: string[]; from?: string;
  /** Team channel only: no ntfy / Slack / Discord (agents' routine results). */ quiet?: boolean };

/** Any channel that can actually reach the owner outside the hub's own timeline. */
const hasRemoteChannel = (n: Cfg["notify"]) => !!(n?.ntfy_url || n?.slack_bot_token || n?.slack_channel || n?.slack_webhook
  || n?.discord_bot_token || n?.discord_channel || n?.discord_webhook);

/** One AppleScript statement that shows a banner. Pure, so it is unit-tested: quotes and backslashes are escaped and
 * the text is flattened, so a message can never break out into a second AppleScript statement. */
export function bannerScript(text: string, title = "Noop"): string {
  const clean = (s: string) => s.replace(/[*`#]/g, "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)
    .replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `display notification "${clean(text)}" with title "${clean(title)}"`;
}

/** Should the primary macOS host show a local banner for this message? Only when nothing else can reach the owner:
 * with no ntfy / Slack / Discord configured, a message lands only in the hub timeline, which needs a web login
 * (`totp_not_setup` leaves nobody able to log in). Quiet hours and `notify.macos = false` opt out. */
export function bannerWanted(n: Cfg["notify"], o: { platform?: string; primary: boolean; quiet?: string; tz?: string; now?: Date }): boolean {
  if ((o.platform ?? process.platform) !== "darwin" || !o.primary) return false;
  if (n?.macos === false || String(n?.macos) === "false") return false;
  if (hasRemoteChannel(n)) return false;
  return !inQuiet(o.quiet, o.tz, o.now ?? new Date());
}

const BANNER_TITLE: Record<string, string> = { decision: "Noop · 需要你拍板", proposals: "Noop · 新的提议",
  menu: "Noop · 下一步", login: "Noop · 登录" };


async function slackUpload(n: Cfg, file: string, thread?: string) {
  const f = Bun.file(file);
  const h = { Authorization: `Bearer ${n.slack_bot_token}` };
  const u = await (await fetch(`https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(basename(file))}&length=${f.size}`, { headers: h })).json() as any;
  if (!u.ok) return;
  await fetch(u.upload_url, { method: "POST", body: f });
  await fetch("https://slack.com/api/files.completeUploadExternal", { method: "POST", headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify({ files: [{ id: u.file_id }], channel_id: n.slack_channel, thread_ts: thread }) });
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  try { return JSON.parse(t || "{}"); } catch { return {}; }
}

const discordHeaders = (n: Cfg) => ({ Authorization: `Bot ${n.discord_bot_token}`, "User-Agent": "noop (1.0)" });

export async function notify(text: string, cfg: Cfg, o: NotifyOpts = {}): Promise<string[]> {
  const n = cfg.notify ?? {};
  const ids: string[] = [];
  const files = (o.attachments ?? []).filter((f) => existsSync(f));
  // 1) the hub's own chat timeline (primary-local; workers forward to the primary server)
  const ev = { from: o.from ?? `hub@${hostName(cfg)}`, kind: o.kind ?? "notice", text, ref: o.ref, options: o.options } as Omit<Event, "id" | "ts">;
  if (isPrimary(cfg)) { appendEvent({ ...ev, attachments: files.map(storeMedia) }); ids.push("hub"); }
  else {
    const urls = (await Promise.all(files.map((f) => uploadMedia(f, cfg)))).filter(Boolean) as string[];
    if (await forwardEvent({ ...ev, attachments: urls }, cfg)) ids.push("hub");
  }
  if (o.quiet) return ids;
  // 2) phone push via ntfy (self-hostable; tap opens the chat page)
  try {
    if (n.ntfy_url) await fetch(n.ntfy_url, { method: "POST", body: text.replace(/\*/g, "").slice(0, 3000),
      headers: { Title: "Noop", ...(cfg.server?.public_url ? { Click: cfg.server.public_url } : {}), ...(n.ntfy_token ? { Authorization: `Bearer ${n.ntfy_token}` } : {}) } });
  } catch (e) { console.error("ntfy failed", e); }
  try {
    if (n.slack_bot_token && n.slack_channel) {
      const r = await post("https://slack.com/api/chat.postMessage", { channel: n.slack_channel, text },
        { Authorization: `Bearer ${n.slack_bot_token}` });
      if (r.ok) { ids.push(`slack:${r.ts}`); for (const f of files) await slackUpload(n, f, r.ts).catch(() => {}); }
      else console.error("slack:", r.error);
    } else if (n.slack_webhook) { await post(n.slack_webhook, { text }); ids.push("slack:webhook"); }
  } catch (e) { console.error("slack notify failed", e); }
  try {
    const content = text.replace(/\*/g, "**").slice(0, 1900);
    if (n.discord_bot_token && n.discord_channel) {
      const fd = new FormData();
      fd.append("payload_json", JSON.stringify({ content }));
      files.slice(0, 10).forEach((f, i) => fd.append(`files[${i}]`, Bun.file(f), basename(f)));
      const r = await (await fetch(`https://discord.com/api/v10/channels/${n.discord_channel}/messages`, { method: "POST", body: fd, headers: discordHeaders(n) })).json() as any;
      if (r.id) ids.push(`discord:${r.id}`); else console.error("discord:", r.message);
    } else if (n.discord_webhook) { await post(n.discord_webhook, { content }); ids.push("discord:webhook"); }
  } catch (e) { console.error("discord notify failed", e); }
  // 3) last resort: no ntfy / Slack / Discord is configured, so the message would sit only in the hub timeline,
  // which the owner may not be able to open. The primary host is the owner's own machine — show it there.
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (bannerWanted(n, { primary: isPrimary(cfg), quiet: (cfg.idle as any)?.quiet_hours, tz })) {
      const r = Bun.spawnSync(["osascript", "-e", bannerScript(text, BANNER_TITLE[o.kind ?? ""] ?? "Noop")]);
      if (r.exitCode === 0) ids.push("macos"); else console.error("macos notify failed", r.stderr?.toString?.());
    }
  } catch (e) { console.error("macos notify failed", e); }
  if (ids.length <= 1) console.log(`[notify]\n${text}`);
  return ids;
}

/** Owner replies look like `D-0012 A`, `D-0012 do B but keep tests`, or `D-0012 override: ...`. */
const ANSWER = /\b([DLP]-[A-Z]?\d{4})\b[\s:：,，\-]*([\s\S]+)/;

export type Reply = { id: string; answer: string; source: string };

export async function pollReplies(cfg: Cfg, ids: Set<string>): Promise<Reply[]> {
  if (!ids.size) return [];
  const n = cfg.notify ?? {};
  const msgs: { text: string; source: string; ts: number }[] = [];
  try {
    if (n.slack_bot_token && n.slack_channel) {
      const r = await (await fetch(`https://slack.com/api/conversations.history?channel=${n.slack_channel}&limit=50`,
        { headers: { Authorization: `Bearer ${n.slack_bot_token}` } })).json() as any;
      for (const m of r.messages ?? []) {
        if (m.bot_id || (n.slack_owner_user_id && m.user !== n.slack_owner_user_id)) continue;
        msgs.push({ text: m.text ?? "", source: "slack", ts: parseFloat(m.ts) * 1000 });
      }
    }
  } catch (e) { console.error("slack poll failed", e); }
  try {
    if (n.discord_bot_token && n.discord_channel) {
      const r = await (await fetch(`https://discord.com/api/v10/channels/${n.discord_channel}/messages?limit=50`,
        { headers: discordHeaders(n) })).json() as any[];
      for (const m of Array.isArray(r) ? r : []) {
        if (m.author?.bot || (n.discord_owner_user_id && m.author?.id !== n.discord_owner_user_id)) continue;
        msgs.push({ text: m.content ?? "", source: "discord", ts: Date.parse(m.timestamp) });
      }
    }
  } catch (e) { console.error("discord poll failed", e); }
  const found = new Map<string, Reply>();
  for (const m of msgs.sort((a, b) => a.ts - b.ts)) {
    const mm = m.text.replace(/`/g, "").match(ANSWER);
    if (mm && ids.has(mm[1])) found.set(mm[1], { id: mm[1], answer: mm[2].trim(), source: m.source });
  }
  return [...found.values()];
}

/** IDs (not paths) of the cards waiting for the owner. `basename` so Windows' "\" separators don't leak into the set:
 * splitting on "/" returned the whole path there, so every chat reply to a D-card matched nothing and was dropped. */
export const openDecisionIds = () => new Set(list(P("decisions", "open")).map(fileId));
