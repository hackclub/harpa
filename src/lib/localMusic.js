// @ts-nocheck
const DB_NAME = "harpa-music";
const STORE = "tracks";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const MEASURE_TIMEOUT_MS = 10_000;

const DAMAGED = "That zip looks damaged.";

function openDb() {
    return new Promise((res, rej) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });
}

async function withStore(mode, work) {
    const db = await openDb();
    return new Promise((res, rej) => {
        const tx = db.transaction(STORE, mode);
        const req = work(tx.objectStore(STORE));
        tx.oncomplete = () => res(req?.result);
        tx.onerror = tx.onabort = () => rej(tx.error ?? new Error("Couldn't save to this browser."));
    }).finally(() => db.close());
}

const rangeOf = (id) => IDBKeyRange.bound([id], [id, []]);

export function loadLibrary(id) {
    return withStore("readonly", (store) => store.getAll(rangeOf(id)));
}

// everything that isn't `keep`, including uploads that never got saved
export async function pruneLibraries(keep) {
    const keys = await withStore("readonly", (store) => store.getAllKeys());
    const stale = new Set(keys.map(([id]) => id).filter((id) => id !== keep));
    if (!stale.size) return;
    await withStore("readwrite", (store) => {
        stale.forEach((id) => store.delete(rangeOf(id)));
    });
}

const view = async (blob) => new DataView(await blob.arrayBuffer());

async function zipEntries(file) {
    const tailStart = Math.max(0, file.size - EOCD_SIZE - MAX_COMMENT);
    const tail = await view(file.slice(tailStart));
    let at = tail.byteLength - EOCD_SIZE;
    while (at >= 0) {
        const commentEnd = at + EOCD_SIZE + tail.getUint16(at + 20, true);
        if (tail.getUint32(at, true) === EOCD_SIG && commentEnd === tail.byteLength) break;
        at--;
    }
    if (at < 0) throw new Error("That file isn't a zip.");

    const count = tail.getUint16(at + 10, true);
    const size = tail.getUint32(at + 12, true);
    const start = tail.getUint32(at + 16, true);
    if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) {
        throw new Error("That zip is over 4 GB. Try a smaller one.");
    }

    const dir = await view(file.slice(start, start + size));
    const names = new TextDecoder();
    const entries = [];
    for (let p = 0, i = 0; i < count; i++) {
        if (dir.getUint32(p, true) !== CENTRAL_SIG) throw new Error(DAMAGED);
        const nameLength = dir.getUint16(p + 28, true);
        entries.push({
            name: names.decode(new Uint8Array(dir.buffer, p + 46, nameLength)),
            flags: dir.getUint16(p + 8, true),
            method: dir.getUint16(p + 10, true),
            packed: dir.getUint32(p + 20, true),
            offset: dir.getUint32(p + 42, true),
        });
        p += 46 + nameLength + dir.getUint16(p + 30, true) + dir.getUint16(p + 32, true);
    }
    return entries;
}

async function unpack(file, entry) {
    const head = await view(file.slice(entry.offset, entry.offset + 30));
    if (head.getUint32(0, true) !== LOCAL_SIG) throw new Error(DAMAGED);
    const start = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    const packed = file.slice(start, start + entry.packed);
    if (entry.method === 0) return packed.slice(0, packed.size, "audio/mpeg");
    if (entry.method !== 8) throw new Error("Unsupported compression.");
    const stream = packed.stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const blob = await new Response(stream).blob();
    return blob.slice(0, blob.size, "audio/mpeg");
}

const ascii = (bytes) => String.fromCharCode(...bytes);
const uint = (bytes, at, length, bits = 8) => {
    let n = 0;
    for (let i = 0; i < length; i++) n = n * 2 ** bits + bytes[at + i];
    return n;
};

