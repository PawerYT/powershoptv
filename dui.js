'use strict';

const stage = document.getElementById('stage');
const msgBox = document.getElementById('msg');

const DRIFT_SECONDS = 2.5;
const SEEK_COOLDOWN = 1500;
const QUALITY_YT = 'hd1080';

let current = null;
let lastState = null;

function showMessage(text) {
    msgBox.textContent = text || '';
    msgBox.style.display = text ? 'block' : 'none';
}

const loadedScripts = {};
function loadScript(src) {
    if (!loadedScripts[src]) {
        loadedScripts[src] = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = () => { delete loadedScripts[src]; reject(new Error('No se pudo cargar ' + src)); };
            document.head.appendChild(s);
        });
    }
    return loadedScripts[src];
}

function parseUrl(raw) {
    let u;
    try { u = new URL(raw); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

    const host = u.hostname.toLowerCase().replace(/^(www|m|music|go)\./, '');
    const path = u.pathname;
    const idRe = /^[\w-]{6,20}$/;

    if (host === 'youtu.be') {
        const id = path.split('/')[1];
        if (idRe.test(id || '')) return { kind: 'youtube', id };
    }
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        let id = null;
        if (path === '/watch') id = u.searchParams.get('v');
        const m = path.match(/^\/(shorts|live|embed|v)\/([\w-]+)/);
        if (m) id = m[2];
        if (idRe.test(id || '')) return { kind: 'youtube', id };
    }

    if (host === 'clips.twitch.tv') {
        const clip = path.split('/')[1];
        if (clip && clip !== 'embed') {
            return { kind: 'iframe', src: `https://clips.twitch.tv/embed?clip=${encodeURIComponent(clip)}&parent=${location.hostname}&autoplay=true&muted=false` };
        }
    }
    if (host === 'player.twitch.tv') {
        const video = u.searchParams.get('video');
        const channel = u.searchParams.get('channel');
        if (video) return { kind: 'twitch', video: video.replace(/^v/, '') };
        if (channel) return { kind: 'twitch', channel };
    }
    if (host === 'twitch.tv') {
        const parts = path.split('/').filter(Boolean);
        if (parts[0] === 'videos' && /^\d+$/.test(parts[1] || '')) return { kind: 'twitch', video: parts[1] };
        if (parts[1] === 'clip' && parts[2]) {
            return { kind: 'iframe', src: `https://clips.twitch.tv/embed?clip=${encodeURIComponent(parts[2])}&parent=${location.hostname}&autoplay=true&muted=false` };
        }
        if (parts[0] && /^\w{3,25}$/.test(parts[0])) return { kind: 'twitch', channel: parts[0] };
    }

    if (/\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(path)) return { kind: 'direct', src: u.href, hls: false };
    if (/\.m3u8$/i.test(path)) return { kind: 'direct', src: u.href, hls: true };

    return { kind: 'iframe', src: u.href };
}

function youtubePlayer(info, state, onReady) {
    const holder = document.createElement('div');
    holder.id = 'yt-' + Date.now();
    stage.appendChild(holder);
    let player = null;
    let destroyed = false;

    const ready = window.YT && window.YT.Player
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            const previous = window.onYouTubeIframeAPIReady;
            window.onYouTubeIframeAPIReady = () => { if (previous) previous(); resolve(); };
            loadScript('https://www.youtube.com/iframe_api').catch(reject);
        });

    function forceQuality() {
        try {
            if (player.setPlaybackQualityRange) player.setPlaybackQualityRange(QUALITY_YT, 'highres');
            if (player.setPlaybackQuality) player.setPlaybackQuality(QUALITY_YT);
        } catch (e) { }
    }

    ready.then(() => {
        if (destroyed) return;
        player = new YT.Player(holder.id, {
            width: '100%',
            height: '100%',
            videoId: info.id,
            playerVars: {
                autoplay: 1, controls: 0, disablekb: 1, fs: 0, rel: 0,
                iv_load_policy: 3, modestbranding: 1, playsinline: 1,
                start: Math.max(0, Math.floor(state.time || 0)),
                vq: QUALITY_YT,
            },
            events: {
                onReady: () => { if (!destroyed) { player.unMute(); forceQuality(); onReady(); } },
                onStateChange: (e) => { if (e.data === 1 || e.data === 3) forceQuality(); },
                onError: (e) => showMessage('YouTube: error ' + e.data),
            },
        });
    }).catch(() => showMessage('No se pudo cargar YouTube'));

    return {
        play: () => player.playVideo(),
        pause: () => player.pauseVideo(),
        seek: (s) => player.seekTo(s, true),
        time: () => player.getCurrentTime() || 0,
        paused: () => { const st = player.getPlayerState(); return st === 2 || st === 5 || st === -1; },
        ended: () => player.getPlayerState() === 0,
        live: () => { const d = player.getVideoData ? player.getVideoData() : null; return !!(d && d.isLive) || !player.getDuration(); },
        volume: (v) => player.setVolume(Math.round(v * 100)),
        destroy: () => { destroyed = true; try { if (player && player.destroy) player.destroy(); } catch (e) { } },
    };
}

