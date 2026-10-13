'use strict';

const PLANNER_FILE = 'garmin_marathon_planner.py';
const APP_DIR = '/home/pyodide/app';
const ZIP_PATH = '/tmp/semana.zip';
const ENGINE_PY = `
import contextlib, io, json, shutil, sys, zipfile
sys.path.insert(0, ${JSON.stringify(APP_DIR)})
import garmin_marathon_planner as gmp

def run_json(args, extra):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = gmp.main(json.loads(args) + extra)
    if code != 0:
        message = err.getvalue().strip().removeprefix("Erro:").strip()
        return json.dumps({"error": message or "O cálculo falhou."}, ensure_ascii=False)
    return out.getvalue()

def plan_json(args_json):
    shutil.rmtree(gmp.DEFAULT_TRAININGS_DIR, ignore_errors=True)
    return run_json(args_json, ["--json-only", "--treinos"])

def workout_json(args_json):
    return run_json(args_json, ["--json-only"])

def week_zip(folder):
    root = gmp.DEFAULT_TRAININGS_DIR
    with zipfile.ZipFile(${JSON.stringify(ZIP_PATH)}, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted((root / folder).rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(root).as_posix())
`;
const DEFAULT_SETTINGS = {
    model: 'Forerunner 165',
    distance: '42.195',
    mode: 'pace',
    pace: '06:40',
    time: '',
    date: '2026-11-01',
    tolerance: '10',
    split: '5',
    event: 'Maratona Maurício de Nassau',
    city: 'Recife',
    start: '',
    longao: '',
};
const WORKOUT_DEFAULTS = {
    kind: 'ritmo', day: '', km: '8', pace: '', tolerance: '10',
    warmup: '15', cooldown: '10', reps: '6', repM: '400', recovery: '90', finishKm: '0',
};
const RECIFE = [-8.0631, -34.8711];
const AI_MODEL = 'gemini-flash-latest';
const AI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const AI_HISTORY = 20;
const CHAT_KEEP = 60;

const store = {
    get(key, fallback) {
        try {
            const value = JSON.parse(localStorage.getItem(key));
            return value ?? fallback;
        } catch {
            return fallback;
        }
    },
    set(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    },
};

const state = {
    plan: null,
    engine: null,
    engineReady: false,
    settings: { ...DEFAULT_SETTINGS, ...store.get('tm_settings', {}) },
    done: store.get('tm_done', {}),
    ai: { key: '', model: AI_MODEL, ...store.get('tm_ai', {}) },
    chat: store.get('tm_chat', []),
    asking: false,
    builder: { ...WORKOUT_DEFAULTS, ...store.get('tm_workout', {}) },
    workout: null,
    workoutId: 0,
    requestId: 0,
    week: null,
    manualTask: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const pad = (n) => String(n).padStart(2, '0');

function fmtDuration(total) {
    const seconds = Math.round(total);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function paceSeconds(text) {
    const [m, s] = String(text).split(':').map(Number);
    return m * 60 + s;
}

function fmtKm(value, digits = 2) {
    return `${Number(value).toLocaleString('pt-BR', { maximumFractionDigits: digits })} km`;
}

function parseISO(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
}

function todayISO() {
    const t = new Date();
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

function fmtDate(iso, options = { day: '2-digit', month: '2-digit' }) {
    return parseISO(iso).toLocaleDateString('pt-BR', options);
}

function daysUntil(iso) {
    return Math.round((parseISO(iso) - parseISO(todayISO())) / 86400000);
}

function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
}

function banner(message) {
    const el = $('#banner');
    el.hidden = !message;
    el.textContent = message || '';
}

/* ---------- dados ---------- */

function weeks() {
    return state.plan?.training?.weeks || [];
}

function allDays() {
    return weeks().flatMap((week) => week.days.map((day) => ({ ...day, weekNumber: week.number })));
}

function sessions(day) {
    const list = [];
    if (day.run) list.push({ type: 'run', ...day.run });
    if (day.strength) list.push({ type: 'strength', ...day.strength });
    return list;
}

const doneKey = (day, type) => `${day.date}:${type}`;
const isDone = (day, type) => Boolean(state.done[doneKey(day, type)]);

function toggleDone(date, type) {
    const key = `${date}:${type}`;
    if (state.done[key]) delete state.done[key];
    else state.done[key] = new Date().toISOString();
    store.set('tm_done', state.done);
    renderToday();
    renderWeeks();
}

function currentWeek() {
    const today = todayISO();
    const list = weeks();
    return list.find((w) => w.start <= today && today <= w.end)
        || list.find((w) => w.start > today)
        || list[list.length - 1];
}

function plannerArgs() {
    const s = state.settings;
    const flags = {
        model: s.model, distance: s.distance, date: s.date, tolerance: s.tolerance, 'split-km': s.split,
        event: s.event, city: s.city, inicio: s.start,
    };
    if (s.mode === 'time' && s.time) flags.time = s.time;
    else flags.pace = s.pace;
    if (String(s.longao).trim()) flags.longao = s.longao;
    return Object.entries(flags).map(([flag, value]) => `--${flag}=${value}`);
}

function startEngine() {
    state.engine ??= (async () => {
        if (!window.loadPyodide) throw new Error('O motor Python precisa de internet na primeira abertura.');
        const [pyodide, source] = await Promise.all([
            window.loadPyodide(),
            fetch(PLANNER_FILE, { cache: 'no-cache' }).then((r) => {
                if (!r.ok) throw new Error(`Não encontrei ${PLANNER_FILE}.`);
                return r.text();
            }),
        ]);
        pyodide.FS.mkdirTree(APP_DIR);
        pyodide.FS.writeFile(`${APP_DIR}/${PLANNER_FILE}`, source);
        pyodide.runPython(ENGINE_PY);
        return {
            fs: pyodide.FS,
            planJson: pyodide.globals.get('plan_json'),
            workoutJson: pyodide.globals.get('workout_json'),
            weekZip: pyodide.globals.get('week_zip'),
            root: pyodide.runPython('gmp.DEFAULT_TRAININGS_DIR.as_posix()'),
        };
    })();
    return state.engine;
}

function download(bytes, name, type) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([bytes], { type }));
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function downloadFit(path) {
    const engine = await startEngine();
    download(engine.fs.readFile(`${engine.root}/${path}`), path.split('/').pop(), 'application/octet-stream');
}

async function downloadWeek(button) {
    const week = weeks().find((w) => w.number === state.week);
    if (!week) return;
    button.disabled = true;
    try {
        const engine = await startEngine();
        engine.weekZip(week.folder);
        download(engine.fs.readFile(ZIP_PATH), `${week.folder}.zip`, 'application/zip');
    } catch (error) {
        toast(error.message);
    } finally {
        button.disabled = false;
    }
}

async function loadInitialPlan() {
    const custom = Object.keys(DEFAULT_SETTINGS)
        .some((key) => key !== 'start' && String(state.settings[key]) !== String(DEFAULT_SETTINGS[key]));
    if (custom) return;
    try {
        const response = await fetch('treino_maratona_config.json', { cache: 'no-cache' });
        if (!response.ok) return;
        const data = await response.json();
        if (state.plan) return;
        state.plan = data;
        renderAll();
    } catch {
        /* o motor Python preenche o plano */
    }
}

async function loadPlan() {
    const id = ++state.requestId;
    $('#busy').textContent = state.engineReady ? 'Calculando…' : 'Carregando o motor de cálculo…';
    $('#busy').classList.add('on');
    try {
        const engine = await startEngine();
        if (id !== state.requestId) return;
        const data = JSON.parse(engine.planJson(JSON.stringify(plannerArgs())));
        if (data.error) throw new Error(data.error);
        state.plan = data;
        state.engineReady = true;
        $('#calc-error').textContent = '';
        banner('');
        renderAll();
        return true;
    } catch (error) {
        if (id !== state.requestId) return undefined;
        $('#calc-error').textContent = error.message;
        if (!state.engineReady) {
            state.engine = null;
            banner(`Não consegui carregar o motor de cálculo: ${error.message}`);
        }
        return false;
    } finally {
        if (id === state.requestId) $('#busy').classList.remove('on');
    }
}

let debounceTimer;
function scheduleLoad() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadPlan, 350);
}

/* ---------- abas ---------- */

function showTab(name) {
    const tab = $(`#tab-${name}`) ? name : 'hoje';
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
    if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
    if (tab === 'mapa') initMap();
    if (tab === 'manual') loadManual();
    if (tab === 'treinador') renderChat();
    if (tab === 'montar') renderBuilderRoute();
}

/* ---------- render ---------- */

function renderAll() {
    if (!state.plan) return;
    renderHeader();
    renderToday();
    renderWeeks();
    renderCalcResults();
    renderWatch();
    renderBuilderChoices();
    renderMapTargets();
    renderMapStats();
    if (mapState.map) renderStops();
}

function renderHeader() {
    const { event, watch } = state.plan;
    $('#brand-sub').textContent = `${event.name} · ${fmtDate(event.date, { day: '2-digit', month: 'short', year: 'numeric' })} · ${watch.model}`;
}

function countdownText(iso) {
    const days = daysUntil(iso);
    if (days > 1) return `${days} dias`;
    if (days === 1) return '1 dia';
    if (days === 0) return 'Hoje';
    return 'Prova realizada';
}

