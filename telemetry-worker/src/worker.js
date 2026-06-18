// token-panda 익명 텔레메트리 Worker.
//   POST /ping   설치 앱이 시간당 보내는 핑을 D1 에 기록 → 204
//   GET  /stats  집계 대시보드 JSON (STATS_TOKEN 필요)
//   GET  /public-stats  랜딩 공개용 최소 집계 JSON (토큰 불필요, PII 0)
//   GET  /health 헬스체크
//
// 설계 메모: 클라(electron/telemetry.cjs)는 {id, v, os} 만 보낸다. 국가는 여기서
// CF 헤더로만 파생하고 IP 는 절대 저장하지 않는다. 핑은 fire-and-forget 라
// 응답 본문이 필요 없어 204 로 빠르게 닫는다.
//
// 대시보드 지표는 *이미 쌓인* 두 테이블에서 전부 파생한다(앱/스키마 변경 없음):
//   pings_daily(id, day, version, os)  — (설치,날짜) 당 1행 [PK]. 시계열 truth.
//   installs(id, first_seen, last_seen, version, os, country, ping_count)
// → DAU/WAU 추이 · 신규 설치 추이 · 신규/복귀 구성 · 리텐션(D1/D7 생존) ·
//   stickiness(DAU/MAU) · 활성일수 분포 · 휴면/이탈 · 버전 채택 속도.
// 파생 계산의 순수 부분(날짜 산술/구간화/리텐션 적격성)은 아래 export 헬퍼로
// 빼서 worker.test.mjs 로 검증한다. SQL 은 집계만, 렌더는 대시보드가 한다.

const MAX = { id: 64, v: 32, os: 16 };

function clampStr(v, max) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

function firstN(result) {
  return result && result.results && result.results[0] ? result.results[0].n : 0;
}

// ── 순수 파생 헬퍼 (DB 없이 단위 테스트 가능) ───────────────────────────────

// 'YYYY-MM-DD' 에 일수를 더한 날짜 문자열. UTC 고정이라 TZ 영향 없음.
export function dateAdd(day, delta) {
  const p = String(day).split("-");
  const t = Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) + delta * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

// 백분율(소수 1자리). 분모 0 이면 null (정의 불가 → "—" 로 렌더).
export function pct(num, den) {
  if (!den) return null;
  return Math.round((num / den) * 1000) / 10;
}

// 듬성한 [{day,n}] 시계열을 start..end 의 빈틈없는 일 단위로 채운다(없는 날 0).
export function fillDays(rows, start, end) {
  const map = new Map();
  (rows || []).forEach((r) => map.set(r.day, r.n));
  const out = [];
  let day = start;
  for (let i = 0; i < 400 && day <= end; i++) {
    out.push({ day, n: map.get(day) || 0 });
    day = dateAdd(day, 1);
  }
  return out;
}

// 설치별 활성일수(distinct day 수) 분포를 사람이 읽는 구간으로 묶는다.
export function bucketActiveDays(rows) {
  const defs = [
    { label: "1일", lo: 1, hi: 1 },
    { label: "2–3일", lo: 2, hi: 3 },
    { label: "4–7일", lo: 4, hi: 7 },
    { label: "8–14일", lo: 8, hi: 14 },
    { label: "15–30일", lo: 15, hi: 30 },
    { label: "31일+", lo: 31, hi: Infinity },
  ];
  const out = defs.map((d) => ({ label: d.label, n: 0 }));
  (rows || []).forEach((r) => {
    const a = r.active_days;
    for (let i = 0; i < defs.length; i++) {
      if (a >= defs[i].lo && a <= defs[i].hi) {
        out[i].n += r.n;
        break;
      }
    }
  });
  return out;
}

// 코호트(설치일별)에 D1/D7 백분율 + "측정 가능 시점 도달" 여부를 붙인다.
// 코호트가 today 기준 offset 일을 아직 안 지났으면 분모가 불공정해 측정 보류.
export function markCohorts(cohorts, todayStr) {
  return (cohorts || []).map((c) => ({
    day: c.cohort,
    size: c.size,
    d1: c.d1,
    d7: c.d7,
    d1_pct: pct(c.d1, c.size),
    d7_pct: pct(c.d7, c.size),
    eligible1: c.cohort <= dateAdd(todayStr, -1),
    eligible7: c.cohort <= dateAdd(todayStr, -7),
  }));
}

