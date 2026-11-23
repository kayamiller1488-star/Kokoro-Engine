import { Live2DModel } from "pixi-live2d-display/cubism4";
import type { Live2dCueBinding } from "@/lib/kokoro-bridge";
import { LipSyncProcessor } from "./LipSyncProcessor";
import { audioPlayer } from "../../core/services";
import type { AudioAnalysis } from "../../lib/audio-player";
import { getLive2dModelProfile, type Live2dModelProfile } from "../../lib/kokoro-bridge";

export type AnimationState = "Idle" | "Speaking" | "Interactive";
export type CueName = string;

/** Channels a motion MOD may drive, each normalised to -1..1 (see Live2DController.POSE_PARAMS).
 *  These mirror the fourteen values a generative motion model produces; the mouth is deliberately
 *  absent because lip sync owns ParamMouthOpenY. */
export type PoseChannel =
    | "headX"
    | "headY"
    | "headZ"
    | "bodyX"
    | "bodyY"
    | "bodyZ"
    | "eyeX"
    | "eyeY"
    | "eyeSquint"
    | "mouthForm"
    | "breath";

export type IdleBehavior =
    | { type: "look_around"; params: { direction: number; duration_ms: number } }
    | { type: "stretch"; params: Record<string, never> }
    | { type: "hum"; params: { melody_seed: number } }
    | { type: "sigh"; params: Record<string, never> }
    | { type: "fidget"; params: Record<string, never> };

export interface Live2DControllerConfig {
    autoIdle: boolean;
    idleMotionGroup: string;
}

const MOTION_PRIORITY = {
    IDLE: 1,
    NORMAL: 2,
    FORCE: 3,
} as const;

type ExpressionDefinition = {
    Name?: string;
    name?: string;
    File?: string;
    file?: string;
};

export class Live2DController {
    /** How long an emotional expression stays before it is released back to neutral, unless the cue says otherwise. */
    private static readonly DEFAULT_EXPRESSION_HOLD_MS = 3000;
    private model: Live2DModel | null = null;
    private lipSync: LipSyncProcessor;
    private currentCue: CueName | null = null;
    private currentState: AnimationState = "Idle";
    private modelPath: string | null = null;
    private modelProfile: Live2dModelProfile | null = null;
    private expressionHoldTimer: number | null = null;
    private expressionDriver: {
        expression: unknown;
        frame: number;
        params: { id: string; base: number }[];
    } | null = null;
    private profileRequestId = 0;

    public onModelLoaded?: (model: Live2DModel) => void;
    public onCueChange?: (cue: CueName | null) => void;

    private amplitudeHandler: (data: AudioAnalysis) => void;

    constructor() {
        this.lipSync = new LipSyncProcessor();
        this.amplitudeHandler = (data) => {
            this.lipSync.updateAudio(data.amplitude, data.lowFreqEnergy, data.highFreqEnergy);
            if (data.amplitude > 0.1 && this.currentState !== "Speaking") {
                this.startSpeaking();
            } else if (data.amplitude <= 0.01 && this.currentState === "Speaking") {
                this.stopSpeaking();
            }
        };
        audioPlayer.addAmplitudeListener(this.amplitudeHandler);
    }

    public setModel(model: Live2DModel) {
        this.model = model;
        this.onModelLoaded?.(model);
        this.patchCubism5MotionQueues();
        console.log("[Live2DController] Available expressions:", this.getAvailableExpressions());
        console.log("[Live2DController] Available motion groups:", this.getAvailableMotionGroups());
        this.exposeForDebug();
        this.playIdleMotion();
    }

