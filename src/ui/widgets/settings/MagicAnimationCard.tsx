import { useCallback, useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";
import { Select } from "@/components/ui/select";
import { labelClasses } from "../../styles/settings-primitives";
import {
    APP_SETTING_KEYS,
    readBooleanSetting,
    readNumberSetting,
    readStringSetting,
    writeBooleanSetting,
    writeNumberSetting,
    writeStringSetting,
} from "../../../lib/app-settings";
import { modMessageBus } from "../../mods/ModMessageBus";

/**
 * ANIMATION — controls for the MAGIC motion driver.
 *
 * The driver itself lives in the MOD (it holds the fitted models and generates pose frames); this
 * card is only the switchboard. Settings are written to app storage on every change and pushed to
 * the MOD frame immediately, because the frame cannot read the host's localStorage - it is a
 * different origin (`mod.localhost`).
 *
 * The publish is repeated on an interval as well as on change: a MOD frame that registers with the
 * message bus after the first publish would otherwise sit on stale defaults until the next click.
 */

const DEFAULT_IDLE = "calm";
const DEFAULT_SPEAKING = "excited";
const DEFAULT_LIVELINESS = 0.7;
const DEFAULT_STRENGTH = 0.7;

type MotionSource = "model" | "magic";

export function MagicAnimationCard() {
    const { t } = useTranslation();

    const [source, setSource] = useState<MotionSource>(() =>
        readBooleanSetting(APP_SETTING_KEYS.magicMotion, true) ? "magic" : "model"
    );
    const [idleProfile, setIdleProfile] = useState<string>(() =>
        readStringSetting(APP_SETTING_KEYS.magicIdleProfile, DEFAULT_IDLE)
    );
    const [speakingProfile, setSpeakingProfile] = useState<string>(() =>
        readStringSetting(APP_SETTING_KEYS.magicSpeakingProfile, DEFAULT_SPEAKING)
    );
    const [followSpeech, setFollowSpeech] = useState<boolean>(() =>
        readBooleanSetting(APP_SETTING_KEYS.magicFollowSpeech, true)
    );
    const [liveliness, setLiveliness] = useState<number>(() =>
        readNumberSetting(APP_SETTING_KEYS.magicLiveliness, DEFAULT_LIVELINESS)
    );
    const [strength, setStrength] = useState<number>(() =>
        readNumberSetting(APP_SETTING_KEYS.magicStrength, DEFAULT_STRENGTH)
    );

    const publish = useCallback(() => {
        modMessageBus.broadcast({
            type: "event",
            payload: {
                name: "magic",
                enabled: source === "magic",
                idleProfile,
                speakingProfile,
                followSpeech,
                noise: liveliness,
                strength,
            },
        });
    }, [source, idleProfile, speakingProfile, followSpeech, liveliness, strength]);

    // Republish on a slow interval so a frame that mounts late still receives the current values.
    const publishRef = useRef(publish);
    publishRef.current = publish;
    useEffect(() => {
        publishRef.current();
        const timer = window.setInterval(() => publishRef.current(), 1500);
        return () => window.clearInterval(timer);
    }, []);

    const chooseSource = (next: MotionSource) => {
        setSource(next);
        writeBooleanSetting(APP_SETTING_KEYS.magicMotion, next === "magic");
        modMessageBus.broadcast({
            type: "event",
            payload: {
                name: "magic",
                enabled: next === "magic",
                idleProfile,
                speakingProfile,
                followSpeech,
                noise: liveliness,
                strength,
            },
        });
    };

    const chooseIdle = (next: string) => {
        setIdleProfile(next);
        writeStringSetting(APP_SETTING_KEYS.magicIdleProfile, next);
        publish();
    };

    const chooseSpeaking = (next: string) => {
        setSpeakingProfile(next);
        writeStringSetting(APP_SETTING_KEYS.magicSpeakingProfile, next);
        publish();
    };

    const toggleFollow = () => {
        const next = !followSpeech;
        setFollowSpeech(next);
        writeBooleanSetting(APP_SETTING_KEYS.magicFollowSpeech, next);
        publish();
    };

    const changeLiveliness = (next: number) => {
        setLiveliness(next);
        writeNumberSetting(APP_SETTING_KEYS.magicLiveliness, next);
        publish();
    };

    const changeStrength = (next: number) => {
        setStrength(next);
        writeNumberSetting(APP_SETTING_KEYS.magicStrength, next);
        publish();
    };

    const profiles = [
        { value: "calm", label: t("settings.model.animation.profile_calm", { defaultValue: "Calm" }) },
        { value: "excited", label: t("settings.model.animation.profile_excited", { defaultValue: "Excited" }) },
    ];

    const magicOn = source === "magic";

    return (
        <div className="space-y-4 border-t border-[var(--color-border)] pt-5">
            <div className="flex items-baseline gap-2">
                <label className={labelClasses}>
                    {t("settings.model.animation.label", { defaultValue: "Animation" })}
                </label>
                <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                    MAGIC
                </span>
            </div>
            <p className="text-xs text-[var(--color-text-muted)] -mt-2">
                {t("settings.model.animation.desc", {
                    defaultValue:
                        "Where her body movement comes from. Model motion plays the motions shipped with the rig; MAGIC generates movement from a recorded reference.",
                })}
            </p>

            {/* Motion source */}
            <div className="grid grid-cols-2 gap-3">
                {([
                    { value: "model" as MotionSource, label: t("settings.model.animation.source_model", { defaultValue: "Model motion" }), desc: t("settings.model.animation.source_model_desc", { defaultValue: "The rig's own idle" }) },
                    { value: "magic" as MotionSource, label: t("settings.model.animation.source_magic", { defaultValue: "MAGIC" }), desc: t("settings.model.animation.source_magic_desc", { defaultValue: "Generated idle" }) },
                ]).map((option) => (
                    <button
                        key={option.value}
                        onClick={() => chooseSource(option.value)}
                        className={clsx(
                            "flex flex-col items-start gap-1 p-3 rounded-xl border text-left transition-colors",
                            source === option.value
                                ? "bg-[var(--color-accent-subtle)] border-[var(--color-accent)]/40 text-[var(--color-accent)]"
                                : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:border-[var(--color-text-muted)]",
                        )}
                        role="radio"
                        aria-checked={source === option.value}
                    >
                        <span className="text-sm font-heading font-semibold tracking-wider uppercase">
                            {option.label}
                        </span>
                        <span className="text-[10px] text-[var(--color-text-muted)]">{option.desc}</span>
                    </button>
                ))}
            </div>

            {/* Profiles — only meaningful for MAGIC */}
            <div className={clsx("space-y-3", !magicOn && "opacity-40 pointer-events-none")}>
                <div>
                    <label className={labelClasses}>
                        {t("settings.model.animation.idle_profile", { defaultValue: "Idle profile" })}
                    </label>
                    <p className="text-xs text-[var(--color-text-muted)] mt-0.5 mb-2">
                        {t("settings.model.animation.idle_profile_desc", {
                            defaultValue: "The reference MAGIC plays while she is not speaking.",
                        })}
                    </p>
                    <Select value={idleProfile} onChange={chooseIdle} options={profiles} />
                </div>

                <div>
                    <label className={labelClasses}>
                        {t("settings.model.animation.speaking_profile", { defaultValue: "Speaking profile" })}
                    </label>
                    <p className="text-xs text-[var(--color-text-muted)] mt-0.5 mb-2">
                        {t("settings.model.animation.speaking_profile_desc", {
                            defaultValue: "The reference it blends into while her voice is playing.",
                        })}
                    </p>
                    <Select value={speakingProfile} onChange={chooseSpeaking} options={profiles} />
                </div>

                <div className="flex items-center justify-between py-1">
                    <div>
                        <label className={labelClasses}>{t("settings.model.animation.follow_speech", { defaultValue: "Follow speech" })}</label>
                        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                            {t("settings.model.animation.follow_speech_desc", {
                                defaultValue: "Blend into the speaking profile while she talks, and back when she stops.",
                            })}
                        </p>
                    </div>
                    <button
                        onClick={toggleFollow}
                        className={clsx(
                            "relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ml-4",
                            followSpeech ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]",
                        )}
                        role="switch"
                        aria-checked={followSpeech}
                        aria-label={t("settings.model.animation.follow_speech", { defaultValue: "Follow speech" })}
                    >
                        <span
                            className={clsx(
                                "absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform",
                                followSpeech && "translate-x-5",
                            )}
                        />
                    </button>
                </div>

                <div>
                    <div className="flex items-center justify-between">
                        <label className={labelClasses}>
                            {t("settings.model.animation.liveliness", { defaultValue: "Liveliness" })}
                        </label>
                        <span className="text-xs text-[var(--color-text-muted)] tabular-nums">
                            {liveliness.toFixed(2)}
                        </span>
                    </div>
                    <p className="text-xs text-[var(--color-text-muted)] mt-0.5 mb-2">
                        {t("settings.model.animation.liveliness_desc", {
                            defaultValue:
                                "How much noise drives the generated movement. 0 is a still pose; above 1 gets twitchy.",
                        })}
                    </p>
                    <input
                        type="range"
                        min={0}
                        max={1.2}
                        step={0.05}
                        value={liveliness}
                        onChange={(event) => changeLiveliness(Number(event.target.value))}
                        className={clsx(
                            "w-full h-1.5 rounded-full appearance-none cursor-pointer",
                            "bg-[var(--color-border)]",
                            "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4",
                            "[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full",
                            "[&::-webkit-slider-thumb]:bg-[var(--color-accent)]",
                            "[&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:cursor-pointer",
                            "[&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4",
                            "[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0",
                            "[&::-moz-range-thumb]:bg-[var(--color-accent)]",
                        )}
                        aria-label={t("settings.model.animation.liveliness", { defaultValue: "Liveliness" })}
                    />
                </div>

                <div>
                    <div className="flex items-center justify-between">
                        <label className={labelClasses}>
                            {t("settings.model.animation.strength", { defaultValue: "Motion strength" })}
                        </label>
                        <span className="text-xs text-[var(--color-text-muted)] tabular-nums">
                            {strength.toFixed(2)}
                        </span>
                    </div>
                    <p className="text-xs text-[var(--color-text-muted)] mt-0.5 mb-2">
                        {t("settings.model.animation.strength_desc", {
                            defaultValue:
                                "Scales how far she moves, without changing how lively it looks. Turn this down if a reference is too big for the rig.",
                        })}
                    </p>
                    <input
                        type="range"
                        min={0.2}
                        max={1.5}
                        step={0.05}
                        value={strength}
                        onChange={(event) => changeStrength(Number(event.target.value))}
                        className={clsx(
                            "w-full h-1.5 rounded-full appearance-none cursor-pointer",
                            "bg-[var(--color-border)]",
                            "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4",
                            "[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full",
                            "[&::-webkit-slider-thumb]:bg-[var(--color-accent)]",
                            "[&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:cursor-pointer",
                            "[&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4",
                            "[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0",
                            "[&::-moz-range-thumb]:bg-[var(--color-accent)]",
                        )}
                        aria-label={t("settings.model.animation.strength", { defaultValue: "Motion strength" })}
                    />
                </div>
            </div>
        </div>
    );
}

// Local alias so the toggle label matches the app's label styling without shadowing the import.

export default MagicAnimationCard;