function renderToday() {
    const { event, target, pace_zone: zone } = state.plan;
    $('#hero').innerHTML = `
        <div class="eyebrow">Faltam ${esc(countdownText(event.date))}</div>
        <h1>${esc(event.name)}</h1>
        <p>${esc(event.city)} · ${esc(fmtDate(event.date, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }))}</p>
        <div class="grid stats">
            <div class="stat"><div class="label">Distância</div><div class="value">${esc(fmtKm(target.distance_km, 4))}</div></div>
            <div class="stat"><div class="label">Pace alvo</div><div class="value">${esc(target.pace)} <small>/km</small></div></div>
            <div class="stat"><div class="label">Tempo previsto</div><div class="value">${esc(target.finish_time)}</div></div>
            <div class="stat"><div class="label">Faixa</div><div class="value">${esc(zone.faster_pace)}–${esc(zone.slower_pace)}</div></div>
        </div>`;

    const today = todayISO();
    const days = allDays();
    const todayEntry = days.find((d) => d.date === today);
    const next = days.find((d) => d.date > today && (d.run || d.strength || d.race));
    let html = '<h2>Treino de hoje</h2>';
    if (!days.length) {
        html += '<p class="muted">Sem calendário. Confira a data da prova na Calculadora.</p>';
    } else if (todayEntry) {
        html += dayBody(todayEntry, true);
    } else if (today < days[0].date) {
        html += `<p class="muted">O bloco começa em ${esc(fmtDate(days[0].date, { weekday: 'long', day: '2-digit', month: '2-digit' }))}. Hoje é livre.</p>`;
    } else {
        html += '<p class="muted">O bloco de treinos terminou.</p>';
    }
    if (next && next.date !== todayEntry?.date) {
        html += `<h3>Próximo: ${esc(next.weekday)}, ${esc(fmtDate(next.date))}</h3>${dayBody(next, false)}`;
    }
    $('#today-card').innerHTML = html;

    const week = currentWeek();
    if (!week) {
        $('#week-card').innerHTML = '<h2>Semana</h2><p class="muted">Sem calendário.</p>';
        return;
    }
    const doneKm = week.days.reduce((sum, d) => sum + (d.run && isDone(d, 'run') ? d.run.distance_km : 0), 0);
    const pct = week.planned_km ? Math.min(100, (doneKm / week.planned_km) * 100) : 0;
    const strip = week.days.map((d) => {
        const list = sessions(d);
        let cls = '';
        if (d.race) cls = 'race';
        else if (list.length && list.every((s) => isDone(d, s.type))) cls = 'done';
        else if (list.length) cls = 'planned';
        if (d.date === today) cls += ' today';
        return `<div><i class="${cls}"></i>${esc(d.weekday.slice(0, 3))}</div>`;
    }).join('');
    $('#week-card').innerHTML = `
        <h2>Semana ${esc(week.number)} de ${esc(weeks().length)} · ${esc(fmtDate(week.start))} a ${esc(fmtDate(week.end))} <span class="pill rest" style="margin-left:6px">${esc(week.phase || '')}</span></h2>
        <div class="grid stats">
            <div class="stat"><div class="label">Feitos</div><div class="value">${esc(fmtKm(doneKm, 1))}</div></div>
            <div class="stat"><div class="label">Planejados</div><div class="value">${esc(fmtKm(week.planned_km, 1))}</div></div>
        </div>
        <div class="progress" style="margin-top:12px"><span style="width:${pct}%"></span></div>
        <div class="strip">${strip}</div>
        <p class="small muted" style="margin-bottom:0">Km planejados contam só trechos medidos em distância. Aquecimento e desaquecimento são por tempo.</p>`;
}

function segmentHtml(segment) {
    const pace = state.plan.target.pace_seconds_per_km;
    const zone = state.plan.pace_zone;
    let what;
    let time = '';
    if (segment.unit === 'min') {
        what = `${segment.amount} min · ${segment.label}`;
        time = 'livre';
    } else if (segment.target === 'pace') {
        what = `${fmtKm(segment.amount)} · ${segment.label} (${zone.faster_pace}–${zone.slower_pace})`;
        time = `≈ ${fmtDuration(segment.amount * pace)}`;
    } else if (segment.target === 'z2') {
        what = `${fmtKm(segment.amount)} · ${segment.label}`;
        time = 'FC zona 2';
    } else {
        what = `${fmtKm(segment.amount)} · ${segment.label}`;
        time = 'livre';
    }
    return `<li class="${esc(segment.target)}"><span>${esc(what)}</span><span class="seg-time">${esc(time)}</span></li>`;
}