    /**
     * Adapter for Cubism 4 vs 5. `pixi-live2d-display@0.4` drives motions and expressions through
     * `queueManager.updateParam(model)`, an API the Cubism 4 SDK has and the 5.x SDK renamed to
     * `doUpdateMotion(model, userTimeSeconds)`. The app ships Core/Framework 5.1, so that call throws on every
     * frame inside the render loop and is swallowed — expressions load (weight 1, correct parameters) and never
     * touch a parameter, and no motion group ever plays. Bridging the name restores both, for every model.
     */
    private patchCubism5MotionQueues() {
        try {
            const motionManager = (this.model as unknown as {
                internalModel?: { motionManager?: Record<string, unknown> };
            })?.internalModel?.motionManager;
            if (!motionManager) return;

            const candidates: unknown[] = [
                motionManager.queueManager,
                (motionManager.expressionManager as { queueManager?: unknown } | undefined)?.queueManager,
            ];

            for (const candidate of candidates) {
                const queue = candidate as
                    | { updateParam?: (model: unknown) => unknown; doUpdateMotion?: (model: unknown, t: number) => unknown }
                    | undefined;
                if (!queue || typeof queue.updateParam === "function") continue;
                if (typeof queue.doUpdateMotion !== "function") continue;
                queue.updateParam = function (this: { doUpdateMotion?: (m: unknown, t: number) => unknown }, m: unknown) {
                    return this.doUpdateMotion?.(m, performance.now() / 1000);
                };
            }
        } catch (error) {
            console.warn("[Live2DController] Failed to patch motion queues for Cubism 5:", error);
        }
    }

    public async loadProfileForModel(modelPath: string | null) {
        this.modelPath = modelPath;
        const requestId = ++this.profileRequestId;

        if (!modelPath) {
            this.modelProfile = null;
            return;
        }

        try {
            const profile = await getLive2dModelProfile(modelPath);
            if (requestId !== this.profileRequestId) return;
            this.modelProfile = profile;
        } catch (error) {
            if (requestId !== this.profileRequestId) return;
            this.modelProfile = null;
            console.warn(`[Live2DController] Failed to load model profile for '${modelPath}':`, error);
        }
    }

    public setProfile(profile: Live2dModelProfile | null) {
        this.modelProfile = profile;
        this.modelPath = profile?.model_path ?? this.modelPath;
    }

    public getModelProfile(): Live2dModelProfile | null {
        return this.modelProfile;
    }

    // Debug hook, off by default: `localStorage.__l2dDebug = "1"` exposes the controller and the pixi model
    // so the expression path can be inspected from the devtools console. Nothing is exposed without the flag.
    private exposeForDebug() {
        try {
            if (typeof window === "undefined") return;
            if (window.localStorage?.getItem("__l2dDebug") !== "1") return;
            const w = window as unknown as { __l2dCtrl?: unknown; __live2dModel?: unknown };
            w.__l2dCtrl = this;
            w.__live2dModel = this.model;
        } catch {
            /* debug hook only — never break rendering for it */
        }
    }

    public getModel(): Live2DModel | null {
        return this.model;
    }

    public getLipSync(): LipSyncProcessor {
        return this.lipSync;
    }

    public getCurrentCue(): CueName | null {
        return this.currentCue;
    }

    public getAvailableExpressions(): string[] {
        if (this.modelProfile) {
            return this.modelProfile.available_expressions;
        }

        const definitions = this.getExpressionDefinitions();
        return definitions
            .map((definition) => definition.Name ?? definition.name)
            .filter((name): name is string => Boolean(name && name.trim()))
            .map((name) => name.trim());
    }

    public getAvailableMotionGroups(): string[] {
        return Object.keys(this.getAvailableMotionGroupCounts());
    }

    public getAvailableMotionGroupCounts(): Record<string, number> {
        if (this.modelProfile) {
            return this.modelProfile.available_motion_groups;
        }

        const groups: Record<string, number> = {};
        if (!this.model) return groups;

        try {
            const defs = this.model.internalModel?.motionManager?.definitions;
            if (defs) {
                for (const [group, motions] of Object.entries(defs)) {
                    groups[group] = Array.isArray(motions) ? motions.length : 0;
                }
            }
        } catch (error) {
            console.warn("[Live2DController] Failed to read motion groups:", error);
        }

        return groups;
    }

