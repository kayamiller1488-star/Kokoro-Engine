// pattern: Imperative Shell

import {
    APP_SETTING_KEYS,
    readBooleanSetting,
    readNumberSetting,
    readStringSetting,
} from "./app-settings";
import { modMessageBus } from "../ui/mods/ModMessageBus";

/**
 * The MAGIC motion settings as they are persisted in app storage.
 *
 * Defaults here must match `MagicAnimationCard`: that card is the editor, this is the publisher
 * that lets the saved values reach the MOD without the owner opening Settings.
 */
export const MAGIC_CONFIG_DEFAULTS = Object.freeze({
    motion: true,
    idleProfile: "calm",
    speakingProfile: "excited",
    followSpeech: true,
    liveliness: 0.7,
    strength: 0.7,
});

/**
 * Push the stored MAGIC settings to the MOD frame.
 *
 * The MOD runs on `mod.localhost`, a different origin, so it cannot read `kokoro_magic_*` itself.
 * `MagicAnimationCard` publishes while it is mounted, which left a gap: on a fresh launch nobody had
 * opened Settings, so the driver sat on its built-in defaults (calm / 0.7 / 0.7) while storage said
 * excited / 0.85 / 1.1. The owner reads that as "my settings did not save".
 */
export function publishStoredMagicConfig(): void {
    modMessageBus.broadcast({
        type: "event",
        payload: {
            name: "magic",
            enabled: readBooleanSetting(APP_SETTING_KEYS.magicMotion, MAGIC_CONFIG_DEFAULTS.motion),
            idleProfile: readStringSetting(APP_SETTING_KEYS.magicIdleProfile, MAGIC_CONFIG_DEFAULTS.idleProfile),
            speakingProfile: readStringSetting(APP_SETTING_KEYS.magicSpeakingProfile, MAGIC_CONFIG_DEFAULTS.speakingProfile),
            followSpeech: readBooleanSetting(APP_SETTING_KEYS.magicFollowSpeech, MAGIC_CONFIG_DEFAULTS.followSpeech),
            noise: readNumberSetting(APP_SETTING_KEYS.magicLiveliness, MAGIC_CONFIG_DEFAULTS.liveliness),
            strength: readNumberSetting(APP_SETTING_KEYS.magicStrength, MAGIC_CONFIG_DEFAULTS.strength),
        },
    });
}
