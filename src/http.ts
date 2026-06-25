/**
 * A tiny HTTP endpoint that lets local tools ask bishop to DM a user.
 *
 * Built on node:http (no extra deps). Bound to 127.0.0.1 by default, gated by a
 * shared bearer token, so only processes on the same box that know the token
 * can use it. The digest job (also on pop.local) POSTs its daily summary here.
 *
 *   POST /dm   Authorization: Bearer <BISHOP_HTTP_TOKEN>
 *     { "content"?: string, "embeds"?: object[], "recipientId"?: string }
 *     -> 200 { ok: true, sent: <number of discord messages> }
 *
 *   GET /health -> 200 { ok: true, ready: <gateway connected?> }
 *
 * Discord caps a message at 2000 chars and 10 embeds, so long content is split
 * on line boundaries and embeds are batched across multiple sends.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Client } from "discord.js";

const MAX_CONTENT = 2000;
const MAX_EMBEDS = 10;

interface DmPayload {
  content?: string;
  embeds?: Record<string, unknown>[];
  recipientId?: string;
}

/** Read and JSON-parse a request body, rejecting anything oversized. */
function readJson(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** Split a long string into <=2000-char chunks, preferring line boundaries. */
function chunkContent(content: string): string[] {
  if (content.length <= MAX_CONTENT) return [content];
  const out: string[] = [];
  let cur = "";
  for (const line of content.split("\n")) {
    if (cur.length + line.length + 1 > MAX_CONTENT) {
      if (cur) out.push(cur);
      if (line.length > MAX_CONTENT) {
        // A single line longer than the limit: hard-split it.
        for (let i = 0; i < line.length; i += MAX_CONTENT) out.push(line.slice(i, i + MAX_CONTENT));
        cur = "";
      } else {
        cur = line;
      }
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startHttpServer(client: Client): void {
  const token = process.env.BISHOP_HTTP_TOKEN;
  if (!token) {
    console.warn("BISHOP_HTTP_TOKEN not set — HTTP message endpoint disabled.");
    return;
  }
  const port = Number(process.env.BISHOP_HTTP_PORT ?? 8787);
  const host = process.env.BISHOP_HTTP_HOST ?? "127.0.0.1";
  const defaultRecipient = process.env.DISCORD_DM_USER_ID;

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        json(res, 200, { ok: true, ready: client.isReady() });
        return;
      }
      if (req.method !== "POST" || req.url !== "/dm") {
        json(res, 404, { ok: false, error: "not found" });
        return;
      }
      if ((req.headers.authorization ?? "") !== `Bearer ${token}`) {
        json(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      const body = (await readJson(req)) as DmPayload;
      const recipientId = body.recipientId ?? defaultRecipient;
      if (!recipientId) {
        json(res, 400, { ok: false, error: "no recipientId and DISCORD_DM_USER_ID unset" });
        return;
      }
      const content = typeof body.content === "string" ? body.content : "";
      const embeds = Array.isArray(body.embeds) ? body.embeds : [];
      if (!content && embeds.length === 0) {
        json(res, 400, { ok: false, error: "content or embeds required" });
        return;
      }

      const user = await client.users.fetch(recipientId);

      let sent = 0;
      for (const chunk of content ? chunkContent(content) : []) {
        await user.send({ content: chunk });
        sent++;
      }
      for (let i = 0; i < embeds.length; i += MAX_EMBEDS) {
        await user.send({ embeds: embeds.slice(i, i + MAX_EMBEDS) });
        sent++;
      }
      json(res, 200, { ok: true, sent });
    } catch (err) {
      console.error("HTTP /dm error:", err);
      json(res, 500, { ok: false, error: String((err as Error)?.message ?? err) });
    }
  });

  server.listen(port, host, () => {
    console.log(`Bishop HTTP message endpoint listening on http://${host}:${port}`);
  });
}