function strengthTable(strength) {
    const rows = strength.exercises.map((e) => {
        const volume = e.reps ? `${e.sets} × ${e.reps}` : `${e.sets} × ${e.seconds} s`;
        return `<tr><td>${esc(e.label)}${e.per_side ? ' <span class="muted">(por lado)</span>' : ''}</td><td>${esc(volume)}</td><td>${esc(e.rest_seconds)} s</td></tr>`;
    }).join('');
    return `<table style="margin-top:10px"><thead><tr><th>Exercício</th><th>Volume</th><th>Descanso</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function sessionHtml(day, session, withActions) {
    const done = isDone(day, session.type);
    const ready = state.engineReady && session.file;
    const head = session.type === 'run'
        ? `<span class="pill run">Corrida</span><b>${esc(session.name)}</b><span class="meta">${esc(fmtKm(session.distance_km))}${session.pace_km ? ` · ${esc(fmtKm(session.pace_km))} no pace` : ''}</span>`
        : `<span class="pill strength">Força</span><b>${esc(session.name)}</b><span class="meta">${esc(session.label)}</span>`;
    const body = session.type === 'run'
        ? `<ul class="segments">${session.segments.map(segmentHtml).join('')}</ul>`
        : strengthTable(session);
    const actions = withActions ? `
        <div class="actions">
            <button class="btn ${done ? 'done' : ''}" data-done="${esc(day.date)}" data-type="${esc(session.type)}">${done ? 'Feito' : 'Marcar como feito'}</button>
            ${ready ? `<button class="btn" data-fit="${esc(session.file)}">Baixar .fit</button>` : ''}
        </div>` : '';
    return `<div class="session"><div class="session-head">${head}${done ? '<span class="pill ok">Feito</span>' : ''}</div>${body}${actions}</div>`;
}

function dayBody(day, withActions) {
    if (day.race) {
        const { target, pace_zone: zone } = state.plan;
        return `<div class="session"><div class="session-head"><span class="pill race">Prova</span><b>${esc(fmtKm(target.distance_km, 4))} em ${esc(target.pace)}</b></div>
            <p>PacePro com pace constante, faixa ${esc(zone.faster_pace)}–${esc(zone.slower_pace)}, tempo alvo ${esc(target.finish_time)}. Parciais na Calculadora.</p></div>`;
    }
    if (day.rest) return '<div class="session"><span class="pill rest">Descanso</span><p>Sono, hidratação e pernas para cima.</p></div>';
    return sessions(day).map((s) => sessionHtml(day, s, withActions)).join('');
}

function renderWeeks() {
    const list = weeks();
    if (!list.length) {
        $('#week-chips').innerHTML = '';
        $('#files-card').innerHTML = '<p class="muted" style="margin:0">Sem calendário. Confira a data da prova na Calculadora.</p>';
        $('#days').innerHTML = '';
        return;
    }
    if (!state.week || !list.some((w) => w.number === state.week)) state.week = currentWeek().number;
    $('#week-chips').innerHTML = list.map((w) => `
        <button class="chip ${w.number === state.week ? 'active' : ''}" data-week="${w.number}">
            Semana ${w.number}<small>${esc(fmtDate(w.start))}–${esc(fmtDate(w.end))} · ${esc((w.phase || '').toLowerCase())}</small>
        </button>`).join('');

    const week = list.find((w) => w.number === state.week);
    const ready = state.engineReady;
    const training = state.plan.training;
    const peakKm = Math.max(...list.map((w) => w.planned_km));
    const start = training.current_long_km ? `partindo de longão de ${fmtKm(training.current_long_km)}` : 'longão inicial padrão da distância';
    $('#files-card').innerHTML = `
        <p class="small muted" style="margin:0 0 12px">Plano de ${list.length} ${list.length === 1 ? 'semana' : 'semanas'} · perfil ${esc(training.profile || '')} · ${esc(start)} · semana mais pesada ${esc(fmtKm(peakKm, 1))}. Semana ${esc(week.number)}: <b>${esc(week.phase || '')}</b>.</p>
        <div class="day-head">
            <div>
                <b>Arquivos para o relógio</b>
                <span class="pill ${ready ? 'ok' : 'rest'}" style="margin-left:8px">${ready ? 'Com a meta atual' : 'Preparando…'}</span>
                <div class="small muted"><code>${esc(week.folder)}</code> · ${esc(fmtKm(week.planned_km, 1))} planejados</div>
            </div>
            <button class="btn primary" id="week-zip" ${ready ? '' : 'disabled'}>Baixar semana (.zip)</button>
        </div>
        <details class="help">
            <summary>Como colocar a semana no relógio</summary>
            <ol class="small">
                <li>Ligue o relógio no computador pelo cabo de carga.</li>
                <li>Abra o relógio no Explorador de Arquivos → Armazenamento interno → <code>GARMIN</code> → <code>NewFiles</code>.</li>
                <li>Copie para lá os <code>.fit</code> desta semana (botões "Baixar .fit" ou de dentro do .zip). Só os arquivos, sem as pastas.</li>
                <li>Desconecte. Corrida: ${esc(state.plan.watch.paths?.run_workout || '')}. Força: ${esc(state.plan.watch.paths?.strength_workout || '')}.</li>
                <li>No domingo, apague no relógio os treinos da semana que passou.</li>
            </ol>
            <p class="small muted">A tela "Importar dados" do Garmin Connect recusa treinos. Treinos copiados pelo cabo ficam só no relógio.</p>
        </details>`;

    const today = todayISO();
    $('#days').innerHTML = week.days.map((day) => {
        const tag = day.race ? '<span class="pill race">Prova</span>' : day.rest ? '<span class="pill rest">Descanso</span>' : '';
        return `<article class="card day ${day.date === today ? 'today' : ''} ${day.date < today ? 'past' : ''}">
            <div class="day-head"><div class="when">${esc(day.weekday)}<span>${esc(fmtDate(day.date))}</span></div>${tag}</div>
            ${dayBody(day, true)}
        </article>`;
    }).join('');
}

/* ---------- calculadora ---------- */

function fillForm() {
    const s = state.settings;
    $('#f-model').value = s.model;
    $('#f-distance').value = s.distance;
    $('#f-pace').value = s.pace;
    $('#f-time').value = s.time;
    $('#f-tolerance').value = s.tolerance;
    $('#tolerance-out').textContent = s.tolerance;
    $('#f-split').value = s.split;
    $('#f-date').value = s.date;
    $('#f-event').value = s.event;
    $('#f-city').value = s.city;
    $('#f-start').value = s.start;
    $('#f-longao').value = s.longao;
    syncFormState();
}

function syncFormState() {
    const s = state.settings;
    $$('#mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === s.mode));
    $('#pace-field').style.opacity = s.mode === 'pace' ? 1 : .45;
    $('#time-field').style.opacity = s.mode === 'time' ? 1 : .45;
    $$('#distance-chips .chip').forEach((c) => c.classList.toggle('active', Number(c.dataset.distance) === Number(String(s.distance).replace(',', '.'))));
}

function updateSetting(key, value) {
    state.settings[key] = value;
    store.set('tm_settings', state.settings);
    syncFormState();
    scheduleLoad();
    if (key === 'model') scheduleWorkout();
}

function renderCalcResults() {
    const { target, pace_zone: zone, splits } = state.plan;
    const models = state.plan.models || [];
    $('#model-list').innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join('');
    const rows = splits.map((s, i) => `
        <tr class="${i === splits.length - 1 ? 'finish' : ''}">
            <td>${esc(fmtKm(s.mark_km, 4))}</td><td>${esc(s.segment_time)}</td><td>${esc(s.cumulative_time)}</td>
        </tr>`).join('');
    const timeNote = state.settings.mode === 'time' && state.settings.time
        ? `<p class="small muted" style="margin:10px 0 0">O pace é arredondado ao segundo. ${esc(target.pace)}/km fecha em ${esc(target.finish_time)}.</p>` : '';
    $('#calc-results').innerHTML = `
        <div class="card">
            <div class="grid stats">
                <div class="stat"><div class="label">Tempo</div><div class="value">${esc(target.finish_time)}</div></div>
                <div class="stat"><div class="label">Pace</div><div class="value">${esc(target.pace)} <small>/km</small></div></div>
                <div class="stat"><div class="label">Velocidade</div><div class="value">${esc(String(target.speed_kmh).replace('.', ','))} <small>km/h</small></div></div>
            </div>
            ${timeNote}
        </div>
        <div class="card">
            <h2>Faixa de pace (± ${esc(target.tolerance_seconds)} s)</h2>
            <div class="zone">
                <div class="fast"><div class="small muted">Rápido</div><div class="pace">${esc(zone.faster_pace)}</div><div class="time">${esc(zone.faster_finish)}</div></div>
                <div class="target"><div class="small muted">Alvo</div><div class="pace">${esc(zone.target_pace)}</div><div class="time">${esc(zone.target_finish)}</div></div>
                <div class="slow"><div class="small muted">Lento</div><div class="pace">${esc(zone.slower_pace)}</div><div class="time">${esc(zone.slower_finish)}</div></div>
            </div>
        </div>
        <div class="card">
            <h2>Parciais a cada ${esc(fmtKm(target.split_km))}</h2>
            <table><thead><tr><th>Marca</th><th>Trecho</th><th>Acumulado</th></tr></thead><tbody>${rows}</tbody></table>
            <p class="small muted" style="margin-bottom:0">No relógio, Auto Lap de 1 km. Esta tabela confere o acumulado.</p>
        </div>`;
}

/* ---------- relógio ---------- */

function renderWatch() {
    const w = state.plan.watch;
    const list = (items) => items.map((i) => `<li>${esc(i)}</li>`).join('');
    $('#watch').innerHTML = `
        <div class="card profile">
            <h2>${esc(w.model)} <span class="pill run" style="margin-left:6px">Linha ${esc(w.line)}</span></h2>
            <dl>
                <div><dt>Operação</dt><dd>${esc(w.input_style)}</dd></div>
                <div><dt>Navegação</dt><dd>${esc(w.navigation)}</dd></div>
                <div><dt>Métricas</dt><dd>${esc(w.metrics)}</dd></div>
                <div><dt>Bateria</dt><dd>${esc(w.battery)}</dd></div>
            </dl>
            <p class="small muted" style="margin-bottom:0">Troque o modelo na Calculadora.</p>
        </div>
        <div class="stack">
            <div class="card profile"><h2>Configuração</h2><ol>${list(w.setup_steps)}</ol></div>
            <div class="card profile"><h2>Telas e alertas</h2><ul>${list(w.screen_recommendations)}</ul></div>
            ${w.paths ? `<div class="card profile"><h2>Caminhos no relógio</h2><dl>
                <div><dt>Treino de corrida</dt><dd>${esc(w.paths.run_workout)}</dd></div>
                <div><dt>Treino de força</dt><dd>${esc(w.paths.strength_workout)}</dd></div>
                <div><dt>PacePro (prova)</dt><dd>${esc(w.paths.pacepro)}</dd></div>
                <div><dt>Percurso do mapa</dt><dd>${esc(w.paths.course)}</dd></div>
            </dl></div>` : ''}
            ${w.model_notes.length ? `<div class="card profile"><h2>Notas do modelo</h2><ul>${list(w.model_notes)}</ul></div>` : ''}
        </div>`;
    const course = $('#course-path');
    if (course && w.paths) course.textContent = w.paths.course;
}

/* ---------- montar treino ---------- */

const plainName = (text) => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function saveBuilder() {
    store.set('tm_workout', state.builder);
}

function workoutArgs() {
    const b = state.builder;
    const flags = {
        model: state.settings.model, avulso: b.kind, pace: b.pace, tolerance: b.tolerance, dia: b.day,
        aquecimento: b.warmup, desaquecimento: b.cooldown,
    };
    if (b.kind === 'tiros') Object.assign(flags, { tiros: b.reps, 'tiro-m': b.repM, recuperacao: b.recovery });
    else flags.km = b.km;
    if (b.kind === 'longao') flags['final-pace'] = b.finishKm;
    return Object.entries(flags).map(([flag, value]) => `--${flag}=${value}`);
}

async function loadWorkout() {
    const id = ++state.workoutId;
    try {
        const engine = await startEngine();
        if (id !== state.workoutId) return null;
        const data = JSON.parse(engine.workoutJson(JSON.stringify(workoutArgs())));
        if (data.error) throw new Error(data.error);
        state.workout = data;
        $('#b-error').textContent = '';
        $('#b-summary').classList.remove('stale');
        renderBuilderSummary();
        renderBuilderHowto();
        renderBuilderRoute();
        renderMapTargets();
        renderMapStats();
        return data;
    } catch (error) {
        if (id === state.workoutId) {
            $('#b-error').textContent = error.message;
            $('#b-summary').classList.add('stale');
        }
        return null;
    }
}

let workoutTimer;
function scheduleWorkout() {
    clearTimeout(workoutTimer);
    workoutTimer = setTimeout(loadWorkout, 250);
}

function fillBuilder() {
    const b = state.builder;
    $$('[data-b]').forEach((input) => { input.value = b[input.dataset.b]; });
    $('#b-tol-out').textContent = b.tolerance;
    syncBuilderFields();
}

function syncBuilderFields() {
    const { kind } = state.builder;
    $('#b-km-field').hidden = kind === 'tiros';
    $('#b-tiros-fields').hidden = kind !== 'tiros';
    $('#b-finish-field').hidden = kind !== 'longao';
    $('#b-pace-label').textContent = {
        leve: 'Pace estimado (só para calcular o tempo)',
        tiros: 'Pace dos tiros (min/km)',
        longao: 'Pace do final e da estimativa (min/km)',
    }[kind] || 'Pace alvo (min/km)';
    $$('#b-types .choice').forEach((c) => c.classList.toggle('active', c.dataset.kind === kind));
}

function renderBuilderChoices() {
    const { watch, target } = state.plan;
    const models = state.plan.models || [];
    const list = models.some((m) => plainName(m) === plainName(watch.model)) ? models : [watch.model, ...models];
    $('#b-watches').innerHTML = list.map((m) => `
        <button type="button" class="choice ${plainName(m) === plainName(watch.model) ? 'active' : ''}" data-watch="${esc(m)}"><b>${esc(m)}</b></button>`).join('');
    $('#b-watch-info').textContent = `${watch.model} · linha ${watch.line}${watch.exact_model ? '' : ' (perfil geral da linha)'}. ${watch.input_style}`;
    $('#b-types').innerHTML = (state.plan.workout_types || []).map((t) => `
        <button type="button" class="choice" data-kind="${esc(t.key)}"><b>${esc(t.title)}</b><small>${esc(t.description)}</small></button>`).join('');
    $('#b-pace-chips').innerHTML = `<button type="button" class="chip" data-set="pace" data-value="${esc(target.pace)}">Pace da prova ${esc(target.pace)}</button>`;
    syncBuilderFields();
}

function stepItem(step) {
    const target = step.target_text !== 'livre' ? ` · ${step.target_text}` : '';
    const time = step.target === 'pace' || step.intensity !== 'active' ? fmtDuration(step.seconds) : `≈ ${fmtDuration(step.seconds)}`;
    return `<li class="${esc(step.target)} ${esc(step.intensity)}"><span><b>${esc(step.duration)}</b> · ${esc(step.label)}${esc(target)}</span><span class="seg-time">${esc(time)}</span></li>`;
}

function renderBuilderSummary() {
    if (!state.workout) return;
    const w = state.workout.workout;
    const blocks = w.blocks.map((block) => {
        const items = `<ul class="segments">${block.steps.map(stepItem).join('')}</ul>`;
        return block.repeat > 1 ? `<div class="repeat"><b>Repetir ${block.repeat} ×</b>${items}</div>` : items;
    }).join('');
    const timed = w.blocks.some((b) => b.steps.some((s) => / (min|s)$/.test(s.duration)));
    $('#b-summary').innerHTML = `
        <div class="eyebrow">${esc(w.type)} · ${esc(fmtDate(w.day, { weekday: 'short', day: '2-digit', month: '2-digit' }))}</div>
        <h2>${esc(w.name)}</h2>
        <div class="map-stats">
            <div class="stat"><div class="label">Distância</div><div class="value">${esc(fmtKm(w.distance_km))}</div></div>
            <div class="stat"><div class="label">Tempo estimado</div><div class="value">${esc(fmtDuration(w.estimated_seconds))}</div></div>
        </div>
        <p class="small muted" style="margin:0 0 8px">Pace ${esc(w.pace)}/km, faixa ${esc(w.faster_pace)}–${esc(w.slower_pace)}. ${esc(w.fit_steps)} etapas no relógio.${timed ? ' A distância conta só as etapas em km; as etapas por tempo somam no tempo estimado.' : ''}</p>
        ${blocks}
        <div class="actions">
            <button class="btn primary" type="button" data-download-workout>Baixar treino .fit</button>
            <button class="btn" type="button" data-download-gpx ${routeCoords().length > 1 ? '' : 'disabled'}>Baixar percurso .gpx</button>
        </div>
        <p class="small muted" style="margin-bottom:0">Arquivo: <code>${esc(w.file.split('/').pop())}</code></p>`;
}

function renderBuilderHowto() {
    if (!state.workout) return;
    const { workout: w, watch } = state.workout;
    const alert = {
        leve: 'O alerta é de frequência cardíaca: acima da zona 2, o relógio vibra e avisa.',
        longao: 'No trecho leve, o alerta é de frequência cardíaca na zona 2; no final, de pace.',
    }[w.kind] || `Fora da faixa ${w.faster_pace}–${w.slower_pace}, o relógio vibra e avisa.`;
    $('#b-howto-sub').textContent = `Passo a passo para o ${watch.model}. Leva uns 2 minutos.`;
    $('#b-howto').innerHTML = `
        <ol class="howto">
            <li><b>Baixe o treino</b> no botão "Baixar treino .fit" do resumo. O arquivo é <code>${esc(w.file.split('/').pop())}</code>.</li>
            <li><b>Ligue o ${esc(watch.model)} ao computador</b> com o cabo de carga.</li>
            <li><b>Abra a pasta do relógio.</b> Windows: Explorador de Arquivos → <code>${esc(watch.model)}</code> → Armazenamento interno → <code>GARMIN</code> → <code>NewFiles</code>. Mac: se o relógio não aparecer no Finder, use o app gratuito OpenMTP.</li>
            <li><b>Copie o arquivo para <code>NewFiles</code></b> e desconecte o cabo. O relógio coloca o treino na lista de treinos com o nome <b>${esc(w.name)}</b>.</li>
            <li><b>No relógio, comece o treino:</b><br><span class="watch-path">${esc(watch.paths.run_workout)}</span></li>
            <li><b>Durante a corrida</b>, a tela do treino mostra a etapa, o alvo e o que falta. ${esc(alert)} As etapas por tempo e por distância passam sozinhas.${w.kind === 'tiros' ? ' Nos tiros, o relógio mostra em qual repetição você está.' : ''}</li>
        </ol>
        <details class="help">
            <summary>Também quero o percurso do mapa no relógio</summary>
            <ol class="small">
                <li>Desenhe o percurso no passo 3 e clique em "Baixar percurso .gpx".</li>
                <li>No computador, em <a href="https://connect.garmin.com/modern/courses" target="_blank" rel="noopener">Garmin Connect → Treinamento e planejamento → Percursos</a>, clique em <b>Importar</b>, escolha o arquivo e salve como corrida.</li>
                <li>Abra o percurso, clique em <b>Enviar para o dispositivo</b> e sincronize o relógio pelo app Garmin Connect.</li>
                <li>No relógio: <span class="watch-path">${esc(watch.paths.course)}</span></li>
            </ol>
        </details>
        <details class="help">
            <summary>O treino não apareceu no relógio</summary>
            <ul class="small">
                <li>Copie o arquivo <code>.fit</code> solto, não a pasta nem um <code>.zip</code>.</li>
                <li>Desconecte o cabo antes de procurar. Se ainda não aparecer, reinicie o relógio.</li>
                <li>A tela "Importar dados" do Garmin Connect e o app do celular não aceitam treinos. O caminho é o cabo.</li>
                <li>Treinos copiados pelo cabo ficam só no relógio. Apague os antigos na lista de treinos do relógio.</li>
            </ul>
        </details>
        <div class="actions"><button class="btn" type="button" data-manual="Montar treino">Ver o passo a passo no manual</button></div>`;
}

function renderBuilderRoute() {
    const box = $('#b-route');
    if (!box) return;
    const coords = routeCoords();
    const gpx = $('[data-download-gpx]');
    if (gpx) gpx.disabled = coords.length < 2;
    $('#b-use-route').disabled = coords.length < 2 || state.builder.kind === 'tiros';
    if (coords.length < 2) {
        box.innerHTML = '<p class="small muted" style="margin:0">Nenhum percurso desenhado ainda.</p>';
        return;
    }
    const km = routeMeters() / 1000;
    const start = $('#route-start').value || 'início';
    const end = $('#route-end').value || 'chegada';
    const goal = state.builder.kind !== 'tiros' ? state.workout?.workout.distance_km : 0;
    const diff = goal ? km - goal : 0;
    let note = '';
    if (goal) {
        if (Math.abs(diff) < 0.2) note = 'Bate com a distância do treino.';
        else if (diff < 0) note = `Faltam ${fmtKm(-diff)} para os ${fmtKm(goal)} do treino.`;
        else note = `Passa ${fmtKm(diff)} dos ${fmtKm(goal)} do treino.`;
    }
    box.innerHTML = `<p style="margin:0"><b>${esc(fmtKm(km))}</b> · ${esc(start)} → ${esc(end)} · ${mapState.stops.length} ${mapState.stops.length === 1 ? 'parada' : 'paradas'}</p>
        ${note ? `<p class="small muted" style="margin:4px 0 0">${esc(note)}</p>` : ''}`;
}

function setBuilder(key, value) {
    state.builder[key] = String(value);
    saveBuilder();
    fillBuilder();
    renderBuilderRoute();
    scheduleWorkout();
}

function chooseKind(kind) {
    const type = (state.plan?.workout_types || []).find((t) => t.key === kind);
    Object.assign(state.builder, { kind }, type ? { warmup: String(type.warmup), cooldown: String(type.cooldown) } : {});
    saveBuilder();
    fillBuilder();
    renderBuilderRoute();
    scheduleWorkout();
}

function stepBuilder(key, delta) {
    const b = state.builder;
    if (key === 'pace') {
        const [m, s] = String(b.pace).split(':').map(Number);
        const current = Number.isFinite(m * 60 + s) ? m * 60 + s : paceSeconds(state.settings.pace);
        const total = Math.min(3599, Math.max(60, current + delta));
        setBuilder('pace', `${pad(Math.floor(total / 60))}:${pad(total % 60)}`);
        return;
    }
    const number = Number(String(b[key]).replace(',', '.')) || 0;
    const [low, high] = { km: [0.5, 100], reps: [1, 40], finishKm: [0, Math.max(0, Math.floor(Number(b.km) - 1))] }[key];
    setBuilder(key, Math.min(high, Math.max(low, Math.round((number + delta) * 10) / 10)));
}

function chooseWatch(model) {
    const name = String(model).trim();
    if (!name) return;
    $$('#b-watches .choice').forEach((c) => c.classList.toggle('active', plainName(c.dataset.watch) === plainName(name)));
    $('#f-model').value = name;
    updateSetting('model', name);
}

function useRouteInWorkout() {
    const km = Math.round((routeMeters() / 1000) * 10) / 10;
    if (km < 0.5) return toast('Desenhe o percurso no mapa primeiro.');
    if (state.builder.kind === 'tiros') return toast('No intervalado, a distância vem dos tiros.');
    setBuilder('km', km);
    toast(`Treino ajustado para ${fmtKm(km, 1)}.`);
}

function drawOnMap() {
    showTab('mapa');
    const select = $('#map-target');
    if ([...select.options].some((o) => o.value === 'workout')) select.value = 'workout';
    renderMapStats();
}

async function downloadWorkout(button) {
    button.disabled = true;
    try {
        const data = await loadWorkout();
        if (!data) throw new Error($('#b-error').textContent || 'Confira os campos do treino.');
        const engine = await startEngine();
        const { file } = data.workout;
        download(engine.fs.readFile(`${engine.root}/${file}`), file.split('/').pop(), 'application/octet-stream');
        toast('Treino baixado. Copie para GARMIN\\NewFiles no relógio.');
    } catch (error) {
        toast(error.message);
    } finally {
        button.disabled = false;
    }
}

/* ---------- treinador IA ---------- */

const COACH_FIELDS = {
    model: ['Relógio', 'Modelo Garmin, ex.: Forerunner 265, Vivoactive 6'],
    distance: ['Distância (km)', 'Distância da prova em km com ponto decimal: 5, 10, 21.0975, 42.195 ou outra'],
    date: ['Data da prova', 'AAAA-MM-DD'],
    mode: ['Meta por', 'pace ou time: qual campo define a meta'],
    pace: ['Pace', 'mm:ss por km, usado com mode pace'],
    time: ['Tempo alvo', 'h:mm:ss, usado com mode time'],
    event: ['Prova', 'Nome da prova'],
    city: ['Cidade', 'Cidade da prova'],
    start: ['Início do plano', 'AAAA-MM-DD, normalmente hoje'],
    longao: ['Longão atual (km)', 'Maior longão das últimas 4 semanas em km; vazio usa o padrão da distância'],
};

const COACH_SCHEMA = {
    type: 'object',
    properties: {
        reply: { type: 'string', description: 'Resposta ao corredor em português do Brasil, texto simples, listas com "- ".' },
        settings: {
            type: 'object',
            description: 'Só os campos da meta que devem mudar. Omita quando nada muda ou faltam dados.',
            properties: Object.fromEntries(Object.entries(COACH_FIELDS).map(([key, [, description]]) => (
                [key, key === 'mode' ? { type: 'string', enum: ['pace', 'time'] } : { type: 'string', description }]
            ))),
        },
    },
    required: ['reply'],
};

const COACH_RULES = `Você é o treinador de corrida do app Treinador Maratona, para corredores amadores. Fale em português do Brasil, com frases curtas, tom de treinador experiente e prático.

Como o app funciona:
- O motor do app monta o plano (até 16 semanas terminando no dia da prova; fases Construção, Recuperação, Pico, Polimento), calcula pace, faixa, parciais e gera os treinos .fit. Você não calcula: nunca invente pace, tempo final, parciais ou quilometragem; cite só números do resumo abaixo.
- Você muda o plano propondo campos em "settings". O corredor confirma num botão e o motor recalcula. Proponha só com os dados necessários; antes disso pergunte, no máximo duas perguntas por vez.
- Para montar um plano: distância e data da prova, meta (pace ou tempo) e o maior longão das últimas 4 semanas. Relógio, nome da prova e cidade são opcionais. Ao montar um plano novo, proponha start com a data de hoje.
- Sem meta definida, sugira um pace realista a partir de uma prova recente ou do pace confortável, deixando claro que é estimativa.
- O motor não muda os dias da semana nem o número de treinos. Se pedirem, explique como trocar dias mantendo o longão e um dia leve ou de descanso depois de treino forte.
- Treinos no relógio: aba Semanas, "Baixar .fit" ou "Baixar semana (.zip)", copiar pelo cabo para GARMIN/NewFiles. Percursos: aba Mapa, desenhar, "Baixar GPX", Garmin Connect → Percursos → Importar.

Segurança: você não é médico. Dor aguda, dor no peito, tontura, falta de ar fora do normal ou suspeita de lesão: oriente parar e procurar um médico. Não aumente volume além do plano.`;

function coachPrompt() {
    const s = state.settings;
    const lines = [COACH_RULES, '', `Hoje: ${todayISO()}.`,
        `Meta atual: ${JSON.stringify(Object.fromEntries(Object.keys(COACH_FIELDS).map((key) => [key, s[key]])))}`];
    const plan = state.plan;
    if (plan) {
        const { target, pace_zone: zone, event, watch, training } = plan;
        lines.push(
            `Resultado do motor: ${target.distance_km} km, pace ${target.pace}/km, tempo ${target.finish_time}, faixa ${zone.faster_pace} a ${zone.slower_pace}.`,
            `Prova: ${event.name}, ${event.city}, ${event.date}. Relógio: ${watch.model} (linha ${watch.line}). Perfil ${training.profile}, longão de pico ${training.peak_long_km} km.`,
            `Caminhos no relógio: corrida ${watch.paths?.run_workout}; força ${watch.paths?.strength_workout}; PacePro ${watch.paths?.pacepro}.`,
            'Plano (marcado [feito] o que o corredor concluiu):',
        );
        weeks().forEach((w) => {
            lines.push(`Semana ${w.number}, ${w.start} a ${w.end}, ${w.phase}, ${w.planned_km} km:`);
            w.days.forEach((d) => {
                const items = [];
                if (d.race) items.push('PROVA');
                if (d.run) items.push(`${d.run.name} ${d.run.distance_km} km${isDone(d, 'run') ? ' [feito]' : ''}`);
                if (d.strength) items.push(`força ${d.strength.name}${isDone(d, 'strength') ? ' [feito]' : ''}`);
                lines.push(`- ${d.date} ${d.weekday}: ${items.join(' + ') || 'descanso'}`);
            });
        });
        if (plan.models?.length) lines.push(`Relógios com perfil próprio: ${plan.models.join(', ')}.`);
    }
    return lines.join('\n');
}

function saveChat() {
    state.chat = state.chat.slice(-CHAT_KEEP);
    store.set('tm_chat', state.chat);
}

function richText(text) {
    const html = [];
    let items = [];
    const inline = (value) => esc(value).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const flush = () => {
        if (items.length) html.push(`<ul>${items.join('')}</ul>`);
        items = [];
    };
    String(text).split('\n').forEach((line) => {
        const item = line.match(/^\s*[-*•]\s+(.*)/);
        if (item) {
            items.push(`<li>${inline(item[1])}</li>`);
            return;
        }
        flush();
        if (line.trim()) html.push(`<p>${inline(line)}</p>`);
    });
    flush();
    return html.join('');
}

function proposalHtml(message, index) {
    const rows = Object.entries(message.settings).map(([key, value]) => `
        <tr><td>${esc(COACH_FIELDS[key][0])}</td><td class="muted">${esc(message.previous?.[key] || '—')}</td><td><b>${esc(value || '—')}</b></td></tr>`).join('');
    const status = {
        pendente: `<div class="actions"><button class="btn primary" data-apply="${index}">Aplicar ao plano</button><button class="btn" data-ignore="${index}">Ignorar</button></div>`,
        aplicada: '<span class="pill ok">Aplicada</span>',
        ignorada: '<span class="pill rest">Ignorada</span>',
        recusada: '<span class="pill rest">Recusada pelo motor</span>',
    }[message.status] || '';
    return `<div class="proposal"><b class="small">Proposta para a meta</b>
        <table><thead><tr><th>Campo</th><th>Agora</th><th>Novo</th></tr></thead><tbody>${rows}</tbody></table>${status}</div>`;
}

function renderChat(waiting = state.asking) {
    const box = $('#chat');
    if (!box) return;
    const intro = `Olá! Sou o seu treinador. Me conte qual prova você vai correr (distância e data), o seu maior longão nas últimas 4 semanas e o tempo que quer fazer, ou um tempo recente em 5 ou 10 km. Eu proponho a meta, você aplica e o app gera o plano e os treinos para o relógio.${state.ai.key ? '' : '\n\nAntes, cole a sua chave grátis do Gemini no painel ao lado.'}`;
    const html = state.chat.length
        ? state.chat.map((m, i) => `<div class="msg ${esc(m.role)}">${richText(m.text)}${m.settings ? proposalHtml(m, i) : ''}${m.goto ? `<div class="actions"><button class="btn" data-goto="${esc(m.goto)}">Abrir ${esc(m.goto === 'semanas' ? 'Semanas' : m.goto)}</button></div>` : ''}</div>`).join('')
        : `<div class="msg model">${richText(intro)}</div>`;
    box.innerHTML = html + (waiting ? '<div class="msg model typing">Pensando…</div>' : '');
    box.scrollTop = box.scrollHeight;
    $('#chat-send').disabled = waiting;
    $$('#coach-quick .chip').forEach((chip) => { chip.disabled = waiting; });
}

function renderAiSetup() {
    const { key, model } = state.ai;
    $('#ai-status').textContent = key ? `Chave salva neste navegador (termina em ${key.slice(-4)}).` : 'Sem chave: o treinador precisa dela para conversar.';
    $('#ai-key').value = '';
    $('#ai-key').placeholder = key ? '•••••••• (salva)' : 'AIza…';
    $('#ai-model').value = model || AI_MODEL;
}

function saveAiKey() {
    const key = $('#ai-key').value.trim();
    if (!key && !state.ai.key) return toast('Cole a chave antes de salvar.');
    if (key) state.ai.key = key;
    state.ai.model = $('#ai-model').value.trim().replace(/^models\//, '') || AI_MODEL;
    store.set('tm_ai', state.ai);
    renderAiSetup();
    renderChat();
    toast('Chave salva neste navegador.');
}

function forgetAiKey() {
    state.ai.key = '';
    store.set('tm_ai', state.ai);
    renderAiSetup();
    renderChat();
    toast('Chave apagada deste navegador.');
}

function cleanProposal(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const proposal = {};
    Object.keys(COACH_FIELDS).forEach((key) => {
        if (typeof raw[key] !== 'string') return;
        let value = raw[key].trim();
        if (key === 'distance' || key === 'longao') value = value.replace(',', '.').replace(/\s*km$/i, '');
        if (key === 'mode' && !['pace', 'time'].includes(value)) return;
        if (value !== String(state.settings[key] ?? '')) proposal[key] = value;
    });
    if (proposal.pace && !proposal.mode && state.settings.mode !== 'pace') proposal.mode = 'pace';
    if (proposal.time && !proposal.mode && state.settings.mode !== 'time') proposal.mode = 'time';
    return Object.keys(proposal).length ? proposal : null;
}

function aiError(status, data) {
    const message = data?.error?.message || '';
    if (status === 400 && /api key/i.test(message)) return 'Chave inválida. Confira a chave em aistudio.google.com/apikey.';
    if (status === 403) return 'A chave não tem permissão para o Gemini. Gere uma nova no AI Studio.';
    if (status === 404) return `Modelo "${state.ai.model}" não encontrado. Em Avançado, use ${AI_MODEL}.`;
    if (status === 429) return 'Limite grátis da chave atingido. Espere um minuto e tente de novo.';
    if (status >= 500) return 'O Gemini está instável agora. Tente de novo em instantes.';
    return message || `Erro ${status} no Gemini.`;
}

async function askCoach(text) {
    const question = text.trim();
    if (!question || state.asking) return;
    if (!state.ai.key) {
        toast('Cole a chave do Gemini no painel ao lado.');
        $('#ai-key').focus();
        return;
    }
    state.chat.push({ role: 'user', text: question });
    saveChat();
    state.asking = true;
    renderChat();
    try {
        const history = state.chat.filter((m) => m.role === 'user' || m.role === 'model').slice(-AI_HISTORY);
        while (history.length && history[0].role !== 'user') history.shift();
        const contents = history.map((m) => ({
            role: m.role,
            parts: [{ text: m.settings ? `${m.text}\n[Proposta ${m.status}: ${JSON.stringify(m.settings)}]` : m.text }],
        }));
        const response = await fetch(`${AI_URL}/${encodeURIComponent(state.ai.model || AI_MODEL)}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': state.ai.key },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: coachPrompt() }] },
                contents,
                generationConfig: { responseMimeType: 'application/json', responseJsonSchema: COACH_SCHEMA },
            }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(aiError(response.status, data));
        const raw = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
        if (!raw) throw new Error('O Gemini não respondeu a esta mensagem. Reformule e tente de novo.');
        const answer = JSON.parse(raw);
        const settings = cleanProposal(answer.settings);
        const message = { role: 'model', text: String(answer.reply || '').trim() || 'Proposta pronta.' };
        if (settings) {
            Object.assign(message, {
                settings,
                previous: Object.fromEntries(Object.keys(settings).map((key) => [key, String(state.settings[key] ?? '')])),
                status: 'pendente',
            });
        }
        state.chat.push(message);
    } catch (error) {
        state.chat.push({ role: 'error', text: error instanceof SyntaxError ? 'Resposta da IA veio fora do formato. Tente de novo.' : error.message });
    } finally {
        state.asking = false;
        saveChat();
        renderChat();
    }
}

