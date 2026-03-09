# backend/__init__.py (Azure Functions)
import os
import json
import re
import uuid
import datetime as dt
import logging
from typing import Any, Dict, List, Optional, Tuple

import azure.functions as func
import pyodbc
import requests
from requests.adapters import HTTPAdapter, Retry

from azure.ai.textanalytics import TextAnalyticsClient
from azure.core.exceptions import HttpResponseError
from azure.identity import DefaultAzureCredential

app = func.FunctionApp()

# ----------------------------
# Logging
# ----------------------------
logging.getLogger("azure.core.pipeline.policies.http_logging_policy").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# ----------------------------
# Defaults / Config
# ----------------------------
DEFAULT_TOPIC = "iphone_vs_android"
DEFAULT_YT_QUERY = "iphone vs android"
DEFAULT_TWITTER_QUERY = "iphone OR android OR samsung"

YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
YOUTUBE_COMMENTS_URL = "https://www.googleapis.com/youtube/v3/commentThreads"

TWITTER_MAX_RESULTS = 100   # X API v2 max per single request (Basic tier)

MAX_TA_CHARS = 4500

# Margin used ONLY for pos vs neg decisioning (neutral does NOT auto-win)
SENTIMENT_MIN_MARGIN = float(os.getenv("SENTIMENT_MIN_MARGIN", "0.05"))

# Dev backfill: rescore rows that have missing/empty scores.
BACKFILL_ENABLE = (os.getenv("BACKFILL_ENABLE", "1").strip().lower() in ("1", "true", "yes", "on"))
BACKFILL_MAX_PER_REQUEST = int(os.getenv("BACKFILL_MAX_PER_REQUEST", "75"))  # you set 500, but cap safely here

# Queue task caps (per ingest request)
QUEUE_TASK_MAX_VIDEOS = int(os.getenv("QUEUE_TASK_MAX_VIDEOS", "10"))

# ----------------------------
# Helpers
# ----------------------------
def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)

def utc_now_iso() -> str:
    return utc_now().isoformat()

def parse_iso_datetime(value: Optional[str]) -> Optional[dt.datetime]:
    if not value:
        return None
    v = str(value).strip()
    if not v:
        return None
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    try:
        d = dt.datetime.fromisoformat(v)
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return d.astimezone(dt.timezone.utc)
    except Exception:
        return None

def get_required_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing app setting: {name}")
    return v

def json_response(payload: Any, status_code: int = 200) -> func.HttpResponse:
    return func.HttpResponse(
        body=json.dumps(payload, ensure_ascii=False),
        status_code=status_code,
        mimetype="application/json",
    )

def safe_int(value: Any, default: int, min_v: int, max_v: int) -> int:
    try:
        n = int(value)
    except Exception:
        n = default
    return max(min_v, min(n, max_v))

def safe_float(value: Any, default: float, min_v: float, max_v: float) -> float:
    try:
        x = float(value)
        if not (x == x):  # NaN
            return default
        return max(min_v, min(x, max_v))
    except Exception:
        return default

def try_float(value: Any) -> Optional[float]:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        try:
            return float(s)
        except Exception:
            return None
    return None

# ----------------------------
# Text cleaning
# ----------------------------
_TIMESTAMP_RE = re.compile(r"\b\d{1,2}:\d{2}(:\d{2})?\b")
_URL_RE = re.compile(r"http\S+")
_MENTION_RE = re.compile(r"@\w+")
_MULTI_PUNCT_RE = re.compile(r"([!?\.]){2,}")
_EMOJI_RE = re.compile(r"[\U00010000-\U0010ffff]")
_RT_PREFIX_RE = re.compile(r"^RT\s+", re.IGNORECASE)

