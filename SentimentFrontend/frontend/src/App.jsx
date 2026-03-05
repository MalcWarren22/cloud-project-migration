// src/App.jsx
import { useEffect, useMemo, useState } from "react";
import { fetchRecent, fetchTopics, apiUrl, ingestYouTube } from "./api";

/* ----------------------------
   UI bits
---------------------------- */

function Badge({ label }) {
  const l = (label || "").toLowerCase();
  const cls =
    l === "positive"
      ? "badge badge--pos"
      : l === "negative"
      ? "badge badge--neg"
      : l === "neutral"
      ? "badge badge--neu"
      : "badge";
  return <span className={cls}>{label || "n/a"}</span>;
}

function fmt(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(2);
}

function fmtPct(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `${Math.round(Number(n) * 100)}%`;
}

function fmtTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

/* ----------------------------
   Device classifier (for display + coverage)
---------------------------- */

function classifyDevice(text = "") {
  const t = text.toLowerCase();

  const apple =
    /\b(iphone|ios|imessage|facetime|airdrop|apple\s?pay|apple|macbook|ipad|watch\s?os|airpods)\b/.test(
      t
    );

  const android =
    /\b(android|pixel|galaxy|samsung|oneplus|motorola|xiaomi|play\s?store|google\s?pay|wear\s?os)\b/.test(
      t
    );

  if (apple && !android) return "iphone";
  if (android && !apple) return "android";
  if (apple && android) return "both";
  return "neither";
}

function labelForBucket(b) {
  if (b === "iphone") return "iPhone";
  if (b === "android") return "Android";
  if (b === "both") return "Both";
  return "Other";
}

/* ----------------------------
   Confidence policy (frontend)
---------------------------- */

const MIN_MARGIN = (() => {
  const raw = import.meta.env.VITE_SENTIMENT_MIN_MARGIN;
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : 0.05;
})();

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * getScores()
 * - Hard-normalizes scores so UI never sees {}
 * - Ensures keys exist, numeric, sum=1
 * - Falls back to label-based defaults if missing/invalid
 */
function getScores(row) {
  const ai = row?.sentiment?.azure_ai || {};
  const raw = ai?.scores;

  const label = String(ai?.label || "").toLowerCase();
  const labelNorm =
    label === "positive" || label === "negative" || label === "neutral"
      ? label
      : "neutral";

  let p = 0,
    neu = 0,
    neg = 0;

  if (raw && typeof raw === "object") {
    p = clamp01(raw.positive);
    neu = clamp01(raw.neutral);
    neg = clamp01(raw.negative);
  }

  let s = p + neu + neg;

  if (s <= 0) {
    if (labelNorm === "positive") {
      p = 0.7;
      neu = 0.3;
      neg = 0.0;
    } else if (labelNorm === "negative") {
      p = 0.0;
      neu = 0.3;
      neg = 0.7;
    } else {
      p = 0.15;
      neu = 0.7;
      neg = 0.15;
    }
    s = p + neu + neg;
  }

  if (s <= 0) return { positive: 0, neutral: 1, negative: 0 };
  return { positive: p / s, neutral: neu / s, negative: neg / s };
}

/**
 * stableLabelFromScores()
 * - Decide only from pos vs neg, with a deadzone (MIN_MARGIN).
 */
function stableLabelFromScores(scores) {
  const p = Number(scores?.positive ?? 0);
  const n = Number(scores?.negative ?? 0);

  if (!Number.isFinite(p) || !Number.isFinite(n)) return "neutral";
  if (Math.abs(p - n) < MIN_MARGIN) return "neutral";
  return p > n ? "positive" : "negative";
}

/* ----------------------------
   Summaries (score-based)
---------------------------- */

function summarizeMix(rows) {
  let pos = 0,
    neu = 0,
    neg = 0;
  let lastIngest = null;

  for (const r of rows) {
    if (r?.scored_at) {
      const d = new Date(r.scored_at);
      if (!Number.isNaN(d.getTime())) {
        if (!lastIngest || d > lastIngest) lastIngest = d;
      }
    }

    const scores = getScores(r);
    const label = stableLabelFromScores(scores);
    if (label === "positive") pos++;
    else if (label === "negative") neg++;
    else neu++;
  }

  return { total: rows.length, pos, neu, neg, lastIngest };
}