async function applyProposal(index) {
    const message = state.chat[index];
    if (!message?.settings || message.status !== 'pendente') return;
    const previous = { ...state.settings };
    Object.assign(state.settings, message.settings);
    store.set('tm_settings', state.settings);
    fillForm();
    message.status = 'aplicada';
    saveChat();
    renderChat();
    const ok = await loadPlan();
    if (ok === false) {
        const reason = $('#calc-error').textContent;
        state.settings = previous;
        store.set('tm_settings', state.settings);
        fillForm();
        message.status = 'recusada';
        state.chat.push({ role: 'error', text: `O motor recusou a proposta: ${reason} Peça outro ajuste ao treinador.` });
        loadPlan();
    } else if (ok) {
        const { target } = state.plan;
        state.chat.push({
            role: 'note',
            text: `Plano recalculado: ${weeks().length} semanas, ${fmtKm(target.distance_km, 4)} em ${target.finish_time} (pace ${target.pace}/km). Os treinos .fit estão na aba Semanas.`,
            goto: 'semanas',
        });
    }
    saveChat();
    renderChat();
}

function ignoreProposal(index) {
    const message = state.chat[index];
    if (message?.status !== 'pendente') return;
    message.status = 'ignorada';
    saveChat();
    renderChat();
}

function clearChat() {
    state.chat = [];
    saveChat();
    renderChat();
}

