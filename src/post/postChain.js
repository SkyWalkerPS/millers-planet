import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { getFragmentSource } from "../gpu/shaderRegistry.js";
import { createColourTarget } from "../gpu/targets.js";

const bloomLevelCount = 8;

function createWrapper(engine, name, uniforms, samplers) {
    return new EffectWrapper({
        engine,
        name,
        fragmentShader: getFragmentSource(name),
        uniforms,
        samplers,
        shaderLanguage: ShaderLanguage.WGSL,
    });
}

export const postTargetNamePrefixes = ["history", "bloomDown", "bloomUp", "shaftMask", "shaftMarch"];

export class PostChain {
    constructor({ engine, scene, beautyTargets, profiler }) {
        this.engine = engine;
        this.scene = scene;
        this.beautyTargets = beautyTargets;
        this.profiler = profiler;
        this.effectRenderer = new EffectRenderer(engine);
        this.settings = {
            temporalUpscaleEnabled: true,
            bloomEnabled: true,
            shaftsEnabled: true,
            compositeEnabled: true,
            feedback: 0.9,
            exposure: 1.0,
            bloomAmount: 0.06,
            shaftAmount: 0.35,
            shaftStrength: 1.0,
            vignetteAmount: 0.12,
            grainAmount: 0.012,
            sharpenAmount: 0.25,
            focusDistanceMetres: 3.2,
            maximumBlurRadiusPixels: 14,
            helmetRimAmount: 0,
            outputBlack: 0,
        };
        this.frame = {
            frameIndex: 0,
            jitterNdcX: 0,
            jitterNdcY: 0,
            lightUvX: 0.5,
            lightUvY: 0.5,
            lightOnScreen: 0,
            shaftColour: [1.0, 0.86, 0.66],
        };
        this.outputWidth = 0;
        this.outputHeight = 0;
        this.historyTargets = [null, null];
        this.historyWriteIndex = 0;
        this.historyValid = false;
        this.bloomDownTargets = [];
        this.bloomUpTargets = [];
        this.bloomLevelSizes = [];
        this.shaftMaskTarget = null;
        this.shaftMarchTarget = null;
        this.temporalUpscale = createWrapper(engine, "temporalUpscale", ["internalSize", "outputSize", "jitterNdc", "historyValid", "feedback", "enabled"], ["beautyColour", "beautyMotion", "historyColour"]);
        this.bloomDownsample = createWrapper(engine, "bloomDownsample", ["sourceTexelSize", "isFirstLevel"], ["sourceTexture"]);
        this.bloomUpsample = createWrapper(engine, "bloomUpsample", ["lowerLevelTexelSize", "radius"], ["lowerLevelTexture", "sameLevelTexture"]);
        this.shaftMask = createWrapper(engine, "shaftMask", ["subRectangleUvScale", "internalTexelSize", "brightnessCeiling"], ["beautyColour", "beautyMotion"]);
        this.shaftMarch = createWrapper(engine, "shaftMarch", ["lightUv", "lightOnScreen", "shaftColour", "strength", "aspect", "frameIndex"], ["shaftMaskTexture"]);
        this.composite = createWrapper(
            engine,
            "composite",
            ["outputTexelSize", "subRectangleUvScale", "exposure", "bloomAmount", "shaftAmount", "vignetteAmount", "grainAmount", "sharpenAmount", "focusDistanceMetres", "maximumBlurRadiusPixels", "helmetRimAmount", "frameIndex", "aspect", "outputBlack"],
            ["resolvedColour", "bloomTexture", "shaftTexture", "beautyMotion"],
        );
        this.bloomDownSourceTexture = null;
        this.bloomDownSourceTexelX = 0;
        this.bloomDownSourceTexelY = 0;
        this.bloomDownIsFirst = 0;
        this.bloomUpLowerTexture = null;
        this.bloomUpSameTexture = null;
        this.bloomUpLowerTexelX = 0;
        this.bloomUpLowerTexelY = 0;
        this.installUniformBinders();
    }

    get allWrappers() {
        return [this.temporalUpscale, this.bloomDownsample, this.bloomUpsample, this.shaftMask, this.shaftMarch, this.composite];
    }

    isReady() {
        return this.allWrappers.every((wrapper) => wrapper.effect && wrapper.effect.isReady());
    }