    public async playExpressionByName(name: string) {
        if (!this.model) return false;

        const trimmed = name.trim();
        const definitions = this.getExpressionDefinitions();
        const expressionIndex = definitions.findIndex((definition) => {
            const candidates = [
                definition.Name,
                definition.name,
                definition.File,
                definition.file,
            ]
                .filter((value): value is string => Boolean(value && value.trim()))
                .flatMap((value) => {
                    const normalized = value.trim();
                    const baseName = normalized.split("/").pop() ?? normalized;
                    return [
                        normalized,
                        baseName,
                        baseName.replace(/\.json$/i, ""),
                    ];
                });

            return candidates.includes(trimmed);
        });

        try {
            if (expressionIndex >= 0) {
                const driver = await this.startExpressionDriver(expressionIndex);
                if (driver) return true;
            }

            return await this.model.expression(trimmed);
        } catch (error) {
            console.warn(`[Live2DController] Failed to play expression '${trimmed}':`, error);
            return false;
        }
    }

    /**
     * Drives an expression ourselves because `pixi-live2d-display@0.4` cannot start motions on the Cubism 5
     * queue (see patchCubism5MotionQueues). The expression object and its parameters come from the rig's own
     * `.exp3.json`, so this applies the model's data — not invented values — and honours its fade times.
     */
    private async startExpressionDriver(index: number): Promise<boolean> {
        const manager = (this.model as unknown as {
            internalModel?: { coreModel?: unknown; motionManager?: { expressionManager?: Record<string, unknown> } };
        })?.internalModel?.motionManager?.expressionManager;
        const coreModel = (this.model as unknown as { internalModel?: { coreModel?: unknown } })?.internalModel
            ?.coreModel;
        if (!manager || !coreModel) return false;

        const loadExpression = manager.loadExpression as ((i: number) => Promise<unknown>) | undefined;
        let expression = (manager.expressions as unknown[] | undefined)?.[index];
        if (!expression && typeof loadExpression === "function") {
            expression = await loadExpression.call(manager, index);
        }
        if (!expression) return false;

        this.stopExpressionDriver();
        try {
            (manager.queueManager as { stopAllMotions?: () => void } | undefined)?.stopAllMotions?.();
        } catch {
            /* pixi's queue is unusable on Cubism 5 anyway */
        }

        const entry = {
            _started: false,
            _finished: false,
            _startTime: 0,
            _fadeInStart: 0,
            _endTime: -1,
            isAvailable: () => true,
            isFinished(this: { _finished: boolean }) {
                return this._finished;
            },
            isStarted(this: { _started: boolean }) {
                return this._started;
            },
            setIsStarted(this: { _started: boolean }, value: boolean) {
                this._started = value;
            },
            getStartTime(this: { _startTime: number }) {
                return this._startTime;
            },
            setStartTime(this: { _startTime: number }, value: number) {
                this._startTime = value;
            },
            getFadeInStartTime(this: { _fadeInStart: number }) {
                return this._fadeInStart;
            },
            setFadeInStartTime(this: { _fadeInStart: number }, value: number) {
                this._fadeInStart = value;
            },
            getEndTime(this: { _endTime: number }) {
                return this._endTime;
            },
            setEndTime(this: { _endTime: number }, value: number) {
                this._endTime = value;
            },
            setState() {
                /* state weight is only used for bookkeeping inside pixi */
            },
            setIsFinished(this: { _finished: boolean }, value: boolean) {
                this._finished = value;
            },
        };

        const update = (expression as { updateParameters?: (m: unknown, e: unknown, t: number) => void })
            .updateParameters;
        if (typeof update !== "function") return false;

        // The framework resets parameters from their saved values before applying motions/expressions each frame.
        // We are driving outside that loop, so capture the rest pose once and restore it before every tick —
        // otherwise an "Add" expression accumulates until it clamps at the parameter's limit.
        const core = coreModel as {
            getParameterValueById?: (id: string) => number;
            setParameterValueById?: (id: string, value: number) => void;
        };
        const parameterIds = ((expression as { _parameters?: { parameterId?: unknown }[] })._parameters ?? [])
            .map((p) => (typeof p.parameterId === "string" ? p.parameterId : undefined))
            .filter((id): id is string => Boolean(id));
        const params = parameterIds.map((id) => ({
            id,
            base: typeof core.getParameterValueById === "function" ? core.getParameterValueById(id) : 0,
        }));

        const tick = () => {
            const driver = this.expressionDriver;
            if (!driver || driver.expression !== expression) return;
            try {
                for (const param of driver.params) {
                    core.setParameterValueById?.(param.id, param.base);
                }
                update.call(expression, coreModel, entry, performance.now() / 1000);
            } catch (error) {
                console.warn("[Live2DController] Expression tick failed, stopping driver:", error);
                this.stopExpressionDriver();
                return;
            }
            driver.frame = requestAnimationFrame(tick);
        };

        this.expressionDriver = { expression, frame: requestAnimationFrame(tick), params };
        return true;
    }