/* ---------- manual ---------- */

function loadManual() {
    state.manualTask ??= (async () => {
        try {
            const text = await (await fetch('PLANO_MARATONA_GARMIN.md', { cache: 'no-store' })).text();
            $('#manual').innerHTML = window.marked ? window.marked.parse(text) : `<pre>${esc(text)}</pre>`;
        } catch {
            state.manualTask = null;
            $('#manual').innerHTML = '<p class="muted">Não consegui abrir PLANO_MARATONA_GARMIN.md.</p>';
        }
    })();
    return state.manualTask;
}

async function openManual(title) {
    showTab('manual');
    await loadManual();
    const heading = $$('#manual h2, #manual h3, #manual h4').find((h) => h.textContent.startsWith(title));
    heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- mapa ---------- */

const mapState = {
    map: null, line: null, marks: null, segments: [], stops: [], busy: false,
    mode: 'route', past: [], future: [], endTimer: null,
};
const HISTORY_MAX = 100;
const SAME_PLACE_M = 30;
const OFF_ROUTE_M = 100;

function distanceMeters(a, b) {
    const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b[0] - a[0]);
    const dLng = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const routeCoords = () => mapState.segments.flat();

function routeMeters(coords = routeCoords()) {
    let total = 0;
    for (let i = 1; i < coords.length; i += 1) total += distanceMeters(coords[i - 1], coords[i]);
    return total;
}

function kmMarks(coords) {
    const marks = [];
    let walked = 0;
    let next = 1000;
    for (let i = 1; i < coords.length; i += 1) {
        const a = coords[i - 1];
        const b = coords[i];
        const d = distanceMeters(a, b);
        while (d > 0 && walked + d >= next) {
            const f = (next - walked) / d;
            marks.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
            next += 1000;
        }
        walked += d;
    }
    return marks;
}

function initMap() {
    if (mapState.map) {
        setTimeout(() => mapState.map.invalidateSize(), 50);
        return;
    }
    if (!window.L) {
        $('#map').innerHTML = '<p class="muted" style="padding:20px">O mapa precisa de internet para carregar o Leaflet e o OpenStreetMap.</p>';
        return;
    }
    const map = L.map('map').setView(RECIFE, 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; colaboradores do OpenStreetMap',
    }).addTo(map);
    mapState.line = L.polyline([], { color: '#fc5200', weight: 5, opacity: .9 }).addTo(map);
    mapState.marks = L.layerGroup().addTo(map);
    map.on('click', (e) => {
        const point = [e.latlng.lat, e.latlng.lng];
        if (mapState.mode === 'stop') addStop(point);
        else addPoint(point);
    });
    mapState.map = map;
    renderSaved();
    renderMapTargets();
    redrawRoute();
}