    installUniformBinders() {
        this.temporalUpscale.onApplyObservable.add(() => {
            const effect = this.temporalUpscale.effect;
            effect.setTexture("beautyColour", this.beautyTargets.colourTexture);
            effect.setTexture("beautyMotion", this.beautyTargets.motionTexture);
            effect.setTexture("historyColour", this.historyTargets[1 - this.historyWriteIndex]);
            effect.setFloat2("internalSize", this.beautyTargets.internalWidth, this.beautyTargets.internalHeight);
            effect.setFloat2("outputSize", this.outputWidth, this.outputHeight);
            effect.setFloat2("jitterNdc", this.frame.jitterNdcX, this.frame.jitterNdcY);
            effect.setFloat("historyValid", this.historyValid ? 1 : 0);
            effect.setFloat("feedback", this.settings.feedback);
            effect.setFloat("enabled", 1);
        });
        this.bloomDownsample.onApplyObservable.add(() => {
            const effect = this.bloomDownsample.effect;
            effect.setTexture("sourceTexture", this.bloomDownSourceTexture);
            effect.setFloat2("sourceTexelSize", this.bloomDownSourceTexelX, this.bloomDownSourceTexelY);
            effect.setFloat("isFirstLevel", this.bloomDownIsFirst);
        });
        this.bloomUpsample.onApplyObservable.add(() => {
            const effect = this.bloomUpsample.effect;
            effect.setTexture("lowerLevelTexture", this.bloomUpLowerTexture);
            effect.setTexture("sameLevelTexture", this.bloomUpSameTexture);
            effect.setFloat2("lowerLevelTexelSize", this.bloomUpLowerTexelX, this.bloomUpLowerTexelY);
            effect.setFloat("radius", 1.0);
        });
        this.shaftMask.onApplyObservable.add(() => {
            const effect = this.shaftMask.effect;
            effect.setTexture("beautyColour", this.beautyTargets.colourTexture);
            effect.setTexture("beautyMotion", this.beautyTargets.motionTexture);
            effect.setFloat2("subRectangleUvScale", this.beautyTargets.subRectangleUvScale[0], this.beautyTargets.subRectangleUvScale[1]);
            effect.setFloat2("internalTexelSize", 1 / this.beautyTargets.allocatedWidth, 1 / this.beautyTargets.allocatedHeight);
            effect.setFloat("brightnessCeiling", 12.0);
        });
        this.shaftMarch.onApplyObservable.add(() => {
            const effect = this.shaftMarch.effect;
            effect.setTexture("shaftMaskTexture", this.shaftMaskTarget);
            effect.setFloat2("lightUv", this.frame.lightUvX, this.frame.lightUvY);
            effect.setFloat("lightOnScreen", this.frame.lightOnScreen);
            effect.setFloat3("shaftColour", this.frame.shaftColour[0], this.frame.shaftColour[1], this.frame.shaftColour[2]);
            effect.setFloat("strength", this.settings.shaftStrength);
            effect.setFloat("aspect", this.outputWidth / this.outputHeight);
            effect.setFloat("frameIndex", this.frame.frameIndex % 64);
        });
        this.composite.onApplyObservable.add(() => {
            const effect = this.composite.effect;
            const settings = this.settings;
            effect.setTexture("resolvedColour", this.historyTargets[this.historyWriteIndex]);
            effect.setTexture("bloomTexture", this.bloomUpTargets[0]);
            effect.setTexture("shaftTexture", this.shaftMarchTarget);
            effect.setTexture("beautyMotion", this.beautyTargets.motionTexture);
            effect.setFloat2("outputTexelSize", 1 / this.outputWidth, 1 / this.outputHeight);
            effect.setFloat2("subRectangleUvScale", this.beautyTargets.subRectangleUvScale[0], this.beautyTargets.subRectangleUvScale[1]);
            effect.setFloat("exposure", settings.exposure);
            effect.setFloat("bloomAmount", settings.bloomEnabled ? settings.bloomAmount : 0);
            effect.setFloat("shaftAmount", settings.shaftsEnabled ? settings.shaftAmount : 0);
            effect.setFloat("vignetteAmount", settings.vignetteAmount);
            effect.setFloat("grainAmount", settings.grainAmount);
            effect.setFloat("sharpenAmount", settings.sharpenAmount);
            effect.setFloat("focusDistanceMetres", settings.focusDistanceMetres);
            effect.setFloat("maximumBlurRadiusPixels", settings.maximumBlurRadiusPixels);
            effect.setFloat("helmetRimAmount", settings.helmetRimAmount);
            effect.setFloat("frameIndex", this.frame.frameIndex % 1024);
            effect.setFloat("aspect", this.outputWidth / this.outputHeight);
            effect.setFloat("outputBlack", settings.outputBlack);
        });
    }

