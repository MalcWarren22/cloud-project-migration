// src/api.js
const API = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, ""); // trim trailing slash

// Exports: apiUrl, fetchRecent, fetchTopics, ingestYouTube, ingestTwitter, youtubeSearchSync, twitterSearchSync
export function apiUrl(path = "") {
  const p = String(path || "");
  if (!p) return API;
  return `${API}${p.startsWith("/") ? "" : "/"}${p}`;
}

async function httpJson(url, options = {}) {
  const res = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.headers || {}),
    },
  });

  // helpful error text instead of silent failures
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API error ${res.status}${text ? `: ${text}` : ""}`);
  }

  // handle empty body
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // if backend returns plain text
    return text;
  }
}

export async function fetchRecent({
  topic,
  limit = 20,
  q,
  device,
  backfill,
  min_margin,
} = {}) {
  const url = new URL(apiUrl("/recent"));

  if (topic) url.searchParams.set("topic", topic);
  if (q) url.searchParams.set("q", q);
  if (device) url.searchParams.set("device", device);
  if (backfill) url.searchParams.set("backfill", "1");
  if (min_margin != null)
    url.searchParams.set("min_margin", String(min_margin));

  url.searchParams.set("limit", String(limit));

  return httpJson(url.toString());
}

export async function fetchTopics({ limit = 200 } = {}) {
  const url = new URL(apiUrl("/topics"));
  url.searchParams.set("limit", String(limit));

  const data = await httpJson(url.toString());
  return data?.topics ?? [];
}

export async function ingestYouTube({
  topic,
  query,
  max_videos = 5,
  comments_per_video = 500,
  videoId,
} = {}) {
  return httpJson(apiUrl("/ingest/youtube"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic,
      query,
      max_videos,
      comments_per_video,
      videoId,
    }),
  });
}

export async function ingestTwitter({ topic, query, max_results = 100 } = {}) {
  return httpJson(apiUrl("/ingest/twitter"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic,
      query,
      max_results,
    }),
  });
}

export async function youtubeSearchSync({ topic, query, max_videos = 5, comments_per_video = 200, videoId } = {}) {
  return httpJson(apiUrl("/youtube/search"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic,
      query,
      max_videos,
      comments_per_video,
      videoId,
    }),
  });
}

export async function twitterSearchSync({ topic, query, max_results = 100 } = {}) {
  return httpJson(apiUrl("/twitter/search"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic,
      query,
      max_results,
    }),
  });
}