    private stopExpressionDriver() {
        if (!this.expressionDriver) return;
        cancelAnimationFrame(this.expressionDriver.frame);
        const core = (this.model as unknown as { internalModel?: { coreModel?: unknown } })?.internalModel
            ?.coreModel as { setParameterValueById?: (id: string, value: number) => void } | undefined;
        for (const param of this.expressionDriver.params) {
            core?.setParameterValueById?.(param.id, param.base);
        }
        this.expressionDriver = null;
    }

    // -----------------------------------------------------------------------------------------
    // External pose driver (MAGIC motion MOD)
    //
    // A MOD pushes normalised poses over the `live2d-pose` event (one frame, roughly 30 per
    // second). Nothing in the app generates these frames: with no MOD attached this stays
    // dormant and the model behaves exactly as it did before. Poses are mapped onto the rig's
    // own parameters here, because the MOD has no access to the model.
    //
    // The pose is re-applied every render frame while it is fresh, which is deliberate: Cubism's
    // physics sways ParamAngle* on its own each frame, so a write that happens once loses the race.
    // Frames arrive at 30 Hz but the page here renders at ~140, and holding each pose across five
    // frames then jumping reads as stutter (measured: ParamAngleX changed on 18 of 89 render frames).
    // So the pose is *interpolated* between arrivals: the newest frame is a target, the previous is
    // the origin, and each render frame samples that span by elapsed time.
    // When the MOD stops (or the window is hidden and the event stream stalls) the captured rest
    // values are restored, so the model does not freeze in whatever pose it was left in.
    // -----------------------------------------------------------------------------------------

    private poseDriver: {
        frame: number;
        target: Partial<Record<PoseChannel, number>>;
        position: Partial<Record<PoseChannel, number>>;
        velocity: Partial<Record<PoseChannel, number>>;
        lastStepAt: number;
        receivedAt: number;
        base: Map<string, number>;
    } | null = null;

    private static readonly POSE_STALE_MS = 400;

    /**
     * Spring that carries each channel toward the newest pose frame.
     *
     * This is AIRI's `motion-control-spring` with the dynamics their MAGIC path uses
     * (`defaultLive2DMotionControlDynamics = { follow: 1, inertia: 0.6 }`):
     *
     *   stiffness = 30 + follow·190   = 220
     *   mass      = 0.75 + inertia·2.25 = 2.1
     *   ζ (damping ratio) = 1 − inertia·0.75 = 0.55   (underdamped: a slight overshoot)
     *
     * Linear interpolation between 30 Hz frames keeps position continuous but makes velocity jump
     * at every frame boundary, which reads as a mechanical tick; a spring keeps both continuous and
     * is what gives their motion its overshoot-and-settle bounce. Their loop clamps each step to
     * 1/120 s, so a slow frame is subdivided rather than integrated in one go.
     */
    private static readonly POSE_SPRING_STIFFNESS = 30 + 1 * 190;
    private static readonly POSE_SPRING_MASS = 0.75 + 0.6 * 2.25;
    private static readonly POSE_SPRING_DAMPING = 2
        * Math.sqrt(220 * 2.1)
        * (1 - 0.6 * 0.75);
    private static readonly POSE_SPRING_MAX_STEP_S = 1 / 120;