function twitchPlayer(info, state, onReady) {
    const holder = document.createElement('div');
    holder.id = 'tw-' + Date.now();
    stage.appendChild(holder);
    let player = null;
    let destroyed = false;

    loadScript('https://player.twitch.tv/js/embed/v1.js').then(() => {
        if (destroyed) return;
        const options = { width: '100%', height: '100%', parent: [location.hostname], autoplay: true, muted: false, controls: false };
        if (info.video) options.video = info.video; else options.channel = info.channel;
        player = new Twitch.Player(holder.id, options);
        player.addEventListener(Twitch.Player.READY, () => {
            if (destroyed) return;
            player.setMuted(false);
            try { player.setQuality('chunked'); } catch (e) { }
            onReady();
        });
    }).catch(() => showMessage('No se pudo cargar Twitch'));

    return {
        play: () => player.play(),
        pause: () => player.pause(),
        seek: (s) => player.seek(s),
        time: () => player.getCurrentTime() || 0,
        paused: () => player.isPaused(),
        ended: () => player.getEnded(),
        live: () => !info.video,
        volume: (v) => player.setVolume(v),
        destroy: () => { destroyed = true; },
    };
}

function directPlayer(info, state, onReady) {
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    stage.appendChild(video);
    let hls = null;
    let destroyed = false;

    video.addEventListener('loadedmetadata', () => { if (!destroyed) onReady(); }, { once: true });
    video.addEventListener('error', () => showMessage('No se pudo reproducir el vídeo'));

    if (info.hls && !video.canPlayType('application/vnd.apple.mpegurl')) {
        loadScript('https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js').then(() => {
            if (destroyed) return;
            if (window.Hls && Hls.isSupported()) {
                hls = new Hls({ capLevelToPlayerSize: false });
                hls.on(Hls.Events.MANIFEST_PARSED, () => { hls.currentLevel = hls.levels.length - 1; });
                hls.loadSource(info.src);
                hls.attachMedia(video);
            } else {
                showMessage('Este dispositivo no admite HLS');
            }
        }).catch(() => showMessage('No se pudo cargar el reproductor HLS'));
    } else {
        video.src = info.src;
    }

    return {
        play: () => { const p = video.play(); if (p && p.catch) p.catch(() => {}); },
        pause: () => video.pause(),
        seek: (s) => { video.currentTime = s; },
        time: () => video.currentTime || 0,
        paused: () => video.paused,
        ended: () => video.ended,
        live: () => !isFinite(video.duration),
        volume: (v) => { video.volume = v; },
        destroy: () => { destroyed = true; if (hls) hls.destroy(); video.pause(); video.removeAttribute('src'); video.load(); },
    };
}

function iframePlayer(info, state, onReady) {
    const frame = document.createElement('iframe');
    frame.allow = 'autoplay; encrypted-media; fullscreen';
    frame.src = info.src;
    stage.appendChild(frame);
    let paused = false;
    setTimeout(onReady, 0);

    return {
        play: () => { if (paused) { paused = false; frame.src = info.src; } },
        pause: () => { if (!paused) { paused = true; frame.src = 'about:blank'; } },
        seek: () => {},
        time: () => 0,
        paused: () => paused,
        ended: () => false,
        live: () => true,
        volume: () => {},
        destroy: () => { frame.src = 'about:blank'; },
    };
}