// 적격(측정 시점 도달) 코호트만 합산한 전체 리텐션 %. 적격 코호트 0 → null.
export function overallRetention(cohorts, todayStr, offsetDays, key) {
  let size = 0;
  let kept = 0;
  const cutoff = dateAdd(todayStr, -offsetDays);
  (cohorts || []).forEach((c) => {
    if (c.cohort <= cutoff) {
      size += c.size;
      kept += c[key];
    }
  });
  return pct(kept, size);
}

// 랜딩 페이지에 공개해도 되는 최소 집계만 고른다.
// total_downloads 는 앱 telemetry 기준의 고유 설치 수와 같은 값이다.
export function publicStatsFromAggregates({
  generatedAt,
  todayStr,
  totalInstalls,
  dau,
  wau,
  mau,
  cohorts,
}) {
  const d = todayStr || today();
  const cohortRows = cohorts || [];
  const total = totalInstalls || 0;
  return {
    generated_at: generatedAt || new Date().toISOString(),
    total_downloads: total,
    total_installs: total,
    active: {
      dau: dau || 0,
      wau: wau || 0,
      mau: mau || 0,
    },
    retention: {
      d1_overall: overallRetention(cohortRows, d, 1, "d1"),
      d7_overall: overallRetention(cohortRows, d, 7, "d7"),
    },
  };
}

// (day, version, n) 평탄 행을 일별 {day,total,segments[]} 로 묶는다(채택 곡선용).
export function rollupVersionByDay(rows) {
  const byDay = new Map();
  (rows || []).forEach((r) => {
    if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, total: 0, segments: [] });
    const e = byDay.get(r.day);
    e.segments.push({ version: r.version || "(미상)", n: r.n });
    e.total += r.n;
  });
  return Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

// ── 핸들러 ─────────────────────────────────────────────────────────────────