    /** Channel -> rig parameter, with the range the channel's -1..1 maps onto. `bipolar: false`
     * means the channel is unipolar in Cubism (0..1), so -1..1 is shifted rather than scaled.
     * `eyeSquint` is absent on purpose: it is a *closing* amount that multiplies both eyes, so it
     * is applied separately below rather than written straight into one parameter. */
    private static readonly POSE_PARAMS: Partial<
        Record<PoseChannel, { id: string; range: number; bipolar: boolean }>
    > = {
        headX: { id: "ParamAngleX", range: 30, bipolar: true },
        headY: { id: "ParamAngleY", range: 30, bipolar: true },
        headZ: { id: "ParamAngleZ", range: 30, bipolar: true },
        bodyX: { id: "ParamBodyAngleX", range: 10, bipolar: true },
        bodyY: { id: "ParamBodyAngleY", range: 10, bipolar: true },
        bodyZ: { id: "ParamBodyAngleZ", range: 10, bipolar: true },
        eyeX: { id: "ParamEyeBallX", range: 1, bipolar: true },
        eyeY: { id: "ParamEyeBallY", range: 1, bipolar: true },
        mouthForm: { id: "ParamMouthForm", range: 1, bipolar: true },
        breath: { id: "ParamBreath", range: 1, bipolar: false },
    };

    private poseCore(): {
        setParameterValueById?: (id: string, value: number) => void;
        getParameterValueById?: (id: string) => number;
        getParameterIndex?: (id: string) => number;
    } | null {
        const core = (this.model as unknown as { internalModel?: { coreModel?: unknown } })?.internalModel
            ?.coreModel;
        return (core as ReturnType<Live2DController["poseCore"]>) ?? null;
    }

    /** Called with one pose frame, or null to hand the model back immediately. */
    public applyPose(pose: Partial<Record<PoseChannel, number>> | null): void {
        if (!this.model) return;
        if (pose === null) {
            this.releasePose();
            return;
        }
        const now = performance.now();
        if (!this.poseDriver) {
            this.poseDriver = {
                frame: 0,
                target: {},
                position: {},
                velocity: {},
                lastStepAt: now,
                receivedAt: now,
                base: new Map(),
            };
            // Begin at the incoming pose: a spring started from rest would visibly drag the head
            // up from neutral every time the driver attaches.
            for (const key of Object.keys(pose) as PoseChannel[]) {
                const value = pose[key];
                if (typeof value !== "number" || !Number.isFinite(value)) continue;
                this.poseDriver.position[key] = value;
                this.poseDriver.velocity[key] = 0;
            }
        }
        const driver = this.poseDriver;

        // The newest frame is the spring's target. A channel the frame omits keeps its previous
        // target rather than snapping to neutral.
        for (const key of Object.keys(pose) as PoseChannel[]) {
            const value = pose[key];
            if (typeof value !== "number" || !Number.isFinite(value)) continue;
            driver.target[key] = value;
            if (typeof driver.position[key] !== "number") driver.position[key] = value;
            if (typeof driver.velocity[key] !== "number") driver.velocity[key] = 0;
        }
        driver.receivedAt = now;

        if (!driver.frame) {
            driver.frame = requestAnimationFrame(() => this.tickPose());
        }
    }

    /**
     * Advance the spring one rendered frame and return the pose to write this frame.
     *
     * Semi-implicit Euler, subdivided into steps no longer than 1/120 s, exactly as AIRI's
     * `stepAxis` does - a 140 fps frame is a single 7 ms step, a stalled 60 ms frame becomes eight,
     * so a hitch cannot fling the head across the rig.
     */
    private stepPoseSpring(now: number): Partial<Record<PoseChannel, number>> {
        const driver = this.poseDriver;
        if (!driver) return {};
        const elapsedSeconds = Math.min(0.25, Math.max(0, (now - driver.lastStepAt) / 1000));
        driver.lastStepAt = now;

        const stiffness = Live2DController.POSE_SPRING_STIFFNESS;
        const mass = Live2DController.POSE_SPRING_MASS;
        const damping = Live2DController.POSE_SPRING_DAMPING;
        const maxStep = Live2DController.POSE_SPRING_MAX_STEP_S;

        let remaining = elapsedSeconds;
        while (remaining > 1e-6) {
            const dt = Math.min(maxStep, remaining);
            remaining -= dt;
            for (const key of Object.keys(driver.target) as PoseChannel[]) {
                const target = driver.target[key];
                if (typeof target !== "number") continue;
                const position = driver.position[key] ?? target;
                const velocity = driver.velocity[key] ?? 0;
                const acceleration = (stiffness * (target - position) - damping * velocity) / mass;
                const nextVelocity = velocity + acceleration * dt;
                driver.velocity[key] = nextVelocity;
                driver.position[key] = position + nextVelocity * dt;
            }
        }
        return driver.position;
    }