const PLAYERS = { youtube: youtubePlayer, twitch: twitchPlayer, direct: directPlayer, iframe: iframePlayer };

const home = document.getElementById('home');
let homeKey = null;
let clockTimer = null;

const ICONS = {
    play:  '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="none" stroke="#fff" stroke-width="3.5"/><path d="M20 15.5v17l14-8.5z" fill="#fff"/></svg>',
    live:  '<svg viewBox="0 0 48 48" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"><circle cx="24" cy="24" r="5" fill="#fff" stroke="none"/><path d="M14.5 14.5a13.5 13.5 0 0 0 0 19M33.5 14.5a13.5 13.5 0 0 1 0 19M8 8a22.6 22.6 0 0 0 0 32M40 8a22.6 22.6 0 0 1 0 32"/></svg>',
    film:  '<svg viewBox="0 0 48 48" fill="none" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"><rect x="6" y="9" width="36" height="30" rx="4"/><path d="M15 9v30M33 9v30M6 19h9M6 29h9M33 19h9M33 29h9"/></svg>',
    music: '<svg viewBox="0 0 48 48" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 35V11l22-4v24"/><circle cx="12.5" cy="35" r="5.5" fill="#fff"/><circle cx="34.5" cy="31" r="5.5" fill="#fff"/></svg>',
    link:  '<svg viewBox="0 0 48 48" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"><circle cx="24" cy="24" r="19"/><path d="M5 24h38M24 5c-7 6-7 32 0 38M24 5c7 6 7 32 0 38"/></svg>',
};

function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
}

function tickClock() {
    const clock = home.querySelector('.h-clock');
    if (!clock) return;
    const d = new Date();
    clock.textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

const GRID_COLS = 5;

function buildHint(text) {
    const hint = node('div', 'h-hint');
    String(text || '').split(/(\[[^\]]+\])/).forEach((part) => {
        if (!part.trim()) return;
        const m = part.match(/^\[([^\]]+)\]$/);
        hint.appendChild(m ? node('kbd', null, m[1]) : node('span', null, part.trim()));
    });
    return hint;
}

