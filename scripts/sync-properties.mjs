import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputPath = resolve(process.env.PROPERTY_CATALOG_PATH ?? "public/data/properties.json");
const configuredFeeds = (process.env.PROPERTY_FEED_URLS ?? "")
  .split(/[\n,]+/)
  .map((value) => value.trim())
  .filter(Boolean);

const text = (value) => String(value ?? "").trim();
const number = (value) => {
  const parsed = Number(String(value ?? "").replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
};
const id = (value) => createHash("sha1").update(value).digest("hex").slice(0, 18);

function safeUrl(value) {
  try {
    const url = new URL(text(value));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function decodeXml(value) {
  return text(value)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function xmlValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeXml(match?.[1]?.replace(/<[^>]+>/g, " ") ?? "");
}

function xmlBlock(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] ?? "";
}

function xmlAttribute(block, tag, attribute) {
  const match = block.match(new RegExp(`<${tag}[^>]*\\s${attribute}=["']([^"']+)["'][^>]*>`, "i"));
  return decodeXml(match?.[1] ?? "");
}

function normalizeKind(value) {
  const source = text(value).toLowerCase();
  if (source.includes("дом") || source.includes("house") || source.includes("коттедж")) return "Дом";
  if (source.includes("новост")) return "Новостройка";
  if (source.includes("коммер") || source.includes("office") || source.includes("склад")) return "Коммерция";
  if (source.includes("участ") || source.includes("land")) return "Участок";
  return "Квартира";
}

function normalizeJsonItem(item, feedUrl) {
  const sourceUrl = safeUrl(item.sourceUrl ?? item.url ?? item.link);
  const title = text(item.title ?? item.name ?? item.description).slice(0, 160);
  const price = number(item.price?.value ?? item.price ?? item.cost);
  if (!sourceUrl || !title || !price) return null;

  const feedHost = new URL(feedUrl).hostname.replace(/^www\./, "");
  return {
    id: text(item.id ?? item.externalId ?? item.external_id) || id(sourceUrl),
    title,
    city: text(item.city ?? item.location?.city ?? item.locality ?? item.region) || "Россия",
    district: text(item.district ?? item.location?.district) || undefined,
    kind: normalizeKind(item.kind ?? item.category ?? item.type),
    price,
    currency: text(item.currency ?? item.price?.currency) || "RUB",
    area: number(item.area ?? item.totalArea) || undefined,
    rooms: number(item.rooms ?? item.roomCount) || undefined,
    image: safeUrl(item.image ?? item.images?.[0] ?? item.photo) || undefined,
    source: text(item.source ?? item.agency) || feedHost,
    sourceUrl,
    updatedAt: text(item.updatedAt ?? item.updated_at ?? item.creationDate) || new Date().toISOString(),
    badges: Array.isArray(item.badges) ? item.badges.map(text).filter(Boolean).slice(0, 4) : undefined,
  };
}

function parseJson(body, feedUrl) {
  const payload = JSON.parse(body);
  const list = Array.isArray(payload)
    ? payload
    : payload.items ?? payload.listings ?? payload.properties ?? payload.offers ?? [];
  return Array.isArray(list) ? list.map((item) => normalizeJsonItem(item, feedUrl)).filter(Boolean) : [];
}

function parseXml(body, feedUrl) {
  const offers = body.match(/<offer\b[\s\S]*?<\/offer>/gi) ?? [];
  const feedHost = new URL(feedUrl).hostname.replace(/^www\./, "");

  return offers.map((offer) => {
    const sourceUrl = safeUrl(xmlValue(offer, "url"));
    const priceBlock = xmlBlock(offer, "price");
    const areaBlock = xmlBlock(offer, "area");
    const price = number(xmlValue(priceBlock, "value")) || number(xmlValue(offer, "price"));
    const city = xmlValue(offer, "locality-name") || xmlValue(offer, "region") || "Россия";
    const category = xmlValue(offer, "category");
    const area = number(xmlValue(areaBlock, "value")) || number(xmlValue(offer, "area"));
    const rooms = number(xmlValue(offer, "rooms"));
    const address = xmlValue(offer, "address");
    const title = text(xmlValue(offer, "title") || [category, rooms && `${rooms}-комн.`, address || city].filter(Boolean).join(", "));
    if (!sourceUrl || !title || !price) return null;

    return {
      id: xmlAttribute(offer, "offer", "internal-id") || id(sourceUrl),
      title: title.slice(0, 160),
      city,
      district: xmlValue(offer, "sub-locality-name") || undefined,
      kind: normalizeKind(category),
      price,
      currency: xmlValue(offer, "currency") || "RUB",
      area: area || undefined,
      rooms: rooms || undefined,
      image: safeUrl(xmlValue(offer, "image")) || undefined,
      source: xmlValue(offer, "organization") || feedHost,
      sourceUrl,
      updatedAt: xmlValue(offer, "last-update-date") || xmlValue(offer, "creation-date") || new Date().toISOString(),
    };
  }).filter(Boolean);
}

async function loadExisting() {
  try {
    return JSON.parse(await readFile(outputPath, "utf8"));
  } catch {
    return { items: [] };
  }
}

async function sync() {
  if (!configuredFeeds.length) {
    const existing = await loadExisting();
    await writeFile(outputPath, `${JSON.stringify({
      ...existing,
      status: "awaiting_authorized_feeds",
    }, null, 2)}\n`);
    console.log("PROPERTY_FEED_URLS is empty; catalog structure is ready.");
    return;
  }

  const collected = [];
  const sources = [];

  for (const feedUrl of configuredFeeds) {
    const url = safeUrl(feedUrl);
    if (!url) continue;
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "FrankovEstateFeedSync/1.0 (+https://frankovfrenk-sys.github.io)" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      const items = body.trimStart().startsWith("<") ? parseXml(body, url) : parseJson(body, url);
      collected.push(...items);
      sources.push({ url, status: "ok", items: items.length });
    } catch (error) {
      sources.push({ url, status: "error", error: error instanceof Error ? error.message : "Unknown error" });
    }
  }

  const unique = [...new Map(collected.map((item) => [item.sourceUrl, item])).values()]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 300);

  await writeFile(outputPath, `${JSON.stringify({
    updatedAt: new Date().toISOString(),
    status: "synced",
    sources,
    items: unique,
  }, null, 2)}\n`);

  console.log(`Synced ${unique.length} authorized properties from ${sources.length} feeds.`);
}

await sync();
