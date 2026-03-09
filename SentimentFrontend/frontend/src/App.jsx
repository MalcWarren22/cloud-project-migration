// src/App.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchRecent, fetchTopics, apiUrl, youtubeSearchSync, twitterSearchSync } from "./api";

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

function topTermsWithSentiment(rows, limit = 10) {
  const stop = new Set([
    "the","a","an","and","or","but","to","of","in","on","for","is","it","this","that","with","as","at","by","be","are","was","were",
    "from","you","your","they","them","their","we","our","i","me","my","just","like","have","has","had","not","dont","does","did","can",
    "could","should","would",
  ]);
  const counts = new Map();
  for (const r of rows) {
    const label = stableLabelFromScores(getScores(r));
    const t = (r?.clean_text || "").toLowerCase();
    const words = t.split(/[^a-z0-9]+/g);
    const seen = new Set();
    for (const w of words) {
      if (!w || w.length < 4 || stop.has(w) || seen.has(w)) continue;
      seen.add(w);
      if (!counts.has(w)) counts.set(w, { total: 0, pos: 0, neg: 0 });
      const c = counts.get(w);
      c.total++;
      if (label === "positive") c.pos++;
      else if (label === "negative") c.neg++;
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, limit)
    .map(([word, c]) => {
      const sig = c.pos + c.neg;
      const tone = sig < 3 ? "neu" : c.pos / sig > 0.60 ? "pos" : c.pos / sig < 0.40 ? "neg" : "neu";
      return [word, c.total, tone];
    });
}

function useCountUp(target, duration = 700) {
  const [display, setDisplay] = useState(target);
  const rafRef = useRef(null);
  const prevRef = useRef(target);
  useEffect(() => {
    const from = prevRef.current;
    if (from === target) { setDisplay(target); return; }
    prevRef.current = target;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (target - from) * eased));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);
  return display;
}

function useRelativeTime(date) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!date) { setText(""); return; }
    const update = () => {
      const s = Math.floor((Date.now() - date.getTime()) / 1000);
      if (s < 10) setText("just now");
      else if (s < 60) setText(`${s}s ago`);
      else setText(`${Math.floor(s / 60)}m ago`);
    };
    update();
    const id = setInterval(update, 10000);
    return () => clearInterval(id);
  }, [date]);
  return text;
}

/* ----------------------------
   Trend chart (no libs)
---------------------------- */

