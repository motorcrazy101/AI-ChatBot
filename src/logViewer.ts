import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { config } from "./config";
import { isDbReady, pool } from "./db";

/**
 * A small password-protected web page for browsing saved chats.
 * Turned on by setting LOG_VIEWER_PASSWORD on Railway, then giving the
 * service a public domain (Settings → Networking → Generate Domain).
 * Log in with any username and that password.
 */

const PAGE_SIZE = 100;

interface LogRow {
  created_at: Date;
  bot_name: string | null;
  direction: "incoming" | "outgoing";
  is_dm: boolean;
  guild_name: string | null;
  channel_id: string;
  channel_name: string | null;
  user_id: string;
  user_name: string;
  content: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return timingSafeEqual(sha256(password), sha256(config.logViewerPassword));
}

const timeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: config.timezone,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

interface Filters {
  q: string;
  user: string;
  uid: string;
  channel: string;
  where: "all" | "dm" | "server";
  from: string;
  to: string;
  order: "newest" | "oldest";
  page: number;
}

function readFilters(url: URL): Filters {
  const get = (key: string) => (url.searchParams.get(key) ?? "").trim();
  const where = get("where");
  const date = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "");
  return {
    q: get("q"),
    user: get("user"),
    uid: /^\d+$/.test(get("uid")) ? get("uid") : "",
    channel: /^\d+$/.test(get("channel")) ? get("channel") : "",
    where: where === "dm" || where === "server" ? where : "all",
    from: date(get("from")),
    to: date(get("to")),
    order: get("order") === "oldest" ? "oldest" : "newest",
    page: Math.max(1, Number.parseInt(get("page"), 10) || 1),
  };
}

function link(filters: Filters, changes: Partial<Filters>): string {
  const merged = { ...filters, ...changes };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value === "" || value === "all" || (key === "order" && value === "newest") || (key === "page" && value === 1)) continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