function tagText(bytes, encoding) {
    const bigEndian = encoding === 2 || (encoding === 1 && bytes[0] === 0xfe);
    const label = encoding === 0 ? "latin1" : encoding === 3 ? "utf-8" : bigEndian ? "utf-16be" : "utf-16le";
    return new TextDecoder(label).decode(bytes).replace(/\0.*$/s, "").trim();
}

function tagCover(frame, oldStyle) {
    const wide = frame[0] === 1 || frame[0] === 2;
    const mimeEnd = oldStyle ? 4 : frame.indexOf(0, 1);
    const mime = oldStyle ? `image/${ascii(frame.subarray(1, 4)).toLowerCase()}` : ascii(frame.subarray(1, mimeEnd));
    if (mime === "-->") return null;
    const step = wide ? 2 : 1;
    let p = mimeEnd + (oldStyle ? 1 : 2);
    while (p < frame.length && (frame[p] || (wide && frame[p + 1]))) p += step;
    const image = frame.subarray(p + step);
    return image.length ? new Blob([image], { type: mime.includes("/") ? mime : "image/jpeg" }) : null;
}

function resync(bytes) {
    return bytes.filter((byte, i) => !(byte === 0 && bytes[i - 1] === 0xff));
}

async function readTags(blob) {
    const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
    if (ascii(head.subarray(0, 3)) !== "ID3") return {};
    const major = head[3];
    const flags = head[5];
    let tag = new Uint8Array(await blob.slice(10, 10 + uint(head, 6, 4, 7)).arrayBuffer());
    if (flags & 0x80) tag = resync(tag);

    const oldStyle = major < 3;
    const idLength = oldStyle ? 3 : 4;
    const headLength = oldStyle ? 6 : 10;
    let p = 0;
    if (flags & 0x40) p = major === 4 ? uint(tag, 0, 4, 7) : uint(tag, 0, 4) + 4;

    const found = {};
    while (p + headLength < tag.length && tag[p]) {
        const id = ascii(tag.subarray(p, p + idLength));
        const length = major === 4 ? uint(tag, p + 4, 4, 7) : uint(tag, p + idLength, oldStyle ? 3 : 4);
        const frame = tag.subarray(p + headLength, p + headLength + length);
        p += headLength + length;
        if (id === "TIT2" || id === "TT2") found.title = tagText(frame.subarray(1), frame[0]);
        else if (id === "TPE1" || id === "TP1") found.artist = tagText(frame.subarray(1), frame[0]);
        else if (id === "APIC" || id === "PIC") found.art ??= tagCover(frame, oldStyle);
    }
    return found;
}

function namesFromFile(path) {
    const base = path.split("/").pop().replace(/\.mp3$/i, "");
    const clean = base.replace(/^\d+[\s._-]+/, "").replaceAll("_", " ").trim() || base;
    const [artist, ...rest] = clean.split(" - ");
    return rest.length ? { artist, title: rest.join(" - ") } : { artist: "", title: clean };
}

function measure(blob) {
    return new Promise((res) => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio();
        const timer = setTimeout(() => done(null), MEASURE_TIMEOUT_MS);
        function done(ms) {
            clearTimeout(timer);
            URL.revokeObjectURL(url);
            res(ms);
        }
        audio.preload = "metadata";
        audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration * 1000 : null);
        audio.onerror = () => done(null);
        audio.src = url;
    });
}

async function readTrack(file, entry) {
    try {
        const audio = await unpack(file, entry);
        const duration = await measure(audio);
        if (!duration) return null;
        const tags = await readTags(audio).catch(() => ({}));
        const names = namesFromFile(entry.name);
        return {
            audio,
            duration,
            title: tags.title || names.title,
            artist: tags.artist || names.artist,
            art: tags.art ?? null,
        };
    } catch {
        return null;
    }
}