function toDateSafe(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatBucketLabel(key, granularity, prevKey) {
  if (granularity === "hour") {
    const hh = key.slice(11, 13);
    const day = key.slice(0, 10);
    const prevDay = prevKey ? prevKey.slice(0, 10) : null;
    if (!prevKey || day !== prevDay) {
      const m = key.slice(5, 7);
      const d = key.slice(8, 10);
      return `${m}/${d} ${hh}h`;
    }
    return `${hh}:00`;
  }
  const m = key.slice(5, 7);
  const d = key.slice(8, 10);
  return `${m}/${d}`;
}

function smoothLinePath(pts) {
  if (!pts.length) return "";
  if (pts.length === 1) return `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  if (pts.length === 2) {
    return `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)} L ${pts[1][0].toFixed(1)} ${pts[1][1].toFixed(1)}`;
  }
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  const t = 0.25;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) * t;
    const cp1y = p1[1] + (p2[1] - p0[1]) * t;
    const cp2x = p2[0] - (p3[0] - p1[0]) * t;
    const cp2y = p2[1] - (p3[1] - p1[1]) * t;
    d += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function TrendChart({ series, granularity = "day" }) {
  const W = 980;
  const H = 240;
  const PL = 42;
  const PR = 14;
  const PT = 14;
  const PB = 28;

  const allPoints = series.flatMap((s) => s.points);
  if (!allPoints.length) {
    return <div className="trendEmpty">No trend data yet.</div>;
  }

  const xKeys = Array.from(new Set(allPoints.map((p) => p.xKey))).sort();
  const xIndex = new Map(xKeys.map((k, i) => [k, i]));

  const plotW = W - PL - PR;
  const plotH = H - PT - PB;

  const xs = (i) => xKeys.length === 1 ? PL + plotW / 2 : PL + (i * plotW) / (xKeys.length - 1);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ys = (y) => PT + (1 - (clamp(y, -1, 1) + 1) / 2) * plotH;

  const baseline = ys(0);
  const gridLines = [-1, -0.5, 0, 0.5, 1];

  const buildPts = (points) =>
    points
      .filter((p) => xIndex.has(p.xKey) && p.y != null)
      .map((p) => [xs(xIndex.get(p.xKey)), ys(p.y)]);

  const labelCount = Math.min(9, xKeys.length);
  const labelEvery = Math.max(1, Math.floor(xKeys.length / labelCount));
  const visibleLabelIdxs = new Set(
    xKeys
      .map((_, i) => i)
      .filter((i) => i % labelEvery === 0 || i === xKeys.length - 1)
  );

  return (
    <div className="trendWrap">
      <div className="trendHeader">
        <div className="trendTitle">Sentiment trend</div>
        <div className="trendSub">
          Net signal = (pos − neg) / (pos + neg) per{" "}
          {granularity === "hour" ? "hour" : granularity === "week" ? "week" : "day"} · neutral excluded · min 3 posts/bucket
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
              x1={PL}
              x2={W - PR}
              y1={ys(g)}
              y2={ys(g)}
              className={g === 0 ? "gridLine gridLine--mid" : "gridLine"}
            />
            <text x={PL - 6} y={ys(g) + 4} textAnchor="end" className="gridLabel">
              {g.toFixed(1)}
            </text>
          </g>
        ))}

        {series.map((s) => {
          const pts = buildPts(s.points);
          if (!pts.length) return null;

          if (pts.length === 1) {
            return (
              <g key={s.name}>
                <line x1={PL} x2={W - PR} y1={pts[0][1]} y2={pts[0][1]}
                  className="gridLine" strokeDasharray="4 4" />
                <circle cx={pts[0][0]} cy={pts[0][1]} r={5}
                  className={`trendDot trendDot--${s.tone}`} />
              </g>
            );
          }

          const linePd = smoothLinePath(pts);
          const first = pts[0], last = pts[pts.length - 1];
          const areaPd = `${linePd} L ${last[0].toFixed(1)},${baseline.toFixed(1)} L ${first[0].toFixed(1)},${baseline.toFixed(1)} Z`;

          return (
            <g key={s.name}>
              <path d={areaPd} className={`trendArea trendArea--${s.tone}`} />
              <path d={linePd} className={`trendLine trendLine--${s.tone}`} fill="none" />
              {pts.map(([px, py], di) => (
                <circle key={di} cx={px} cy={py} r={3} className={`trendDot trendDot--${s.tone}`} />
              ))}
            </g>
          );
        })}

        {xKeys.map((k, idx) => {
          if (!visibleLabelIdxs.has(idx)) return null;
          const prevVisIdx = [...visibleLabelIdxs].filter((i) => i < idx).pop();
          const prevKey = prevVisIdx != null ? xKeys[prevVisIdx] : null;
          return (
            <text key={k} x={xs(idx)} y={H - 6} textAnchor="middle" className="xLabel">
              {formatBucketLabel(k, granularity, prevKey)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

/* ----------------------------
   Donut chart
---------------------------- */

function polarXY(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function donutArc(cx, cy, R, r, startDeg, endDeg) {
  const span = endDeg - startDeg;
  if (span <= 0) return "";
  const end = span >= 360 ? startDeg + 359.9 : endDeg;
  const [x1, y1] = polarXY(cx, cy, R, startDeg);
  const [x2, y2] = polarXY(cx, cy, R, end);
  const [ix1, iy1] = polarXY(cx, cy, r, end);
  const [ix2, iy2] = polarXY(cx, cy, r, startDeg);
  const large = span > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)},${y1.toFixed(2)} A ${R},${R} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} L ${ix1.toFixed(2)},${iy1.toFixed(2)} A ${r},${r} 0 ${large} 0 ${ix2.toFixed(2)},${iy2.toFixed(2)} Z`;
}

function DonutChart({ label, pos, neu, neg }) {
  const total = pos + neu + neg;
  const W = 200, H = 200, cx = 100, cy = 100, R = 76, r = 50;

  if (!total) {
    return (
      <div className="donutWrap">
        <div className="donutTitle">{label}</div>
        <div className="donutEmpty">No data yet</div>
      </div>
    );
  }

  const pPct = pos / total;
  const neuPct = neu / total;
  const negPct = neg / total;
  const posEnd = pPct * 360;
  const neuEnd = posEnd + neuPct * 360;

  const dominant = pos >= neg && pos >= neu ? "positive" : neg >= pos && neg >= neu ? "negative" : "neutral";
  const domPct = dominant === "positive" ? pPct : dominant === "negative" ? negPct : neuPct;

  const segments = [
    { key: "pos", start: 0, end: posEnd, cls: "donutSeg--pos" },
    { key: "neu", start: posEnd, end: neuEnd, cls: "donutSeg--neu" },
    { key: "neg", start: neuEnd, end: 360, cls: "donutSeg--neg" },
  ];

  return (
    <div className="donutWrap">
      <div className="donutTitle">{label}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="donutSvg">
        {segments.map((s) =>
          (s.end - s.start) > 0.5 ? (
            <path key={s.key} d={donutArc(cx, cy, R, r, s.start, s.end)}
              className={`donutSeg ${s.cls}`} />
          ) : null
        )}
        <text x={cx} y={cy - 8} className="donutCenterBig" textAnchor="middle">
          {Math.round(domPct * 100)}%
        </text>
        <text x={cx} y={cy + 14} className="donutCenterSub" textAnchor="middle">
          {dominant}
        </text>
      </svg>
      <div className="donutLegend">
        <span className="donutLegItem donutLegItem--pos">▲ {Math.round(pPct * 100)}% pos</span>
        <span className="donutLegItem donutLegItem--neu">● {Math.round(neuPct * 100)}% neu</span>
        <span className="donutLegItem donutLegItem--neg">▼ {Math.round(negPct * 100)}% neg</span>
      </div>
    </div>
  );
}

