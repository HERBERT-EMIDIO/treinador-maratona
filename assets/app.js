'use strict';

const PLANNER_FILE = 'garmin_marathon_planner.py';
const APP_DIR = '/home/pyodide/app';
const ZIP_PATH = '/tmp/semana.zip';
const ENGINE_PY = `
import contextlib, io, json, shutil, sys, zipfile
sys.path.insert(0, ${JSON.stringify(APP_DIR)})
import garmin_marathon_planner as gmp

def plan_json(args_json):
    shutil.rmtree(gmp.DEFAULT_TRAININGS_DIR, ignore_errors=True)
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = gmp.main(json.loads(args_json) + ["--json-only", "--treinos"])
    if code != 0:
        message = err.getvalue().strip().removeprefix("Erro:").strip()
        return json.dumps({"error": message or "O cálculo falhou."}, ensure_ascii=False)
    return out.getvalue()

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
};
const RECIFE = [-8.0631, -34.8711];

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
    requestId: 0,
    week: null,
    manualLoaded: false,
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
    const args = ['--model', s.model, '--distance', s.distance, '--date', s.date, '--tolerance', s.tolerance, '--split-km', s.split];
    if (s.mode === 'time' && s.time) args.push('--time', s.time);
    else args.push('--pace', s.pace);
    return args;
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
    } catch (error) {
        if (id !== state.requestId) return;
        $('#calc-error').textContent = error.message;
        if (!state.engineReady) {
            state.engine = null;
            banner(`Não consegui carregar o motor de cálculo: ${error.message}`);
        }
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
}

/* ---------- render ---------- */

function renderAll() {
    if (!state.plan) return;
    renderHeader();
    renderToday();
    renderWeeks();
    renderCalcResults();
    renderWatch();
    renderMapTargets();
    renderMapStats();
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
        html += '<p class="muted">O calendário precisa de prova num domingo. Ajuste a data na Calculadora.</p>';
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
        <h2>Semana ${esc(week.number)} · ${esc(fmtDate(week.start))} a ${esc(fmtDate(week.end))}</h2>
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
        $('#files-card').innerHTML = '<p class="muted" style="margin:0">O calendário precisa de prova num domingo. Ajuste a data na Calculadora.</p>';
        $('#days').innerHTML = '';
        return;
    }
    if (!state.week || !list.some((w) => w.number === state.week)) state.week = currentWeek().number;
    $('#week-chips').innerHTML = list.map((w) => `
        <button class="chip ${w.number === state.week ? 'active' : ''}" data-week="${w.number}">
            Semana ${w.number}<small>${esc(fmtDate(w.start))}–${esc(fmtDate(w.end))}${w.race_week ? ' · prova' : ''}</small>
        </button>`).join('');

    const week = list.find((w) => w.number === state.week);
    const ready = state.engineReady;
    $('#files-card').innerHTML = `
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
                <li>Desconecte. Corrida: START → Corrida → UP → Treino → Treinos. Força: START → Força → Treinos.</li>
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
            ${w.model_notes.length ? `<div class="card profile"><h2>Notas do modelo</h2><ul>${list(w.model_notes)}</ul></div>` : ''}
        </div>`;
}

/* ---------- manual ---------- */

async function loadManual() {
    if (state.manualLoaded) return;
    state.manualLoaded = true;
    try {
        const text = await (await fetch('PLANO_MARATONA_GARMIN.md', { cache: 'no-store' })).text();
        $('#manual').innerHTML = window.marked ? window.marked.parse(text) : `<pre>${esc(text)}</pre>`;
    } catch {
        state.manualLoaded = false;
        $('#manual').innerHTML = '<p class="muted">Não consegui abrir PLANO_MARATONA_GARMIN.md.</p>';
    }
}

/* ---------- mapa ---------- */

const mapState = { map: null, line: null, marks: null, start: null, segments: [], busy: false };

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
    map.on('click', (e) => addPoint([e.latlng.lat, e.latlng.lng]));
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

async function addPoint(point) {
    if (mapState.busy) return;
    if (!mapState.segments.length) {
        mapState.segments.push([point]);
    } else {
        const coords = routeCoords();
        mapState.segments.push(await connect(coords[coords.length - 1], point));
    }
    redrawRoute();
}

function redrawRoute() {
    if (!mapState.map) return;
    const coords = routeCoords();
    mapState.line.setLatLngs(coords);
    mapState.marks.clearLayers();
    if (coords.length) {
        L.circleMarker(coords[0], { radius: 8, color: '#fff', weight: 3, fillColor: '#1d9a5b', fillOpacity: 1 })
            .bindTooltip('Início').addTo(mapState.marks);
    }
    if (coords.length > 1) {
        L.circleMarker(coords[coords.length - 1], { radius: 7, color: '#fff', weight: 3, fillColor: '#242428', fillOpacity: 1 })
            .bindTooltip('Fim').addTo(mapState.marks);
    }
    kmMarks(coords).forEach((p, i) => {
        L.marker(p, { icon: L.divIcon({ className: 'km-icon', html: String(i + 1), iconSize: [22, 22] }) }).addTo(mapState.marks);
    });
    renderMapStats();
}

function renderMapTargets() {
    const select = $('#map-target');
    if (!select || !state.plan) return;
    const current = select.value;
    const options = ['<option value="">Livre (sem distância alvo)</option>'];
    allDays().forEach((d) => {
        if (d.run) options.push(`<option value="${d.run.distance_km}">${esc(d.run.name)} · ${esc(fmtKm(d.run.distance_km))}</option>`);
    });
    options.push(`<option value="${state.plan.target.distance_km}">Prova · ${esc(fmtKm(state.plan.target.distance_km, 4))}</option>`);
    select.innerHTML = options.join('');
    if ([...select.options].some((o) => o.value === current)) select.value = current;
}

function renderMapStats() {
    const box = $('#map-stats');
    if (!box || !state.plan) return;
    const km = routeMeters() / 1000;
    const pace = state.plan.target.pace_seconds_per_km;
    const zone = state.plan.pace_zone;
    const target = Number($('#map-target').value || 0);
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
            <div class="stat"><div class="label">No pace ${esc(state.plan.target.pace)}</div><div class="value">${esc(fmtDuration(km * pace))}</div></div>
        </div>
        <div class="small muted">Faixa: ${esc(fmtDuration(km * paceSeconds(zone.faster_pace)))} a ${esc(fmtDuration(km * paceSeconds(zone.slower_pace)))}</div>
        ${goal}
        ${rows.length ? `<div class="km-list"><table><thead><tr><th>Marca</th><th>Acumulado</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : ''}`;
}

function undoPoint() {
    mapState.segments.pop();
    redrawRoute();
}

async function closeLoop() {
    const coords = routeCoords();
    if (coords.length < 2) return toast('Marque pelo menos dois pontos.');
    mapState.segments.push(await connect(coords[coords.length - 1], coords[0]));
    redrawRoute();
}

function outAndBack() {
    const coords = routeCoords();
    if (coords.length < 2) return toast('Marque pelo menos dois pontos.');
    mapState.segments.push(coords.slice(0, -1).reverse());
    redrawRoute();
}

function clearRoute() {
    mapState.segments = [];
    redrawRoute();
}

function routeName() {
    return $('#route-name').value.trim() || 'Percurso';
}

function exportGpx() {
    const coords = routeCoords();
    if (coords.length < 2) return toast('Desenhe o percurso antes de baixar.');
    const name = routeName();
    const points = coords.map(([lat, lng]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"></trkpt>`).join('\n');
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Treinador Maratona" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name></metadata>
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
    routes.unshift({ name: routeName(), km: routeMeters() / 1000, segments: mapState.segments, saved: new Date().toISOString() });
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
    if (!route) return;
    mapState.segments = route.segments;
    $('#route-name').value = route.name;
    redrawRoute();
    const coords = routeCoords();
    if (coords.length) mapState.map.fitBounds(L.latLngBounds(coords), { padding: [30, 30] });
}

function removeRoute(index) {
    const routes = savedRoutes();
    routes.splice(index, 1);
    store.set('tm_routes', routes);
    renderSaved();
}

async function searchPlace(text) {
    if (!text.trim() || !mapState.map) return;
    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(text)}`;
        const results = await (await fetch(url, { headers: { 'Accept-Language': 'pt-BR' } })).json();
        if (!results.length) return toast('Lugar não encontrado.');
        mapState.map.setView([Number(results[0].lat), Number(results[0].lon)], 16);
    } catch {
        toast('Busca indisponível no momento.');
    }
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
    });

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

    $('#map-undo').addEventListener('click', undoPoint);
    $('#map-loop').addEventListener('click', closeLoop);
    $('#map-back').addEventListener('click', outAndBack);
    $('#map-clear').addEventListener('click', clearRoute);
    $('#map-gpx').addEventListener('click', exportGpx);
    $('#map-save').addEventListener('click', saveRoute);
    $('#map-target').addEventListener('change', renderMapStats);
    $('#map-search').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') searchPlace(e.target.value);
    });
}

function boot() {
    bindEvents();
    fillForm();
    showTab(location.hash.slice(1) || 'hoje');
    loadInitialPlan();
    loadPlan();
}

boot();
