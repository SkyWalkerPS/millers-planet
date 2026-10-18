export function installPageApi() {
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    readyPromise.catch(() => {});
    let application = null;
    let bootError = null;

    function requireApplication() {
        if (!application) {
            throw new Error(bootError ? `Miller's Planet failed to start: ${bootError}` : "Miller's Planet is not ready yet");
        }
        return application;
    }

    const debug = {
        setOrbitCamera: (options = {}) => requireApplication().setOrbitCamera(options),
        pinRenderScale: (scaleOrNull) => {
            requireApplication().resolution.pin(scaleOrNull);
            return requireApplication().resolution.currentScale;
        },
        setAllocationPolicy: (policy) => requireApplication().beautyTargets.setAllocationPolicy(policy),
        requestPreemptiveCut: (fraction = 0.05, reason = "api") => requireApplication().resolution.requestPreemptiveCut(fraction, reason),
        setHeavyPatternIterations: (iterations) => {
            requireApplication().testScene.heavyPatternIterations = iterations;
        },
        clearGpuErrors: () => requireApplication().gpuErrors.clear(),
        setAstronautPosition: ({ x = 0, z = 0, yawDegrees = 0, cameraYawDegrees = yawDegrees } = {}) => {
            const app = requireApplication();
            app.placeAstronaut(x, z, (yawDegrees * Math.PI) / 180, (cameraYawDegrees * Math.PI) / 180);
            return app.stats().astronaut;
        },
        enterPlayerMode: () => requireApplication().enterPlayerMode(),
        relocateShipForWave: (waveIndex, impactX, impactZ) => requireApplication().relocateShipForWave(waveIndex, impactX, impactZ),
        placeOpeningShip: () => requireApplication().placeOpeningShip(),
        placeShip: ({ x = 0, z = 0, yawDegrees = 0, state = 0 } = {}) => {
            requireApplication().lander.place(x, z, (yawDegrees * Math.PI) / 180, state);
            return requireApplication().shipStats();
        },
        shiftWorldOrigin: (deltaX, deltaZ) => {
            const app = requireApplication();
            app.shiftWorldOrigin(deltaX, deltaZ);
            return app.stats().origin;
        },
        walkToShip: (options) => requireApplication().walkToShip(options),
        probeShipCollision: (options) => requireApplication().probeShipCollision(options),
        runFootDriftWalk: (options) => requireApplication().runFootDriftWalk(options),
        requestSkyUpdate: () => {
            requireApplication().gargantuaFirstFillPending = true;
        },
        traceTestRays: (specification) => requireApplication().traceGargantuaTestRays(specification),
        gargantuaDiagnostics: (options) => requireApplication().gargantuaDiagnostics(options),
        measureGargantuaPlacement: (options) => requireApplication().measureGargantuaPlacement(options),
        checkSkyViewIndependence: (options) => requireApplication().checkSkyViewIndependence(options),
        setGargantuaHeatMap: (enabled) => {
            requireApplication().gargantua.debugHeatMap = Boolean(enabled);
        },
        setLook: (look) => requireApplication().setLook(look),
        getLook: () => requireApplication().currentLook(),
        fftModeTest: (options) => requireApplication().measureSeaModeFrequency(options),
        calibrateSeaHeight: () => requireApplication().calibrateSeaHeight(),
        stampRipple: (stamp) => requireApplication().rippleField.queueStamp(stamp),
        measureRippleRingSpeed: (options) => requireApplication().measureRippleRingSpeed(options),
        seaProbe: async (points) => {
            const app = requireApplication();
            app.seaSimulation.requestProbe(points.map(([x, z]) => [x, z, 0]), true);
            await app.renderFramesNow(1);
            return app.seaSimulation.readProbeResults(points.length);
        },
        spike: {
            list: () => requireApplication().spike?.names ?? [],
            run: (name) => requireApplication().spike.run(name),
            runAll: () => requireApplication().spike.runAll(),
        },
        get application() {
            return application;
        },
    };

    const api = {
        ready: readyPromise,
        isReady: false,
        bootError: null,
        freezeTime(secondsOrNull) {
            requireApplication().clock.freeze(secondsOrNull);
            return requireApplication().clock.timeSeconds;
        },
        renderFrames(count = 1, options = {}) {
            return requireApplication().renderFramesNow(count, options);
        },
        setCameraShot(name) {
            return requireApplication().applyShot(name, true);
        },
        setViewPreset(presetIndex) {
            const app = requireApplication();
            app.cameraRig.setPreset(presetIndex);
            app.viewPreset = presetIndex;
            return presetIndex;
        },
        skipTo() {
            throw new Error("skipTo arrives with the wave in phase 7");
        },
        setShipState(state) {
            return requireApplication().setShipState(state);
        },
        injectInput(options = {}) {
            return requireApplication().injectInput(options);
        },
        benchmark(options = {}) {
            return requireApplication().benchmark(options);
        },
        frameLog(sinceFrameIndex = -1) {
            const app = requireApplication();
            return app.frameLog.exportSince(sinceFrameIndex, app.profiler.labelNames);
        },
        setSystemEnabled(name, enabled) {
            requireApplication().setSystemEnabled(name, enabled);
            return requireApplication().systemsEnabled[name];
        },
        get systems() {
            return application ? { ...application.systemsEnabled } : {};
        },
        stats() {
            return requireApplication().stats();
        },
        debug,
    };

    window.millersPlanet = api;

    return {
        attach(app) {
            application = app;
            api.isReady = true;
            resolveReady(api);
        },
        fail(error) {
            bootError = String(error?.message ?? error);
            api.bootError = bootError;
            rejectReady(error);
        },
    };
}