    private tickPose(): void {
        const driver = this.poseDriver;
        if (!driver) return;
        driver.frame = 0;

        const core = this.poseCore();
        if (!core?.setParameterValueById) {
            this.releasePose();
            return;
        }
        const now = performance.now();
        if (now - driver.receivedAt > Live2DController.POSE_STALE_MS) {
            // The MOD stopped pushing (closed, reloaded, or its window was hidden).
            this.releasePose();
            return;
        }

        const pose = this.stepPoseSpring(now);

        try {
            // Eye closing is multiplicative in Cubism (and AIRI maps it the same way): the channel
            // is "how closed", so the parameter that survives is 1 - squint, on both eyes.
            const squint = pose.eyeSquint;
            if (typeof squint === "number" && Number.isFinite(squint)) {
                const open = Math.max(0, Math.min(1, 1 - Math.max(-1, Math.min(1, squint))));
                for (const id of ["ParamEyeLOpen", "ParamEyeROpen"]) {
                    if (typeof core.getParameterIndex === "function" && core.getParameterIndex(id) < 0) continue;
                    if (!driver.base.has(id)) {
                        driver.base.set(id, core.getParameterValueById?.(id) ?? 1);
                    }
                    core.setParameterValueById(id, open);
                }
            }

            for (const [channel, spec] of Object.entries(Live2DController.POSE_PARAMS) as [
                PoseChannel,
                { id: string; range: number; bipolar: boolean },
            ][]) {
                const raw = pose[channel];
                if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
                // A rig that lacks the parameter (our models have no torso) is skipped rather than written blind.
                if (typeof core.getParameterIndex === "function" && core.getParameterIndex(spec.id) < 0) continue;
                if (!driver.base.has(spec.id)) {
                    driver.base.set(spec.id, core.getParameterValueById?.(spec.id) ?? 0);
                }
                const clamped = Math.max(-1, Math.min(1, raw));
                core.setParameterValueById(spec.id, spec.bipolar ? clamped * spec.range : (clamped + 1) / 2);
            }
        } catch (error) {
            console.warn("[Live2DController] Pose frame failed, releasing the model:", error);
            this.releasePose();
            return;
        }

        driver.frame = requestAnimationFrame(() => this.tickPose());
    }

    /** Restore every parameter the pose driver touched and stop writing. Safe to call twice. */
    public releasePose(): void {
        const driver = this.poseDriver;
        if (!driver) return;
        this.poseDriver = null;
        if (driver.frame) cancelAnimationFrame(driver.frame);
        const core = this.poseCore();
        if (!core?.setParameterValueById) return;
        for (const [id, value] of driver.base) {
            try {
                core.setParameterValueById(id, value);
            } catch {
                /* the core is gone (model switched) - nothing left to restore */
            }
        }
    }

    /**
     * Release an expression after a bounded hold.
     *
     * Cubism keeps an expression applied until something stops it, and the driver above simply ran until the next
     * cue replaced it. One `silly` cue therefore left Kana's face in 呆猫 for the rest of the session - measured by
     * the owner as "her face is always on silly mode". Emotions get a short hold; a cue can opt out with
     * `hold_seconds: 0` in the profile's cue_map, which is what wardrobe props need (glasses, apron, cat filter are
     * meant to stay on until they are taken off).
     */
    private scheduleExpressionRelease(binding?: Live2dCueBinding) {
        if (this.expressionHoldTimer !== null) {
            window.clearTimeout(this.expressionHoldTimer);
            this.expressionHoldTimer = null;
        }
        const configured = binding?.hold_seconds;
        const holdMs = typeof configured === "number"
            ? configured * 1000
            : Live2DController.DEFAULT_EXPRESSION_HOLD_MS;
        if (holdMs <= 0) return;                 // 0 = keep it on until another cue replaces it
        this.expressionHoldTimer = window.setTimeout(() => {
            this.expressionHoldTimer = null;
            this.stopExpressionDriver();
            this.currentCue = "";
        }, holdMs);
    }