export async function importZip(file, { signal, onProgress } = {}) {
    let songs;
    try {
        songs = (await zipEntries(file))
            .filter(({ name }) => /\.mp3$/i.test(name) && !/(^|\/)(__MACOSX\/|\._)/.test(name))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    } catch (e) {
        throw e instanceof RangeError ? new Error(DAMAGED) : e;
    }
    if (!songs.length) throw new Error("There aren't any MP3s in that zip.");
    if (songs.some((entry) => entry.flags & 1)) throw new Error("That zip has a password on it.");

    const id = String(Date.now());
    let count = 0;
    try {
        for (const [i, entry] of songs.entries()) {
            signal?.throwIfAborted();
            onProgress?.(i + 1, songs.length);
            const track = await readTrack(file, entry);
            if (!track) continue;
            await withStore("readwrite", (store) => {
                store.put(track, [id, count]);
            });
            count++;
        }
    } catch (e) {
        await withStore("readwrite", (store) => {
            store.delete(rangeOf(id));
        }).catch(() => {});
        if (signal?.aborted) throw e;
        if (e?.name === "QuotaExceededError") throw new Error("This browser ran out of room for those songs. Try a smaller zip.");
        throw new Error("This browser wouldn't save those songs. Private windows can't keep them.");
    }
    if (!count) throw new Error("None of the MP3s in that zip would play.");

    // ask the browser not to clear these out when disk space runs low
    navigator.storage?.persist?.().catch(() => {});
    return { id, name: file.name.replace(/\.zip$/i, ""), count, skipped: songs.length - count };
}

export const LOCAL_EVENTS = {
    READY: "ready",
    PLAY: "play",
    PAUSE: "pause",
    PLAY_PROGRESS: "progress",
    SEEK: "seek",
    FINISH: "finish",
};

// same surface as the soundcloud widget, so Turntable drives both the same way
export function createLocalWidget(tracks) {
    const E = LOCAL_EVENTS;
    const audio = new Audio();
    const urls = tracks.map((track) => URL.createObjectURL(track.audio));
    const sounds = tracks.map((track, i) => ({
        id: i + 1,
        title: track.title,
        user: { username: track.artist },
        duration: track.duration,
        artwork_url: track.art ? URL.createObjectURL(track.art) : null,
        waveform_url: null,
    }));

    let handlers = {};
    let index = 0;
    let turn = 0;

    const emit = (event, data) => handlers[event]?.(data);
    const at = () => ({ currentPosition: audio.currentTime * 1000 });
    const play = () => audio.play().catch(() => {});

    function cue(i) {
        index = i;
        turn++;
        audio.src = urls[i];
    }

    function skip(i) {
        cue(i);
        play();
    }

    audio.onplay = () => emit(E.PLAY);
    audio.onpause = () => emit(E.PAUSE);
    audio.ontimeupdate = () => emit(E.PLAY_PROGRESS, at());
    audio.onseeked = () => emit(E.SEEK, at());
    audio.onended = () => {
        const finished = turn;
        emit(E.FINISH);
        // like the widget, roll on to the next song unless the handler picked one
        setTimeout(() => {
            if (turn === finished && index < tracks.length - 1) skip(index + 1);
        });
    };

    cue(0);

    return {
        bind: (event, handler) => { handlers[event] = handler; },
        start(autoPlay) {
            emit(E.READY);
            if (autoPlay) play();
        },
        play,
        pause: () => audio.pause(),
        skip,
        next: () => skip(index + 1),
        prev: () => skip(index - 1),
        seekTo: (ms) => { audio.currentTime = ms / 1000; },
        setVolume: (volume) => { audio.volume = volume / 100; },
        getSounds: (reply) => reply(sounds),
        getCurrentSound: (reply) => reply(sounds[index]),
        getCurrentSoundIndex: (reply) => reply(index),
        artFor: (id) => sounds.find((sound) => sound.id === id)?.artwork_url ?? null,
        destroy() {
            handlers = {};
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
            urls.forEach((url) => URL.revokeObjectURL(url));
            sounds.forEach((sound) => sound.artwork_url && URL.revokeObjectURL(sound.artwork_url));
        },
    };
}
