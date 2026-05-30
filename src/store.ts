/**
 * A tiny JSON-file-backed map from a Discord scheduled-event ID to the message
 * bishop posted for it. Persisted (rather than in-memory) so edits/deletes are
 * still matched to the original message across bot restarts.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PostedMessage {
  guildId: string;
  channelId: string;
  messageId: string;
}

const STORE_PATH = process.env.BISHOP_STORE_PATH ?? "data/messages.json";

type StoreData = Record<string, PostedMessage>;

let cache: StoreData | null = null;

async function load(): Promise<StoreData> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(STORE_PATH, "utf8")) as StoreData;
  } catch {
    cache = {};
  }
  return cache;
}

async function persist(): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(cache ?? {}, null, 2));
}

export async function rememberMessage(eventId: string, msg: PostedMessage): Promise<void> {
  const data = await load();
  data[eventId] = msg;
  await persist();
}

export async function getMessage(eventId: string): Promise<PostedMessage | undefined> {
  return (await load())[eventId];
}

export async function forgetMessage(eventId: string): Promise<void> {
  const data = await load();
  delete data[eventId];
  await persist();
}