function summarizeSignal(rows) {
  const mix = summarizeMix(rows);
  const signal = mix.pos + mix.neg;
  const netSignal = signal ? (mix.pos - mix.neg) / signal : null;
  return { ...mix, signal, netSignal };
}

function wilsonInterval(pos, neg, z = 1.96) {
  const n = pos + neg;
  if (!n) return { lb: null, ub: null, phat: null, n: 0 };

  const phat = pos / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const adj = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);

  const lb = (center - adj) / denom;
  const ub = (center + adj) / denom;

  return { lb, ub, phat, n };
}

function topTerms(rows, limit = 10) {
  const stop = new Set([
    "the","a","an","and","or","but","to","of","in","on","for","is","it","this","that","with","as","at","by","be","are","was","were",
    "from","you","your","they","them","their","we","our","i","me","my","just","like","have","has","had","not","dont","does","did","can",
    "could","should","would",
  ]);

  const counts = new Map();

  for (const r of rows) {
    const t = (r?.clean_text || "").toLowerCase();
    const words = t.split(/[^a-z0-9]+/g);
    for (const w of words) {
      if (!w || w.length < 4) continue;
      if (stop.has(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

/* ----------------------------
   Trend chart (no libs)
---------------------------- */

function toDateSafe(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatBucketLabel(key, granularity) {
  if (granularity === "hour") {
    const hh = key.slice(11, 13);
    return `${hh}:00`;
  }
  const m = key.slice(5, 7);
  const d = key.slice(8, 10);
  return `${m}/${d}`;
}

function TrendChart({ series, granularity = "day" }) {
  const W = 980;
  const H = 220;
  const P = 18;

  const allPoints = series.flatMap((s) => s.points);
  if (!allPoints.length) {
    return <div className="trendEmpty">No trend data yet.</div>;
  }

  const xKeys = Array.from(new Set(allPoints.map((p) => p.xKey))).sort();
  const xIndex = new Map(xKeys.map((k, i) => [k, i]));

  const xs = (i) =>
    xKeys.length === 1 ? P : P + (i * (W - P * 2)) / (xKeys.length - 1);

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ys = (y) => {
    const v = clamp(y, -1, 1);
    return P + (1 - (v + 1) / 2) * (H - P * 2);
  };

  const gridLines = [-1, -0.5, 0, 0.5, 1];

  const baselinePath = () => {
    if (!xKeys.length) return "";
    const y0 = ys(0);
    return `M ${xs(0).toFixed(2)} ${y0.toFixed(2)} L ${xs(xKeys.length - 1).toFixed(
      2
    )} ${y0.toFixed(2)}`;
  };

  const linePath = (points) => {
    const pts = points
      .filter((p) => xIndex.has(p.xKey) && p.y != null)
      .map((p) => {
        const i = xIndex.get(p.xKey);
        return [xs(i), ys(p.y)];
      });

    if (!pts.length) return baselinePath();
    if (pts.length === 1) return baselinePath();

    return pts
      .map(
        (pt, idx) =>
          `${idx === 0 ? "M" : "L"} ${pt[0].toFixed(2)} ${pt[1].toFixed(2)}`
      )
      .join(" ");
  };

  const labelCount = Math.min(8, xKeys.length);
  const labelEvery = Math.max(1, Math.floor(xKeys.length / labelCount));

  return (
    <div className="trendWrap">
      <div className="trendHeader">
        <div className="trendTitle">Sentiment trend</div>
        <div className="trendSub">
          Signal net = (pos − neg) / (pos + neg) per{" "}
          {granularity === "hour" ? "hour" : "day"} (neutral ignored)
        </div>
        <div className="trendLegend">
          {series.map((s) => (
            <span key={s.name} className={`legendChip legendChip--${s.tone}`}>
              <span className={`legendDot legendDot--${s.tone}`} />
              {s.name}
            </span>
          ))}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="trendSvg"
        role="img"
        aria-label="Sentiment trend chart"
      >
        {gridLines.map((g) => (
          <g key={g}>
            <line
              x1={P}
              x2={W - P}
              y1={ys(g)}
              y2={ys(g)}
              className={g === 0 ? "gridLine gridLine--mid" : "gridLine"}
            />
            <text x={P} y={ys(g) - 6} className="gridLabel">
              {g.toFixed(1)}
            </text>
          </g>
        ))}

        {series.map((s) => (
          <path
            key={s.name}
            d={linePath(s.points)}
            className={`trendLine trendLine--${s.tone}`}
            fill="none"
          />
        ))}

        {xKeys.map((k, idx) => {
          if (idx % labelEvery !== 0 && idx !== xKeys.length - 1) return null;
          return (
            <text
              key={k}
              x={xs(idx)}
              y={H - 6}
              textAnchor="middle"
              className="xLabel"
            >
              {formatBucketLabel(k, granularity)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

/* ----------------------------
   App
---------------------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default function App() {
  const [apiStatus, setApiStatus] = useState("checking");
  const [lastCheck, setLastCheck] = useState(null);

  const [topics, setTopics] = useState([]);
  const [topic, setTopic] = useState("");
  const [limit, setLimit] = useState(2000);
  const [query, setQuery] = useState("");
  const [deviceFilter, setDeviceFilter] = useState("any");

  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function checkHealth() {
    try {
      const res = await fetch(apiUrl("/health"), { cache: "no-store" });
      setApiStatus(res.ok ? "online" : "degraded");
    } catch {
      setApiStatus("offline");
    } finally {
      setLastCheck(new Date());
    }
  }

  // FIXED: Search now ingests from YouTube using the search text, then loads /recent
  async function load({ silent = false } = {}) {
    if (!silent) setErr("");
    setLoading(true);

    await checkHealth();

    const qText = query.trim();

    try {
      // If user typed something, trigger ingestion for that query
      if (qText) {
        await ingestYouTube({
          topic: topic || "demo",
          query: qText,
          max_videos: 5,
          comments_per_video: 500,
        });

        // give the queue worker a moment, then poll a couple times
        await sleep(1200);
      }

      // poll up to 4 times to let queue populate SQL
      let data = [];
      for (let attempt = 0; attempt < 4; attempt++) {
       data = await fetchRecent({
       topic: topic || undefined,
       limit,
       q: qText || undefined,
       device: deviceFilter !== "any" ? deviceFilter : undefined,
       backfill: true,              // ✅ tell backend to rescore legacy rows
       min_margin: MIN_MARGIN,      // ✅ keep UI+API consistent
    });

        if (Array.isArray(data) && data.length > 0) break;
        await sleep(900);
      }

      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      if (!silent) setErr(e?.message || "Request failed");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      await checkHealth();
      try {
        const t = await fetchTopics({ limit: 200 });
        setTopics(t);
      } catch {
        setTopics(["demo", "iphone_vs_android"]);
      }
      await load({ silent: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buckets = useMemo(() => {
    const iphone = [];
    const android = [];
    const both = [];
    const neither = [];

    for (const r of rows) {
      const bucket = classifyDevice(r?.clean_text || "");
      if (bucket === "iphone") iphone.push(r);
      else if (bucket === "android") android.push(r);
      else if (bucket === "both") both.push(r);
      else neither.push(r);
    }

    return { iphone, android, both, neither };
  }, [rows]);

  const sumIphone = useMemo(() => summarizeSignal(buckets.iphone), [buckets.iphone]);
  const sumAndroid = useMemo(() => summarizeSignal(buckets.android), [buckets.android]);
  const overall = useMemo(() => summarizeMix(rows), [rows]);

  const coverage = useMemo(() => {
    const matched = buckets.iphone.length + buckets.android.length + buckets.both.length;
    return overall.total ? matched / overall.total : null;
  }, [buckets, overall.total]);

  const ipWilson = useMemo(() => wilsonInterval(sumIphone.pos, sumIphone.neg), [sumIphone.pos, sumIphone.neg]);
  const anWilson = useMemo(() => wilsonInterval(sumAndroid.pos, sumAndroid.neg), [sumAndroid.pos, sumAndroid.neg]);

  const MIN_EFFECTIVE_SIGNAL = 25;

  const decision = useMemo(() => {
    const ipSig = sumIphone.signal;
    const anSig = sumAndroid.signal;

    if (ipSig < MIN_EFFECTIVE_SIGNAL || anSig < MIN_EFFECTIVE_SIGNAL) {
      return {
        label: "Not enough signal",
        detail: `Need ≥ ${MIN_EFFECTIVE_SIGNAL} pos/neg per side (iPhone ${ipSig}, Android ${anSig}).`,
        confidence: null,
      };
    }

    if (ipWilson.lb != null && anWilson.lb != null) {
      if (ipWilson.lb > anWilson.ub) {
        return { label: "iPhone", detail: "statistically higher positive-rate", confidence: ipWilson.lb - anWilson.ub };
      }
      if (anWilson.lb > ipWilson.ub) {
        return { label: "Android", detail: "statistically higher positive-rate", confidence: anWilson.lb - ipWilson.ub };
      }
    }

    const netDiff = (sumIphone.netSignal ?? 0) - (sumAndroid.netSignal ?? 0);
    const deadzone = 0.08;
    if (netDiff > deadzone) return { label: "iPhone", detail: "leaning positive (signal)", confidence: Math.abs(netDiff) };
    if (netDiff < -deadzone) return { label: "Android", detail: "leaning positive (signal)", confidence: Math.abs(netDiff) };
    return { label: "Even", detail: "confidence intervals overlap", confidence: Math.abs(netDiff) };
  }, [sumIphone.signal, sumAndroid.signal, sumIphone.netSignal, sumAndroid.netSignal, ipWilson, anWilson]);

  const netDiff = useMemo(() => {
    const a = sumIphone.netSignal ?? 0;
    const b = sumAndroid.netSignal ?? 0;
    return a - b;
  }, [sumIphone.netSignal, sumAndroid.netSignal]);

  const trend = useMemo(() => {
    const granularity = rows.length > 800 ? "hour" : "day";

    function bucketKey(d) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      if (granularity === "hour") {
        const hh = String(d.getHours()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd} ${hh}`;
      }
      return `${yyyy}-${mm}-${dd}`;
    }

    function netSignalForRows(rowsInBucket) {
      let pos = 0, neg = 0;
      for (const r of rowsInBucket) {
        const scores = getScores(r);
        const label = stableLabelFromScores(scores);
        if (label === "positive") pos++;
        else if (label === "negative") neg++;
      }
      const sig = pos + neg;
      return sig ? (pos - neg) / sig : null;
    }

    function buildSeries(name, rowsArr, tone) {
      const map = new Map();
      for (const r of rowsArr) {
        const d = toDateSafe(r?.scored_at);
        if (!d) continue;
        const k = bucketKey(d);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(r);
      }
      const keys = Array.from(map.keys()).sort();
      const points = keys.map((k) => ({ xKey: k, y: netSignalForRows(map.get(k)) }));
      return { name, tone, points };
    }

    return {
      granularity,
      series: [
        buildSeries("iPhone", buckets.iphone, "pos"),
        buildSeries("Android", buckets.android, "neg"),
      ],
    };
  }, [rows, buckets.iphone, buckets.android]);

  const iphoneTerms = useMemo(() => topTerms(buckets.iphone, 10), [buckets.iphone]);
  const androidTerms = useMemo(() => topTerms(buckets.android, 10), [buckets.android]);

  const heroText = useMemo(() => {
    if (!overall.total) return "No data yet — click Search to load scored posts.";
    const cov = coverage == null ? "—" : `${Math.round(coverage * 100)}%`;
    if (decision.label === "Not enough signal") {
      return `Not enough reliable positive/negative signal to declare a winner yet. Coverage: ${cov} of rows mention iPhone/Android.`;
    }
    if (decision.label === "Even") {
      return `Sentiment is too close to call with confidence. Coverage: ${cov} of rows mention iPhone/Android.`;
    }
    return `${decision.label} is trending more positive with higher confidence. Coverage: ${cov} of rows mention iPhone/Android (or both).`;
  }, [overall.total, coverage, decision.label]);

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <div className="logo" />
          <div>
            <div className="title">Sentiment Analysis Dashboard</div>
            <div className="subtitle">Azure Functions • Azure AI Language • SQL</div>
          </div>
        </div>
        <div className="actions" />
      </header>

      <main className="grid">
        <section className="card area-filters">
          <div className="cardTitle">Filters</div>

          <div className="filtersGrid">
            <div className="filtersRow filtersRow--inputs">
              <div className="field field--topic">
                <label>Topic</label>
                <select className="select" value={topic} onChange={(e) => setTopic(e.target.value)}>
                  <option value="">All topics</option>
                  {topics.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>

              <div className="field field--limit">
                <label>Limit</label>
                <input
                  type="number"
                  value={limit}
                  min={1}
                  max={5000}
                  onChange={(e) => setLimit(Number(e.target.value))}
                />
              </div>

              <div className="field field--search">
                <label>Search</label>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      load();
                    }
                  }}
                  placeholder='Try: "iphone battery", "android camera", "samsung overheating"'
                />
              </div>

              <div className="field field--device">
                <label>Device</label>
                <select className="select" value={deviceFilter} onChange={(e) => setDeviceFilter(e.target.value)}>
                  <option value="any">All</option>
                  <option value="iphone">iPhone</option>
                  <option value="android">Android</option>
                  <option value="both">Both</option>
                </select>
              </div>

              <div className="field field--btn">
                <label>&nbsp;</label>
                <button className="btn btn--primary" onClick={() => load()} disabled={loading}>
                  {loading ? "Searching…" : "Search"}
                </button>
              </div>
            </div>

            <div className="filtersRow filtersRow--meta">
              <div className="pill metaPill">
                <span style={{ fontWeight: 850 }}>Winner mode</span>
                <span className="dim" style={{ marginLeft: 8 }}>
                  (Wilson confidence + signal fallback)
                </span>
              </div>

              <div className="pill metaPill metaPill--right" title={import.meta.env.VITE_API_BASE_URL}>
                <span className="statusDot" data-status={apiStatus} aria-label={`backend ${apiStatus}`} />
                <span style={{ fontWeight: 800, textTransform: "capitalize" }}>{apiStatus}</span>
                {lastCheck && (
                  <span style={{ marginLeft: 10, opacity: 0.72 }}>
                    • checked {lastCheck.toLocaleTimeString()}
                  </span>
                )}
              </div>
            </div>
          </div>

          {err && (
            <div className="alert">
              <span className="alertDot" />
              <div>
                <div className="alertTitle">Request failed</div>
                <div className="alertMsg">{err}</div>
              </div>
            </div>
          )}
        </section>

        <section className="card card--kpi area-kpi1">
          <div className="cardTitle">iPhone</div>
          <div className="kpiRow">
            <div>
              <div className="statBig">{sumIphone.total}</div>
              <div className="statSub">posts matched</div>
            </div>
            <div className="kpiMeta">Signal: {sumIphone.signal}</div>
          </div>
        </section>

        <section className="card card--kpi area-kpi2">
          <div className="cardTitle">Android</div>
          <div className="kpiRow">
            <div>
              <div className="statBig">{sumAndroid.total}</div>
              <div className="statSub">posts matched</div>
            </div>
            <div className="kpiMeta">Signal: {sumAndroid.signal}</div>
          </div>
        </section>

        <section className="card card--kpi area-kpi3">
          <div className="cardTitle">Who’s Winning</div>
          <div className="kpiRow">
            <div>
              <div className="statBig" style={{ fontSize: 26 }}>{decision.label}</div>
              <div className="statSub">{decision.detail}</div>
            </div>
            <div className="kpiMeta">{fmtPct(Math.abs(netDiff))}</div>
          </div>
        </section>

        <section className="card card--kpi area-kpi4">
          <div className="cardTitle">Coverage</div>
          <div className="kpiRow">
            <div>
              <div className="statBig" style={{ fontSize: 30 }}>
                {coverage == null ? "—" : `${Math.round(coverage * 100)}%`}
              </div>
              <div className="statSub">mentions iPhone/Android (or both)</div>
            </div>
            <div className="kpiMeta">Both: {buckets.both.length}</div>
          </div>
        </section>

        <section className="card card--hero area-hero">
          <div className="cardTitle">Insights</div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 18, fontWeight: 950, letterSpacing: "-0.01em" }}>
              {heroText}
            </div>

            <TrendChart series={trend.series} granularity={trend.granularity} />

            <div className="compareGrid">
              <div className="compareCol">
                <div className="compareTitle">Top iPhone terms</div>
                <div className="termWrap">
                  {iphoneTerms.length ? (
                    iphoneTerms.map(([w, c]) => (
                      <span key={`ip-${w}`} className="termPill" title={`${c} mentions`}>
                        {w} <span className="termCount">{c}</span>
                      </span>
                    ))
                  ) : (
                    <div className="dim">No iPhone terms yet.</div>
                  )}
                </div>
              </div>

              <div className="compareCol">
                <div className="compareTitle">Top Android terms</div>
                <div className="termWrap">
                  {androidTerms.length ? (
                    androidTerms.map(([w, c]) => (
                      <span key={`an-${w}`} className="termPill" title={`${c} mentions`}>
                        {w} <span className="termCount">{c}</span>
                      </span>
                    ))
                  ) : (
                    <div className="dim">No Android terms yet.</div>
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <span className="badge">Rows: <b style={{ marginLeft: 6 }}>{overall.total}</b></span>
              <span className="badge">Topic: <b style={{ marginLeft: 6 }}>{topic || "All"}</b></span>
              <span className="badge">Search: <b style={{ marginLeft: 6 }}>{query.trim() || "—"}</b></span>
              <span className="badge">Device: <b style={{ marginLeft: 6 }}>{deviceFilter}</b></span>
              <span className="badge">Margin: <b style={{ marginLeft: 6 }}>{MIN_MARGIN.toFixed(2)}</b></span>
            </div>
          </div>
        </section>

        <section className="card area-side">
          <div className="cardTitle">Signal Mix (pos/neg drive winner)</div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="sideCompareRow">
              <div className="sideCompareName">iPhone</div>
              <div className="sideCompareBadges">
                <span className="badge badge--pos">Pos {sumIphone.pos}</span>
                <span className="badge badge--neg">Neg {sumIphone.neg}</span>
                <span className="badge badge--neu">Neu {sumIphone.neu}</span>
              </div>
            </div>

            <div className="sideCompareRow">
              <div className="sideCompareName">Android</div>
              <div className="sideCompareBadges">
                <span className="badge badge--pos">Pos {sumAndroid.pos}</span>
                <span className="badge badge--neg">Neg {sumAndroid.neg}</span>
                <span className="badge badge--neu">Neu {sumAndroid.neu}</span>
              </div>
            </div>

            <div className="footerHint" style={{ marginTop: 4 }}>
              Tip: “Signal” is pos+neg after confidence gating. Neutrals don’t decide winners.
            </div>
          </div>
        </section>

        <section className="card area-table">
          <div className="cardTitle">Recent Scored Posts</div>

          <div className="tableWrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Platform</th>
                  <th>Topic</th>
                  <th>Device</th>
                  <th>Sentiment</th>
                  <th>Scores</th>
                  <th>Text</th>
                </tr>
              </thead>

              <tbody>
                {rows.map((r, idx) => {
                  const s = getScores(r);
                  const stable = stableLabelFromScores(s);
                  const scoreStr = `P:${fmt(s.positive)}  Neu:${fmt(s.neutral)}  Neg:${fmt(s.negative)}`;

                  const key = r?._id || `${r?.platform || "p"}-${r?.scored_at || "t"}-${idx}`;

                  return (
                    <tr key={key}>
                      <td className="mono">{fmtTime(r.scored_at)}</td>
                      <td>{r.platform || ""}</td>
                      <td>{r.topic || ""}</td>
                      <td className="dim">{labelForBucket(classifyDevice(r?.clean_text || ""))}</td>
                      <td><Badge label={stable} /></td>
                      <td className="mono dim">{scoreStr}</td>
                      <td className="textCell" title={r.clean_text || ""}>{r.clean_text || ""}</td>
                    </tr>
                  );
                })}

                {!loading && rows.length === 0 && (
                  <tr>
                    <td colSpan="7" className="empty">
                      No rows found. Try increasing Limit or clearing filters.
                    </td>
                  </tr>
                )}

                {loading && (
                  <tr>
                    <td colSpan="7" className="empty">Loading…</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="footerHint">Next upgrades: time range + export.</div>
        </section>
      </main>
    </div>
  );
}