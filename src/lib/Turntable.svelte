<script>
// @ts-nocheck
    import { onMount } from "svelte";
    import { resolve } from "$app/paths";
    import { DEFAULT_PLAYLIST, loadPlayback, savePlayback } from "#lib/havenSettings.js";
    import { LOCAL_EVENTS, createLocalWidget, loadLibrary } from "#lib/localMusic.js";
    import { createPudding } from "#lib/pudding.js";

    let { layout = "corner", playlist = DEFAULT_PLAYLIST, library = null, still = false } = $props();

    let activePlaylist;
    const POLL_MS = 60_000;
    const SAVE_MS = 2000;
    const RESUME_TIMEOUT_MS = 4000;
    const JUMP_MS = 2000;
    const GLIDE_MS = 200;
    const HOLD_MS = 3000;
    const FETCH_TRIES = 25;
    const FETCH_POLL_MS = 200;

    const WIDGET_OPTS = {
        hide_related: true,
        show_comments: false,
        show_user: false,
        show_reposts: false,
        show_teaser: false,
        visual: false,
    };

    const widgetSrc = (autoPlay) =>
        "https://w.soundcloud.com/player/?url=" + encodeURIComponent(activePlaylist) + "&" +
        Object.entries({ ...WIDGET_OPTS, auto_play: autoPlay }).map(([k, v]) => `${k}=${v}`).join("&");

    let iframe;
    let scoutFrame;
    let disc;
    let puddingEl;
    let spikesEl;
    let headEl;
    let expressionEl;
    let popNotes;
    let pudding;
    let widget;
    let scout;

    let loadedIds = "";
    let latestIds = [];
    let updatePending = false;
    let hasPlayed = false;
    let currentId = null;
    let seekTarget = null;
    let seekUntil = 0;
    let savedAt = 0;
    let resume = null;
    let resumeTimer;
    let fill;
    let glide;
    let shownPosition = 0;
    let shownProgress = 0;
    let scrubbing = false;
    let scrubbed = false;
    let played = [];
    let pendingId = null;
    let pendingUntil = 0;

    let ready = $state(false);
    let playing = $state(false);
    let failed = $state(false);
    let title = $state("tuning in…");
    let artist = $state("");
    let art = $state(null);
    let position = $state(0);
    let duration = $state(0);
    let trackIndex = $state(0);
    let trackCount = $state(0);
    let shuffle = $state(false);

    let progress = $derived(duration ? Math.min(1, position / duration) : 0);

    // a css transition would restart on every progress tick and crawl
    $effect(() => {
        const jumped = Math.abs(position - shownPosition) > JUMP_MS;
        const from = shownProgress;
        shownPosition = position;
        shownProgress = progress;
        if (!jumped || scrubbed || !fill || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const start = glide?.playState === "running" ? getComputedStyle(fill).width : `${from * 100}%`;
        glide?.cancel();
        glide = fill.animate(
            [{ width: start }, { width: `${progress * 100}%` }],
            { duration: GLIDE_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
    });

    const hiRes = (url) => url?.replace("-large.", "-t500x500.") ?? null;
    const idsOf = (sounds) => (sounds ?? []).map((s) => s.id);
    const wrap = (i, n) => ((i % n) + n) % n;

    function fmt(ms) {
        const s = Math.max(0, Math.floor(ms / 1000));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }

    function loadScript() {
        if (window.SC?.Widget) return Promise.resolve();
        return new Promise((res, rej) => {
            const s = document.createElement("script");
            s.src = "https://w.soundcloud.com/player/api.js";
            s.onload = res;
            s.onerror = rej;
            document.head.appendChild(s);
        });
    }

    const ask = (w, method) => new Promise((res) => w[method](res));

    async function refreshSound() {
        const [s, i, sounds] = await Promise.all([
            ask(widget, "getCurrentSound"),
            ask(widget, "getCurrentSoundIndex"),
            ask(widget, "getSounds"),
        ]);
        // the widget auto-advances in order before a shuffled pick can land
        if (pendingId !== null && s?.id !== pendingId && performance.now() < pendingUntil) return;
        pendingId = null;
        trackCount = sounds?.length ?? 0;
        trackIndex = i ?? 0;
        if (!s?.title) return;
        if (s.id !== currentId) {
            seekTarget = null;
            position = 0;
            if (currentId !== null) pudding?.hop();
        }
        currentId = s.id;
        if (shuffle && !played.includes(s.id)) played.push(s.id);
        title = s.title;
        artist = s.user?.username ?? "";
        art = hiRes(s.artwork_url || s.user?.avatar_url);
        duration = s.duration;
        pudding?.loadWave(s.waveform_url, s.duration, s.id);
    }

    function savePosition() {
        if (resume || !currentId) return;
        savedAt = performance.now();
        savePlayback({ playlist: activePlaylist, id: currentId, position, playing, title, artist, art, duration, shuffle, played });
    }

    function primeResume() {
        const saved = loadPlayback();
        shuffle = !!saved?.shuffle;
        if (!saved?.id || saved.playlist !== activePlaylist) return;
        played = saved.played ?? [];
        resume = saved;
        currentId = saved.id;
        position = saved.position;
        title = saved.title;
        artist = saved.artist;
        art = library ? widget.artFor(saved.id) : saved.art;
        duration = saved.duration;
    }

    function startResume(ids) {
        const index = ids.indexOf(resume.id);
        if (index < 0) {
            const { playing: wasPlaying } = resume;
            resume = null;
            currentId = null;
            if (wasPlaying) widget.play();
            refreshSound();
            return;
        }
        trackIndex = index;
        trackCount = ids.length;
        hasPlayed = true;
        widget.setVolume(0);
        skipAndPlay(index);
    }

    function endResume() {
        if (!resume) return;
        const { playing: wasPlaying } = resume;
        resume = null;
        clearTimeout(resumeTimer);
        resumeTimer = null;
        widget.setVolume(100);
        if (!wasPlaying) widget.pause();
    }

    function dropResume() {
        if (!resume) return;
        resume.playing = true;
        endResume();
    }

    // skip alone won't start a song the widget hasn't fetched yet
    async function skipAndPlay(index) {
        widget.skip(index);
        if (library) return;
        for (let i = 0; i < FETCH_TRIES; i++) {
            await new Promise((res) => setTimeout(res, FETCH_POLL_MS));
            if ((await ask(widget, "getCurrentSound"))?.title) return widget.play();
        }
    }

    function reloadPlaylist(startAt, autoplay) {
        dropResume();
        updatePending = false;
        seekTarget = null;
        position = 0;
        widget.load(activePlaylist, {
            ...WIDGET_OPTS,
            auto_play: false,
            callback: async () => {
                const sounds = await ask(widget, "getSounds");
                loadedIds = idsOf(sounds).join(",");
                if (autoplay && sounds?.length) skipAndPlay(wrap(startAt, sounds.length));
                refreshSound();
            },
        });
    }

    function applyUpdate(step) {
        const at = latestIds.indexOf(currentId);
        const base = at >= 0 ? at + step : trackIndex + Math.min(step, 0);
        reloadPlaylist(base, true);
    }

    function checkPlaylist() {
        if (!scout || document.hidden) return;
        scout.load(activePlaylist, {
            ...WIDGET_OPTS,
            auto_play: false,
            callback: async () => {
                const ids = idsOf(await ask(scout, "getSounds"));
                if (!ids.length || ids.join(",") === loadedIds) return;
                latestIds = ids;
                if (hasPlayed) updatePending = true;
                else reloadPlaylist(0, false);
            },
        });
    }

    let keepAlive;

    // chrome requires at least five seconds of media for full audio focus
    function silentWavUrl(seconds = 6, rate = 8000) {
        const n = seconds * rate;
        const buf = new ArrayBuffer(44 + n);
        const v = new DataView(buf);
        const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
        str(0, "RIFF"); v.setUint32(4, 36 + n, true); str(8, "WAVE");
        str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
        str(36, "data"); v.setUint32(40, n, true);
        new Uint8Array(buf, 44).fill(128);
        return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    }

    function syncKeepAlive() {
        if (!keepAlive) return;
        if (playing) keepAlive.play().catch(() => {});
        else keepAlive.pause();
    }

    $effect(() => {
        playing;
        syncKeepAlive();
    });

    function play() {
        if (!ready) return;
        keepAlive?.play().catch(() => {});
        if (resume) {
            resume.playing = true;
            skipAndPlay(trackIndex);
            return;
        }
        widget.play();
    }

    function pause() {
        if (!ready) return;
        if (resume) resume.playing = false;
        keepAlive?.pause();
        widget.pause();
    }

    $effect(() => {
        const wanted = playlist || DEFAULT_PLAYLIST;
        if (library || !ready || wanted === activePlaylist) return;
        activePlaylist = wanted;
        loadedIds = "";
        latestIds = [];
        played = [];
        reloadPlaylist(0, playing);
    });

    function toggle() {
        if (playing) pause();
        else play();
    }

    async function next() {
        if (!ready) return;
        dropResume();
        if (shuffle) return shuffleNext();
        if (updatePending) return applyUpdate(1);
        const [i, sounds] = await Promise.all([ask(widget, "getCurrentSoundIndex"), ask(widget, "getSounds")]);
        if (i < (sounds?.length ?? 1) - 1) widget.next();
        else widget.skip(0);
    }

    async function prev() {
        if (!ready) return;
        if (position > 3000) return seek(0);
        dropResume();
        if (shuffle) return shufflePrev();
        if (updatePending) return applyUpdate(-1);
        const [i, sounds] = await Promise.all([ask(widget, "getCurrentSoundIndex"), ask(widget, "getSounds")]);
        if (i > 0) widget.prev();
        else widget.skip((sounds?.length ?? 1) - 1);
    }

    function toggleShuffle() {
        shuffle = !shuffle;
        played = shuffle && currentId ? [currentId] : [];
        savePosition();
    }

    function holdFor(id) {
        pendingId = id;
        pendingUntil = performance.now() + HOLD_MS;
    }

    function pickUnplayed(ids) {
        let fresh = ids.filter((id) => !played.includes(id));
        if (!fresh.length) {
            played = [currentId];
            fresh = ids.filter((id) => id !== currentId);
        }
        return fresh[Math.floor(Math.random() * fresh.length)] ?? currentId;
    }

    async function shuffleNext() {
        holdFor(-1);
        const reload = updatePending;
        const ids = reload ? latestIds : idsOf(await ask(widget, "getSounds"));
        const id = pickUnplayed(ids);
        holdFor(id);
        if (reload) reloadPlaylist(ids.indexOf(id), true);
        else widget.skip(ids.indexOf(id));
    }

    async function shufflePrev() {
        played.pop();
        const id = played.at(-1);
        if (id === undefined) {
            played = [currentId];
            return seek(0);
        }
        const i = idsOf(await ask(widget, "getSounds")).indexOf(id);
        if (i < 0) return shufflePrev();
        holdFor(id);
        widget.skip(i);
    }

    function seek(ms) {
        if (!ready || !Number.isFinite(ms)) return;
        const target = Math.max(0, Math.min(duration || ms, ms));
        position = target;
        seekTarget = target;
        seekUntil = performance.now() + 4000;
        if (resume) resume.position = target;
        widget.seekTo(target);
    }

    function onProgress(ms) {
        if (scrubbing) return;
        if (resume) {
            if (Math.abs(ms - resume.position) > 1500) return;
            endResume();
        }
        if (seekTarget !== null) {
            const stale = Math.abs(ms - seekTarget) > 1500 && performance.now() < seekUntil;
            if (stale) return;
            seekTarget = null;
        }
        position = ms;
        if (performance.now() - savedAt > SAVE_MS) savePosition();
    }

    function pointerMs(e) {
        const r = e.currentTarget.getBoundingClientRect();
        return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration;
    }

    function scrubStart(e) {
        // a mac context menu swallows the pointerup, so right and ctrl clicks never start a drag
        if (!ready || !duration || e.button !== 0 || e.ctrlKey) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        scrubbing = true;
        seek(pointerMs(e));
    }

    function scrubMove(e) {
        if (!scrubbing) return;
        if (!e.buttons) return scrubEnd();
        scrubbed = true;
        glide?.cancel();
        position = pointerMs(e);
        pudding?.nudge(e.movementX);
    }

    function scrubEnd() {
        if (!scrubbing) return;
        scrubbing = false;
        if (scrubbed) seek(position);
        scrubbed = false;
    }

    function setupMediaKeys() {
        if (!("mediaSession" in navigator)) return () => {};
        const session = navigator.mediaSession;
        const handlers = {
            play,
            pause,
            stop: () => { pause(); seek(0); },
            nexttrack: next,
            previoustrack: prev,
            seekto: (d) => seek(d.seekTime * 1000),
            seekbackward: (d) => seek(position - (d.seekOffset ?? 10) * 1000),
            seekforward: (d) => seek(position + (d.seekOffset ?? 10) * 1000),
        };
        const registered = [];
        for (const [action, handler] of Object.entries(handlers)) {
            try {
                session.setActionHandler(action, handler);
                registered.push(action);
            } catch {
                // nothing HAHA catch nothing or wait maybe it catches 21? get it?? catch 21??
            }
        }
        return () => {
            for (const action of registered) session.setActionHandler(action, null);
            session.metadata = null;
            session.playbackState = "none";
            session.setPositionState?.();
        };
    }

    $effect(() => {
        if (!("mediaSession" in navigator) || !("MediaMetadata" in window) || !ready) return;
        navigator.mediaSession.metadata = new MediaMetadata({
            title,
            artist,
            album: "Haven NYC",
            artwork: art ? [{ src: art, sizes: "500x500", type: "image/jpeg" }] : [],
        });
    });

    $effect(() => {
        if (!("mediaSession" in navigator)) return;
        navigator.mediaSession.playbackState = playing ? "playing" : ready ? "paused" : "none";
    });

    $effect(() => {
        if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
        if (!ready || !Number.isFinite(duration) || duration <= 0) {
            navigator.mediaSession.setPositionState();
            return;
        }
        try {
            navigator.mediaSession.setPositionState({
                duration: duration / 1000,
                position: Math.max(0, Math.min(position, duration)) / 1000,
                playbackRate: 1,
            });
        } catch {}
    });

    function seekFromKey(e) {
        if (!ready) return;
        const step = { ArrowLeft: -5000, ArrowRight: 5000 }[e.key];
        if (!step) return;
        e.preventDefault();
        pudding?.nudge(Math.sign(step) * 12);
        seek(position + step);
    }

    onMount(() => {
        let raf;

        keepAlive = new Audio(silentWavUrl());
        keepAlive.loop = true;
        const cleanupMediaKeys = setupMediaKeys();
        let poll;
        let cancelled = false;

        const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        const SPIN_DEG_PER_MS = reduced ? 0.012 : 0.054;
        let angle = 0, vel = 0, last = performance.now();
        pudding = createPudding({ root: puddingEl, spikes: spikesEl, head: headEl, expression: expressionEl, notes: popNotes, reduced });

        const spin = (t) => {
            const dt = Math.min(64, t - last);
            last = t;
            const target = playing ? SPIN_DEG_PER_MS : 0;
            vel += (target - vel) * (1 - Math.exp(-dt / 450));
            angle = (angle + vel * dt) % 360;
            if (disc) disc.style.transform = `rotate(${angle}deg)`;
            pudding.tick(t, dt, { playing, position, duration, still });
            raf = requestAnimationFrame(spin);
        };
        raf = requestAnimationFrame(spin);

        const onVisible = () => { if (!document.hidden) checkPlaylist(); };
        window.addEventListener("pagehide", savePosition);

        function offAir(reason) {
            failed = true;
            title = "the radio's quiet";
            artist = reason;
        }

        function connect(E) {
            widget.bind(E.READY, async () => {
                ready = true;
                const ids = idsOf(await ask(widget, "getSounds"));
                loadedIds = ids.join(",");
                if (resume) return startResume(ids);
                widget.setVolume(100);
                refreshSound();
            });
            widget.bind(E.PLAY, () => {
                hasPlayed = true;
                playing = resume ? resume.playing : true;
                if (resume) {
                    widget.seekTo(resume.position);
                    resumeTimer ||= setTimeout(endResume, RESUME_TIMEOUT_MS);
                }
                refreshSound();
            });
            widget.bind(E.PAUSE, () => { playing = false; savePosition(); });
            widget.bind(E.PLAY_PROGRESS, (e) => onProgress(e.currentPosition));
            widget.bind(E.SEEK, (e) => onProgress(e.currentPosition));
            widget.bind(E.FINISH, async () => {
                playing = false;
                if (shuffle) return shuffleNext();
                if (updatePending) return applyUpdate(1);
                const [i, sounds] = await Promise.all([ask(widget, "getCurrentSoundIndex"), ask(widget, "getSounds")]);
                if (i >= (sounds?.length ?? 1) - 1) widget.skip(0);
            });
        }

        function startLocal(tracks) {
            if (cancelled) return;
            if (!tracks.length) return offAir("your mp3s are gone, add them again in settings");
            widget = createLocalWidget(tracks);
            primeResume();
            connect(LOCAL_EVENTS);
            widget.start(!resume);
        }

        function startSoundCloud() {
            if (cancelled) return;
            iframe.src = widgetSrc(!resume);
            widget = window.SC.Widget(iframe);
            connect(window.SC.Widget.Events);

            scoutFrame.src = widgetSrc(false);
            scout = window.SC.Widget(scoutFrame);
            poll = setInterval(checkPlaylist, POLL_MS);
            document.addEventListener("visibilitychange", onVisible);
        }

        if (library) {
            activePlaylist = `local:${library.id}`;
            loadLibrary(library.id).catch(() => []).then(startLocal);
        } else {
            activePlaylist = playlist || DEFAULT_PLAYLIST;
            primeResume();
            loadScript().then(startSoundCloud).catch(() => offAir("couldn't reach soundcloud"));
        }

        return () => {
            cancelled = true;
            widget?.destroy?.();
            cancelAnimationFrame(raf);
            pudding.destroy();
            clearTimeout(resumeTimer);
            window.removeEventListener("pagehide", savePosition);
            cleanupMediaKeys();
            keepAlive.pause();
            URL.revokeObjectURL(keepAlive.src);
            keepAlive = null;
            clearInterval(poll);
            document.removeEventListener("visibilitychange", onVisible);
        };
    });
</script>

<div class="deck {layout}" class:playing dir="ltr">
    {#if !library}
        <iframe
            bind:this={iframe}
            class="sc"
            title="SoundCloud audio"
            aria-hidden="true"
            tabindex="-1"
            allow="autoplay; encrypted-media"
        ></iframe>
        <iframe
            bind:this={scoutFrame}
            class="sc"
            title="SoundCloud playlist check"
            aria-hidden="true"
            tabindex="-1"
        ></iframe>
    {/if}

    <div class="slot">
        <div class="vinyl" bind:this={disc}>
            <div class="label">
                {#if art}
                    <img src={art} alt="Cover art for {title}" />
                {:else}
                    <span>haven</span>
                {/if}
            </div>
            <div class="hole"></div>
        </div>
        <div class="sheen"></div>
        <div class="notes" aria-hidden="true">
            <span>♪</span><span>♫</span>
        </div>
    </div>

    <div class="tagwrap">
        <div class="popnotes" bind:this={popNotes} aria-hidden="true">
            <span>♪</span><span>♫</span><span>♪</span><span>♫</span>
        </div>
        <button class="pudding" bind:this={puddingEl} aria-label="Boop Pudding the hedgehog" title="Boop Pudding" onclick={() => pudding?.boop()}>
            <img class="spikes" bind:this={spikesEl} src={resolve("haven/pudding-spikes.webp")} alt="" draggable="false" />
            <span class="head" bind:this={headEl}>
                <img class="face" src={resolve("haven/pudding-face.webp")} alt="" draggable="false" />
                <svg class="expression" bind:this={expressionEl} viewBox="0 0 1650 1864" aria-hidden="true">
                    <g class="shape shut">
                        <circle cx="642" cy="722" r="38" />
                        <circle cx="998" cy="687" r="38" />
                        <path d="M606 722q36 26 72 0M962 687q36 26 72 0" />
                    </g>
                    <g class="shape happy">
                        <circle cx="642" cy="722" r="38" />
                        <circle cx="998" cy="687" r="38" />
                        <path d="M606 738q36 -44 72 0M962 703q36 -44 72 0" />
                    </g>
                    <g class="shape wide">
                        <circle cx="642" cy="722" r="38" />
                        <circle cx="998" cy="687" r="38" />
                        <circle class="ink" cx="642" cy="722" r="35" />
                        <circle class="ink" cx="998" cy="687" r="35" />
                    </g>
                    <g class="shape wow">
                        <ellipse cx="843" cy="756" rx="66" ry="46" />
                        <ellipse class="ink" cx="843" cy="770" rx="20" ry="28" />
                    </g>
                </svg>
            </span>
            <span class="zzz" aria-hidden="true"><span>z</span><span>z</span><span>z</span></span>
        </button>
        <div class="tag">
            <div aria-live="polite">
                <p class="title" title={title} dir="auto">{title}</p>
                <p class="artist" dir="auto">{artist || " "}</p>
            </div>

            <div
                class="progress"
                role="slider"
                tabindex="0"
                aria-label="Seek"
                aria-valuemin="0"
                aria-valuemax={Math.round(duration / 1000)}
                aria-valuenow={Math.round(position / 1000)}
                aria-valuetext="{fmt(position)} of {fmt(duration)}"
                onpointerdown={scrubStart}
                onpointermove={scrubMove}
                onpointerup={scrubEnd}
                onpointercancel={scrubEnd}
                onlostpointercapture={scrubEnd}
                onkeydown={seekFromKey}
            >
                <div class="fill" bind:this={fill} style:width="{progress * 100}%"></div>
            </div>

            <div class="foot">
                <span class="meta">
                    {#if failed}off air{:else}{fmt(position)} / {fmt(duration)}{#if trackCount}<span class="no">no. {trackIndex + 1} of {trackCount}</span>{/if}{/if}
                </span>
                <div class="controls">
                    <button class="shuffle" class:on={shuffle} aria-label="Shuffle" aria-pressed={shuffle} title={shuffle ? "Shuffle on" : "Shuffle off"} onclick={toggleShuffle} disabled={!ready}>
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path class="s" d="M3 7h3.2c1.9 0 3.1.8 4.1 2.4l3.4 5.2c1 1.6 2.2 2.4 4.1 2.4H20M3 17h3.2c1.5 0 2.6-.5 3.5-1.5M14.3 8.5c.9-1 2-1.5 3.5-1.5H20M17.5 4 20.5 7l-3 3M17.5 14l3 3-3 3" /></svg>
                    </button>
                    <button aria-label="Previous" title="Previous" onclick={prev} disabled={!ready}>
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path class="s" d="M6 5.5v13" /><path d="M18 6.5 9 12l9 5.5z" /></svg>
                    </button>
                    <button class="play" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause" : "Play"} onclick={toggle} disabled={!ready}>
                        {#if playing}
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path class="s thick" d="M9 7v10M15 7v10" /></svg>
                        {:else}
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5 18 12l-9 5.5z" /></svg>
                        {/if}
                    </button>
                    <button aria-label="Next" title="Next" onclick={next} disabled={!ready}>
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path class="s" d="M18 5.5v13" /><path d="M6 6.5 15 12l-9 5.5z" /></svg>
                    </button>
                </div>
            </div>
        </div>
    </div>
</div>

<style>
    .deck {
        --disc: 112px;
        --tag-w: 272px;

        position: fixed;
        z-index: 1000;
        width: calc(var(--tag-w) + 84px);
        height: 124px;
    }
    .deck.corner {
        left: 22px;
        bottom: 20px;
        transform-origin: bottom left;
    }
    .deck.center {
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%) scale(1.5);
    }
    .deck.bottom {
        left: 50%;
        bottom: 28px;
        transform: translateX(-50%) scale(1.15);
        transform-origin: bottom center;
    }
    @media (max-width: 600px) {
        .deck.corner { left: 12px; bottom: 12px; transform: scale(0.85); }
        .deck.center { transform: translate(-50%, -50%) scale(1.1); }
        .deck.bottom { bottom: 16px; transform: translateX(-50%) scale(0.9); }
    }

    .sc {
        position: absolute;
        z-index: -1;
        left: 0;
        bottom: 0;
        width: 300px;
        height: 166px;
        opacity: 0.01;
        pointer-events: none;
        border: 0;
    }

    .pudding {
        position: absolute;
        z-index: 0;
        width: 150px;
        aspect-ratio: 1650 / 1864;
        left: 12px;
        bottom: calc(100% - 87.6px);
        padding: 0;
        border: 0;
        background: none;
        cursor: pointer;
        transform-origin: 50% 62.4%;
        will-change: transform;
        -webkit-tap-highlight-color: transparent;
    }
    .pudding:focus-visible {
        outline: 3px solid var(--rust-deep);
        outline-offset: 2px;
    }
    .pudding img,
    .head,
    .expression {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        user-select: none;
    }
    .spikes {
        transform-origin: 47.5% 38%;
        will-change: transform;
    }
    .head {
        transform-origin: 47.5% 38%;
        will-change: transform;
    }
    .expression {
        pointer-events: none;
    }
    .shape {
        opacity: 0;
    }
    .shape circle,
    .shape ellipse {
        fill: #f7a387;
    }
    .shape .ink {
        fill: #803a27;
    }
    .shape path {
        fill: none;
        stroke: #803a27;
        stroke-width: 16;
        stroke-linecap: round;
    }

    .zzz {
        position: absolute;
        left: 74%;
        top: 21%;
        pointer-events: none;
    }
    .zzz span {
        position: absolute;
        font-family: var(--font-display);
        font-size: 15px;
        color: #fff;
        text-shadow: 0 0 6px var(--haven-orange-deep);
        opacity: 0;
    }
    .pudding:global(.asleep) .zzz span {
        animation: snooze 3.6s ease-out infinite;
    }
    .pudding:global(.asleep) .zzz span:nth-child(2) {
        animation-delay: 1.2s;
    }
    .pudding:global(.asleep) .zzz span:nth-child(3) {
        animation-delay: 2.4s;
    }
    @keyframes snooze {
        0% { opacity: 0; transform: translate(0, 6px) scale(0.6); }
        20% { opacity: 1; }
        100% { opacity: 0; transform: translate(20px, -34px) scale(1.15) rotate(12deg); }
    }

    .popnotes {
        position: absolute;
        z-index: 0;
        left: 86px;
        bottom: calc(100% + 56px);
        pointer-events: none;
    }
    .popnotes span {
        position: absolute;
        font-size: 17px;
        font-family: system-ui, sans-serif;
        color: #fff;
        opacity: 0;
        text-shadow: 0 0 8px var(--haven-orange-deep);
    }

    .slot {
        position: absolute;
        z-index: 1;
        bottom: 6px;
        left: calc(var(--tag-w) - var(--disc) + 10px);
        width: var(--disc);
        height: var(--disc);
        transform: translateX(26px);
        transition: transform 1.1s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .playing .slot {
        transform: translateX(64px);
    }

    .vinyl {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        background: repeating-radial-gradient(circle, #1d1714 0 1.1px, #261e1a 1.1px 2.4px);
        box-shadow:
            0 0 0 4px #fff,
            0 8px 18px rgb(0 0 0 / 0.35),
            inset 0 0 0 3px #120e0c;
        will-change: transform;
    }
    .label {
        position: absolute;
        inset: 24%;
        border-radius: 50%;
        overflow: hidden;
        display: grid;
        place-items: center;
        background: var(--rust);
        box-shadow: 0 0 0 4px #120e0c;
    }
    .label img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
    .label span {
        font-family: var(--font-display);
        font-size: 12px;
        color: var(--sticker);
    }
    .hole {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 6px;
        height: 6px;
        margin: -3px 0 0 -3px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 0 0 1px rgb(0 0 0 / 0.5);
    }
    .sheen {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        pointer-events: none;
        background: conic-gradient(
            from 20deg,
            transparent 0 8%,
            rgb(255 255 255 / 0.12) 13%,
            transparent 20% 52%,
            rgb(255 255 255 / 0.07) 60%,
            transparent 68%
        );
        mix-blend-mode: screen;
    }

    .notes {
        position: absolute;
        right: 6px;
        top: -4px;
        pointer-events: none;
    }
    .notes span {
        position: absolute;
        font-size: 18px;
        font-family: system-ui, sans-serif;
        color: #fff;
        opacity: 0;
        text-shadow: 0 0 8px var(--haven-orange-deep);
    }
    .playing .notes span {
        animation: drift 6s ease-out infinite;
    }
    .playing .notes span:nth-child(2) {
        animation-delay: 3s;
        left: 12px;
        font-size: 15px;
    }
    @keyframes drift {
        0% { opacity: 0; transform: translate(0, 8px) rotate(-10deg); }
        15% { opacity: 1; }
        100% { opacity: 0; transform: translate(16px, -54px) rotate(14deg); }
    }

    .tagwrap {
        position: absolute;
        z-index: 2;
        left: 0;
        bottom: 0;
        width: var(--tag-w);
    }
    .tag {
        position: relative;
        z-index: 1;
        box-sizing: border-box;
        padding: 14px 16px 12px;
        border-radius: 1.25rem;
        background: var(--sticker);
        border: 5px solid var(--sticker-edge);
        box-shadow: 0 6px 18px rgb(60 25 5 / 0.3);
    }
    .tag,
    .tag * {
        color: var(--sticker-ink);
    }

    .title,
    .artist {
        margin: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .title {
        font-family: var(--font-display);
        font-size: 23px;
        line-height: 0.95;
        letter-spacing: -0.03em;
        padding-bottom: 2px;
    }
    .artist {
        font-size: 14px;
        line-height: 1.2;
        color: var(--sticker-ink-soft);
    }

    .progress {
        position: relative;
        height: 5px;
        margin: 12px 0 8px;
        border-radius: 99px;
        background: oklch(0.34 0.08 45 / 0.16);
        cursor: pointer;
        touch-action: none;
    }
    .progress::after {
        content: "";
        position: absolute;
        inset: -9px 0;
    }
    .progress:focus-visible {
        outline: 3px solid var(--rust-deep);
        outline-offset: 4px;
    }
    .fill {
        position: relative;
        height: 100%;
        border-radius: inherit;
        background: var(--rust);
    }
    .fill::after {
        content: "";
        position: absolute;
        top: 50%;
        right: -6.5px;
        width: 13px;
        height: 13px;
        margin-top: -6.5px;
        border-radius: 50%;
        background: var(--rust-deep);
        box-shadow: 0 0 0 2px var(--sticker);
        transition: transform 0.15s ease-out;
    }
    .progress:hover .fill::after {
        transform: scale(1.15);
    }
    .progress:active .fill::after {
        transform: scale(1.3);
    }

    .foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }
    .meta {
        display: flex;
        flex-direction: column;
        font-size: 12.5px;
        line-height: 1.2;
        color: var(--sticker-ink-soft);
    }
    .meta .no {
        color: var(--sticker-ink-soft);
        font-size: 11.5px;
    }

    .controls {
        display: flex;
        align-items: center;
        gap: 4px;
    }
    .controls button {
        display: grid;
        place-items: center;
        width: 32px;
        height: 32px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        cursor: pointer;
        transition: transform 0.15s ease-out;
    }
    .controls button.play {
        width: 42px;
        height: 42px;
        background: var(--rust-deep);
    }
    .controls button.play,
    .controls button.play * {
        color: var(--sticker);
    }
    .controls button.shuffle {
        position: relative;
    }
    .controls button.shuffle,
    .controls button.shuffle * {
        color: var(--sticker-ink-soft);
    }
    .controls button.shuffle.on,
    .controls button.shuffle.on * {
        color: var(--rust-deep);
    }
    .controls button.shuffle.on::after {
        content: "";
        position: absolute;
        left: 50%;
        bottom: 0;
        width: 4px;
        height: 4px;
        margin-left: -2px;
        border-radius: 50%;
        background: var(--rust-deep);
    }
    .controls svg {
        width: 20px;
        height: 20px;
        fill: currentColor;
        stroke: currentColor;
        stroke-width: 2.2;
        stroke-linejoin: round;
        stroke-linecap: round;
    }
    .controls svg .s {
        fill: none;
        stroke-width: 2.6;
    }
    .controls svg .thick {
        stroke-width: 3.6;
    }
    .controls button:hover:not(:disabled) {
        transform: scale(1.08);
    }
    .controls button:active:not(:disabled) {
        transform: scale(1);
    }
    .controls button:focus-visible {
        outline: 3px solid var(--rust-deep);
        outline-offset: 2px;
    }
    .controls button:disabled {
        opacity: 0.5;
        cursor: default;
    }

    @media (prefers-reduced-motion: reduce) {
        .playing .notes span,
        .pudding:global(.asleep) .zzz span { animation: none; }
        .slot { transition: none; }
    }
</style>
