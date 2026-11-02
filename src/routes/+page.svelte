<script>
// @ts-nocheck

    import { onMount } from "svelte";
    import { resolve } from "$app/paths";
    import Turntable from "#lib/Turntable.svelte";
    import HavenSetup from "#lib/HavenSetup.svelte";
    import { loadSettings, saveSettings } from "#lib/havenSettings.js";
    import havenLogo from "#lib/assets/haven-logo-white.png";

    let width = $state(0);
    let height = $state(0);

    let vinylLayout = $state("corner");

    let settings = $state(null);
    let setupOpen = $state(false);
    let setupFirstRun = $state(false);
    let awake = $state(false);
    let sleepTimer;

    function handleSave(next) {
        if (!saveSettings(next)) return false;
        settings = next;
        setupOpen = false;
        setupFirstRun = false;
        return true;
    }

    function openSettings() {
        setupFirstRun = false;
        setupOpen = true;
    }

    function wake() {
        awake = true;
        clearTimeout(sleepTimer);
        sleepTimer = setTimeout(() => (awake = false), 2500);
    }

    function fullscreen() {
        if (document.fullscreenElement) {
            return;
        }
        // @ts-ignore
        document.getElementById("view").requestFullscreen();
    }
    onMount(() => {
        settings = loadSettings();
        if (!settings.onboarded) {
            setupFirstRun = true;
            setupOpen = true;
        }
        const requested = new URLSearchParams(location.search).get("vinyl");
        if (requested === "center" || requested === "bottom") {
            vinylLayout = requested;
        }
        window.addEventListener("fullscreenchange", (e) => {
            if (!document.fullscreenElement) {
                fullscreenEnabled = false;
                return;
            }
            fullscreenEnabled = true;
        })
    })

    let fullscreenEnabled = $state(false);
</script>

<style>
    #background {
        position: fixed;
        top: 0;
        transform: translate(-50%, 0%);
        left: 50%;
        z-index: 0;
        user-select: none;
        -webkit-user-drag: none;
        -moz-user-drag: none;
    }
    #treeLeft {
        position: fixed;
        z-index: 1;
        left: 0;
        height: 100%;
        user-select: none;
        -webkit-user-drag: none;
        -moz-user-drag: none;
        animation: treeLeft 15s infinite ease-in-out;
    }

    @keyframes treeLeft {
        0% {
            transform: translateX(0px)
        }
        50% {
            transform: translateX(-35px)
        }
        100% {
            transform: translateX(0px)
        }
    }

    #treeRight {
        position: fixed;
        z-index: 1;
        right: 0;
        height: 100%;
        user-select: none;
        -webkit-user-drag: none;
        -moz-user-drag: none;
        animation: treeRight 15s infinite ease-in-out;
    }

    @keyframes treeRight {
        0% {
            transform: translateX(0px)
        }
        50% {
            transform: translateX(20px)
        }
        100% {
            transform: translateX(0px)
        }
    }

    #sun1 {
        position: fixed;
        height: 100%;
        z-index: 0;
        left: 30px;
        opacity: 0.1;
        animation: treeLeft infinite 15s ease-in-out, surge 50s infinite ease-in-out;
        animation-delay: 2s;
    }

    #sun2 {
        position: fixed;
        height: 100%;
        z-index: 0;
        left: 70px;
        top: 50px;
        opacity: 0.2;
        animation: surgeLite 15s infinite ease-in-out;
        animation-delay: 2s;
    }

    @keyframes surge {
        0%, 100% {
            opacity: 0.05;
        }
        40% {
            opacity: 0.1;
        }
        60% {
            opacity: 0.5;
        }
        85% {
            opacity: 0.3;
        }
    }

    @keyframes surgeLite {
        0%, 100% {
            opacity: 0.2;
            transform: rotate(0deg) translateX(0px);
        }
        40% {
            opacity: 0.25;
        }
        50% {
            opacity: 0.3;
            transform: rotate(-5deg) translateX(-35px);
        }
        85% {
            opacity: 0.25;
        }
    }


    button {
        display: grid;
        place-items: center;
        padding: 10px;
        border: 0;
        border-radius: 1.25rem;
        background: var(--haven-orange-deep);
        cursor: pointer;
        transition: transform 0.15s ease-out;
        span {
            font-size: 36px;
            color: #fff;
            user-select: none;
        }
    }
    button:hover {
        transform: scale(1.04);
    }
    button:active {
        transform: scale(1);
    }
    button:focus-visible {
        outline: 3px solid var(--haven-yellow);
        outline-offset: 3px;
    }
    #fullscreen {
        position: fixed;
        z-index: 1000;
        top: 15px;
        right: 20px;
        transform: scale(0.8);
    }
    #fullscreen.dissapear {
        display: none;
    }

    #logos {
        position: fixed;
        z-index: 900;
        display: flex;
        align-items: center;
        gap: clamp(12px, 2vw, 28px);
        pointer-events: none;
        filter: drop-shadow(0 3px 0 oklch(0.32 0.08 42 / 0.4)) drop-shadow(0 6px 16px oklch(0.22 0.06 38 / 0.5));
        img {
            height: clamp(64px, 15vh, 150px);
            width: auto;
            max-width: 30vw;
            object-fit: contain;
        }
        .org {
            max-width: 24vw;
        }
    }
    #logos.pos-top-left {
        top: 24px;
        left: 28px;
    }
    #logos.pos-top-center {
        top: 24px;
        left: 50%;
        transform: translateX(-50%);
    }
    #logos.pos-top-right {
        top: 24px;
        right: 28px;
    }
    #logos.pos-top-right.clear {
        top: 84px;
    }
    #logos.pos-bottom-right {
        bottom: 28px;
        right: 28px;
    }

    #settings {
        position: fixed;
        z-index: 1000;
        top: 15px;
        right: 78px;
        transform: scale(0.8);
        transition: opacity 0.4s ease-out;
    }
    #settings.solo {
        right: 20px;
        display: none;
    }
    #settings.asleep {
        opacity: 0;
        pointer-events: none;
    }
    #settings.asleep:focus-within {
        opacity: 1;
        pointer-events: auto;
    }