async function snapRoute(from, to) {
    const url = `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.code !== 'Ok' || !data.routes?.length) throw new Error('sem rota');
    return data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
}

async function connect(from, to) {
    if (!$('#map-snap').checked) return [to];
    mapState.busy = true;
    $('#busy').textContent = 'Traçando rota…';
    $('#busy').classList.add('on');
    try {
        return (await snapRoute(from, to)).slice(1);
    } catch {
        toast('Rota por ruas indisponível aqui. Liguei em linha reta.');
        return [to];
    } finally {
        mapState.busy = false;
        $('#busy').classList.remove('on');
    }
}

function placeField(which) {
    return $(which === 'start' ? '#route-start' : '#route-end');
}

function setPlace(which, text, auto) {
    const input = placeField(which);
    input.value = text;
    input.dataset.auto = auto ? '1' : '';
}

function snapshot() {
    return JSON.stringify({
        segments: mapState.segments,
        stops: mapState.stops,
        start: [placeField('start').value, placeField('start').dataset.auto],
        end: [placeField('end').value, placeField('end').dataset.auto],
    });
}

function restore(saved) {
    const data = JSON.parse(saved);
    mapState.segments = data.segments;
    mapState.stops = data.stops;
    setPlace('start', data.start[0], data.start[1]);
    setPlace('end', data.end[0], data.end[1]);
    redrawRoute();
    const coords = routeCoords();
    if (coords.length && !data.start[0]) fillPlace('start', coords[0]);
    if (!data.end[0]) syncEndPlace();
    mapState.stops.filter((s) => s.auto && !s.name).forEach((s) => fillStopName(s.id));
}

function commit() {
    mapState.past.push(snapshot());
    if (mapState.past.length > HISTORY_MAX) mapState.past.shift();
    mapState.future = [];
}

function undoRoute() {
    if (mapState.busy || !mapState.past.length) return;
    mapState.future.push(snapshot());
    restore(mapState.past.pop());
}

function redoRoute() {
    if (mapState.busy || !mapState.future.length) return;
    mapState.past.push(snapshot());
    restore(mapState.future.pop());
}

async function placeName([lat, lng]) {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${lat}&lon=${lng}`;
        const data = await (await fetch(url, { headers: { 'Accept-Language': 'pt-BR' } })).json();
        const a = data.address || {};
        const street = a.road || a.pedestrian || a.footway || a.path || data.name;
        const area = a.suburb || a.neighbourhood || a.city_district || a.city || a.town;
        return [street, area].filter(Boolean).join(', ') || String(data.display_name || '').split(',').slice(0, 2).join(',');
    } catch {
        return '';
    }
}

async function fillPlace(which, point) {
    const input = placeField(which);
    if (input.value && !input.dataset.auto) return;
    const name = await placeName(point);
    const coords = routeCoords();
    const current = which === 'start' ? coords[0] : coords[coords.length - 1];
    if (!name || !current || distanceMeters(current, point) > 1) return;
    if (input.value && !input.dataset.auto) return;
    setPlace(which, name, true);
}

function syncEndPlace() {
    clearTimeout(mapState.endTimer);
    const coords = routeCoords();
    if (coords.length < 2) {
        if (placeField('end').dataset.auto) setPlace('end', '', true);
        return;
    }
    const last = coords[coords.length - 1];
    if (distanceMeters(coords[0], last) < SAME_PLACE_M) {
        if (!placeField('end').value || placeField('end').dataset.auto) setPlace('end', placeField('start').value, true);
        return;
    }
    mapState.endTimer = setTimeout(() => fillPlace('end', last), 1200);
}

async function addPoint(point) {
    if (mapState.busy) return;
    commit();
    if (!mapState.segments.length) {
        mapState.segments.push([point]);
        fillPlace('start', point);
    } else {
        const coords = routeCoords();
        mapState.segments.push(await connect(coords[coords.length - 1], point));
    }
    redrawRoute();
    syncEndPlace();
}

function projectOnRoute(point, coords = routeCoords()) {
    let best = { meters: Infinity, km: 0 };
    let walked = 0;
    const cos = Math.cos((point[0] * Math.PI) / 180);
    for (let i = 1; i < coords.length; i += 1) {
        const a = coords[i - 1];
        const b = coords[i];
        const length = distanceMeters(a, b);
        const dx = (b[1] - a[1]) * cos;
        const dy = b[0] - a[0];
        const span = dx * dx + dy * dy;
        const t = span ? Math.min(1, Math.max(0, (((point[1] - a[1]) * cos) * dx + (point[0] - a[0]) * dy) / span)) : 0;
        const foot = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const meters = distanceMeters(point, foot);
        if (meters < best.meters) best = { meters, km: (walked + length * t) / 1000, foot };
        walked += length;
    }
    return best;
}

function orderedStops() {
    const coords = routeCoords();
    return mapState.stops
        .map((stop) => ({ ...stop, ...projectOnRoute([stop.lat, stop.lng], coords) }))
        .sort((a, b) => a.km - b.km);
}

async function fillStopName(id) {
    const stop = mapState.stops.find((s) => s.id === id);
    if (!stop || !stop.auto) return;
    const name = await placeName([stop.lat, stop.lng]);
    const current = mapState.stops.find((s) => s.id === id);
    if (!name || !current || !current.auto) return;
    current.name = name;
    const input = $(`[data-stop-name="${id}"]`);
    if (input && document.activeElement !== input) input.value = name;
    drawMarks();
}

function onRoute(point) {
    const near = projectOnRoute(point);
    return near.meters <= OFF_ROUTE_M ? near.foot : point;
}

function addStop(point) {
    if (routeCoords().length < 2) return toast('Trace o caminho antes de marcar paradas.');
    commit();
    const [lat, lng] = onRoute(point);
    const stop = { id: Date.now(), lat, lng, name: '', auto: true };
    mapState.stops.push(stop);
    redrawRoute();
    fillStopName(stop.id);
}