    public async playMotionGroupByName(group: string, index?: number, priority: number = MOTION_PRIORITY.NORMAL) {
        if (!this.model) return false;

        const count = this.getMotionCount(group);
        if (count <= 0) return false;

        const motionIndex = typeof index === "number"
            ? Math.max(0, Math.min(index, count - 1))
            : Math.floor(Math.random() * count);

        try {
            return await this.model.motion(group, motionIndex, priority);
        } catch (error) {
            console.warn(`[Live2DController] Failed to play motion group '${group}':`, error);
            return false;
        }
    }

    public async playCue(cue: string) {
        const trimmed = cue.trim();
        if (!trimmed) return false;

        this.currentCue = trimmed;
        this.onCueChange?.(trimmed);

        const binding = this.modelProfile?.cue_map?.[trimmed];
        const hasKnownBinding = Boolean(
            binding && (
                (binding.expression && this.getAvailableExpressions().includes(binding.expression)) ||
                (binding.motion_group && this.getAvailableMotionGroups().includes(binding.motion_group))
            )
        );
        let played = false;

        if (binding?.expression) {
            played = (await this.playExpressionByName(binding.expression)) || played;
        }

        if (binding?.motion_group) {
            played = (await this.playMotionGroupByName(binding.motion_group)) || played;
        }

        if (played) {
            this.scheduleExpressionRelease(binding);
            return true;
        }

        if (hasKnownBinding) {
            return true;
        }

        const expressionPlayed = this.getAvailableExpressions().includes(trimmed)
            ? await this.playExpressionByName(trimmed)
            : false;
        const motionPlayed = this.getAvailableMotionGroups().includes(trimmed)
            ? await this.playMotionGroupByName(trimmed)
            : false;

        if (expressionPlayed || motionPlayed) {
            return true;
        }

        if (import.meta.env.DEV) {
            console.warn(`[Live2DController] Unmapped cue '${trimmed}'`, {
                modelPath: this.modelPath,
                configuredCues: Object.keys(this.modelProfile?.cue_map ?? {}),
                binding,
                availableExpressions: this.getAvailableExpressions(),
                availableMotionGroups: this.getAvailableMotionGroups(),
            });
        }

        return false;
    }

    public resolveSemanticCue(semanticKey: string): CueName | null {
        const normalizedKey = semanticKey.trim().toLowerCase();
        if (!normalizedKey) return null;

        const cue = this.modelProfile?.semantic_cue_map?.[normalizedKey];
        if (cue?.trim()) {
            return cue.trim();
        }
        return null;
    }

    public resolveInteractionSemanticCue(gesture: string, hitArea: string): CueName | null {
        const normalizedGesture = gesture.trim().toLowerCase();
        const normalizedArea = hitArea.trim().toLowerCase();
        const candidates = [
            `interaction:${normalizedGesture}_${normalizedArea}`,
            `interaction:${normalizedGesture}_*`,
            `interaction:*_${normalizedArea}`,
            "interaction:*_*",
        ];

        for (const semanticKey of candidates) {
            const cue = this.resolveSemanticCue(semanticKey);
            if (cue) {
                return cue;
            }
        }

        return null;
    }

    public startSpeaking() {
        this.currentState = "Speaking";
    }

    public stopSpeaking() {
        this.currentState = "Idle";
        this.playIdleMotion();
    }