async function queryLogs(f: Filters): Promise<{ rows: LogRow[]; total: number }> {
  if (!pool) return { rows: [], total: 0 };
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };

  if (f.q) add("content ILIKE ?", `%${f.q}%`);
  if (f.user) add("user_name ILIKE ?", `%${f.user}%`);
  if (f.uid) add("user_id = ?", f.uid);
  if (f.channel) add("channel_id = ?", f.channel);
  if (f.where === "dm") where.push("is_dm");
  if (f.where === "server") where.push("NOT is_dm");
  if (f.from) {
    params.push(config.timezone);
    add(`created_at >= (?::date)::timestamp AT TIME ZONE $${params.length}::text`, f.from);
  }
  if (f.to) {
    params.push(config.timezone);
    add(`created_at < (?::date + 1)::timestamp AT TIME ZONE $${params.length}::text`, f.to);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const order = f.order === "oldest" ? "ASC" : "DESC";

  const count = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM chat_logs ${whereSql}`,
    params
  );
  const rows = await pool.query<LogRow>(
    `SELECT created_at, bot_name, direction, is_dm, guild_name, channel_id, channel_name,
            user_id, user_name, content
       FROM chat_logs ${whereSql}
      ORDER BY created_at ${order}, id ${order}
      LIMIT ${PAGE_SIZE} OFFSET ${(f.page - 1) * PAGE_SIZE}`,
    params
  );
  return { rows: rows.rows, total: count.rows[0]?.total ?? 0 };
}

const STYLE = `
  :root { --bg:#f6f6f8; --card:#fff; --text:#1d1d22; --muted:#6b6b76; --line:#e4e4ea; --accent:#6d4aff; --in:#eef0ff; --out:#f4eefe; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#141418; --card:#1d1d23; --text:#ececf1; --muted:#9a9aa6; --line:#2e2e37; --accent:#a48bff; --in:#22243a; --out:#2a2236; }
  }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); }
  main { max-width:1100px; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 20px; }
  form { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; margin-bottom:16px; }
  label { display:flex; flex-direction:column; font-size:12px; color:var(--muted); gap:4px; }
  input, select { font:inherit; padding:7px 9px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--text); }
  .buttons { display:flex; gap:8px; align-items:flex-end; }
  button, .reset { font:inherit; padding:8px 14px; border-radius:8px; border:0; background:var(--accent); color:#fff; cursor:pointer; text-decoration:none; }
  .reset { background:transparent; color:var(--muted); border:1px solid var(--line); }
  .meta { display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; color:var(--muted); margin:0 0 10px; font-size:14px; }
  .msg { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:10px; padding:10px 12px; margin-bottom:8px; }
  .msg.incoming { border-left-color:#4a8cff; background:var(--in); }
  .msg.outgoing { background:var(--out); }
  .head { display:flex; flex-wrap:wrap; gap:4px 12px; font-size:13px; color:var(--muted); margin-bottom:4px; }
  .head b { color:var(--text); }
  .head a { color:var(--accent); text-decoration:none; }
  .head a:hover { text-decoration:underline; }
  .content { white-space:pre-wrap; word-break:break-word; }
  .pager { display:flex; gap:10px; justify-content:center; margin-top:18px; }
  .pager a { color:var(--accent); }
  .empty { text-align:center; color:var(--muted); padding:40px 0; }
`;

function renderPage(f: Filters, rows: LogRow[], total: number, notice = ""): string {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const option = (value: string, label: string, current: string) =>
    `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`;

  const items = rows
    .map((r) => {
      const place = r.is_dm
        ? "DM"
        : `${escapeHtml(r.guild_name ?? "Server")} · #${escapeHtml(r.channel_name ?? r.channel_id)}`;
      const person = `<a href="${link(f, { uid: r.user_id, user: "", page: 1 })}" title="Only this person">${escapeHtml(r.user_name)}</a>`;
      const bot = escapeHtml(r.bot_name ?? "Bot");
      const who =
        r.direction === "incoming" ? `<b>${person}</b> → ${bot}` : `<b>${bot}</b> → ${person}`;
      return `<div class="msg ${r.direction}">
        <div class="head"><span>${escapeHtml(timeFormat.format(new Date(r.created_at)))}</span>
          <a href="${link(f, { channel: r.channel_id, page: 1 })}" title="Only this conversation">${place}</a>
          <span>${who}</span></div>
        <div class="content">${escapeHtml(r.content)}</div></div>`;
    })
    .join("\n");

  const pager =
    pages > 1
      ? `<div class="pager">${f.page > 1 ? `<a href="${link(f, { page: f.page - 1 })}">← Previous</a>` : ""}
         <span>Page ${f.page} of ${pages}</span>
         ${f.page < pages ? `<a href="${link(f, { page: f.page + 1 })}">Next →</a>` : ""}</div>`
      : "";

  const activeExtras = [
    f.uid ? `one person <a href="${link(f, { uid: "", page: 1 })}">(show everyone)</a>` : "",
    f.channel ? `one conversation <a href="${link(f, { channel: "", page: 1 })}">(show all)</a>` : "",
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chat Logs</title><style>${STYLE}</style></head>
<body><main>
  <h1>Chat Logs</h1>
  <p class="sub">Everything your bots said and heard. Times are in ${escapeHtml(config.timezone)}.</p>
  ${notice ? `<p class="empty">${notice}</p>` : ""}
  <form method="get" action="/">
    <label>Search messages<input name="q" value="${escapeHtml(f.q)}" placeholder="any words"></label>
    <label>Person<input name="user" value="${escapeHtml(f.user)}" placeholder="name"></label>
    <label>Where<select name="where">${option("all", "Everywhere", f.where)}${option("server", "Servers", f.where)}${option("dm", "DMs", f.where)}</select></label>
    <label>From<input type="date" name="from" value="${f.from}"></label>
    <label>To<input type="date" name="to" value="${f.to}"></label>
    <label>Order<select name="order">${option("newest", "Newest first", f.order)}${option("oldest", "Oldest first", f.order)}</select></label>
    ${f.uid ? `<input type="hidden" name="uid" value="${f.uid}">` : ""}
    ${f.channel ? `<input type="hidden" name="channel" value="${f.channel}">` : ""}
    <div class="buttons"><button type="submit">Filter</button><a class="reset" href="/">Reset</a></div>
  </form>
  <div class="meta"><span>${total.toLocaleString("en-US")} message${total === 1 ? "" : "s"}${activeExtras.length ? ` · ${activeExtras.join(" · ")}` : ""}</span></div>
  ${items || (notice ? "" : `<p class="empty">No messages match.</p>`)}
  ${pager}
</main></body></html>`;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (!isAuthorized(req)) {
    res
      .writeHead(401, { "WWW-Authenticate": 'Basic realm="Chat Logs", charset="UTF-8"', "Content-Type": "text/plain" })
      .end("Password required");
    return;
  }
  if (url.pathname !== "/") {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }

  const filters = readFilters(url);
  let html: string;
  if (!pool || !isDbReady()) {
    html = renderPage(filters, [], 0, "The database isn't connected yet, so there are no saved chats to show.");
  } else {
    const { rows, total } = await queryLogs(filters);
    html = renderPage(filters, rows, total);
  }
  res
    .writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    })
    .end(html);
}

export function startLogViewer(): Server | null {
  if (!config.logViewerPassword) {
    console.log("[log-viewer] LOG_VIEWER_PASSWORD not set — chat log web page is off.");
    return null;
  }
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("[log-viewer] Error:", err);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Something went wrong");
    });
  });
  server.listen(config.port, () => {
    console.log(`[log-viewer] Chat log page running on port ${config.port}`);
  });
  return server;
}
