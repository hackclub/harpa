// @ts-nocheck
export const DEFAULT_PLAYLIST = "https://api.soundcloud.com/playlists/2323201092";

export const LOGO_POSITIONS = [
    { value: "top-center", label: "Top center" },
    { value: "top-left", label: "Top left" },
    { value: "top-right", label: "Top right" },
    { value: "bottom-right", label: "Bottom right" },
];

const KEY = "harpa:haven";
const PLAYBACK_KEY = "harpa:playback";
const EMPTY = { onboarded: false, logo: null, logoPosition: "top-center", playlist: null, playlistTitle: null, mp3s: null, puddingStill: false };

export function loadSettings() {
    try {
        const raw = localStorage.getItem(KEY);
        return raw ? { ...EMPTY, ...JSON.parse(raw) } : { ...EMPTY };
    } catch {
        return { ...EMPTY };
    }
}

export function saveSettings(settings) {
    try {
        localStorage.setItem(KEY, JSON.stringify(settings));
        return true;
    } catch {
        return false;
    }
}

export function loadPlayback() {
    try {
        return JSON.parse(localStorage.getItem(PLAYBACK_KEY));
    } catch {
        return null;
    }
}

export function savePlayback(playback) {
    try {
        localStorage.setItem(PLAYBACK_KEY, JSON.stringify(playback));
    } catch {
        // losing your spot beats breaking the radio
    }
}

export function logoFromFile(file, maxSide = 900) {
    return new Promise((res, rej) => {
        if (!file.type.startsWith("image/")) return rej(new Error("That file isn't an image."));
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const w = img.naturalWidth || maxSide;
            const h = img.naturalHeight || maxSide;
            const scale = Math.min(1, maxSide / Math.max(w, h));
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(w * scale);
            canvas.height = Math.round(h * scale);
            canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            res(canvas.toDataURL("image/webp", 0.9));
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            rej(new Error("Couldn't read that image."));
        };
        img.src = url;
    });
}

export async function resolvePlaylist(input) {
    const link = input.trim();
    if (!/^https?:\/\/(www\.|m\.|on\.)?soundcloud\.com\//i.test(link) && !/^https?:\/\/api\.soundcloud\.com\//i.test(link)) {
        throw new Error("Paste a link from soundcloud.com.");
    }
    let data;
    try {
        const r = await fetch("https://soundcloud.com/oembed?format=json&url=" + encodeURIComponent(link));
        if (!r.ok) throw new Error();
        data = await r.json();
    } catch {
        throw new Error("SoundCloud couldn't find that link. Is the playlist public?");
    }
    const match = (data.html ?? "").match(/api\.soundcloud\.com(?:%2F|\/)(playlists|tracks)(?:%2F|\/)(\d+)/i);
    if (!match) throw new Error("That link isn't a playlist or track.");
    return { url: `https://api.soundcloud.com/${match[1]}/${match[2]}`, title: data.title ?? link };
}