function removeStop(id) {
    commit();
    mapState.stops = mapState.stops.filter((s) => s.id !== id);
    redrawRoute();
}

function pinIcon(label, kind) {
    return L.divIcon({
        className: 'pin-icon',
        html: `<div class="pin ${kind}"><span>${esc(label)}</span></div>`,
        iconSize: [30, 40],
        iconAnchor: [15, 38],
        tooltipAnchor: [0, -34],
    });
}

function drawMarks() {
    const coords = routeCoords();
    mapState.marks.clearLayers();
    kmMarks(coords).forEach((p, i) => {
        L.marker(p, { icon: L.divIcon({ className: 'km-icon', html: String(i + 1), iconSize: [22, 22] }), interactive: false }).addTo(mapState.marks);
    });
    if (!coords.length) return;
    const first = coords[0];
    const last = coords[coords.length - 1];
    const loop = coords.length > 1 && distanceMeters(first, last) < SAME_PLACE_M;
    const startName = placeField('start').value;
    if (coords.length > 1 && !loop) {
        L.marker(last, { icon: pinIcon('F', 'end'), zIndexOffset: 900 })
            .bindTooltip(`Chegada${placeField('end').value ? `: ${esc(placeField('end').value)}` : ''}`).addTo(mapState.marks);
    }
    L.marker(first, { icon: pinIcon(loop ? 'I·F' : 'I', 'start'), zIndexOffset: 1000 })
        .bindTooltip(`${loop ? 'Início e chegada' : 'Início'}${startName ? `: ${esc(startName)}` : ''}`).addTo(mapState.marks);
    orderedStops().forEach((stop, i) => {
        const marker = L.marker([stop.lat, stop.lng], { icon: pinIcon(`P${i + 1}`, 'stop'), draggable: true, zIndexOffset: 800 })
            .bindTooltip(`Parada ${i + 1}${stop.name ? `: ${esc(stop.name)}` : ''} · km ${esc(stop.km.toFixed(1).replace('.', ','))}`)
            .addTo(mapState.marks);
        marker.on('dragstart', commit);
        marker.on('dragend', () => {
            const moved = mapState.stops.find((s) => s.id === stop.id);
            const { lat, lng } = marker.getLatLng();
            const [onLat, onLng] = onRoute([lat, lng]);
            Object.assign(moved, { lat: onLat, lng: onLng });
            redrawRoute();
            fillStopName(stop.id);
        });
    });
}

function renderStops() {
    const list = orderedStops();
    const pace = state.plan ? mapPace().seconds : 0;
    $('#stop-count').textContent = list.length;
    $('#stop-list').innerHTML = list.length
        ? list.map((stop, i) => {
            const where = stop.meters > OFF_ROUTE_M
                ? `<small class="off">Fora do percurso (${Math.round(stop.meters)} m). Arraste o alfinete para o caminho.</small>`
                : `<small>km ${esc(stop.km.toFixed(1).replace('.', ','))}${pace ? ` · chega em ≈ ${esc(fmtDuration(stop.km * pace))} no pace` : ''}</small>`;
            return `<li><span class="tag">P${i + 1}</span>
                <input data-stop-name="${stop.id}" value="${esc(stop.name)}" placeholder="Nome da parada" maxlength="60">
                <button type="button" data-stop-remove="${stop.id}" title="Excluir parada">×</button>${where}</li>`;
        }).join('')
        : '<li class="small muted" style="display:block">Nenhuma parada. Use "Marcar parada" e clique no caminho onde vai parar (água, banheiro, encontro).</li>';
}

function renderMapHint() {
    const points = routeCoords().length;
    let hint;
    if (!points) hint = 'Passo 1: clique no mapa para fincar o alfinete de início, ou digite o local de início e aperte Enter.';
    else if (points === 1) hint = 'Passo 2: clique nos pontos do caminho. Cada clique segue as ruas até lá. O último ponto é a chegada.';
    else if (mapState.mode === 'stop') hint = 'Clique no caminho onde você vai parar. Arraste o alfinete azul para ajustar.';
    else hint = 'Continue o caminho, marque paradas ou baixe o GPX. Errou? Desfazer (Ctrl+Z) e Refazer (Ctrl+Y).';
    $('#map-hint').textContent = hint;
}

function setMapMode(mode) {
    mapState.mode = mode;
    $$('#map-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mapMode === mode));
    renderMapHint();
}

function redrawRoute() {
    if (!mapState.map) return;
    mapState.line.setLatLngs(routeCoords());
    drawMarks();
    renderStops();
    renderMapHint();
    $('#map-undo').disabled = !mapState.past.length;
    $('#map-redo').disabled = !mapState.future.length;
    renderMapStats();
    renderBuilderRoute();
}

async function placeFromField(which) {
    const text = placeField(which).value.trim();
    if (!text || mapState.busy) return;
    const point = await geocode(text);
    if (point === null) toast('Lugar não encontrado.');
    if (!point) return;
    const coords = routeCoords();
    if (which === 'start') {
        if (coords.length) return toast('O início já está marcado. Use Desfazer ou Limpar para trocar.');
        setPlace('start', text, false);
        mapState.map.setView(point, 16);
        addPoint(point);
        return;
    }
    if (!coords.length) return toast('Marque o início antes da chegada.');
    setPlace('end', text, false);
    await addPoint(point);
    mapState.map.fitBounds(L.latLngBounds(routeCoords()), { padding: [30, 30] });
}

function renderMapTargets() {
    const select = $('#map-target');
    if (!select || !state.plan) return;
    const current = select.value;
    const options = ['<option value="">Livre (sem distância alvo)</option>'];
    if (state.workout) {
        const w = state.workout.workout;
        options.push(`<option value="workout">Treino montado · ${esc(w.name)} · ${esc(fmtKm(w.distance_km))}</option>`);
    }
    const from = currentWeek()?.number ?? 1;
    allDays().filter((d) => d.weekNumber >= from && d.weekNumber <= from + 1).forEach((d) => {
        if (d.run) options.push(`<option value="${d.run.distance_km}">${esc(d.run.name)} · ${esc(fmtKm(d.run.distance_km))}</option>`);
    });
    options.push(`<option value="${state.plan.target.distance_km}">Prova · ${esc(fmtKm(state.plan.target.distance_km, 4))}</option>`);
    select.innerHTML = options.join('');
    if ([...select.options].some((o) => o.value === current)) select.value = current;
}

function mapPace() {
    const custom = $('#map-target')?.value === 'workout' ? state.workout?.workout : null;
    if (custom) {
        return {
            seconds: custom.pace_seconds_per_km, text: custom.pace, target: custom.distance_km,
            zone: { faster_pace: custom.faster_pace, slower_pace: custom.slower_pace },
        };
    }
    return {
        seconds: state.plan.target.pace_seconds_per_km, text: state.plan.target.pace,
        target: Number($('#map-target')?.value || 0), zone: state.plan.pace_zone,
    };
}

function renderMapStats() {
    const box = $('#map-stats');
    if (!box || !state.plan) return;
    const km = routeMeters() / 1000;
    const { seconds: pace, text: paceText, zone, target } = mapPace();
    let goal = '';
    if (target) {
        const diff = target - km;
        const pct = Math.min(100, (km / target) * 100);
        goal = `<div class="progress" style="margin:4px 0 6px"><span style="width:${pct}%"></span></div>
            <div class="small ${Math.abs(diff) < 0.2 ? '' : 'muted'}">${Math.abs(diff) < 0.2 ? 'Distância do treino atingida.' : diff > 0 ? `Faltam ${esc(fmtKm(diff))} para ${esc(fmtKm(target))}.` : `Passou ${esc(fmtKm(-diff))} de ${esc(fmtKm(target))}.`}</div>`;
    }
    const full = Math.floor(km);
    const rows = [];
    for (let i = 1; i <= full; i += 1) rows.push(`<tr><td>${i} km</td><td>${esc(fmtDuration(i * pace))}</td></tr>`);
    if (km - full > 0.01) rows.push(`<tr class="finish"><td>${esc(fmtKm(km))}</td><td>${esc(fmtDuration(km * pace))}</td></tr>`);
    box.innerHTML = `
        <div class="map-stats">
            <div class="stat"><div class="label">Distância</div><div class="value">${esc(fmtKm(km))}</div></div>
            <div class="stat"><div class="label">No pace ${esc(paceText)}</div><div class="value">${esc(fmtDuration(km * pace))}</div></div>
        </div>
        <div class="small muted">Faixa: ${esc(fmtDuration(km * paceSeconds(zone.faster_pace)))} a ${esc(fmtDuration(km * paceSeconds(zone.slower_pace)))}</div>
        ${goal}
        ${rows.length ? `<div class="km-list"><table><thead><tr><th>Marca</th><th>Acumulado</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : ''}`;
}

async function closeLoop() {
    const coords = routeCoords();
    if (coords.length < 2) return toast('Marque pelo menos dois pontos.');
    if (mapState.busy) return;
    commit();
    mapState.segments.push(await connect(coords[coords.length - 1], coords[0]));
    redrawRoute();
    syncEndPlace();
}

function outAndBack() {
    const coords = routeCoords();
    if (coords.length < 2) return toast('Marque pelo menos dois pontos.');
    if (mapState.busy) return;
    commit();
    mapState.segments.push(coords.slice(0, -1).reverse());
    redrawRoute();
    syncEndPlace();
}

function clearRoute() {
    if (mapState.busy || (!mapState.segments.length && !mapState.stops.length)) return;
    commit();
    mapState.segments = [];
    mapState.stops = [];
    setPlace('start', '', true);
    setPlace('end', '', true);
    redrawRoute();
}

function routeName() {
    const start = placeField('start').value.trim();
    const end = placeField('end').value.trim();
    const fallback = start && end && start !== end ? `${start} → ${end}` : start || 'Percurso';
    return $('#route-name').value.trim() || fallback;
}

function gpxWaypoints(coords) {
    const wpt = ([lat, lng], name, type) => `  <wpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"><name>${esc(name)}</name><type>${type}</type></wpt>`;
    const start = placeField('start').value.trim();
    const end = placeField('end').value.trim();
    const points = [wpt(coords[0], start ? `Início: ${start}` : 'Início', 'start')];
    orderedStops().forEach((stop, i) => {
        points.push(wpt([stop.lat, stop.lng], `P${i + 1}${stop.name ? `: ${stop.name}` : ''} (km ${stop.km.toFixed(1)})`, 'stop'));
    });
    points.push(wpt(coords[coords.length - 1], end ? `Chegada: ${end}` : 'Chegada', 'finish'));
    return points.join('\n');
}