    /**
     * External lip-sync input. The MOD speaks (the app's own TTS playback is disabled), so the
     * amplitude that used to arrive from audio-player.addAmplitudeListener has to be supplied here
     * instead. Same contract as the internal handler: drive the mouth, and start/stop the speaking
     * state so idle motions and expressions still react.
     */
    public setMouthLevel(level: number) {
        const clamped = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
        this.lipSync.updateAudio(clamped);
        if (clamped > 0.1 && this.currentState !== "Speaking") {
            this.startSpeaking();
        } else if (clamped <= 0.01 && this.currentState === "Speaking") {
            this.stopSpeaking();
        }
    }

    public update(dt: number) {
        if (!this.model) return;

        const dtSecs = dt / 60;
        const mouth = this.lipSync.getValues(dtSecs);
        const internalModel = this.model.internalModel as unknown as {
            coreModel?: {
                setParameterValueById: (id: string, val: number) => void;
            };
        };

        const coreModel = internalModel.coreModel;
        if (coreModel) {
            // Model-declared hidden parts (a `Groups` entry named "Hidden"). VTube Studio models use
            // this for censor/prop layers - DeepSeek-chan ships a "face black" part that otherwise
            // draws a black box over her mouth. Re-applied every frame because part opacity is part
            // of the model state the runtime rewrites.
            const hidden = this.modelProfile?.hidden_parts;
            if (hidden && hidden.length) {
                const setPart = (coreModel as unknown as { setPartOpacityById?: (id: string, v: number) => void }).setPartOpacityById;
                if (setPart) {
                    for (const partId of hidden) {
                        try { setPart.call(coreModel, partId, 0); } catch { /* part not in this model */ }
                    }
                }
            }
            coreModel.setParameterValueById("ParamMouthOpenY", mouth.mouthOpenY);
            coreModel.setParameterValueById("ParamMouthForm", mouth.mouthForm);
            // Debug hook: the value actually pushed to the rig this frame. Makes lip sync measurable
            // from the outside (window.__live2dMouth) instead of guessed at from screenshots.
            (window as unknown as { __live2dMouth?: number; __live2dMouthForm?: number; __live2dCore?: unknown }).__live2dMouth = mouth.mouthOpenY;
            (window as unknown as { __live2dCore?: unknown }).__live2dCore = coreModel;
            (window as unknown as { __live2dMouth?: number; __live2dMouthForm?: number }).__live2dMouthForm = mouth.mouthForm;
        }
    }

    private playIdleMotion() {
        const availableGroups = this.getAvailableMotionGroups();
        if (availableGroups.includes("Idle")) {
            void this.playMotionGroupByName("Idle", undefined, MOTION_PRIORITY.IDLE);
        }
    }

    public playMotion(group: string, index?: number, priority?: number) {
        void this.playMotionGroupByName(group, index, priority);
    }

    public playIdleBehavior(behavior: IdleBehavior) {
        if (!this.model) return;

        switch (behavior.type) {
            case "look_around":
                this.playIdleMotion();
                break;
            case "stretch":
                this.tryPlayMotionGroup(["Stretch", "Idle"]);
                break;
            case "hum":
                this.tryPlayMotionGroup(["Hum", "Sing", "Idle"]);
                break;
            case "sigh":
                this.tryPlayMotionGroup(["Sigh", "Sad", "Idle"]);
                break;
            case "fidget":
                this.tryPlayMotionGroup(["Fidget", "TapBody", "Idle"]);
                break;
        }
    }

    private tryPlayMotionGroup(groups: string[]) {
        const available = this.getAvailableMotionGroups();
        for (const group of groups) {
            if (available.includes(group)) {
                void this.playMotionGroupByName(group);
                return;
            }
        }
    }

    private getMotionCount(group: string): number {
        return this.getAvailableMotionGroupCounts()[group] ?? 0;
    }

    private getExpressionDefinitions(): ExpressionDefinition[] {
        if (!this.model) return [];

        try {
            const expressionManager = this.model.internalModel?.motionManager?.expressionManager;
            if (Array.isArray(expressionManager?.definitions)) {
                return expressionManager.definitions as ExpressionDefinition[];
            }
        } catch (error) {
            console.warn("[Live2DController] Failed to read expression definitions:", error);
        }

        return [];
    }
    public destroy() {
        audioPlayer.removeAmplitudeListener(this.amplitudeHandler);
    }
}
