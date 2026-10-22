'use strict';

/* Page /flow: live values over server-sent events, day chart with day navigation. */

(() => {
  const q = new URLSearchParams(location.search);
  const $ = id => document.getElementById(id);
  const root = document.documentElement;
  root.classList.add(['light', 'dark'].includes(q.get('theme')) ? q.get('theme') : 'auto');
  if (q.get('bg') === 'transparent') root.classList.add('transparent');
  const view = ['flow', 'stats', 'chart'].includes(q.get('view')) ? q.get('view') : 'all';
  $('app').className = view;
  if (view !== 'all') for (const k of ['flow', 'stats', 'chart']) if (k !== view) $(k + 'Box').classList.add('hide');
  const style = document.createElement('style');
  style.textContent = EnergyView.css;
  document.head.appendChild(style);

  const flow = EnergyView.flow($('flow'));
  let today = null;
  let shown = null; // date of the chart; null = today
  let dates = [];
  let lastChart = 0;

  function onLive(d) {
    if (!d || !d.s) return;
    flow.update(d.s, d.view);
    EnergyView.stats($('stats'), d.today, d.s.battery !== null);
    const miss = d.s.missing || [];
    $('note').hidden = !miss.length;
    $('note').textContent = miss.length ? 'Kein Wert: ' + miss.join(', ') : '';
    if (today && d.today && today !== d.today.date && shown === null) lastChart = 0;
    today = d.today && d.today.date;
    // today's chart follows every 5 minutes
    if (shown === null && view !== 'flow' && view !== 'stats' && Date.now() - lastChart > 60000) loadDay(null);
  }

  async function loadDay(date) {
    lastChart = Date.now();
    const res = await fetch('api/day' + (date ? '?date=' + date : '') + location.search.replace(/^\?/, date ? '&' : '?'));
    if (!res.ok) return;
    const day = await res.json();
    dates = day.dates || [];
    shown = date;
    const d = new Date(day.date + 'T12:00:00');
    $('dayTitle').textContent = date ? d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }) : 'Tagesverlauf heute';
    const s = day.summary;
    $('dayStats').innerHTML = date && s ? ['PV <b>' + EnergyView.fmtKwh(s.pv) + '</b>', 'Verbrauch <b>' + EnergyView.fmtKwh(s.house) + '</b>', 'Autarkie <b>' + (s.autarky === null ? '–' : s.autarky + ' %') + '</b>'].join('') : '';
    EnergyView.chart($('chart'), day);
    const i = dates.indexOf(day.date);
    $('prev').disabled = i <= 0;
    $('next').disabled = !date;
  }

  $('prev').onclick = () => {
    const cur = shown || today;
    const i = dates.indexOf(cur);
    if (i > 0) loadDay(dates[i - 1]);
  };
  $('next').onclick = () => {
    const i = dates.indexOf(shown);
    loadDay(i >= 0 && i < dates.length - 1 && dates[i + 1] !== today ? dates[i + 1] : null);
  };

  function connect() {
    const es = new EventSource('events' + location.search);
    es.onmessage = e => onLive(JSON.parse(e.data));
  }
  fetch('api/live' + location.search).then(r => r.json()).then(onLive).catch(() => {});
  connect();
})();