function exportGpx() {
    const coords = routeCoords();
    if (coords.length < 2) return toast('Desenhe o percurso antes de baixar.');
    const name = routeName();
    const points = coords.map(([lat, lng]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"></trkpt>`).join('\n');
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Treinador Maratona" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name></metadata>
${gpxWaypoints(coords)}
  <trk>
    <name>${esc(name)}</name>
    <type>running</type>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
    const slug = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'percurso';
    download(gpx, `${slug}.gpx`, 'application/gpx+xml');
    toast('GPX baixado. Importe em Garmin Connect → Percursos.');
}

function savedRoutes() {
    return store.get('tm_routes', []);
}

function saveRoute() {
    const coords = routeCoords();
    if (coords.length < 2) return toast('Desenhe o percurso antes de salvar.');
    const routes = savedRoutes().filter((r) => r.name !== routeName());
    routes.unshift({
        name: routeName(),
        km: routeMeters() / 1000,
        segments: mapState.segments,
        stops: mapState.stops,
        start: placeField('start').value.trim(),
        end: placeField('end').value.trim(),
        saved: new Date().toISOString(),
    });
    store.set('tm_routes', routes.slice(0, 30));
    renderSaved();
    toast('Percurso salvo neste navegador.');
}

function renderSaved() {
    const routes = savedRoutes();
    $('#saved-routes').innerHTML = routes.length
        ? routes.map((r, i) => `<li><span>${esc(r.name)} <span class="muted">· ${esc(fmtKm(r.km))}</span></span>
            <span><button data-load="${i}">Abrir</button><button data-remove="${i}">Excluir</button></span></li>`).join('')
        : '<li class="muted">Nenhum percurso salvo.</li>';
}

function loadRoute(index) {
    const route = savedRoutes()[index];
    if (!route || mapState.busy) return;
    commit();
    mapState.segments = route.segments;
    mapState.stops = route.stops || [];
    setPlace('start', route.start || '', !route.start);
    setPlace('end', route.end || '', !route.end);
    $('#route-name').value = route.name;
    redrawRoute();
    if (!route.start && route.segments.length) fillPlace('start', routeCoords()[0]);
    syncEndPlace();
    const coords = routeCoords();
    if (coords.length) mapState.map.fitBounds(L.latLngBounds(coords), { padding: [30, 30] });
}

function removeRoute(index) {
    const routes = savedRoutes();
    routes.splice(index, 1);
    store.set('tm_routes', routes);
    renderSaved();
}

async function geocode(text) {
    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(text)}`;
        const results = await (await fetch(url, { headers: { 'Accept-Language': 'pt-BR' } })).json();
        return results.length ? [Number(results[0].lat), Number(results[0].lon)] : null;
    } catch {
        toast('Busca indisponível no momento.');
        return undefined;
    }
}

async function searchPlace(text) {
    if (!text.trim() || !mapState.map) return;
    const point = await geocode(text);
    if (point) mapState.map.setView(point, 16);
    else if (point === null) toast('Lugar não encontrado.');
}

/* ---------- eventos ---------- */

function bindEvents() {
    $('#tabs').addEventListener('click', (e) => {
        const button = e.target.closest('button[data-tab]');
        if (button) showTab(button.dataset.tab);
    });
    window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

    document.addEventListener('click', (e) => {
        const doneButton = e.target.closest('[data-done]');
        if (doneButton) toggleDone(doneButton.dataset.done, doneButton.dataset.type);
        const weekChip = e.target.closest('[data-week]');
        if (weekChip) {
            state.week = Number(weekChip.dataset.week);
            renderWeeks();
        }
        if (e.target.id === 'week-zip') downloadWeek(e.target);
        const fit = e.target.closest('[data-fit]');
        if (fit) downloadFit(fit.dataset.fit).catch((error) => toast(error.message));
        const load = e.target.closest('[data-load]');
        if (load) loadRoute(Number(load.dataset.load));
        const remove = e.target.closest('[data-remove]');
        if (remove) removeRoute(Number(remove.dataset.remove));
        const ask = e.target.closest('[data-ask]');
        if (ask) askCoach(ask.dataset.ask);
        const apply = e.target.closest('[data-apply]');
        if (apply) applyProposal(Number(apply.dataset.apply));
        const ignore = e.target.closest('[data-ignore]');
        if (ignore) ignoreProposal(Number(ignore.dataset.ignore));
        const go = e.target.closest('[data-goto]');
        if (go) showTab(go.dataset.goto);
        const watchChoice = e.target.closest('[data-watch]');
        if (watchChoice) chooseWatch(watchChoice.dataset.watch);
        const kind = e.target.closest('[data-kind]');
        if (kind) chooseKind(kind.dataset.kind);
        const step = e.target.closest('[data-step]');
        if (step) stepBuilder(step.dataset.step, Number(step.dataset.delta));
        const preset = e.target.closest('[data-set]');
        if (preset) setBuilder(preset.dataset.set, preset.dataset.value);
        const workoutFile = e.target.closest('[data-download-workout]');
        if (workoutFile) downloadWorkout(workoutFile);
        if (e.target.closest('[data-download-gpx]')) exportGpx();
        const manualLink = e.target.closest('[data-manual]');
        if (manualLink) openManual(manualLink.dataset.manual);
    });

    $('#chat-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('#chat-input');
        if (state.asking || !input.value.trim()) return;
        askCoach(input.value);
        input.value = '';
    });
    $('#chat-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            $('#chat-form').requestSubmit();
        }
    });
    $('#ai-save').addEventListener('click', saveAiKey);
    $('#ai-forget').addEventListener('click', forgetAiKey);
    $('#ai-key').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveAiKey();
    });
    $('#chat-clear').addEventListener('click', clearChat);

    const form = $('#calc-form');
    form.addEventListener('submit', (e) => e.preventDefault());
    form.addEventListener('input', (e) => {
        const { name, value } = e.target;
        if (!name) return;
        if (name === 'tolerance') $('#tolerance-out').textContent = value;
        if (name === 'pace' && value) state.settings.mode = 'pace';
        if (name === 'time' && value) state.settings.mode = 'time';
        updateSetting(name, value);
    });
    $('#mode').addEventListener('click', (e) => {
        const button = e.target.closest('[data-mode]');
        if (button) updateSetting('mode', button.dataset.mode);
    });
    $('#distance-chips').addEventListener('click', (e) => {
        const chip = e.target.closest('[data-distance]');
        if (!chip) return;
        $('#f-distance').value = chip.dataset.distance;
        updateSetting('distance', chip.dataset.distance);
    });

    $('#map-undo').addEventListener('click', undoRoute);
    $('#map-redo').addEventListener('click', redoRoute);
    $('#map-mode').addEventListener('click', (e) => {
        const button = e.target.closest('[data-map-mode]');
        if (button) setMapMode(button.dataset.mapMode);
    });
    ['start', 'end'].forEach((which) => {
        const input = placeField(which);
        input.addEventListener('input', () => { input.dataset.auto = ''; });
        input.addEventListener('change', () => mapState.map && drawMarks());
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') placeFromField(which);
        });
    });
    $('#stop-list').addEventListener('input', (e) => {
        const stop = mapState.stops.find((s) => String(s.id) === e.target.dataset.stopName);
        if (!stop) return;
        Object.assign(stop, { name: e.target.value, auto: false });
    });
    $('#stop-list').addEventListener('change', () => drawMarks());
    $('#stop-list').addEventListener('click', (e) => {
        const button = e.target.closest('[data-stop-remove]');
        if (button) removeStop(Number(button.dataset.stopRemove));
    });
    document.addEventListener('keydown', (e) => {
        if (!$('#tab-mapa').classList.contains('active') || e.target.closest('input, textarea, select')) return;
        const key = e.key.toLowerCase();
        if (!(e.ctrlKey || e.metaKey)) return;
        if (key === 'z' && !e.shiftKey) {
            e.preventDefault();
            undoRoute();
        } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
            e.preventDefault();
            redoRoute();
        }
    });
    $('#map-loop').addEventListener('click', closeLoop);
    $('#map-back').addEventListener('click', outAndBack);
    $('#map-clear').addEventListener('click', clearRoute);
    $('#map-gpx').addEventListener('click', exportGpx);
    $('#map-save').addEventListener('click', saveRoute);
    $('#map-target').addEventListener('change', () => {
        renderMapStats();
        renderStops();
    });
    $('#map-use').addEventListener('click', () => {
        useRouteInWorkout();
        if (routeMeters() >= 500 && state.builder.kind !== 'tiros') showTab('montar');
    });

    $('#tab-montar').addEventListener('input', (e) => {
        const key = e.target.dataset.b;
        if (!key) return;
        state.builder[key] = e.target.value;
        if (key === 'tolerance') $('#b-tol-out').textContent = e.target.value;
        saveBuilder();
        scheduleWorkout();
    });
    $('#b-model-other').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        chooseWatch(e.target.value);
        e.target.value = '';
    });
    $('#b-draw').addEventListener('click', drawOnMap);
    $('#b-use-route').addEventListener('click', useRouteInWorkout);
    $('#map-search').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') searchPlace(e.target.value);
    });
}

function boot() {
    if (!state.settings.start) {
        state.settings.start = todayISO();
        store.set('tm_settings', state.settings);
    }
    const builder = state.builder;
    if (!builder.day || builder.day < todayISO()) builder.day = todayISO();
    if (!builder.pace) builder.pace = state.settings.pace || DEFAULT_SETTINGS.pace;
    saveBuilder();
    bindEvents();
    fillForm();
    fillBuilder();
    renderAiSetup();
    showTab(location.hash.slice(1) || 'hoje');
    loadInitialPlan();
    loadPlan();
    loadWorkout();
}

boot();