</style>

<svelte:window bind:innerWidth={width} bind:innerHeight={height} onpointermove={wake} onpointerdown={wake} onkeydown={wake}></svelte:window>
<div id="view">
    <img id="background" src={resolve("haven/background.webp")} alt="Forest background" style:width={((width >= 990) ? 100 : 180)}%/>
    <img id="treeLeft" src={resolve("haven/treeLeft.webp")} alt="Tree" />
    <img id="treeRight" src={resolve("haven/treeRight.webp")} alt="Tree" />
    <img id="sun1" src={resolve("haven/sun1.webp")} alt="Ray of sunshine" />
    <img id="sun2" src={resolve("haven/sun2.webp")} alt="Ray of sunshine" />


    {#if settings}
        <div id="logos" class="pos-{settings.logoPosition}" class:clear={!fullscreenEnabled}>
            <img src={havenLogo} alt="Hack Club Haven" />
            {#if settings.logo}
                <img class="org" src={settings.logo} alt="Local Haven logo" />
            {/if}
        </div>
    {/if}

    {#if settings}
        {#key settings.mp3s?.id}
            <Turntable layout={vinylLayout} playlist={settings.playlist} library={settings.mp3s} still={settings.puddingStill} />
        {/key}
    {/if}

    <div id="settings" class:asleep={fullscreenEnabled && !awake && !setupOpen} class:solo={fullscreenEnabled}>
        <button title="Haven settings" aria-label="Haven settings" onclick={openSettings} translate="no"><span class="material-symbols-outlined">settings</span></button>
    </div>
    <div id="fullscreen" class:dissapear={fullscreenEnabled}>
        <button title="Enter Fullscreen" onclick={fullscreen} translate="no"><span class="material-symbols-outlined">fullscreen</span></button>
        <!--<p>Use {"<f>"} key to enter fullscreen</p>-->
    </div>

    {#if settings}
        <HavenSetup
            open={setupOpen}
            firstRun={setupFirstRun}
            {settings}
            onsave={handleSave}
            onclose={() => (setupOpen = false)}
        />
    {/if}
</div>