async function handlePing(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(null, { status: 204 }); // 깨진 body 는 조용히 무시
  }
  const id = clampStr(payload && payload.id, MAX.id);
  if (id.length < 8) return new Response(null, { status: 204 }); // 잘못된 id 무시
  const v = clampStr(payload && payload.v, MAX.v);
  const os = clampStr(payload && payload.os, MAX.os);
  const country =
    (request.cf && request.cf.country) ||
    request.headers.get("CF-IPCountry") ||
    null;
  const day = today();

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO installs (id, first_seen, last_seen, version, os, country, ping_count)
         VALUES (?1, ?2, ?2, ?3, ?4, ?5, 1)
         ON CONFLICT(id) DO UPDATE SET
           last_seen  = ?2,
           version    = ?3,
           os         = ?4,
           country    = COALESCE(?5, country),
           ping_count = ping_count + 1`,
      ).bind(id, day, v, os, country),
      env.DB.prepare(
        `INSERT OR IGNORE INTO pings_daily (id, day, version, os)
         VALUES (?1, ?2, ?3, ?4)`,
      ).bind(id, day, v, os),
    ]);
  } catch (e) {
    // 로깅 실패가 클라에 영향 주지 않도록 그래도 204. (서버 로그로만 남김)
    console.error("ping insert failed:", e && e.message ? e.message : e);
  }
  return new Response(null, { status: 204 });
}

async function handleStats(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ||
    (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.STATS_TOKEN || token !== env.STATS_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }
  const d = today();
  const start = dateAdd(d, -29); // 추이 윈도우 시작(30일)
  const q = (sql, ...binds) => env.DB.prepare(sql).bind(...binds);

  // 헤드라인 + 분포 (기존 계약 유지: 아래 필드는 그대로 둔다)
  const [total, dau, wau, mau, newToday, byVersion, byOs, byCountry] =
    await env.DB.batch([
      q(`SELECT COUNT(*) AS n FROM installs`),
      q(`SELECT COUNT(DISTINCT id) AS n FROM pings_daily WHERE day = ?1`, d),
      q(`SELECT COUNT(DISTINCT id) AS n FROM pings_daily WHERE day >= date(?1,'-6 days')`, d),
      q(`SELECT COUNT(DISTINCT id) AS n FROM pings_daily WHERE day >= date(?1,'-29 days')`, d),
      q(`SELECT COUNT(*) AS n FROM installs WHERE first_seen = ?1`, d),
      q(`SELECT version, COUNT(*) AS n FROM installs GROUP BY version ORDER BY n DESC`),
      q(`SELECT os, COUNT(*) AS n FROM installs GROUP BY os ORDER BY n DESC`),
      q(`SELECT country, COUNT(*) AS n FROM installs GROUP BY country ORDER BY n DESC`),
    ]);

  // 파생 시계열/분포 (전부 SELECT, 쓰기 없음)
  const [wauR, newR, splitR, adaysR, dormR, cohR, verR] =
    await env.DB.batch([
      // 일별 WAU = 그 날 기준 직전 7일 distinct 활성 (date-spine 조인)
      q(`WITH spine AS (SELECT DISTINCT day FROM pings_daily WHERE day >= date(?1,'-29 days'))
         SELECT s.day AS day, COUNT(DISTINCT p.id) AS n
         FROM spine s JOIN pings_daily p ON p.day <= s.day AND p.day > date(s.day,'-7 days')
         GROUP BY s.day ORDER BY s.day`, d),
      // 신규 설치 추이
      q(`SELECT first_seen AS day, COUNT(*) AS n FROM installs
         WHERE first_seen >= date(?1,'-29 days') GROUP BY first_seen ORDER BY first_seen`, d),
      // DAU 구성: 그 날 활성 중 신규(first_seen=day) vs 복귀(first_seen<day)
      q(`SELECT p.day AS day,
           SUM(CASE WHEN i.first_seen = p.day THEN 1 ELSE 0 END) AS new_n,
           SUM(CASE WHEN i.first_seen < p.day THEN 1 ELSE 0 END) AS ret_n
         FROM pings_daily p JOIN installs i ON i.id = p.id
         WHERE p.day >= date(?1,'-29 days') GROUP BY p.day ORDER BY p.day`, d),
      // 설치별 활성일수(distinct day) 분포의 원천 (pings_daily PK=(id,day) 라 COUNT(*)=distinct day)
      q(`SELECT cnt AS active_days, COUNT(*) AS n FROM
           (SELECT id, COUNT(*) AS cnt FROM pings_daily GROUP BY id)
         GROUP BY cnt ORDER BY cnt`),
      // 휴면/이탈: 마지막 핑 경과일 구간별 설치 수
      q(`SELECT
           SUM(CASE WHEN last_seen >= date(?1,'-1 days') THEN 1 ELSE 0 END) AS d_active,
           SUM(CASE WHEN last_seen <  date(?1,'-1 days')  AND last_seen >= date(?1,'-6 days')  THEN 1 ELSE 0 END) AS d_recent,
           SUM(CASE WHEN last_seen <  date(?1,'-6 days')  AND last_seen >= date(?1,'-29 days') THEN 1 ELSE 0 END) AS d_dormant,
           SUM(CASE WHEN last_seen <  date(?1,'-29 days') THEN 1 ELSE 0 END) AS d_churned
         FROM installs`, d),
      // 코호트(설치일)별 D1/D7 생존: last_seen 이 first_seen+N 이후까지 살아있었나
      q(`SELECT first_seen AS cohort, COUNT(*) AS size,
           SUM(CASE WHEN last_seen >= date(first_seen,'+1 days') THEN 1 ELSE 0 END) AS d1,
           SUM(CASE WHEN last_seen >= date(first_seen,'+7 days') THEN 1 ELSE 0 END) AS d7
         FROM installs WHERE first_seen >= date(?1,'-60 days')
         GROUP BY first_seen ORDER BY first_seen`, d),
      // 버전 채택 속도: 최근 14일 day×version 활성 수
      q(`SELECT day, version, COUNT(*) AS n FROM pings_daily
         WHERE day >= date(?1,'-13 days') GROUP BY day, version ORDER BY day`, d),
    ]);

  const dauN = firstN(dau);
  const wauN = firstN(wau);
  const mauN = firstN(mau);

  // 신규/복귀를 dense 30일로 채우고, DAU 추이는 (신규+복귀)로 일관 산출
  const splitRows = splitR.results || [];
  const newDense = fillDays(splitRows.map((r) => ({ day: r.day, n: r.new_n })), start, d);
  const retDense = fillDays(splitRows.map((r) => ({ day: r.day, n: r.ret_n })), start, d);
  const dauDense = newDense.map((x, i) => ({ day: x.day, n: x.n + retDense[i].n }));
  const newR14 = newDense.slice(-14);
  const retR14 = retDense.slice(-14);
  const dauSplitRecent = newR14.map((x, i) => ({ day: x.day, new: x.n, ret: retR14[i].n }));

  const dorm = (dormR.results && dormR.results[0]) || {};
  const dormancy = [
    { key: "active", label: "활성 (≤1일)", n: dorm.d_active || 0 },
    { key: "recent", label: "최근 (2–6일)", n: dorm.d_recent || 0 },
    { key: "dormant", label: "휴면 (7–29일)", n: dorm.d_dormant || 0 },
    { key: "churned", label: "이탈 (30일+)", n: dorm.d_churned || 0 },
  ];

  const cohortRows = cohR.results || [];

  return json({
    generated_at: new Date().toISOString(),
    total_installs: firstN(total),
    active: { dau: dauN, wau: wauN, mau: mauN },
    new_installs_today: firstN(newToday),
    by_version: byVersion.results,
    by_os: byOs.results,
    by_country: byCountry.results,
    // ── 파생 지표 ──
    stickiness: { dau_mau: pct(dauN, mauN), wau_mau: pct(wauN, mauN) },
    trends: {
      start,
      end: d,
      dau: dauDense,
      wau: fillDays(wauR.results || [], start, d),
      new_installs: fillDays(newR.results || [], start, d),
      dau_split: dauSplitRecent,
    },
    retention: {
      d1_overall: overallRetention(cohortRows, d, 1, "d1"),
      d7_overall: overallRetention(cohortRows, d, 7, "d7"),
      cohorts: markCohorts(cohortRows, d),
    },
    active_days: bucketActiveDays(adaysR.results || []),
    dormancy,
    version_adoption: rollupVersionByDay(verR.results || []),
  });
}

async function handlePublicStats(request, env) {
  const d = today();
  const q = (sql, ...binds) => env.DB.prepare(sql).bind(...binds);
  const [total, dau, wau, mau, cohR] = await env.DB.batch([
    q(`SELECT COUNT(*) AS n FROM installs`),
    q(`SELECT COUNT(DISTINCT id) AS n FROM pings_daily WHERE day = ?1`, d),
    q(`SELECT COUNT(DISTINCT id) AS n FROM pings_daily WHERE day >= date(?1,'-6 days')`, d),
    q(`SELECT COUNT(DISTINCT id) AS n FROM pings_daily WHERE day >= date(?1,'-29 days')`, d),
    q(`SELECT first_seen AS cohort, COUNT(*) AS size,
         SUM(CASE WHEN last_seen >= date(first_seen,'+1 days') THEN 1 ELSE 0 END) AS d1,
         SUM(CASE WHEN last_seen >= date(first_seen,'+7 days') THEN 1 ELSE 0 END) AS d7
       FROM installs WHERE first_seen >= date(?1,'-60 days')
       GROUP BY first_seen ORDER BY first_seen`, d),
  ]);

  return json(publicStatsFromAggregates({
    generatedAt: new Date().toISOString(),
    todayStr: d,
    totalInstalls: firstN(total),
    dau: firstN(dau),
    wau: firstN(wau),
    mau: firstN(mau),
    cohorts: cohR.results || [],
  }));
}

// GET / 또는 /dashboard 에서 보여주는 단일 파일 대시보드. 토큰은 ?token= 으로
// 받거나(브라우저 sessionStorage 에 기억) 입력창에서 받아 /stats 를 호출한다.
// 외부 라이브러리 0개 — fetch + 인라인 SVG. 내부에 백틱/${} 안 씀(바깥 템플릿과 충돌 방지).
function dashboardHtml() {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>토큰 지키미 · telemetry</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--line:#262a33;--fg:#e8eaed;--mut:#8b919e;--accent:#46b3a8;--blue:#5b8cff;--purple:#9a7bff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .wrap{max-width:880px;margin:0 auto;padding:28px 20px 60px}
  h1{font-size:18px;margin:0 0 2px}
  .sub{color:var(--mut);font-size:12px;margin-bottom:22px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:26px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .card .n{font-size:28px;font-weight:700}
  .card .l{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-top:2px}
  .sec{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:14px}
  .sec h2{font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em;margin:0 0 12px}
  .row{display:flex;align-items:center;gap:10px;margin:6px 0}
  .row .k{width:130px;flex:none}
  .row .k.sm{width:46px;font-size:11px;color:var(--mut)}
  .row .barwrap{flex:1;display:flex;background:var(--bg);border-radius:6px;overflow:hidden;height:18px}
  .row .bar{height:100%;background:var(--accent)}
  .row .seg{height:100%}
  .row .v{width:70px;text-align:right;color:var(--mut);flex:none;font-variant-numeric:tabular-nums}
  .spark{width:100%;height:48px;display:block}
  .legend{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:10px}
  .lg{font-size:11px;color:var(--mut);display:inline-flex;align-items:center;gap:6px}
  .lg::before{content:"";width:9px;height:9px;border-radius:2px;background:var(--c,var(--accent))}
  .ax{display:flex;justify-content:space-between;color:var(--mut);font-size:10px;margin-top:6px}
  .kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
  .kpi{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:130px}
  .kpi .kn{font-size:22px;font-weight:700}
  .kpi .kl{font-size:11px;margin-top:2px}
  .kpi .ks{font-size:10px;color:var(--mut)}
  table.tbl{width:100%;border-collapse:collapse;font-size:12px}
  .tbl th{text-align:left;color:var(--mut);font-weight:600;font-size:11px;padding:5px 6px;border-bottom:1px solid var(--line)}
  .tbl td{padding:5px 6px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
  .mut{color:var(--mut)}
  .gate{max-width:340px;margin:60px auto;text-align:center}
  .gate input{width:100%;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);margin:10px 0}
  .gate button{padding:10px 18px;border-radius:8px;border:0;background:var(--accent);color:#06231f;font-weight:600;cursor:pointer}
  .err{color:#e26d6d}
</style></head>
<body><div class="wrap" id="app"><p class="sub">불러오는 중…</p></div>
<script>
  var P = new URLSearchParams(location.search);
  var token = P.get('token') || sessionStorage.getItem('tp_token') || '';
  var app = document.getElementById('app');
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function gate(msg){
    app.innerHTML='<div class="gate"><h1>🐼 토큰 지키미 telemetry</h1>'+
      (msg?'<p class="err">'+esc(msg)+'</p>':'<p class="sub">STATS_TOKEN 을 입력하세요</p>')+
      '<input id="tk" type="password" placeholder="STATS_TOKEN"><br>'+
      '<button onclick="save()">보기</button></div>';
  }
  function save(){var v=document.getElementById('tk').value.trim();if(!v)return;
    sessionStorage.setItem('tp_token',v);location.search='?token='+encodeURIComponent(v);}

  // ── 작은 유틸 ──
  function maxOf(a){var m=0;(a||[]).forEach(function(v){if(v>m)m=v;});return m;}
  function last(a){return a&&a.length?a[a.length-1]:0;}
  function fmtPct(p){return p==null?'—':p+'%';}
  function md(s){return String(s).slice(5);} // YYYY-MM-DD → MM-DD
  function hue(s){var h=0;s=String(s);for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return h%360;}
  function vColor(s){return 'hsl('+hue(s)+',60%,58%)';}

  function card(n,l){return '<div class="card"><div class="n">'+esc(n)+'</div><div class="l">'+esc(l)+'</div></div>';}
  function kpi(big,label,sub){return '<div class="kpi"><div class="kn">'+esc(big)+'</div><div class="kl">'+esc(label)+'</div><div class="ks">'+esc(sub)+'</div></div>';}

  // ── 막대 (분포) ──
  function bars(title,rows,key){
    rows=rows||[];var max=1;rows.forEach(function(r){if(r.n>max)max=r.n;});
    var h='<div class="sec"><h2>'+esc(title)+'</h2>';
    if(!rows.length)h+='<p class="sub">데이터 없음</p>';
    rows.forEach(function(r){var k=r[key];if(k==null||k==='')k='(미상)';
      var w=Math.round(r.n/max*100);
      h+='<div class="row"><div class="k">'+esc(k)+'</div><div class="barwrap"><div class="bar" style="width:'+w+'%"></div></div><div class="v">'+esc(r.n)+'</div></div>';});
    return h+'</div>';
  }
  // 카운트 분포 + 전체 대비 % (활성일수 / 휴면이탈 공용)
  function barsCount(title,rows){
    rows=rows||[];var sum=0,max=1;rows.forEach(function(r){sum+=r.n;if(r.n>max)max=r.n;});
    var h='<div class="sec"><h2>'+esc(title)+'</h2>';
    if(!sum)return h+'<p class="sub">데이터 없음</p></div>';
    rows.forEach(function(r){var w=Math.round(r.n/max*100);var p=Math.round(r.n/sum*100);
      h+='<div class="row"><div class="k">'+esc(r.label)+'</div><div class="barwrap"><div class="bar" style="width:'+w+'%"></div></div><div class="v">'+esc(r.n)+' · '+p+'%</div></div>';});
    return h+'</div>';
  }

  // ── 인라인 SVG 스파크라인 ──
  function scalePts(vals,max,W,H,Pd){var n=vals.length,pts=[];for(var i=0;i<n;i++){
    var x=n>1?Pd+(W-2*Pd)*i/(n-1):W/2;var y=H-Pd-(max>0?vals[i]/max:0)*(H-2*Pd);pts.push([x,y]);}return pts;}
  function polyline(pts,color){var s='';pts.forEach(function(p,i){s+=(i?' ':'')+p[0].toFixed(1)+','+p[1].toFixed(1);});
    return '<polyline points="'+s+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';}
  function areaPath(pts,H,Pd){if(!pts.length)return '';var s='M '+pts[0][0].toFixed(1)+' '+(H-Pd);
    pts.forEach(function(p){s+=' L '+p[0].toFixed(1)+' '+p[1].toFixed(1);});
    s+=' L '+pts[pts.length-1][0].toFixed(1)+' '+(H-Pd)+' Z';return s;}
  function dot(p,c){return '<circle cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="2.6" fill="'+c+'" vector-effect="non-scaling-stroke"/>';}
  function spark2(a,b,ca,cb){var W=680,H=48,Pd=4;var max=Math.max(maxOf(a),maxOf(b),1);
    var pa=scalePts(a,max,W,H,Pd),pb=scalePts(b,max,W,H,Pd);
    var s='<svg class="spark" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">';
    if(pa.length)s+='<path d="'+areaPath(pa,H,Pd)+'" fill="'+ca+'" opacity="0.13"/>';
    if(pb.length>1)s+=polyline(pb,cb);
    if(pa.length>1)s+=polyline(pa,ca);
    if(pa.length)s+=dot(pa[pa.length-1],ca);
    if(pb.length)s+=dot(pb[pb.length-1],cb);
    return s+'</svg>';}
  function sparkBars(vals,color){var W=680,H=48,Pd=4;var max=maxOf(vals)||1;var n=vals.length;
    var bw=n>0?(W-2*Pd)/n:0;var gap=bw>4?1.2:0.3;
    var s='<svg class="spark" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">';
    for(var i=0;i<n;i++){var bh=(max>0?vals[i]/max:0)*(H-2*Pd);var x=Pd+i*bw;var y=H-Pd-bh;
      s+='<rect x="'+(x+gap).toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+Math.max(0.5,bw-2*gap).toFixed(1)+'" height="'+Math.max(0,bh).toFixed(1)+'" fill="'+color+'"/>';}
    return s+'</svg>';}
  function axis(start,end,peak){return '<div class="ax"><span>'+esc(start)+'</span><span>최대 '+esc(peak)+'</span><span>'+esc(end)+'</span></div>';}

  // ── 섹션들 ──
  function trendDauWau(t,st){t=t||{};st=st||{};
    var dau=(t.dau||[]).map(function(x){return x.n;});var wau=(t.wau||[]).map(function(x){return x.n;});
    var h='<div class="sec"><h2>활성 사용자 추이 — 최근 30일</h2>';
    if(!dau.length&&!wau.length)return h+'<p class="sub">데이터 없음</p></div>';
    h+='<div class="legend"><span class="lg" style="--c:var(--accent)">DAU '+last(dau)+'</span>'+
       '<span class="lg" style="--c:var(--blue)">WAU '+last(wau)+'</span></div>';
    h+=spark2(dau,wau,'var(--accent)','var(--blue)');
    h+=axis(t.start,t.end,Math.max(maxOf(dau),maxOf(wau)));
    h+='<div class="sub" style="margin-top:8px;margin-bottom:0">끈적도(stickiness) · DAU/MAU '+fmtPct(st.dau_mau)+' · WAU/MAU '+fmtPct(st.wau_mau)+'</div>';
    return h+'</div>';}

  function trendNew(t){t=t||{};var v=(t.new_installs||[]).map(function(x){return x.n;});
    var h='<div class="sec"><h2>신규 설치 추이 — 최근 30일</h2>';
    if(!v.length)return h+'<p class="sub">데이터 없음</p></div>';
    h+=sparkBars(v,'var(--purple)');h+=axis(t.start,t.end,maxOf(v));return h+'</div>';}

  function dauSplit(t){t=t||{};var rows=t.dau_split||[];
    var h='<div class="sec"><h2>DAU 구성 — 신규 vs 복귀 (최근 14일)</h2>';
    var sum=0,max=1;rows.forEach(function(r){var s=r['new']+r.ret;sum+=s;if(s>max)max=s;});
    if(!sum)return h+'<p class="sub">데이터 없음</p></div>';
    h+='<div class="legend"><span class="lg" style="--c:var(--accent)">신규</span><span class="lg" style="--c:var(--blue)">복귀</span></div>';
    rows.forEach(function(r){var wn=Math.round(r['new']/max*100),wr=Math.round(r.ret/max*100);
      h+='<div class="row"><div class="k sm">'+esc(md(r.day))+'</div><div class="barwrap">'+
         '<div class="seg" style="width:'+wn+'%;background:var(--accent)"></div>'+
         '<div class="seg" style="width:'+wr+'%;background:var(--blue)"></div>'+
         '</div><div class="v">'+esc(r['new']+r.ret)+'</div></div>';});
    return h+'</div>';}

  function retention(r){r=r||{};var cs=r.cohorts||[];
    var h='<div class="sec"><h2>리텐션 — 코호트 생존율</h2>';
    h+='<div class="kpis">'+kpi(fmtPct(r.d1_overall),'D1 생존','다음날도 켠 설치 비율')+
       kpi(fmtPct(r.d7_overall),'D7 생존','일주일 뒤에도 켠 설치 비율')+'</div>';
    if(!cs.length)return h+'<p class="sub">데이터 없음</p></div>';
    h+='<table class="tbl"><thead><tr><th>설치일(코호트)</th><th>설치수</th><th>D1</th><th>D7</th></tr></thead><tbody>';
    cs.slice().reverse().forEach(function(c){
      h+='<tr><td>'+esc(c.day)+'</td><td>'+esc(c.size)+'</td>'+
         '<td>'+(c.eligible1?cell(c.d1,c.size,c.d1_pct):'<span class="mut">측정중</span>')+'</td>'+
         '<td>'+(c.eligible7?cell(c.d7,c.size,c.d7_pct):'<span class="mut">측정중</span>')+'</td></tr>';});
    return h+'</tbody></table><p class="sub" style="margin:10px 0 0">생존 = 마지막 핑이 설치 후 N일 이후까지 유지. 측정중 = 설치 후 N일이 아직 안 지난 코호트.</p></div>';}
  function cell(k,size,p){return esc(k)+'/'+esc(size)+' <span class="mut">('+(p==null?'—':p+'%')+')</span>';}

  function versionAdopt(va){va=va||[];
    var h='<div class="sec"><h2>버전 채택 속도 — 최근 14일 (일별 점유율)</h2>';
    if(!va.length)return h+'<p class="sub">데이터 없음</p></div>';
    var seen={},order=[];
    va.forEach(function(d){(d.segments||[]).forEach(function(s){if(!seen[s.version]){seen[s.version]=1;order.push(s.version);}});});
    h+='<div class="legend">';order.forEach(function(v){h+='<span class="lg" style="--c:'+vColor(v)+'">'+esc(v)+'</span>';});h+='</div>';
    va.forEach(function(d){h+='<div class="row"><div class="k sm">'+esc(md(d.day))+'</div><div class="barwrap">';
      (d.segments||[]).forEach(function(s){var w=d.total?Math.round(s.n/d.total*100):0;
        h+='<div class="seg" title="'+esc(s.version)+' · '+esc(s.n)+'" style="width:'+w+'%;background:'+vColor(s.version)+'"></div>';});
      h+='</div><div class="v">'+esc(d.total)+'</div></div>';});
    return h+'</div>';}

  function render(d){var a=d.active||{};var st=d.stickiness||{};
    app.innerHTML='<h1>🐼 토큰 지키미 telemetry</h1><div class="sub">갱신 '+esc(d.generated_at)+' · 60초마다 자동</div>'+
      '<div class="cards">'+card(d.total_installs,'총 설치')+card(a.dau,'DAU')+card(a.wau,'WAU')+card(a.mau,'MAU')+
        card(d.new_installs_today,'오늘 신규')+card(fmtPct(st.dau_mau),'끈적도 DAU/MAU')+'</div>'+
      trendDauWau(d.trends,st)+
      trendNew(d.trends)+
      dauSplit(d.trends)+
      retention(d.retention)+
      barsCount('활성일수 분포 (설치별 distinct 사용일)',d.active_days)+
      barsCount('휴면 / 이탈 (마지막 핑 경과)',d.dormancy)+
      versionAdopt(d.version_adoption)+
      bars('버전 분포 (현재 설치)',d.by_version,'version')+bars('OS',d.by_os,'os')+bars('국가 (대략 · CF 헤더, IP 미저장)',d.by_country,'country');
  }
  function load(){if(!token){gate();return;}
    fetch('/stats?token='+encodeURIComponent(token))
      .then(function(r){if(r.status===401){sessionStorage.removeItem('tp_token');gate('토큰이 틀렸어요');throw new Error('401');}return r.json();})
      .then(render)
      .catch(function(e){if(e.message!=='401')app.innerHTML='<p class="err">불러오기 실패: '+esc(e.message)+'</p>';});
  }
  load();setInterval(function(){if(token)load();},60000);
</script></body></html>`;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/ping") return handlePing(request, env);
    if (request.method === "GET" && pathname === "/stats") return handleStats(request, env);
    if (request.method === "GET" && pathname === "/public-stats") return handlePublicStats(request, env);
    if (request.method === "GET" && (pathname === "/" || pathname === "/dashboard")) {
      return new Response(dashboardHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (pathname === "/health") return json({ ok: true });
    return new Response("not found", { status: 404 });
  },
};
