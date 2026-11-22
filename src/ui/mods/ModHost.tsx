import { useEffect, useSyncExternalStore } from "react";
import { registry } from "../registry/ComponentRegistry";
import { modMessageBus } from "./ModMessageBus";
import { onChatTurnDelta, onChatTurnFinish } from "../../lib/kokoro-bridge";
import { readBooleanSetting, readStringSetting, APP_SETTING_KEYS } from "../../lib/app-settings";

let registrySnapshot = 0;
const subscribeRegistry = (onStoreChange: () => void) =>
    registry.subscribe(() => {
        registrySnapshot++;
        onStoreChange();
    });
const getRegistrySnapshot = () => registrySnapshot;

/**
 * Zero-size mount point for a MOD that needs a live document but no pixels.
 *
 * A MOD claims it by registering a component named "ModHost" in its manifest;
 * with no such MOD nothing renders at all. The iframe is 1x1 and visually
 * invisible but stays *rendered* (not display:none), so its document keeps
 * running: getUserMedia, WebAudio playback, fetch and timers all work.
 *
 * Why it exists: echo cancellation only applies to audio that enters the graph
 * of the document that owns the microphone. A MOD that captures the mic and
 * plays the reply inside this one document gets Chromium's AEC for free, which
 * the native path cannot do while playback happens in Rust (cpal).
 *
 * It also re-broadcasts turn text itself: App.tsx carries a `chat-delta` effect,
 * but in 0.4.6 such a frame never received those broadcasts (a raw message
 * listener saw only `prop-update` across a whole turn), so this keeps the
 * engine-event to iframe path working regardless of that effect.
 */
export const ModHost = () => {
    useSyncExternalStore(subscribeRegistry, getRegistrySnapshot);
    const Host = registry.get("ModHost");

    useEffect(() => {
        if (!Host) return;
        let alive = true;
        const unlisteners: Array<() => void> = [];
        const keep = (unlisten: () => void) => {
            if (alive) unlisteners.push(unlisten);
            else unlisten();
        };
        void onChatTurnDelta(({ turn_id, delta }) =>
            modMessageBus.broadcast({ type: "event", payload: { name: "chat-delta", delta, turn_id } })
        ).then(keep).catch(() => { /* engine stream unavailable */ });
        void onChatTurnFinish(({ turn_id, status }) =>
            modMessageBus.broadcast({ type: "event", payload: { name: "chat-done", turn_id, status } })
        ).then(keep).catch(() => { /* engine stream unavailable */ });
        // The app's own Voice Interrupt service cannot see a MOD frame's playback,
        // so it can neither detect speech over it nor stop it. Publish the setting
        // to the frame instead; it is the one holding the audio.
        // Broadcast unconditionally: the frame may not be registered yet when this
        // effect first runs (so a one-shot send is lost), and the setting is stored
        // in localStorage which only changes on a settings save. One postMessage
        // every 1.5 s is cheaper than the bugs a cache of "last value" caused.
        const publishInterrupt = () =>
            modMessageBus.broadcast({
                type: "event",
                payload: { name: "voice-interrupt", enabled: readBooleanSetting(APP_SETTING_KEYS.voiceInterrupt, false) },
            });
        // The frame cannot read the host's localStorage (different origin), but it is
        // the only place that speaks. Publish who is active so the voice matches the
        // character instead of every persona borrowing one voice.
        const publishCharacter = () =>
            modMessageBus.broadcast({
                type: "event",
                payload: { name: "character", id: readStringSetting(APP_SETTING_KEYS.activeCharacterId, "") },
            });
        // The mic button belongs to the app, but the microphone belongs to the MOD.
        // Publish its state so the icon and the actual capture can never disagree,
        // and react immediately to a click instead of waiting for the next tick.
        const publishMic = () =>
            modMessageBus.broadcast({
                type: "event",
                payload: { name: "mic", enabled: readBooleanSetting(APP_SETTING_KEYS.modMic, true) },
            });
        // The STT tab's language selector is a hint to the recognizer; the MOD talks to
        // the recognizer, so pass it through instead of leaving that control inert.
        const publishEars = () =>
            modMessageBus.broadcast({
                type: "event",
                payload: { name: "ears", language: readStringSetting(APP_SETTING_KEYS.sttLanguage, "") },
            });
        const onMicToggle = () => publishMic();
        window.addEventListener("kokoro:mod-mic", onMicToggle);
        publishInterrupt();
        publishCharacter();
        publishMic();
        publishEars();
        const interval = window.setInterval(() => {
            publishInterrupt();
            publishCharacter();
            publishMic();
            publishEars();
        }, 1500);

        return () => {
            alive = false;
            window.clearInterval(interval);
            window.removeEventListener("kokoro:mod-mic", onMicToggle);
            for (const off of unlisteners) off();
        };
    }, [Host]);

    if (!Host) return null;
    return (
        <div
            aria-hidden="true"
            data-mod-host=""
            style={{
                position: "fixed",
                left: 0,
                bottom: 0,
                width: 1,
                height: 1,
                overflow: "hidden",
                opacity: 0.01,
                pointerEvents: "none",
                zIndex: -1,
            }}
        >
            <Host />
        </div>
    );
};