function buildApps(data) {
    home.appendChild(node('div', 'h-title', data.title || ''));
    const apps = node('div', 'h-apps');
    (Array.isArray(data.apps) ? data.apps : []).slice(0, 6).forEach((app, i) => {
        const card = node('div', 'h-app');
        card.dataset.i = i + 1;
        card.style.setProperty('--c', /^#[0-9a-f]{3,8}$/i.test(app.color || '') ? app.color : '#3e63dd');
        const icon = node('div', 'h-icon');
        if (typeof app.image === 'string' && /^[\w./-]+$/.test(app.image)) {
            const img = document.createElement('img');
            img.src = app.image;
            icon.appendChild(img);
        } else {
            icon.innerHTML = ICONS[app.icon] || ICONS.play;
        }
        const text = node('div');
        text.appendChild(node('div', 'h-label', app.label || ''));
        if (app.hint) text.appendChild(node('div', 'h-sub', app.hint));
        card.append(icon, text);
        apps.appendChild(card);
    });
    home.appendChild(apps);
    home.appendChild(buildHint(data.hint));
}

function buildList(data, ui) {
    const head = node('div', 'h-head');
    head.appendChild(node('b', null, ui.title || ''));
    head.appendChild(node('span', null, ui.subtitle || ''));
    home.appendChild(head);

    const items = Array.isArray(ui.items) ? ui.items : [];
    if (ui.loading || ui.error || !items.length) {
        home.appendChild(node('div', 'h-msg', ui.loading ? data.loading : (ui.error || data.empty)));
    } else {
        const view = node('div', 'h-view');
        const grid = node('div', 'h-grid');
        items.forEach((item, i) => {
            const card = node('div', 'h-card');
            card.dataset.i = i + 1;
            const thumb = node('div', 'h-thumb');
            if (typeof item.thumb === 'string' && /^https:\/\//.test(item.thumb)) {
                const img = document.createElement('img');
                img.src = item.thumb;
                thumb.appendChild(img);
            } else {
                thumb.appendChild(node('i', null, item.badge || '▶'));
            }
            card.appendChild(thumb);
            card.appendChild(node('div', 'h-ctitle', item.title || ''));
            card.appendChild(node('div', 'h-csub', item.sub || ''));
            grid.appendChild(card);
        });
        view.appendChild(grid);
        home.appendChild(view);
    }
    home.appendChild(buildHint(ui.searchable ? data.searchHint : data.listHint));
}

function selectItem(index) {
    home.querySelectorAll('[data-i]').forEach((n) => n.classList.toggle('sel', Number(n.dataset.i) === index));
    const grid = home.querySelector('.h-grid');
    if (!grid || !grid.children.length) return;
    const row = Math.floor((Math.min(index, grid.children.length) - 1) / GRID_COLS);
    const firstRow = Math.max(0, row - 1);
    const anchor = grid.children[firstRow * GRID_COLS];
    grid.style.transform = `translateY(${-(anchor ? anchor.offsetTop : 0)}px)`;
}

function showHome(state) {
    const data = state.home;
    if (!data) { hideHome(); return; }
    const ui = (state.ui && typeof state.ui === 'object') ? state.ui : { view: 'home', index: 1 };

    const key = JSON.stringify([state.name, data, Object.assign({}, ui, { index: 0 })]);
    if (key !== homeKey) {
        homeKey = key;
        home.textContent = '';
        if (data.accent) {
            home.style.setProperty('--accent', data.accent);
            home.style.setProperty('--glow', data.accent + '38');
        }
        const top = node('div', 'h-top');
        top.appendChild(node('div', 'h-name', state.name || ''));
        top.appendChild(node('div', 'h-clock'));
        home.appendChild(top);

        if (ui.view === 'list') buildList(data, ui); else buildApps(data);
        tickClock();
    }

    home.classList.add('on');
    selectItem(Number(ui.index) || 1);
    if (!clockTimer) clockTimer = setInterval(tickClock, 10000);
}

function hideHome() {
    home.classList.remove('on');
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
}

function unload() {
    if (current) {
        try { current.api.destroy(); } catch (e) { }
        current = null;
    }
    stage.textContent = '';
    showMessage('');
}

function load(state) {
    unload();
    const info = parseUrl(state.url);
    if (!info) {
        current = { url: state.url, api: null, ready: false };
        showMessage('Enlace no válido');
        return;
    }
    const isTwitch = info.kind === 'twitch' || (info.kind === 'iframe' && /twitch\.tv/.test(info.src));
    if (isTwitch && /^cfx-nui-/i.test(location.hostname)) {
        current = { url: state.url, api: null, ready: false };
        showMessage('Twitch necesita una página alojada (Config.DuiPage)');
        return;
    }
    const entry = { url: state.url, api: null, ready: false, lastSeek: 0 };
    current = entry;
    entry.api = PLAYERS[info.kind](info, state, () => {
        if (current !== entry) return;
        entry.ready = true;
        if (lastState) apply(lastState);
    });
}

function apply(state) {
    lastState = state;

    if (!state.url) { unload(); showHome(state); return; }
    hideHome();
    if (!current || current.url !== state.url) { load(state); return; }
    if (!current.ready || !current.api) return;

    const api = current.api;
    try {
        api.volume(Math.max(0, Math.min(1, Number(state.volume) || 0)));

        if (!state.playing) {
            if (!api.paused()) api.pause();
            return;
        }

        if (api.ended()) return;
        if (api.paused()) api.play();

        if (!api.live()) {
            const now = Date.now();
            const target = Math.max(0, Number(state.time) || 0);
            if (Math.abs(api.time() - target) > DRIFT_SECONDS && now - current.lastSeek > SEEK_COOLDOWN) {
                current.lastSeek = now;
                api.seek(target);
            }
        }
    } catch (e) {
    }
}

window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'state') return;
    apply(data);
});