    resize(outputWidth, outputHeight) {
        if (outputWidth === this.outputWidth && outputHeight === this.outputHeight) {
            return false;
        }
        const allTargets = [...this.historyTargets, ...this.bloomDownTargets, ...this.bloomUpTargets, this.shaftMaskTarget, this.shaftMarchTarget];
        for (const target of allTargets) {
            if (target) {
                target.dispose();
            }
        }
        this.outputWidth = outputWidth;
        this.outputHeight = outputHeight;
        this.historyTargets = [createColourTarget(this.scene, "historyA", outputWidth, outputHeight), createColourTarget(this.scene, "historyB", outputWidth, outputHeight)];
        this.bloomLevelSizes = [];
        this.bloomDownTargets = [];
        this.bloomUpTargets = [];
        let levelWidth = outputWidth;
        let levelHeight = outputHeight;
        for (let level = 0; level < bloomLevelCount; level++) {
            levelWidth = Math.max(1, Math.ceil(levelWidth / 2));
            levelHeight = Math.max(1, Math.ceil(levelHeight / 2));
            this.bloomLevelSizes.push([levelWidth, levelHeight]);
            this.bloomDownTargets.push(createColourTarget(this.scene, `bloomDown${level}`, levelWidth, levelHeight));
            if (level < bloomLevelCount - 1) {
                this.bloomUpTargets.push(createColourTarget(this.scene, `bloomUp${level}`, levelWidth, levelHeight));
            }
        }
        const quarterWidth = Math.max(1, Math.ceil(outputWidth / 4));
        const quarterHeight = Math.max(1, Math.ceil(outputHeight / 4));
        this.shaftMaskTarget = createColourTarget(this.scene, "shaftMask", quarterWidth, quarterHeight);
        this.shaftMarchTarget = createColourTarget(this.scene, "shaftMarch", quarterWidth, quarterHeight);
        this.historyValid = false;
        return true;
    }

    clearTarget(target) {
        this.engine.bindFramebuffer(target.renderTarget);
        this.engine.clear(target.clearColor, true, false, false);
        this.engine.unBindFramebuffer(target.renderTarget);
    }

    draw(wrapper, target) {
        this.effectRenderer.render(wrapper, target);
    }

    render(frameIndex) {
        this.frame.frameIndex = frameIndex;
        const settings = this.settings;
        this.historyWriteIndex = 1 - this.historyWriteIndex;
        const resolvedTarget = this.historyTargets[this.historyWriteIndex];
        this.draw(this.temporalUpscale, resolvedTarget);
        this.historyValid = settings.temporalUpscaleEnabled;
        if (settings.bloomEnabled) {
            for (let level = 0; level < bloomLevelCount; level++) {
                const source = level === 0 ? resolvedTarget : this.bloomDownTargets[level - 1];
                const sourceWidth = level === 0 ? this.outputWidth : this.bloomLevelSizes[level - 1][0];
                const sourceHeight = level === 0 ? this.outputHeight : this.bloomLevelSizes[level - 1][1];
                this.bloomDownSourceTexture = source;
                this.bloomDownSourceTexelX = 1 / sourceWidth;
                this.bloomDownSourceTexelY = 1 / sourceHeight;
                this.bloomDownIsFirst = level === 0 ? 1 : 0;
                this.draw(this.bloomDownsample, this.bloomDownTargets[level]);
            }
            for (let level = bloomLevelCount - 2; level >= 0; level--) {
                const lowerTarget = level === bloomLevelCount - 2 ? this.bloomDownTargets[bloomLevelCount - 1] : this.bloomUpTargets[level + 1];
                const lowerSize = this.bloomLevelSizes[level + 1];
                this.bloomUpLowerTexture = lowerTarget;
                this.bloomUpSameTexture = this.bloomDownTargets[level];
                this.bloomUpLowerTexelX = 1 / lowerSize[0];
                this.bloomUpLowerTexelY = 1 / lowerSize[1];
                this.draw(this.bloomUpsample, this.bloomUpTargets[level]);
            }
        } else {
            for (const target of this.bloomDownTargets) {
                this.clearTarget(target);
            }
            for (const target of this.bloomUpTargets) {
                this.clearTarget(target);
            }
        }
        if (settings.shaftsEnabled) {
            this.draw(this.shaftMask, this.shaftMaskTarget);
            this.draw(this.shaftMarch, this.shaftMarchTarget);
        } else {
            this.clearTarget(this.shaftMaskTarget);
            this.clearTarget(this.shaftMarchTarget);
        }
        this.profiler.explicitLabel = "composite";
        this.engine.restoreDefaultFramebuffer();
        this.draw(this.composite, null);
        this.profiler.explicitLabel = null;
    }
}