def clean_text(text: str) -> str:
    t = (text or "").strip()
    if not t:
        return ""
    t = _RT_PREFIX_RE.sub("", t)
    t = _URL_RE.sub("", t)
    t = _MENTION_RE.sub("", t)
    t = _TIMESTAMP_RE.sub("", t)
    t = t.replace("#", "")
    t = _EMOJI_RE.sub(" ", t)
    t = _MULTI_PUNCT_RE.sub(r"\1", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t

def is_likely_non_english(text: str) -> bool:
    """Returns True if more than 35% of characters are non-ASCII — used to skip
    tweets that slipped through the lang:en API filter."""
    t = (text or "").strip()
    if not t:
        return True
    non_ascii = sum(1 for c in t if ord(c) > 127)
    return (non_ascii / len(t)) > 0.35

def safe_for_text_analytics(text: str) -> str:
    t = (text or "").strip()
    if not t:
        return ""
    if len(t) > MAX_TA_CHARS:
        t = t[:MAX_TA_CHARS]
    return t

def looks_like_garbage(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    if len(t) < 3:
        return True
    if not any(ch.isalnum() for ch in t):
        return True
    return False

def normalize_topic(value: Optional[str]) -> str:
    v = (value or "").strip()
    if not v:
        return (os.getenv("TOPIC_DEFAULT", DEFAULT_TOPIC).strip() or DEFAULT_TOPIC)
    v = re.sub(r"\s+", "_", v)
    return v

# ----------------------------
# Requests session (retry)
# ----------------------------
_session: Optional[requests.Session] = None

def get_session() -> requests.Session:
    global _session
    if _session is not None:
        return _session

    s = requests.Session()
    retries = Retry(
        total=3,
        connect=3,
        read=3,
        backoff_factor=0.5,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET", "POST"),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retries)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    _session = s
    return _session

# ----------------------------
# SQL helpers (Azure SQL)
# ----------------------------
_sql_schema_ready = False

def get_sql_conn() -> pyodbc.Connection:
    conn_str = get_required_env("SQLCON")
    return pyodbc.connect(conn_str)

def ensure_schema() -> None:
    global _sql_schema_ready
    if _sql_schema_ready:
        return

    ddl = """
    IF OBJECT_ID('dbo.posts_scored', 'U') IS NULL
    BEGIN
        CREATE TABLE dbo.posts_scored (
            id NVARCHAR(128) NOT NULL PRIMARY KEY,
            platform NVARCHAR(64) NULL,
            topic NVARCHAR(128) NULL,
            text_raw NVARCHAR(MAX) NULL,
            clean_text NVARCHAR(MAX) NULL,
            created_at DATETIMEOFFSET NULL,
            ingested_at DATETIMEOFFSET NULL,
            scored_at DATETIMEOFFSET NULL,
            sentiment_label NVARCHAR(32) NULL,
            sentiment_scores NVARCHAR(MAX) NULL
        );
    END;

    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_posts_scored_scored_at' AND object_id = OBJECT_ID('dbo.posts_scored'))
    BEGIN
        CREATE INDEX IX_posts_scored_scored_at ON dbo.posts_scored(scored_at DESC);
    END;

    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_posts_scored_topic_scored_at' AND object_id = OBJECT_ID('dbo.posts_scored'))
    BEGIN
        CREATE INDEX IX_posts_scored_topic_scored_at ON dbo.posts_scored(topic, scored_at DESC);
    END;
    """
    with get_sql_conn() as conn:
        cur = conn.cursor()
        cur.execute(ddl)
        conn.commit()

    _sql_schema_ready = True

def upsert_post_scored(
    *,
    post_id: str,
    platform: Optional[str],
    topic: Optional[str],
    text_raw: str,
    clean: str,
    created_at: Optional[dt.datetime],
    ingested_at: Optional[dt.datetime],
    scored_at: dt.datetime,
    sentiment_label: str,
    sentiment_scores_json: str,
) -> None:
    ensure_schema()
    sentiment_label = (sentiment_label or "").strip() or "neutral"

    sql = """
    MERGE dbo.posts_scored AS t
    USING (SELECT ? AS id) AS s
    ON (t.id = s.id)
    WHEN MATCHED THEN UPDATE SET
        platform = ?, topic = ?, text_raw = ?, clean_text = ?,
        created_at = ?, ingested_at = ?, scored_at = ?,
        sentiment_label = ?, sentiment_scores = ?
    WHEN NOT MATCHED THEN INSERT (
        id, platform, topic, text_raw, clean_text,
        created_at, ingested_at, scored_at,
        sentiment_label, sentiment_scores
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    """

    params = (
        post_id,
        platform, topic, text_raw, clean,
        created_at, ingested_at, scored_at,
        sentiment_label, sentiment_scores_json,
        post_id, platform, topic, text_raw, clean,
        created_at, ingested_at, scored_at,
        sentiment_label, sentiment_scores_json,
    )

    with get_sql_conn() as conn:
        cur = conn.cursor()
        cur.execute(sql, params)
        conn.commit()

def update_sentiment_only(
    *,
    post_id: str,
    scored_at: dt.datetime,
    sentiment_label: str,
    sentiment_scores_json: str,
) -> None:
    ensure_schema()
    sql = """
    UPDATE dbo.posts_scored
    SET scored_at = ?, sentiment_label = ?, sentiment_scores = ?
    WHERE id = ?;
    """
    with get_sql_conn() as conn:
        cur = conn.cursor()
        cur.execute(sql, (scored_at, sentiment_label, sentiment_scores_json, post_id))
        conn.commit()

def fetch_topics(limit: int = 200) -> List[str]:
    ensure_schema()
    limit = safe_int(limit, 200, 1, 500)

    sql = f"""
    SELECT TOP ({limit}) topic
    FROM dbo.posts_scored
    WHERE topic IS NOT NULL AND LTRIM(RTRIM(topic)) <> ''
    GROUP BY topic
    ORDER BY MAX(scored_at) DESC;
    """

    out: List[str] = []
    with get_sql_conn() as conn:
        cur = conn.cursor()
        cur.execute(sql)
        rows = cur.fetchall()

    for r in rows:
        if r and r[0]:
            out.append(str(r[0]))
    return out

# ----------------------------
# Azure AI Language (Text Analytics) - Managed Identity
# ----------------------------
_text_client: Optional[TextAnalyticsClient] = None

def get_text_analytics_client() -> TextAnalyticsClient:
    global _text_client
    if _text_client is not None:
        return _text_client

    endpoint = get_required_env("AI_LANGUAGE_ENDPOINT").rstrip("/")
    credential = DefaultAzureCredential()
    _text_client = TextAnalyticsClient(endpoint=endpoint, credential=credential)
    return _text_client

def _normalize_label(label: Optional[str]) -> str:
    l = (label or "").strip().lower()
    if l in ("positive", "negative", "neutral"):
        return l
    return "neutral"

def _coerce_scores(scores: Any) -> Dict[str, float]:
    if not isinstance(scores, dict):
        scores = {}

    p = safe_float(try_float(scores.get("positive")), 0.0, 0.0, 1.0)
    neu = safe_float(try_float(scores.get("neutral")), 0.0, 0.0, 1.0)
    neg = safe_float(try_float(scores.get("negative")), 0.0, 0.0, 1.0)

    if p == 0.0 and neu == 0.0 and neg == 0.0:
        return {"positive": 0.0, "neutral": 1.0, "negative": 0.0}

    s = p + neu + neg
    if s <= 0.0:
        return {"positive": 0.0, "neutral": 1.0, "negative": 0.0}

    return {"positive": p / s, "neutral": neu / s, "negative": neg / s}

def _is_scores_empty(scores: Any) -> bool:
    if not isinstance(scores, dict) or not scores:
        return True
    if not any(k in scores for k in ("positive", "neutral", "negative")):
        return True
    usable = False
    for k in ("positive", "neutral", "negative"):
        if try_float(scores.get(k)) is not None:
            usable = True
            break
    return not usable

def inject_default_scores_from_label(label: str) -> Dict[str, float]:
    if label == "positive":
        return {"positive": 0.70, "neutral": 0.30, "negative": 0.0}
    if label == "negative":
        return {"positive": 0.0, "neutral": 0.30, "negative": 0.70}
    return {"positive": 0.15, "neutral": 0.70, "negative": 0.15}

def sentiment_from_scores(scores: Dict[str, float], min_margin: float) -> str:
    p = float(scores.get("positive") or 0.0)
    neg = float(scores.get("negative") or 0.0)
    if abs(p - neg) < min_margin:
        return "neutral"
    return "positive" if p > neg else "negative"

def ai_language_sentiment_one(text: str, *, min_margin: float) -> Tuple[str, Dict[str, float]]:
    """
    Azure AI Language sentiment. We DO NOT force language.
    """
    t = safe_for_text_analytics(text)
    if not t or looks_like_garbage(t):
        return "neutral", {"positive": 0.0, "neutral": 1.0, "negative": 0.0}

    client = get_text_analytics_client()
    try:
        results = client.analyze_sentiment(documents=[t])
    except HttpResponseError as e:
        logger.error("TextAnalytics error: %s", e)
        return "neutral", {"positive": 0.0, "neutral": 1.0, "negative": 0.0}
    except Exception as e:
        logger.error("TextAnalytics unexpected error: %s", e)
        return "neutral", {"positive": 0.0, "neutral": 1.0, "negative": 0.0}

    res = list(results)[0]
    if getattr(res, "is_error", False):
        return "neutral", {"positive": 0.0, "neutral": 1.0, "negative": 0.0}

    scores = {
        "positive": float(res.confidence_scores.positive),
        "neutral": float(res.confidence_scores.neutral),
        "negative": float(res.confidence_scores.negative),
    }
    scores = _coerce_scores(scores)
    label = sentiment_from_scores(scores, min_margin=min_margin)
    return label, scores

# ----------------------------
# Fallback sentiment (lexicon) + Hybrid policy (fix "all neutral" issue)
# ----------------------------
_POS_WORDS = {
    # Core positive
    "love","loved","like","liked","enjoy","enjoyed","enjoys",
    "great","good","amazing","awesome","excellent","best","better","brilliant",
    "perfect","nice","solid","fantastic","wonderful","superb","outstanding",
    "impressive","incredible","unbelievable","insane","phenomenal","exceptional",
    # Feel / experience
    "happy","satisfied","pleased","glad","thrilled","excited","stoked",
    "favorite","favourite","clean","elegant","beautiful","gorgeous","stunning",
    # Performance
    "smooth","fast","quick","snappy","speedy","fluid","responsive","reliable",
    "stable","powerful","efficient","seamless","flawless","crisp",
    # Value
    "worth","worthwhile","affordable","value","deal","recommend","recommended",
    # Improvement
    "improved","improvement","upgraded","upgrade","fixed","works","working",
    # Winning
    "wins","winning","winner","leads","ahead","dominates","superior","top",
    # Modern slang
    "fire","goated","banger","peak","clutch","based","slaps","bussin","lowkey",
    # Tech-specific positives
    "innovative","intuitive","premium","polished","refined","versatile","ecosystem",
    # Camera / display quality
    "sharp","vibrant","vivid","clear","detailed","accurate","natural","bright",
    "colorful","colourful","lifelike","realistic","balanced","rich","punchy",
    "dynamic","lush","brilliant",
    # Battery / endurance
    "lasts","lasting","endurance","longevity","durable","long-lasting","allday",
    "allnight","reliable","charges","charged","charges fast","fast charge",
    # Build / feel
    "premium","sturdy","solid","satisfying","comfortable","lightweight","sleek",
    "buttery","buttery smooth",
}
_NEG_WORDS = {
    # Core negative
    "hate","hated","hates","dislike","disliked","despise","loathe",
    "bad","terrible","awful","worst","worse","horrible","dreadful","atrocious","abysmal",
    "pathetic","disgusting","appalling",
    # Quality
    "trash","garbage","junk","rubbish","crap","worthless","useless","pointless",
    "cheap","flimsy","fragile","plastic","toyish",
    # Problems
    "bug","bugs","buggy","glitch","glitchy","broken","break","breaking","fails",
    "failed","failure","error","errors","corrupt","corrupted",
    # Performance
    "slow","lag","laggy","sluggish","choppy","stutters","stuttering","freezes",
    "frozen","clunky","heavy","bloat","bloatware",
    # Heat / hardware
    "overheat","overheating","overheated","hot","burning","throttle","throttling",
    # Crashes
    "crash","crashes","crashing","crashed","restart","reboots","bricked","dead",
    # Issues
    "problem","problems","issue","issues","flaw","flaws","defect","defects",
    # Annoyance
    "sucks","suck","annoying","frustrating","frustration","infuriating","painful",
    "ridiculous","absurd","stupid","idiotic","embarrassing",
    # Unusable
    "unusable","unacceptable","unreliable","unstable","inconsistent",
    # Value
    "expensive","overpriced","ripoff","rip-off","scam","waste","regret","regrets",
    # Disappointment
    "disappointed","disappointing","underwhelming","mediocre","forgettable","meh",
    # Modern slang
    "mid","trash","nah","nahhh","bruh","smh","yikes",
    # Tech-specific
    "outdated","obsolete","limited","locked","restricted","proprietary",
    # Camera / display negatives
    "blurry","blurred","grainy","muddy","washed","washed-out","overexposed",
    "underexposed","noisy","noise","artifacting","oversharpened","distorted",
    "pixelated","dull","dim","lifeless","inaccurate","oversaturated","ugly",
    # Battery / charging negatives
    "drains","draining","drained","dies","dying","depletes","dwindles",
    "short","shortlived","unreliable","inconsistent","weak",
    # Overrated / hype
    "overrated","overhyped","gimmick","gimmicky","pointless","unnecessary",
}
_NEGATORS = {
    "not","no","never","dont","don't","didnt","didn't","isnt","isn't","wasnt","wasn't",
    "cant","can't","won't","wont","hardly","barely","scarcely","neither","nor",
    "nobody","nothing","nowhere","noone","without","lack","lacks","lacking",
}
_INTENSIFIERS = {
    "very","really","so","extremely","absolutely","incredibly","totally","completely",
    "super","ultra","genuinely","truly","seriously","literally","way","much","far",
}
_NEUTRAL_ANCHORS = {
    # Mild / ambiguous words that signal no strong opinion
    "fine","okay","ok","decent","alright","acceptable","passable","adequate","fair",
    "average","ordinary","normal","standard","moderate","reasonable","neutral",
    "depends","depending","subjective","mixed","both","either","whatever","maybe",
    "perhaps","guess","suppose","think","feel","opinion","preference","prefer",
}

def _tokenize_basic(text: str) -> List[str]:
    t = (text or "").lower()
    return [w for w in re.split(r"[^a-z0-9']+", t) if w]

def lexicon_sentiment_one(text: str, *, min_margin: float) -> Tuple[str, Dict[str, float]]:
    tokens = _tokenize_basic(text)
    if not tokens:
        return "neutral", {"positive": 0.0, "neutral": 1.0, "negative": 0.0}

    pos = 0.0
    neg = 0.0
    anchor_count = 0
    for i, w in enumerate(tokens):
        prev = tokens[i - 1] if i > 0 else ""
        prev2 = tokens[i - 2] if i > 1 else ""
        negated = (prev in _NEGATORS) or (prev2 in _NEGATORS)
        intensified = (prev in _INTENSIFIERS) or (prev2 in _INTENSIFIERS and prev not in _NEGATORS)
        weight = 1.5 if intensified else 1.0

        if w in _POS_WORDS:
            if negated:
                neg += weight
            else:
                pos += weight
        elif w in _NEG_WORDS:
            if negated:
                pos += weight
            else:
                neg += weight
        elif w in _NEUTRAL_ANCHORS:
            anchor_count += 1

    total = pos + neg
    if total == 0:
        # If neutral anchor words are present with no directional signal,
        # return a confident neutral rather than a drawable 0.15/0.15 split.
        if anchor_count >= 1:
            scores = {"positive": 0.05, "neutral": 0.90, "negative": 0.05}
        else:
            scores = {"positive": 0.15, "neutral": 0.70, "negative": 0.15}
        scores = _coerce_scores(scores)
        return sentiment_from_scores(scores, min_margin=min_margin), scores

    strength = min(1.0, total / 6.0)      # 0..1
    neutral = 1.0 - (0.75 * strength)     # 1..0.25
    # Neutral anchors dampen the directional strength slightly
    if anchor_count >= 2:
        neutral = min(1.0, neutral + 0.10)
    remaining = 1.0 - neutral
    p = remaining * (pos / total)
    n = remaining * (neg / total)

    scores = _coerce_scores({"positive": p, "neutral": neutral, "negative": n})
    label = sentiment_from_scores(scores, min_margin=min_margin)
    return label, scores

def _azure_is_dead_neutral(scores: Dict[str, float]) -> bool:
    p = float(scores.get("positive") or 0.0)
    neu = float(scores.get("neutral") or 0.0)
    n = float(scores.get("negative") or 0.0)
    return (neu >= 0.92) and (p <= 0.04) and (n <= 0.04)

def _azure_is_tied(scores: Dict[str, float]) -> bool:
    """Azure returned pos ≈ neg (exact or near-tie from 0.25-step rounding)."""
    p = float(scores.get("positive") or 0.0)
    n = float(scores.get("negative") or 0.0)
    return abs(p - n) < 0.02

def _lexicon_is_decisive(s2: Dict[str, float], threshold: float = 0.06) -> bool:
    """Lexicon result has a clear directional signal worth trusting."""
    p2 = float(s2.get("positive", 0.0))
    n2 = float(s2.get("negative", 0.0))
    return abs(p2 - n2) >= threshold

def hybrid_sentiment_one(text: str, *, min_margin: float) -> Tuple[str, Dict[str, float]]:
    """
    Try Azure; fall back to lexicon when Azure gives a dead-neutral or tied result.
    Dead-neutral: neu >= 0.92 (Azure literally has no opinion).
    Tied: abs(pos - neg) < 0.02, i.e. Azure's 0.25-step scoring produced an exact
    tie such as {pos:0.25, neu:0.50, neg:0.25} — lexicon breaks the tie.
    Neutral-anchor override: if lexicon detects only neutral-anchor words (neu >= 0.85)
    and Azure's directional lead is weak (< 0.40), defer to lexicon's neutral call.
    """
    label, scores = ai_language_sentiment_one(text, min_margin=min_margin)

    if _azure_is_dead_neutral(scores) or (label == "neutral" and _azure_is_tied(scores)):
        l2, s2 = lexicon_sentiment_one(text, min_margin=min_margin)
        if l2 != "neutral" and _lexicon_is_decisive(s2):
            return l2, s2

    if label != "neutral":
        az_lead = max(float(scores.get("positive", 0.0)), float(scores.get("negative", 0.0)))
        if az_lead < 0.40:
            l2, s2 = lexicon_sentiment_one(text, min_margin=min_margin)
            if l2 == "neutral" and float(s2.get("neutral", 0.0)) >= 0.85:
                return l2, s2

    return label, scores

def ai_language_sentiment_batch(
    texts: List[str], *, min_margin: float
) -> List[Tuple[str, Dict[str, float]]]:
    """
    Score a list of pre-cleaned texts using Azure AI Language with batches of up to 10
    (the API limit per call). Applies the same hybrid policy as hybrid_sentiment_one:
    lexicon fallback for dead-neutral/tied Azure results, and neutral-anchor override
    for weak Azure signals.
    Returns a list of (label, scores) in the same order as the input.
    """
    BATCH_SIZE = 10
    _neutral_default = ("neutral", {"positive": 0.0, "neutral": 1.0, "negative": 0.0})

    azure_out: List[Tuple[str, Dict[str, float]]] = []
    client = get_text_analytics_client()

    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i: i + BATCH_SIZE]
        try:
            responses = list(client.analyze_sentiment(documents=batch))
            for res in responses:
                if getattr(res, "is_error", False):
                    azure_out.append(_neutral_default)
                    continue
                s = _coerce_scores({
                    "positive": float(res.confidence_scores.positive),
                    "neutral":  float(res.confidence_scores.neutral),
                    "negative": float(res.confidence_scores.negative),
                })
                azure_out.append((sentiment_from_scores(s, min_margin=min_margin), s))
        except Exception as e:
            logger.error("ai_language_sentiment_batch error batch_start=%d: %s", i, e)
            azure_out.extend([_neutral_default] * len(batch))

    final: List[Tuple[str, Dict[str, float]]] = []
    for idx, (label, scores) in enumerate(azure_out):
        text = texts[idx]
        if _azure_is_dead_neutral(scores) or (label == "neutral" and _azure_is_tied(scores)):
            l2, s2 = lexicon_sentiment_one(text, min_margin=min_margin)
            if l2 != "neutral" and _lexicon_is_decisive(s2):
                final.append((l2, s2))
                continue
        if label != "neutral":
            az_lead = max(float(scores.get("positive", 0.0)), float(scores.get("negative", 0.0)))
            if az_lead < 0.40:
                l2, s2 = lexicon_sentiment_one(text, min_margin=min_margin)
                if l2 == "neutral" and float(s2.get("neutral", 0.0)) >= 0.85:
                    final.append((l2, s2))
                    continue
        final.append((label, scores))

    return final


def hybrid_label_from_stored(text: str, scores: Dict[str, float], *, min_margin: float) -> str:
    """
    Re-derive the label for a row that already has stored Azure scores.
    If the stored scores are tied, try the lexicon as a tiebreaker
    (avoids an extra Azure API call while still improving the label).
    """
    label = sentiment_from_scores(scores, min_margin=min_margin)
    if label == "neutral" and _azure_is_tied(scores) and text:
        l2, s2 = lexicon_sentiment_one(text, min_margin=min_margin)
        if l2 != "neutral" and _lexicon_is_decisive(s2):
            return l2
    return label

# ----------------------------
# fetch_recent with hard normalization + DEV BACKFILL
# ----------------------------
def fetch_recent(
    limit: int,
    topic: Optional[str],
    q: Optional[str] = None,
    device: Optional[str] = None,
    *,
    backfill_missing: bool = False,
    min_margin_override: Optional[float] = None,
) -> List[Dict[str, Any]]:
    ensure_schema()
    limit = safe_int(limit, 200, 1, 5000)

    min_margin = SENTIMENT_MIN_MARGIN
    if min_margin_override is not None:
        min_margin = safe_float(min_margin_override, SENTIMENT_MIN_MARGIN, 0.0, 0.5)

    wheres: List[str] = []
    params: List[Any] = []

    if topic:
        wheres.append("topic = ?")
        params.append(topic)

    if q:
        wheres.append("clean_text LIKE ?")
        params.append(f"%{q}%")

    if device:
        d = (device or "").strip().lower()

        apple_like = "(" \
            "clean_text LIKE '%iphone%' OR clean_text LIKE '%ios%' OR clean_text LIKE '%imessage%' OR " \
            "clean_text LIKE '%facetime%' OR clean_text LIKE '%airdrop%' OR clean_text LIKE '%airpods%' OR " \
            "clean_text LIKE '%ipad%' OR clean_text LIKE '%apple%')"

        android_like = "(" \
            "clean_text LIKE '%android%' OR clean_text LIKE '%pixel%' OR clean_text LIKE '%galaxy%' OR " \
            "clean_text LIKE '%samsung%' OR clean_text LIKE '%oneplus%' OR clean_text LIKE '%motorola%' OR " \
            "clean_text LIKE '%xiaomi%' OR clean_text LIKE '%play store%' OR clean_text LIKE '%google pay%' OR " \
            "clean_text LIKE '%wear os%')"

        if d == "iphone":
            wheres.append(f"{apple_like} AND NOT {android_like}")
        elif d == "android":
            wheres.append(f"{android_like} AND NOT {apple_like}")
        elif d == "both":
            wheres.append(f"{apple_like} AND {android_like}")

    sql_where = f"WHERE {' AND '.join(wheres)}" if wheres else ""

    sql = f"""
    SELECT TOP ({limit})
        id, platform, topic, clean_text,
        sentiment_label, sentiment_scores,
        CONVERT(varchar(33), scored_at, 127) AS scored_at,
        CONVERT(varchar(33), created_at, 127) AS created_at
    FROM dbo.posts_scored
    {sql_where}
    ORDER BY scored_at DESC;
    """

    out: List[Dict[str, Any]] = []
    to_backfill: List[Tuple[str, str]] = []

    with get_sql_conn() as conn:
        cur = conn.cursor()
        cur.execute(sql, params)
        rows = cur.fetchall()

    for r in rows:
        post_id = r[0]
        platform = r[1]
        topic_v = r[2]
        text = r[3] or ""
        label_raw = r[4]
        scores_raw = r[5]
        scored_at = r[6] if r[6] else None
        created_at_val = r[7] if r[7] else None

        label = _normalize_label(label_raw)

        try:
            parsed = json.loads(scores_raw or "{}")
        except Exception:
            parsed = {}

        missing = _is_scores_empty(parsed)
        if missing:
            scores = inject_default_scores_from_label(label)
            if backfill_missing and text:
                to_backfill.append((post_id, text))
        else:
            scores = _coerce_scores(parsed)

        if missing:
            stable_label = sentiment_from_scores(scores, min_margin=min_margin)
        else:
            stable_label = hybrid_label_from_stored(text, scores, min_margin=min_margin)

        out.append({
            "_id": post_id,
            "platform": platform,
            "topic": topic_v,
            "clean_text": text,
            "sentiment": {"azure_ai": {"label": stable_label, "scores": scores}},
            "scored_at": scored_at,
            "created_at": created_at_val,
        })

    # Backfill rows missing scores (or broken JSON) so your UI starts getting pos/neg immediately.
    if backfill_missing and BACKFILL_ENABLE and to_backfill:
        batch_cap = max(1, min(BACKFILL_MAX_PER_REQUEST, len(to_backfill)))
        batch = to_backfill[:batch_cap]

        now = utc_now()
        updated = 0

        for post_id, text in batch:
            try:
                new_label, new_scores = hybrid_sentiment_one(text, min_margin=min_margin)
                update_sentiment_only(
                    post_id=post_id,
                    scored_at=now,
                    sentiment_label=new_label,
                    sentiment_scores_json=json.dumps(new_scores, ensure_ascii=False),
                )
                updated += 1
            except Exception as e:
                logger.warning("Backfill failed id=%s err=%s", post_id, e)

        if updated:
            logger.info("Backfilled %d legacy rows (min_margin=%.3f)", updated, min_margin)

    return out

# ----------------------------
# YouTube helpers
# ----------------------------
def _youtube_get(url: str, params: Dict[str, Any], timeout: int) -> Dict[str, Any]:
    s = get_session()
    r = s.get(url, params=params, timeout=timeout)
    if not r.ok:
        raise RuntimeError(f"YouTube API error {r.status_code}: {r.text}")
    return r.json()

def youtube_search_video_ids(query: str, max_results: int = 5) -> List[str]:
    api_key = get_required_env("YOUTUBE_API_KEY")
    max_results = safe_int(max_results, 5, 1, 25)

    params = {
        "part": "snippet",
        "q": query,
        "type": "video",
        "maxResults": max_results,
        "safeSearch": "none",
        "key": api_key,
    }
    data = _youtube_get(YOUTUBE_SEARCH_URL, params=params, timeout=15)

    ids: List[str] = []
    for item in (data.get("items") or []):
        vid = (item.get("id") or {}).get("videoId")
        if vid:
            ids.append(vid)
    return ids

def youtube_fetch_comments(video_id: str, max_results: int = 500) -> List[Dict[str, Any]]:
    api_key = get_required_env("YOUTUBE_API_KEY")
    max_results = safe_int(max_results, 500, 1, 2000)

    out: List[Dict[str, Any]] = []
    page_token: Optional[str] = None

    while len(out) < max_results:
        remaining = max_results - len(out)
        page_size = min(100, remaining)

        params = {
            "part": "snippet",
            "videoId": video_id,
            "maxResults": page_size,
            "order": "time",
            "textFormat": "plainText",
            "key": api_key,
        }
        if page_token:
            params["pageToken"] = page_token

        data = _youtube_get(YOUTUBE_COMMENTS_URL, params=params, timeout=20)

        for item in (data.get("items") or []):
            top = (((item.get("snippet") or {}).get("topLevelComment") or {}).get("snippet") or {})
            text = (top.get("textDisplay") or "").strip()
            if not text:
                continue

            published_at = top.get("publishedAt")
            author = top.get("authorDisplayName")

            comment_id = ((item.get("snippet") or {}).get("topLevelComment") or {}).get("id")
            if not comment_id:
                comment_id = f"yt:{video_id}:{uuid.uuid4().hex}"

            out.append({
                "_id": f"youtube:comment:{comment_id}",
                "platform": "youtube",
                "topic": None,
                "text_raw": text,
                "created_at": published_at,
                "meta": {"videoId": video_id, "author": author},
            })

            if len(out) >= max_results:
                break

        page_token = data.get("nextPageToken")
        if not page_token:
            break

    return out

# ----------------------------
# Queue task building (per-video task)
# ----------------------------
def build_youtube_video_tasks(
    *,
    topic: str,
    query: str,
    max_videos: int,
    comments_per_video: int,
    video_id_override: Optional[str] = None,
) -> List[str]:
    topic = normalize_topic(topic)
    max_videos = safe_int(max_videos, 5, 1, QUEUE_TASK_MAX_VIDEOS)
    comments_per_video = safe_int(comments_per_video, 500, 1, 2000)

    video_ids = [video_id_override] if video_id_override else youtube_search_video_ids(query=query, max_results=max_videos)
    ingested_at = utc_now_iso()

    tasks: List[str] = []
    for vid in video_ids:
        task = {
            "type": "youtube_video",
            "topic": topic,
            "query": query,
            "videoId": vid,
            "comments_per_video": comments_per_video,
            "ingested_at": ingested_at,
        }
        tasks.append(json.dumps(task, ensure_ascii=False))
    return tasks

# ----------------------------
# Twitter / X helpers
# ----------------------------

def _get_twitter_client():
    """
    Returns a tweepy.Client.
    Prefers TWITTER_BEARER_TOKEN (app-only, best for search_recent_tweets).
    Falls back to OAuth 1.0a if all four credentials are present.
    """
    import tweepy  # lazy import — only required if Twitter is used

    bearer = (os.getenv("TWITTER_BEARER_TOKEN") or "").strip() or None
    if bearer:
        return tweepy.Client(bearer_token=bearer, wait_on_rate_limit=False)

    api_key    = (os.getenv("TWITTER_API_KEY") or "").strip() or None
    api_secret = (os.getenv("TWITTER_API_KEY_SECRET") or "").strip() or None
    acc_token  = (os.getenv("TWITTER_ACCESS_TOKEN") or "").strip() or None
    acc_secret = (os.getenv("TWITTER_ACCESS_TOKEN_SECRET") or "").strip() or None

    if api_key and api_secret and acc_token and acc_secret:
        return tweepy.Client(
            consumer_key=api_key,
            consumer_secret=api_secret,
            access_token=acc_token,
            access_token_secret=acc_secret,
            wait_on_rate_limit=False,
        )

    raise RuntimeError(
        "Twitter credentials not configured. "
        "Set TWITTER_BEARER_TOKEN (recommended for search) "
        "or all four OAuth 1.0a env vars."
    )


def twitter_fetch_tweets(query: str, max_results: int = TWITTER_MAX_RESULTS) -> List[Dict[str, Any]]:
    """
    Fetch recent tweets via X API v2 search_recent_tweets.
    Automatically appends lang:en and -is:retweet to the query unless already present.
    Returns records in the same shape as youtube_fetch_comments.
    """
    import tweepy

    max_results = safe_int(max_results, TWITTER_MAX_RESULTS, 10, TWITTER_MAX_RESULTS)

    safe_q = query.strip()
    if "lang:" not in safe_q:
        safe_q += " lang:en"
    if "is:retweet" not in safe_q:
        safe_q += " -is:retweet"
    if "is:reply" not in safe_q:
        safe_q += " -is:reply"

    client = _get_twitter_client()

    try:
        response = client.search_recent_tweets(
            query=safe_q,
            max_results=max_results,
            tweet_fields=["id", "text", "created_at", "author_id", "public_metrics"],
        )
    except tweepy.TweepyException as e:
        logger.error("Twitter search error query=%r: %s", safe_q, e)
        raise

    out: List[Dict[str, Any]] = []
    if not response or not response.data:
        logger.info("twitter_fetch_tweets: 0 results for query=%r", safe_q)
        return out

    for tweet in response.data:
        text = (tweet.text or "").strip()
        if not text:
            continue
        created_at = None
        if getattr(tweet, "created_at", None):
            created_at = tweet.created_at.isoformat()
        metrics = {}
        if getattr(tweet, "public_metrics", None):
            metrics = {
                "like_count": tweet.public_metrics.get("like_count", 0),
                "retweet_count": tweet.public_metrics.get("retweet_count", 0),
                "reply_count": tweet.public_metrics.get("reply_count", 0),
                "quote_count": tweet.public_metrics.get("quote_count", 0),
            }
        out.append({
            "_id": f"twitter:tweet:{tweet.id}",
            "platform": "twitter",
            "topic": None,
            "text_raw": text,
            "created_at": created_at,
            "meta": {"tweet_id": str(tweet.id), "public_metrics": metrics},
        })

    logger.info("twitter_fetch_tweets: %d tweets for query=%r", len(out), safe_q)
    return out


def build_twitter_search_task(*, topic: str, query: str, max_results: int) -> str:
    task = {
        "type": "twitter_search",
        "topic": normalize_topic(topic),
        "query": query.strip(),
        "max_results": safe_int(max_results, TWITTER_MAX_RESULTS, 10, TWITTER_MAX_RESULTS),
        "ingested_at": utc_now_iso(),
    }
    return json.dumps(task, ensure_ascii=False)


# ----------------------------
# 1) Timer: ingest (to queue)
# ----------------------------
@app.timer_trigger(schedule="0 */10 * * * *", arg_name="timer", run_on_startup=False, use_monitor=True)
@app.queue_output(arg_name="$return", queue_name="ingest-queue", connection="AzureWebJobsStorage")
def ingest_timer(timer: func.TimerRequest):
    topic = normalize_topic(os.getenv("TOPIC_DEFAULT", DEFAULT_TOPIC))
    query = (os.getenv("YOUTUBE_QUERY", DEFAULT_YT_QUERY) or DEFAULT_YT_QUERY).strip()

    max_videos = safe_int(os.getenv("YOUTUBE_MAX_VIDEOS", "5"), 5, 1, QUEUE_TASK_MAX_VIDEOS)
    comments_per_video = safe_int(os.getenv("YOUTUBE_COMMENTS_PER_VIDEO", "500"), 500, 1, 2000)

    try:
        tasks = build_youtube_video_tasks(
            topic=topic,
            query=query,
            max_videos=max_videos,
            comments_per_video=comments_per_video,
        )
        logger.info("Ingested YouTube (timer): topic=%s query=%s tasks=%d", topic, query, len(tasks))
        return tasks
    except Exception as e:
        logger.exception("ingest_timer failed: %s", e)
        return []

# ----------------------------
# 2) Queue trigger: process + store (SQL)
# ----------------------------
@app.queue_trigger(arg_name="msg", queue_name="ingest-queue", connection="AzureWebJobsStorage")
def process_queue(msg: func.QueueMessage) -> None:
    try:
        payload = json.loads(msg.get_body().decode("utf-8"))
        msg_type = (payload.get("type") or "").strip().lower()

        if msg_type == "youtube_video":
            _process_youtube_video(payload)
        elif msg_type == "twitter_search":
            _process_twitter_search(payload)
        else:
            logger.warning("Unknown queue msg type=%s", msg_type)

    except Exception as e:
        logger.exception("process_queue failed (swallowed): %s", e)
        return


def _process_youtube_video(payload: Dict[str, Any]) -> None:
    topic = normalize_topic(payload.get("topic"))
    video_id = (payload.get("videoId") or "").strip()
    comments_per_video = safe_int(payload.get("comments_per_video", 500), 500, 1, 2000)
    ingested_at = parse_iso_datetime(payload.get("ingested_at"))

    if not video_id:
        return

    comments = youtube_fetch_comments(video_id=video_id, max_results=comments_per_video)
    if not comments:
        return

    now_scored = utc_now()

    for c in comments:
        raw = c.get("text_raw", "") or ""
        cleaned = clean_text(raw)
        cleaned_safe = safe_for_text_analytics(cleaned)
        if not cleaned_safe:
            continue

        label, scores = hybrid_sentiment_one(cleaned_safe, min_margin=SENTIMENT_MIN_MARGIN)

        post_id = c.get("_id") or f"youtube:comment:{uuid.uuid4().hex}"
        platform = c.get("platform") or "youtube"
        created_at = parse_iso_datetime(c.get("created_at"))

        upsert_post_scored(
            post_id=post_id,
            platform=platform,
            topic=topic,
            text_raw=raw,
            clean=cleaned_safe,
            created_at=created_at,
            ingested_at=ingested_at,
            scored_at=now_scored,
            sentiment_label=label,
            sentiment_scores_json=json.dumps(scores, ensure_ascii=False),
        )


def _process_twitter_search(payload: Dict[str, Any]) -> None:
    topic = normalize_topic(payload.get("topic"))
    query = (payload.get("query") or "").strip()
    max_results = safe_int(payload.get("max_results", TWITTER_MAX_RESULTS), TWITTER_MAX_RESULTS, 10, TWITTER_MAX_RESULTS)
    ingested_at = parse_iso_datetime(payload.get("ingested_at"))

    if not query:
        logger.warning("twitter_search task missing query")
        return

    tweets = twitter_fetch_tweets(query=query, max_results=max_results)
    if not tweets:
        return

    now_scored = utc_now()

    stored = 0
    skipped = 0
    errored = 0
    label_counts: Dict[str, int] = {"positive": 0, "negative": 0, "neutral": 0}

    for t in tweets:
        try:
            raw = t.get("text_raw", "") or ""
            cleaned = clean_text(raw)
            cleaned_safe = safe_for_text_analytics(cleaned)

            if not cleaned_safe:
                skipped += 1
                continue

            if is_likely_non_english(cleaned_safe):
                skipped += 1
                continue

            tokens = _tokenize_basic(cleaned_safe)
            if len(tokens) < 3:
                skipped += 1
                continue

            label, scores = hybrid_sentiment_one(cleaned_safe, min_margin=SENTIMENT_MIN_MARGIN)
            label_counts[label] = label_counts.get(label, 0) + 1

            post_id = t.get("_id") or f"twitter:tweet:{uuid.uuid4().hex}"
            created_at = parse_iso_datetime(t.get("created_at"))

            upsert_post_scored(
                post_id=post_id,
                platform="twitter",
                topic=topic,
                text_raw=raw,
                clean=cleaned_safe,
                created_at=created_at,
                ingested_at=ingested_at,
                scored_at=now_scored,
                sentiment_label=label,
                sentiment_scores_json=json.dumps(scores, ensure_ascii=False),
            )
            stored += 1

        except Exception as e:
            errored += 1
            logger.warning(
                "_process_twitter_search: skipping tweet _id=%s due to error: %s",
                t.get("_id", "?"), e,
            )

    logger.info(
        "_process_twitter_search: stored=%d skipped=%d errored=%d "
        "positive=%d negative=%d neutral=%d topic=%s query=%r",
        stored, skipped, errored,
        label_counts.get("positive", 0),
        label_counts.get("negative", 0),
        label_counts.get("neutral", 0),
        topic, query,
    )

# ----------------------------
# 3) HTTP API
# ----------------------------
@app.route(route="health", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def health(req: func.HttpRequest) -> func.HttpResponse:
    return func.HttpResponse("ok", status_code=200)

@app.route(route="topics", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def topics(req: func.HttpRequest) -> func.HttpResponse:
    try:
        limit = safe_int(req.params.get("limit", "200"), 200, 1, 500)
        items = fetch_topics(limit=limit)
        return json_response({"topics": items}, status_code=200)
    except Exception as e:
        logger.exception("topics failed: %s", e)
        return func.HttpResponse(f"topics failed: {type(e).__name__}: {e}", status_code=500)

@app.route(route="recent", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def recent(req: func.HttpRequest) -> func.HttpResponse:
    try:
        topic_param = req.params.get("topic")
        topic = normalize_topic(topic_param) if topic_param else None

        limit = safe_int(req.params.get("limit", "200"), 200, 1, 5000)
        q = (req.params.get("q") or "").strip() or None
        device = (req.params.get("device") or "").strip().lower() or None

        backfill = (req.params.get("backfill") or "").strip().lower() in ("1", "true", "yes", "on")
        min_margin = req.params.get("min_margin")
        min_margin_override = float(min_margin) if min_margin is not None and str(min_margin).strip() != "" else None

        rows = fetch_recent(
            limit=limit,
            topic=topic,
            q=q,
            device=device,
            backfill_missing=backfill,
            min_margin_override=min_margin_override,
        )
        return json_response(rows, status_code=200)
    except Exception as e:
        logger.exception("recent failed: %s", e)
        return func.HttpResponse(f"recent failed: {type(e).__name__}: {e}", status_code=500)

@app.route(route="ingest/youtube", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
@app.queue_output(arg_name="outmsg", queue_name="ingest-queue", connection="AzureWebJobsStorage")
def ingest_youtube(req: func.HttpRequest, outmsg: func.Out[List[str]]) -> func.HttpResponse:
    try:
        try:
            body = req.get_json()
        except Exception:
            body = {}

        topic = normalize_topic(body.get("topic") or os.getenv("TOPIC_DEFAULT", DEFAULT_TOPIC))
        query = (body.get("query") or os.getenv("YOUTUBE_QUERY", DEFAULT_YT_QUERY) or DEFAULT_YT_QUERY).strip()

        max_videos = safe_int(body.get("max_videos", os.getenv("YOUTUBE_MAX_VIDEOS", "5")), 5, 1, QUEUE_TASK_MAX_VIDEOS)
        comments_per_video = safe_int(body.get("comments_per_video", os.getenv("YOUTUBE_COMMENTS_PER_VIDEO", "500")), 500, 1, 2000)
        video_id_override = body.get("videoId")

        tasks = build_youtube_video_tasks(
            topic=topic,
            query=query,
            max_videos=max_videos,
            comments_per_video=comments_per_video,
            video_id_override=video_id_override,
        )

        outmsg.set(tasks)

        return json_response({
            "ok": True,
            "queued_tasks": len(tasks),
            "topic": topic,
            "query": query,
            "videoId": video_id_override,
            "max_videos": max_videos,
            "comments_per_video": comments_per_video,
        })
    except Exception as e:
        logger.exception("ingest_youtube failed: %s", e)
        return func.HttpResponse(f"ingest_youtube failed: {type(e).__name__}: {e}", status_code=500)


@app.route(route="twitter/search", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
def twitter_search(req: func.HttpRequest) -> func.HttpResponse:
    """
    Synchronous Twitter/X search: fetch → clean → batch-score → upsert → return rows.
    Returns scored rows in the same shape as /recent so the frontend can use them directly.
    No queue involved — results are available immediately in the response.
    """
    try:
        try:
            body = req.get_json()
        except Exception:
            body = {}

        topic = normalize_topic(body.get("topic") or os.getenv("TOPIC_DEFAULT", DEFAULT_TOPIC))
        query = (body.get("query") or os.getenv("TWITTER_QUERY", DEFAULT_TWITTER_QUERY) or DEFAULT_TWITTER_QUERY).strip()
        max_results = safe_int(
            body.get("max_results", os.getenv("TWITTER_MAX_RESULTS_DEFAULT", str(TWITTER_MAX_RESULTS))),
            TWITTER_MAX_RESULTS, 10, TWITTER_MAX_RESULTS,
        )

        tweets = twitter_fetch_tweets(query=query, max_results=max_results)
        if not tweets:
            return json_response([], status_code=200)

        now_scored = utc_now()
        ingested_at = now_scored

        valid: List[Dict[str, Any]] = []
        texts_to_score: List[str] = []

        for t in tweets:
            raw = t.get("text_raw", "") or ""
            cleaned = clean_text(raw)
            cleaned_safe = safe_for_text_analytics(cleaned)
            if not cleaned_safe or is_likely_non_english(cleaned_safe):
                continue
            tokens = _tokenize_basic(cleaned_safe)
            if len(tokens) < 3:
                continue
            valid.append({"tweet": t, "clean": cleaned_safe})
            texts_to_score.append(cleaned_safe)

        if not texts_to_score:
            return json_response([], status_code=200)

        scored = ai_language_sentiment_batch(texts_to_score, min_margin=SENTIMENT_MIN_MARGIN)

        rows: List[Dict[str, Any]] = []
        for item, (label, scores) in zip(valid, scored):
            t = item["tweet"]
            cleaned_safe = item["clean"]
            raw = t.get("text_raw", "") or ""
            post_id = t.get("_id") or f"twitter:tweet:{uuid.uuid4().hex}"
            created_at = parse_iso_datetime(t.get("created_at"))

            try:
                upsert_post_scored(
                    post_id=post_id,
                    platform="twitter",
                    topic=topic,
                    text_raw=raw,
                    clean=cleaned_safe,
                    created_at=created_at,
                    ingested_at=ingested_at,
                    scored_at=now_scored,
                    sentiment_label=label,
                    sentiment_scores_json=json.dumps(scores, ensure_ascii=False),
                )
            except Exception as e:
                logger.warning("twitter_search: upsert failed id=%s: %s", post_id, e)

            rows.append({
                "_id": post_id,
                "platform": "twitter",
                "topic": topic,
                "clean_text": cleaned_safe,
                "sentiment": {"azure_ai": {"label": label, "scores": scores}},
                "scored_at": now_scored.isoformat(),
                "created_at": created_at.isoformat() if created_at else None,
            })

        logger.info(
            "twitter_search: returned=%d skipped=%d topic=%s query=%r",
            len(rows), len(tweets) - len(rows), topic, query,
        )
        return json_response(rows, status_code=200)

    except Exception as e:
        logger.exception("twitter_search failed: %s", e)
        return func.HttpResponse(f"twitter_search failed: {type(e).__name__}: {e}", status_code=500)


@app.route(route="youtube/search", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
def youtube_search(req: func.HttpRequest) -> func.HttpResponse:
    """
    Synchronous YouTube search: find videos → fetch comments → clean → batch-score → upsert → return rows.
    Returns scored rows in the same shape as /recent so the frontend can use them directly.
    No queue involved — results are available immediately in the response.
    """
    try:
        try:
            body = req.get_json()
        except Exception:
            body = {}

        topic = normalize_topic(body.get("topic") or os.getenv("TOPIC_DEFAULT", DEFAULT_TOPIC))
        query = (body.get("query") or os.getenv("YOUTUBE_QUERY", DEFAULT_YT_QUERY) or DEFAULT_YT_QUERY).strip()
        max_videos = safe_int(body.get("max_videos", os.getenv("YOUTUBE_MAX_VIDEOS", "5")), 5, 1, QUEUE_TASK_MAX_VIDEOS)
        comments_per_video = safe_int(body.get("comments_per_video", 200), 200, 1, 500)
        video_id_override = body.get("videoId")

        now_scored = utc_now()
        ingested_at = now_scored

        video_ids = [video_id_override] if video_id_override else youtube_search_video_ids(query=query, max_results=max_videos)
        if not video_ids:
            return json_response([], status_code=200)

        all_comments: List[Dict[str, Any]] = []
        for vid in video_ids:
            try:
                comments = youtube_fetch_comments(video_id=vid, max_results=comments_per_video)
                all_comments.extend(comments)
            except Exception as e:
                logger.warning("youtube_search: failed to fetch comments for video %s: %s", vid, e)

        if not all_comments:
            return json_response([], status_code=200)

        valid: List[Dict[str, Any]] = []
        texts_to_score: List[str] = []

        for c in all_comments:
            raw = c.get("text_raw", "") or ""
            cleaned = clean_text(raw)
            cleaned_safe = safe_for_text_analytics(cleaned)
            if not cleaned_safe or is_likely_non_english(cleaned_safe):
                continue
            tokens = _tokenize_basic(cleaned_safe)
            if len(tokens) < 3:
                continue
            valid.append({"comment": c, "clean": cleaned_safe})
            texts_to_score.append(cleaned_safe)

        if not texts_to_score:
            return json_response([], status_code=200)

        scored = ai_language_sentiment_batch(texts_to_score, min_margin=SENTIMENT_MIN_MARGIN)

        rows: List[Dict[str, Any]] = []
        for item, (label, scores) in zip(valid, scored):
            c = item["comment"]
            cleaned_safe = item["clean"]
            raw = c.get("text_raw", "") or ""
            post_id = c.get("_id") or f"youtube:comment:{uuid.uuid4().hex}"
            created_at = parse_iso_datetime(c.get("created_at"))

            try:
                upsert_post_scored(
                    post_id=post_id,
                    platform="youtube",
                    topic=topic,
                    text_raw=raw,
                    clean=cleaned_safe,
                    created_at=created_at,
                    ingested_at=ingested_at,
                    scored_at=now_scored,
                    sentiment_label=label,
                    sentiment_scores_json=json.dumps(scores, ensure_ascii=False),
                )
            except Exception as e:
                logger.warning("youtube_search: upsert failed id=%s: %s", post_id, e)

            rows.append({
                "_id": post_id,
                "platform": "youtube",
                "topic": topic,
                "clean_text": cleaned_safe,
                "sentiment": {"azure_ai": {"label": label, "scores": scores}},
                "scored_at": now_scored.isoformat(),
                "created_at": created_at.isoformat() if created_at else None,
            })

        logger.info(
            "youtube_search: returned=%d skipped=%d videos=%d topic=%s query=%r",
            len(rows), len(all_comments) - len(rows), len(video_ids), topic, query,
        )
        return json_response(rows, status_code=200)

    except Exception as e:
        logger.exception("youtube_search failed: %s", e)
        return func.HttpResponse(f"youtube_search failed: {type(e).__name__}: {e}", status_code=500)


@app.route(route="ingest/twitter", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
@app.queue_output(arg_name="outmsg", queue_name="ingest-queue", connection="AzureWebJobsStorage")
def ingest_twitter(req: func.HttpRequest, outmsg: func.Out[List[str]]) -> func.HttpResponse:
    try:
        try:
            body = req.get_json()
        except Exception:
            body = {}

        topic = normalize_topic(body.get("topic") or os.getenv("TOPIC_DEFAULT", DEFAULT_TOPIC))
        query = (body.get("query") or os.getenv("TWITTER_QUERY", DEFAULT_TWITTER_QUERY) or DEFAULT_TWITTER_QUERY).strip()

        max_results = safe_int(
            body.get("max_results", os.getenv("TWITTER_MAX_RESULTS_DEFAULT", str(TWITTER_MAX_RESULTS))),
            TWITTER_MAX_RESULTS, 10, TWITTER_MAX_RESULTS,
        )

        task = build_twitter_search_task(topic=topic, query=query, max_results=max_results)
        outmsg.set([task])

        return json_response({
            "ok": True,
            "queued_tasks": 1,
            "topic": topic,
            "query": query,
            "max_results": max_results,
        })
    except Exception as e:
        logger.exception("ingest_twitter failed: %s", e)
        return func.HttpResponse(f"ingest_twitter failed: {type(e).__name__}: {e}", status_code=500)