function getPageNums(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set([1, total]);
  for (let i = Math.max(1, current - 1); i <= Math.min(total, current + 1); i++) pages.add(i);
  const sorted = [...pages].sort((a, b) => a - b);
  const result = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) result.push("...");
    result.push(p);
    prev = p;
  }
  return result;
}

/* ----------------------------
   Battle Banner
---------------------------- */

function BattleBanner({ sumIphone, sumAndroid, decision, loading }) {
  const ipSig = sumIphone.signal || 0;
  const anSig = sumAndroid.signal || 0;
  const total = ipSig + anSig || 1;
  const ipW = ((ipSig / total) * 100).toFixed(1);
  const anW = ((anSig / total) * 100).toFixed(1);
  const ipPosRate = sumIphone.signal > 0 ? Math.round((sumIphone.pos / sumIphone.signal) * 100) : null;
  const anPosRate = sumAndroid.signal > 0 ? Math.round((sumAndroid.pos / sumAndroid.signal) * 100) : null;
  const hasData = ipSig > 0 || anSig > 0;
  const showVerdict = hasData && decision.label && decision.label !== "Not enough signal" && decision.label !== "Even";

  return (
    <div className="battleBanner">
      <div className="battleSide battleSide--ip">
        <div className="battleEmoji">🍎</div>
        <div className="battleName">iPhone</div>
        {ipPosRate != null ? (
          <>
            <div className="battlePct">{ipPosRate}%</div>
            <div className="battleSub">positive sentiment</div>
          </>
        ) : (
          <div className="battleSub">no data yet</div>
        )}
      </div>

      <div className="battleCenter">
        {loading ? (
          <div className="battleLoading">Analyzing comments…</div>
        ) : showVerdict ? (
          <div className="battleVerdict">
            {decision.label === "iPhone" ? "🍎" : "🤖"}{" "}
            <span>{decision.label}</span>{" "}
            <span className="battleVerdictSub">leads</span>
          </div>
        ) : hasData ? (
          <div className="battleVs">TOO CLOSE</div>
        ) : (
          <div className="battleVs">VS</div>
        )}
        <div className="battleBarTrack">
          <div className="battleBarFill--ip" style={{ width: `${ipW}%` }} />
          <div className="battleBarFill--an" style={{ width: `${anW}%` }} />
        </div>
        <div className="battleBarLabels">
          {hasData ? (
            <>
              <span>{ipSig} iPhone signal</span>
              <span>{anSig} Android signal</span>
            </>
          ) : (
            <span style={{ margin: "0 auto" }}>Search to start the battle</span>
          )}
        </div>
      </div>

      <div className="battleSide battleSide--an">
        <div className="battleEmoji">🤖</div>
        <div className="battleName">Android</div>
        {anPosRate != null ? (
          <>
            <div className="battlePct">{anPosRate}%</div>
            <div className="battleSub">positive sentiment</div>
          </>
        ) : (
          <div className="battleSub">no data yet</div>
        )}
      </div>
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
  const [source, setSource] = useState("youtube");

  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadPhase, setLoadPhase] = useState("");
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const [tablePage, setTablePage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sentFilter, setSentFilter] = useState("all");

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

  async function load({ silent = false, dbOnly = false } = {}) {
    if (!silent) setErr("");
    setLoading(true);

    const qText = query.trim();
    const doIngest = Boolean(qText) && !dbOnly;

    try {
      if (doIngest) {
        if (source === "youtube") {
          setLoadPhase("Searching YouTube…");
          const ytData = await youtubeSearchSync({
            topic: topic || "demo",
            query: qText,
            max_videos: 5,
            comments_per_video: 200,
          });
          setRows(Array.isArray(ytData) ? ytData : []);
          setTablePage(1);
          setLastRefreshed(new Date());
          setApiStatus("online");
          setLastCheck(new Date());
          return;
        }

        if (source === "twitter") {
          setLoadPhase("Fetching and scoring from X / Twitter…");
          const twitterData = await twitterSearchSync({
            topic: topic || "demo",
            query: qText,
            max_results: 100,
          });
          setRows(Array.isArray(twitterData) ? twitterData : []);
          setTablePage(1);
          setLastRefreshed(new Date());
          setApiStatus("online");
          setLastCheck(new Date());
          return;
        }

        if (source === "both") {
          setLoadPhase("Searching YouTube + X / Twitter…");
          const [ytData, twitterData] = await Promise.all([
            youtubeSearchSync({
              topic: topic || "demo",
              query: qText,
              max_videos: 5,
              comments_per_video: 200,
            }),
            twitterSearchSync({
              topic: topic || "demo",
              query: qText,
              max_results: 100,
            }),
          ]);
          const combined = [
            ...(Array.isArray(ytData) ? ytData : []),
            ...(Array.isArray(twitterData) ? twitterData : []),
          ];
          setRows(combined);
          setTablePage(1);
          setLastRefreshed(new Date());
          setApiStatus("online");
          setLastCheck(new Date());
          return;
        }
      }

      setLoadPhase("Loading data…");

      // After a fresh ingest, don't stop on pre-existing rows — keep polling
      // until we see NEW data (rows scored after ingest started) or exhaust attempts.
      const ingestStart = doIngest ? Date.now() - 2000 : null;
      let data = [];

      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0) {
          setLoadPhase(`Waiting for scoring… (${attempt}/4)`);
          await sleep(800);
        }

        data = await fetchRecent({
          topic: topic || undefined,
          limit,
          q: qText || undefined,
          device: deviceFilter !== "any" ? deviceFilter : undefined,
          backfill: attempt === 0,
          min_margin: MIN_MARGIN,
        });

        if (!Array.isArray(data)) { data = []; break; }

        // If we did not ingest, any rows are fine
        if (!ingestStart) { if (data.length > 0) break; continue; }

        // If we did ingest, look for at least one row scored after ingest started
        const hasNew = data.some((r) => {
          const t = r?.scored_at ? new Date(r.scored_at).getTime() : 0;
          return t >= ingestStart;
        });
        if (hasNew) break;
      }

      setRows(data);
      setTablePage(1);
      setLastRefreshed(new Date());
      setApiStatus("online");
      setLastCheck(new Date());
    } catch (e) {
      if (!silent) setErr(e?.message || "Request failed");
      setApiStatus("offline");
      setLastCheck(new Date());
      setRows([]);
    } finally {
      setLoading(false);
      setLoadPhase("");
    }
  }

  useEffect(() => {
    checkHealth();
    Promise.all([
      fetchTopics({ limit: 200 }).then(setTopics).catch(() => setTopics(["demo", "iphone_vs_android"])),
      load({ silent: true }),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!rows.length) return;
    const timer = setTimeout(() => load({ silent: true }), 5 * 60 * 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

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

  // "both" posts mention iPhone AND Android — count them for each side
  const sumIphone = useMemo(() => summarizeSignal([...buckets.iphone, ...buckets.both]), [buckets.iphone, buckets.both]);
  const sumAndroid = useMemo(() => summarizeSignal([...buckets.android, ...buckets.both]), [buckets.android, buckets.both]);
  const overall = useMemo(() => summarizeMix(rows), [rows]);

  const coverage = useMemo(() => {
    const matched = buckets.iphone.length + buckets.android.length + buckets.both.length;
    return overall.total ? matched / overall.total : null;
  }, [buckets, overall.total]);

  const ipWilson = useMemo(() => wilsonInterval(sumIphone.pos, sumIphone.neg), [sumIphone.pos, sumIphone.neg]);
  const anWilson = useMemo(() => wilsonInterval(sumAndroid.pos, sumAndroid.neg), [sumAndroid.pos, sumAndroid.neg]);

  // Scale threshold with data — require at least 5, up to 25
  const MIN_EFFECTIVE_SIGNAL = Math.max(5, Math.min(25, Math.floor(rows.length * 0.05)));

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
    const allDates = rows
      .map((r) => toDateSafe(r?.created_at) ?? toDateSafe(r?.scored_at))
      .filter(Boolean);

    if (!allDates.length) return { granularity: "day", series: [] };

    const minMs = Math.min(...allDates.map((d) => d.getTime()));
    const maxMs = Math.max(...allDates.map((d) => d.getTime()));
    const spanDays = (maxMs - minMs) / (1000 * 60 * 60 * 24);

    const granularity = spanDays <= 3 ? "hour" : spanDays <= 60 ? "day" : "week";
    const MIN_BUCKET = 3;

    function weekStart(d) {
      const copy = new Date(d);
      copy.setDate(copy.getDate() - copy.getDay());
      return copy;
    }

    function bucketKey(d) {
      const fmt = (x) => String(x).padStart(2, "0");
      if (granularity === "hour") {
        return `${d.getFullYear()}-${fmt(d.getMonth() + 1)}-${fmt(d.getDate())} ${fmt(d.getHours())}`;
      }
      if (granularity === "week") {
        const ws = weekStart(d);
        return `${ws.getFullYear()}-${fmt(ws.getMonth() + 1)}-${fmt(ws.getDate())}`;
      }
      return `${d.getFullYear()}-${fmt(d.getMonth() + 1)}-${fmt(d.getDate())}`;
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
        const d = toDateSafe(r?.created_at) ?? toDateSafe(r?.scored_at);
        if (!d) continue;
        const k = bucketKey(d);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(r);
      }
      const keys = Array.from(map.keys()).sort();
      const points = keys
        .filter((k) => map.get(k).length >= MIN_BUCKET)
        .map((k) => ({ xKey: k, y: netSignalForRows(map.get(k)) }));
      return { name, tone, points };
    }

    return {
      granularity,
      series: [
        buildSeries("iPhone", [...buckets.iphone, ...buckets.both], "pos"),
        buildSeries("Android", [...buckets.android, ...buckets.both], "neg"),
      ],
    };
  }, [rows, buckets.iphone, buckets.android, buckets.both]);

  const iphoneTerms = useMemo(() => topTermsWithSentiment([...buckets.iphone, ...buckets.both], 10), [buckets.iphone, buckets.both]);
  const androidTerms = useMemo(() => topTermsWithSentiment([...buckets.android, ...buckets.both], 10), [buckets.android, buckets.both]);

  const refreshedAgo = useRelativeTime(lastRefreshed);
  const ipCountUp = useCountUp(sumIphone.total);
  const anCountUp = useCountUp(sumAndroid.total);

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

  const ipPosRate = sumIphone.signal > 0 ? sumIphone.pos / sumIphone.signal : null;
  const anPosRate = sumAndroid.signal > 0 ? sumAndroid.pos / sumAndroid.signal : null;

  function signalArrow(netSig) {
    if (netSig == null) return { cls: "sigArrow--flat", char: "→" };
    if (netSig > 0.08) return { cls: "sigArrow--up", char: "↑" };
    if (netSig < -0.08) return { cls: "sigArrow--down", char: "↓" };
    return { cls: "sigArrow--flat", char: "→" };
  }

  const ipArrow = signalArrow(sumIphone.netSignal);
  const anArrow = signalArrow(sumAndroid.netSignal);

  const filteredRows = useMemo(() => {
    if (sentFilter === "all") return rows;
    return rows.filter(r => stableLabelFromScores(getScores(r)) === sentFilter);
  }, [rows, sentFilter]);

  useEffect(() => { setTablePage(1); }, [rows, sentFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const safePage = Math.min(tablePage, pageCount);
  const pageRows = filteredRows.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <div className="page">
      {loading && <div className="loadBar" />}

      <header className="topbar">
        <div className="brand">
          <div className="logoIcon">📊</div>
          <div>
            <div className="title">SentimentIQ</div>
            <div className="subtitle">iPhone vs Android · YouTube · X · Azure AI</div>
          </div>
        </div>
        <div className="topbarRight">
          {rows.length > 0 && !loading && (
            <div className="liveBadge">
              <span className="livePulse" />
              Live
            </div>
          )}
          {refreshedAgo && (
            <span className="refreshChip">Updated {refreshedAgo}</span>
          )}
          <div className="statusChip">
            <span className="statusDot" data-status={apiStatus} />
            <span style={{ textTransform: "capitalize" }}>{apiStatus}</span>
          </div>
        </div>
      </header>

      <BattleBanner sumIphone={sumIphone} sumAndroid={sumAndroid} decision={decision} loading={loading} />

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

              <div className="field field--source">
                <label>Source</label>
                <div className="sourcePills">
                  <button
                    className={`sourcePill${source === "youtube" ? " sourcePill--active sourcePill--yt" : ""}`}
                    onClick={() => setSource("youtube")}
                    title="Pull from YouTube comments"
                  >
                    ▶ YouTube
                  </button>
                  <button
                    className={`sourcePill${source === "twitter" ? " sourcePill--active sourcePill--x" : ""}`}
                    onClick={() => setSource("twitter")}
                    title="Pull from X / Twitter"
                  >
                    𝕏 Twitter
                  </button>
                  <button
                    className={`sourcePill${source === "both" ? " sourcePill--active sourcePill--both" : ""}`}
                    onClick={() => setSource("both")}
                    title="Pull from both sources"
                  >
                    Both
                  </button>
                </div>
              </div>

              <div className="field field--btn">
                <label>&nbsp;</label>
                <div className="btnGroup">
                  {query.trim() ? (
                    <>
                      <button
                        className="btn btn--ghost"
                        onClick={() => load({ dbOnly: true })}
                        disabled={loading}
                        title="Read from your database — no API calls"
                      >
                        Load from DB
                      </button>
                      <button
                        className={`btn btn--primary${source === "twitter" ? " btn--twitter" : source === "both" ? "" : " btn--youtube"}`}
                        onClick={() => load()}
                        disabled={loading}
                        title={
                          source === "youtube" ? "Fetch from YouTube (uses quota)"
                          : source === "twitter" ? "Fetch from X / Twitter (uses credit)"
                          : "Fetch from YouTube + X (uses both quotas)"
                        }
                      >
                        {loading
                          ? (loadPhase || "Searching…")
                          : source === "youtube" ? "Search YouTube"
                          : source === "twitter" ? "Search X"
                          : "Search Both"}
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn btn--primary"
                      onClick={() => load()}
                      disabled={loading}
                    >
                      {loading ? (loadPhase || "Loading…") : "Refresh"}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="filtersRow filtersRow--meta">
              <div className="pill metaPill">
                <span style={{ fontWeight: 700 }}>Winner mode</span>
                <span className="dim" style={{ marginLeft: 8 }}>
                  Wilson confidence interval + signal fallback
                </span>
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

        <section className="card card--kpi area-kpi1 card--anim" style={{ animationDelay: "0ms" }}>
          <span className="kpiAccentBar kpiAccentBar--ip" />
          <div className="cardTitle">iPhone</div>
          <div className="kpiRow">
            {loading ? (
              <>
                <div><div className="skeleton skeleton--stat" /><div className="skeleton skeleton--sub" /></div>
                <div className="skeleton skeleton--meta" />
              </>
            ) : (
              <>
                <div>
                  <div className="statBig">{ipCountUp.toLocaleString()}</div>
                  <div className="statSub">posts · {sumIphone.signal} signal</div>
                  <div className="kpiRate">
                    <span className={`sigArrow ${ipArrow.cls}`}>{ipArrow.char}</span>
                    {ipPosRate != null && (
                      <span className={`posRate posRate--${ipPosRate > 0.5 ? "pos" : ipPosRate < 0.45 ? "neg" : "neu"}`}>
                        {Math.round(ipPosRate * 100)}% pos
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ fontSize: 20 }}>🍎</div>
              </>
            )}
          </div>
        </section>

        <section className="card card--kpi area-kpi2 card--anim" style={{ animationDelay: "60ms" }}>
          <span className="kpiAccentBar kpiAccentBar--an" />
          <div className="cardTitle">Android</div>
          <div className="kpiRow">
            {loading ? (
              <>
                <div><div className="skeleton skeleton--stat" /><div className="skeleton skeleton--sub" /></div>
                <div className="skeleton skeleton--meta" />
              </>
            ) : (
              <>
                <div>
                  <div className="statBig">{anCountUp.toLocaleString()}</div>
                  <div className="statSub">posts · {sumAndroid.signal} signal</div>
                  <div className="kpiRate">
                    <span className={`sigArrow ${anArrow.cls}`}>{anArrow.char}</span>
                    {anPosRate != null && (
                      <span className={`posRate posRate--${anPosRate > 0.5 ? "pos" : anPosRate < 0.45 ? "neg" : "neu"}`}>
                        {Math.round(anPosRate * 100)}% pos
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ fontSize: 20 }}>🤖</div>
              </>
            )}
          </div>
        </section>

        <section className="card card--kpi area-kpi3 card--anim" style={{ animationDelay: "120ms" }}>
          <span className="kpiAccentBar kpiAccentBar--win" />
          <div className="cardTitle">Who’s Winning</div>
          <div className="kpiRow">
            {loading ? (
              <>
                <div><div className="skeleton skeleton--stat" style={{ width: 110, height: 26 }} /><div className="skeleton skeleton--sub" /></div>
                <div className="skeleton skeleton--meta" />
              </>
            ) : (
              <>
                <div>
                  <div className="statBig statBig--winner" style={{
                    color: decision.label === "iPhone" ? "var(--ip-color)"
                         : decision.label === "Android" ? "var(--an-color)"
                         : "var(--text)"
                  }}>
                    {decision.label === "iPhone" ? "🍎 iPhone"
                   : decision.label === "Android" ? "🤖 Android"
                   : decision.label === "Even" ? "🤝 Even"
                   : decision.label}
                  </div>
                  <div className="statSub">{decision.detail}</div>
                  {decision.confidence != null && (
                    <div className="kpiRate">
                      <span className="posRate posRate--pos">{fmtPct(decision.confidence)} conf.</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </section>

        <section className="card card--kpi area-kpi4 card--anim" style={{ animationDelay: "180ms" }}>
          <span className="kpiAccentBar kpiAccentBar--cov" />
          <div className="cardTitle">Coverage</div>
          <div className="kpiRow">
            {loading ? (
              <>
                <div><div className="skeleton skeleton--stat" style={{ width: 70, height: 30 }} /><div className="skeleton skeleton--sub" /></div>
                <div className="skeleton skeleton--meta" />
              </>
            ) : (
              <>
                <div>
                  <div className="statBig" style={{ fontSize: 32 }}>
                    {coverage == null ? "—" : `${Math.round(coverage * 100)}%`}
                  </div>
                  <div className="statSub">mention iPhone or Android</div>
                  <div className="kpiRate">
                    <span className="posRate posRate--neu">{buckets.both.length} mention both</span>
                  </div>
                </div>
                <div className="kpiMeta">{overall.total.toLocaleString()} total</div>
              </>
            )}
          </div>
        </section>

        <section className="card card--hero area-hero">
          <div className="cardTitle">Insights</div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {loading && !overall.total ? (
              <div className="dim" style={{ fontStyle: "italic", fontSize: 14 }}>Fetching latest data…</div>
            ) : !overall.total ? (
              <div className="onboardHero">
                <div className="onboardBattle">
                  <div className="onboardBattleSide">
                    <div className="onboardBattleEmoji">🍎</div>
                    <div className="onboardBattleLabel onboardBattleLabel--ip">iPhone</div>
                  </div>
                  <div className="onboardVs">VS</div>
                  <div className="onboardBattleSide">
                    <div className="onboardBattleEmoji">🤖</div>
                    <div className="onboardBattleLabel onboardBattleLabel--an">Android</div>
                  </div>
                </div>
                <div className="onboardSteps">
                  <div className="onboardStep">
                    <div className="onboardStepNum">1</div>
                    <div className="onboardStepText"><strong>Enter a topic</strong> — try "iPhone 16 review" or "Samsung Galaxy S25"</div>
                  </div>
                  <div className="onboardStep">
                    <div className="onboardStepNum">2</div>
                    <div className="onboardStepText"><strong>We fetch YouTube comments or X / Twitter posts</strong> using the Azure backend and score them with Azure AI Language</div>
                  </div>
                  <div className="onboardStep">
                    <div className="onboardStepNum">3</div>
                    <div className="onboardStepText"><strong>See who wins</strong> — real positive/negative sentiment from real users, not reviews</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="heroHeadline">{heroText}</div>
            )}

            <TrendChart series={trend.series} granularity={trend.granularity} />

            <div className="compareGrid">
              <div className="compareCol">
                <div className="compareTitle">Top iPhone terms</div>
                <div className="termWrap">
                  {iphoneTerms.length ? (
                    iphoneTerms.map(([w, c, tone]) => (
                      <span key={`ip-${w}`} className={`termPill termPill--${tone}`} title={`${c} mentions · sentiment: ${tone}`}>
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
                    androidTerms.map(([w, c, tone]) => (
                      <span key={`an-${w}`} className={`termPill termPill--${tone}`} title={`${c} mentions · sentiment: ${tone}`}>
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
          <div className="cardTitle">Signal Mix</div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="signalBlock">
              <div className="signalBlockName signalBlockName--ip">🍎 iPhone</div>
              <div className="signalBars">
                <div className="signalBarRow">
                  <span className="signalBarLabel">Pos</span>
                  <div className="signalBarTrack"><div className="signalBarFill signalBarFill--pos" style={{ width: sumIphone.total ? `${sumIphone.pos / sumIphone.total * 100}%` : "0%" }} /></div>
                  <span className="signalBarCount">{sumIphone.pos}</span>
                </div>
                <div className="signalBarRow">
                  <span className="signalBarLabel">Neu</span>
                  <div className="signalBarTrack"><div className="signalBarFill signalBarFill--neu" style={{ width: sumIphone.total ? `${sumIphone.neu / sumIphone.total * 100}%` : "0%" }} /></div>
                  <span className="signalBarCount">{sumIphone.neu}</span>
                </div>
                <div className="signalBarRow">
                  <span className="signalBarLabel">Neg</span>
                  <div className="signalBarTrack"><div className="signalBarFill signalBarFill--neg" style={{ width: sumIphone.total ? `${sumIphone.neg / sumIphone.total * 100}%` : "0%" }} /></div>
                  <span className="signalBarCount">{sumIphone.neg}</span>
                </div>
              </div>
            </div>

            <div className="signalBlock">
              <div className="signalBlockName signalBlockName--an">🤖 Android</div>
              <div className="signalBars">
                <div className="signalBarRow">
                  <span className="signalBarLabel">Pos</span>
                  <div className="signalBarTrack"><div className="signalBarFill signalBarFill--pos" style={{ width: sumAndroid.total ? `${sumAndroid.pos / sumAndroid.total * 100}%` : "0%" }} /></div>
                  <span className="signalBarCount">{sumAndroid.pos}</span>
                </div>
                <div className="signalBarRow">
                  <span className="signalBarLabel">Neu</span>
                  <div className="signalBarTrack"><div className="signalBarFill signalBarFill--neu" style={{ width: sumAndroid.total ? `${sumAndroid.neu / sumAndroid.total * 100}%` : "0%" }} /></div>
                  <span className="signalBarCount">{sumAndroid.neu}</span>
                </div>
                <div className="signalBarRow">
                  <span className="signalBarLabel">Neg</span>
                  <div className="signalBarTrack"><div className="signalBarFill signalBarFill--neg" style={{ width: sumAndroid.total ? `${sumAndroid.neg / sumAndroid.total * 100}%` : "0%" }} /></div>
                  <span className="signalBarCount">{sumAndroid.neg}</span>
                </div>
              </div>
            </div>

            <div className="footerHint" style={{ marginTop: 4 }}>
              Signal = pos + neg after confidence gating. Neutrals don’t decide winners.
            </div>
          </div>
        </section>

        <section className="card area-ipie">
          <div className="cardTitle">iPhone · Sentiment breakdown</div>
          {loading ? (
            <div className="donutSkeletonWrap">
              <div className="skeleton" style={{ width: 160, height: 160, borderRadius: "50%" }} />
            </div>
          ) : (
            <DonutChart label="iPhone" pos={sumIphone.pos} neu={sumIphone.neu} neg={sumIphone.neg} />
          )}
        </section>

        <section className="card area-apie">
          <div className="cardTitle">Android · Sentiment breakdown</div>
          {loading ? (
            <div className="donutSkeletonWrap">
              <div className="skeleton" style={{ width: 160, height: 160, borderRadius: "50%" }} />
            </div>
          ) : (
            <DonutChart label="Android" pos={sumAndroid.pos} neu={sumAndroid.neu} neg={sumAndroid.neg} />
          )}
        </section>

        <section className="card area-table">
          <div className="tableHeader">
            <div className="cardTitle" style={{ marginBottom: 0 }}>Recent Scored Posts</div>
            <div className="tableToolbar">
              <div className="sentFilterPills">
                {[["all","All"],["positive","Positive"],["neutral","Neutral"],["negative","Negative"]].map(([v, label]) => (
                  <button
                    key={v}
                    className={`sentPill sentPill--${v}${sentFilter === v ? " sentPill--active" : ""}`}
                    onClick={() => setSentFilter(v)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <select
                className="pageSizeSelect"
                value={pageSize}
                onChange={e => { setPageSize(Number(e.target.value)); setTablePage(1); }}
              >
                <option value={10}>10 / page</option>
                <option value={25}>25 / page</option>
                <option value={50}>50 / page</option>
                <option value={100}>100 / page</option>
              </select>
            </div>
          </div>

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
                {pageRows.map((r, idx) => {
                  const s = getScores(r);
                  const stable = stableLabelFromScores(s);
                  const key = r?._id || `${r?.platform || "p"}-${r?.scored_at || "t"}-${idx}`;
                  return (
                    <tr key={key} className={`row--${stable}`}>
                      <td className="mono">{fmtTime(r.scored_at)}</td>
                      <td>
                        {r.platform === "twitter"
                          ? <span className="platformBadge platformBadge--x">𝕏</span>
                          : r.platform === "youtube"
                          ? <span className="platformBadge platformBadge--yt">▶</span>
                          : <span className="platformBadge">{r.platform || "—"}</span>}
                      </td>
                      <td>{r.topic || ""}</td>
                      <td className="dim">{labelForBucket(classifyDevice(r?.clean_text || ""))}</td>
                      <td><Badge label={stable} /></td>
                      <td className="scoreCell">
                        <span className="scoreVal scoreVal--pos">P:{fmt(s.positive)}</span>
                        <span className="scoreVal scoreVal--neu">N:{fmt(s.neutral)}</span>
                        <span className="scoreVal scoreVal--neg">-:{fmt(s.negative)}</span>
                      </td>
                      <td className="textCell" title={r.clean_text || ""}>{r.clean_text || ""}</td>
                    </tr>
                  );
                })}

                {!loading && filteredRows.length === 0 && rows.length > 0 && (
                  <tr>
                    <td colSpan="7">
                      <div className="emptyState">
                        <div className="emptyStateIcon">🔍</div>
                        <div className="emptyStateText">No {sentFilter} posts</div>
                        <div className="emptyStateSub">Try a different sentiment filter</div>
                      </div>
                    </td>
                  </tr>
                )}

                {!loading && rows.length === 0 && (
                  <tr>
                    <td colSpan="7">
                      <div className="emptyState">
                        <div className="emptyStateIcon">📊</div>
                        <div className="emptyStateText">No data yet</div>
                        <div className="emptyStateSub">Enter a search query and click Search YouTube, Search X, or Search Both</div>
                      </div>
                    </td>
                  </tr>
                )}

                {loading && (
                  <tr>
                    <td colSpan="7">
                      <div className="emptyState">
                        <div className="emptyStateText" style={{ color: "var(--muted)" }}>{loadPhase || "Loading…"}</div>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {filteredRows.length > 0 && (
            <div className="tablePager">
              <div className="tableInfo">
                {sentFilter !== "all" && (
                  <span className="tableFilterNote">{sentFilter} only · </span>
                )}
                Showing {((safePage - 1) * pageSize + 1).toLocaleString()}–{Math.min(safePage * pageSize, filteredRows.length).toLocaleString()} of {filteredRows.length.toLocaleString()}
                {sentFilter !== "all" && rows.length !== filteredRows.length && (
                  <span className="tableFilterNote"> ({rows.length.toLocaleString()} total)</span>
                )}
              </div>
              <div className="pagerControls">
                <button className="pagerBtn" onClick={() => setTablePage(1)} disabled={safePage === 1} title="First">«</button>
                <button className="pagerBtn" onClick={() => setTablePage(p => p - 1)} disabled={safePage === 1} title="Previous">‹</button>
                {getPageNums(safePage, pageCount).map((n, i) =>
                  n === "..." ? (
                    <span key={`dots-${i}`} className="pagerDots">…</span>
                  ) : (
                    <button
                      key={n}
                      className={`pagerBtn${n === safePage ? " pagerBtn--active" : ""}`}
                      onClick={() => setTablePage(n)}
                    >
                      {n}
                    </button>
                  )
                )}
                <button className="pagerBtn" onClick={() => setTablePage(p => p + 1)} disabled={safePage === pageCount} title="Next">›</button>
                <button className="pagerBtn" onClick={() => setTablePage(pageCount)} disabled={safePage === pageCount} title="Last">»</button>
              </div>
            </div>
          )}

          <div className="footerHint">{overall.total.toLocaleString()} total rows loaded · {pageCount} page{pageCount !== 1 ? "s" : ""}</div>
        </section>
      </main>
    </div>
  );
}