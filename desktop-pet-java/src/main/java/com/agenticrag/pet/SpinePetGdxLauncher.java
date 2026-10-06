package com.agenticrag.pet;

import com.badlogic.gdx.ApplicationAdapter;
import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.Input;
import com.badlogic.gdx.InputAdapter;
import com.badlogic.gdx.backends.lwjgl3.Lwjgl3Application;
import com.badlogic.gdx.backends.lwjgl3.Lwjgl3ApplicationConfiguration;
import com.badlogic.gdx.backends.lwjgl3.Lwjgl3Graphics;
import com.badlogic.gdx.files.FileHandle;
import com.badlogic.gdx.graphics.Color;
import com.badlogic.gdx.graphics.GL20;
import com.badlogic.gdx.graphics.OrthographicCamera;
import com.badlogic.gdx.graphics.g2d.PolygonSpriteBatch;
import com.badlogic.gdx.graphics.g2d.TextureAtlas;
import com.badlogic.gdx.math.Vector2;
import com.badlogic.gdx.utils.BufferUtils;
import com.esotericsoftware.spine.Animation;
import com.esotericsoftware.spine.AnimationState;
import com.esotericsoftware.spine.AnimationStateData;
import com.esotericsoftware.spine.Skeleton;
import com.esotericsoftware.spine.SkeletonBinary;
import com.esotericsoftware.spine.SkeletonData;
import com.esotericsoftware.spine.SkeletonMeshRenderer;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.lwjgl.glfw.GLFW;
import org.lwjgl.glfw.GLFWNativeWin32;
import org.lwjgl.system.MemoryStack;

import java.awt.Dimension;
import java.awt.GraphicsConfiguration;
import java.awt.GraphicsDevice;
import java.awt.GraphicsEnvironment;
import java.awt.Insets;
import java.awt.Rectangle;
import java.awt.Toolkit;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.DoubleBuffer;
import java.nio.IntBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Random;
import java.util.Set;

public final class SpinePetGdxLauncher {
    public static void main(String[] args) {
        SpineOptions options = SpineOptions.parse(args);
        StartupDiagnostics.runAsync(options);

        Lwjgl3ApplicationConfiguration config = new Lwjgl3ApplicationConfiguration();
        config.setTitle(options.windowTitle);
        config.setDecorated(false);
        config.setResizable(false);
        config.setTransparentFramebuffer(true);
        config.setBackBufferConfig(8, 8, 8, 8, 16, 8, 0);
        config.setWindowedMode(options.renderedWidth(), options.renderedHeight());
        config.setInitialBackgroundColor(new Color(0f, 0f, 0f, 0f));
        config.setForegroundFPS(60);
        config.useVsync(false);

        try {
            Dimension screen = Toolkit.getDefaultToolkit().getScreenSize();
            config.setWindowPosition(
                    Math.max(0, screen.width - options.renderedWidth() - 80 + options.boundaryPaddingX),
                    Math.max(0, screen.height - options.renderedHeight() - 60 + options.boundaryPaddingY)
            );
        } catch (Exception ignored) {
        }

        new Lwjgl3Application(new SpinePetGdxApp(options), config);
    }
}

final class SpinePetGdxApp extends ApplicationAdapter {
    private static final int SOLID_PIXEL_ALPHA_THRESHOLD = 12;

    private final SpineOptions options;
    private final NativeWindowController nativeWindowController;
    private final Random random = new Random();
    private final PetClickSequence clickSequence = new PetClickSequence();

    private TextureAtlas atlas;
    private Skeleton skeleton;
    private AnimationState animationState;
    private SkeletonMeshRenderer meshRenderer;
    private PolygonSpriteBatch batch;
    private OrthographicCamera camera;
    private Vector2 baseBoundsOffset;
    private Vector2 baseBoundsSize;
    private Vector2 currentBoundsOffset;
    private Vector2 currentBoundsSize;
    private PetControlWindow controlWindow;
    private ProfileConfig activeConfig;
    private String activeProfileId;
    private List<PetModelOption> modelLibrary = List.of();
    private long glfwWindow;
    private long nativeWindowHandle;
    private long profilesLastModified;
    private long spineAssetsLastModified;
    private boolean randomBehaviorEnabled = true;
    private float randomActionElapsedSeconds;
    private float nextRandomActionAfterSeconds = 14f;
    private float randomMoveElapsedSeconds;
    private float nextRandomMoveAfterSeconds = 42f;
    private boolean randomMoveActive;
    private int randomMoveTargetX;
    private float roamSpeed;
    private float roamCruiseSpeed;
    private float restTimeRemaining;
    private String loopBeforeMove = "";
    private String idleAnimationName = "";
    private String pokeAnimationName = "";
    private String moveAnimationName = "";
    private String sitAnimationName = "";
    private String sleepAnimationName = "";
    private String specialAnimationName = "";
    private List<String> randomActionAnimations = List.of();
    private List<String> loopActionAnimations = List.of();
    private List<String> burstActionAnimations = List.of();
    private String currentLoopAnimationName = "";
    private boolean dragging;
    private double dragStartMouseX;
    private double dragStartMouseY;
    private int dragStartWindowX;
    private int dragStartWindowY;
    private boolean nativeDragCoordinates;
    private long leftPointerDownAtMs;
    private boolean leftPointerMoved;
    private boolean clickThroughEnabled;
    private int clickThroughProbeFrames;
    private ByteBuffer hitPixelBuffer;
    private int styleRetryFrames;
    private int topmostPulseFrames;
    private int hotReloadFrames;
    private int menuSyncFrames;

    SpinePetGdxApp(SpineOptions options) {
        this.options = options;
        this.nativeWindowController = new NativeWindowController();
    }

    @Override
    public void create() {
        glfwWindow = ((Lwjgl3Graphics) Gdx.graphics).getWindow().getWindowHandle();
        nativeWindowHandle = resolveNativeWindowHandle();
        Gdx.input.setInputProcessor(new DragAndActionInput());
        hitPixelBuffer = BufferUtils.newByteBuffer(4);

        meshRenderer = new SkeletonMeshRenderer();
        meshRenderer.setPremultipliedAlpha(false);
        batch = new PolygonSpriteBatch();
        camera = new OrthographicCamera();
        camera.setToOrtho(false, options.renderedWidth(), options.renderedHeight());
        currentBoundsOffset = new Vector2();
        currentBoundsSize = new Vector2();

        modelLibrary = loadModelLibrary();
        activeProfileId = options.profileId;
        activeConfig = ProfileConfig.fromProfilesFile(options, ProfileConfig.fromOptions(options), activeProfileId);
        if (activeProfileId == null || activeProfileId.isBlank()) {
            activeProfileId = findProfileIdBySkeleton(activeConfig.skeletonUrl);
        }
        reloadSpine(activeConfig);
        profilesLastModified = getProfilesLastModified();
        spineAssetsLastModified = getSpineAssetsLastModified(activeConfig);
        controlWindow = new PetControlWindow(new PetMenuActions(), options.chatUrl, options.projectRoot, modelLibrary);
        controlWindow.updateModelLibrary(modelLibrary, activeProfileId);
        nextRandomActionAfterSeconds = randomBetween(14f, 30f);
        nextRandomMoveAfterSeconds = randomBetween(30f, 65f);
        setClickThrough(false);
    }

    @Override
    public void render() {
        float delta = Gdx.graphics.getDeltaTime();
        checkProfileHotReload();

        if (styleRetryFrames < 120) {
            configurePetWindow();
            styleRetryFrames += 1;
        }
        if (topmostPulseFrames++ >= 60) {
            keepWindowTopmost();
            topmostPulseFrames = 0;
        }
        if (menuSyncFrames++ >= 10) {
            syncControlWindow();
            menuSyncFrames = 0;
        }

        dispatchClickAction(clickSequence.flush(nowMillis(), dragging));
        updateAutonomousBehavior(delta);
        animationState.update(delta);
        animationState.apply(skeleton);
        layoutSkeleton();

        Gdx.gl.glClearColor(0f, 0f, 0f, 0f);
        Gdx.gl.glClear(GL20.GL_COLOR_BUFFER_BIT);

        camera.update();
        batch.getProjectionMatrix().set(camera.combined);
        batch.begin();
        meshRenderer.draw(batch, skeleton);
        batch.end();

        if (clickThroughProbeFrames++ >= 1) {
            clickThroughProbeFrames = 0;
            updateClickThroughByPixel();
        }
    }

    @Override
    public void dispose() {
        if (atlas != null) {
            atlas.dispose();
        }
        if (batch != null) {
            batch.dispose();
        }
        if (controlWindow != null) {
            controlWindow.dispose();
        }
    }

    private void cacheBaseBounds() {
        baseBoundsOffset = new Vector2();
        baseBoundsSize = new Vector2();

        skeleton.setToSetupPose();
        skeleton.setPosition(0f, 0f);
        skeleton.updateWorldTransform();
        skeleton.getBounds(baseBoundsOffset, baseBoundsSize);
    }

    private void layoutSkeleton() {
        float x = options.boundaryPaddingX + options.width / 2f
                - baseBoundsOffset.x - baseBoundsSize.x / 2f + activeConfig.xOffset;
        float y = options.boundaryPaddingY + activeConfig.floorOffset - baseBoundsOffset.y;
        skeleton.setPosition(x, y);
        skeleton.updateWorldTransform();
        skeleton.getBounds(currentBoundsOffset, currentBoundsSize);
    }

    private void reloadSpine(ProfileConfig nextConfig) {
        TextureAtlas nextAtlas = new TextureAtlas(Gdx.files.absolute(options.resolveAssetPath(nextConfig.atlasUrl).toString()));
        SkeletonBinary binary = new SkeletonBinary(nextAtlas);
        binary.setScale(nextConfig.skeletonScale);
        FileHandle skeletonFile = Gdx.files.absolute(options.resolveAssetPath(nextConfig.skeletonUrl).toString());
        SkeletonData skeletonData = binary.readSkeletonData(skeletonFile);

        Skeleton nextSkeleton = new Skeleton(skeletonData);
        AnimationStateData stateData = new AnimationStateData(skeletonData);
        stateData.setDefaultMix(0.18f);
        AnimationState nextAnimationState = new AnimationState(stateData);

        idleAnimationName = safeAnimationName(resolveAnimationName(skeletonData, nextConfig.idleAnimationName));
        pokeAnimationName = safeAnimationName(resolveAnimationName(skeletonData, nextConfig.pokeAnimationName));
        moveAnimationName = safeAnimationName(resolveAnimationName(skeletonData, nextConfig.moveAnimationName));
        sitAnimationName = exactAnimationName(skeletonData, nextConfig.sitAnimationName);
        sleepAnimationName = exactAnimationName(skeletonData, nextConfig.sleepAnimationName);
        specialAnimationName = exactAnimationName(skeletonData, nextConfig.specialAnimationName);
        randomActionAnimations = resolveAnimationNames(skeletonData, nextConfig.randomAnimationNames);
        if (randomActionAnimations.isEmpty() && !pokeAnimationName.isBlank()) {
            randomActionAnimations = List.of(pokeAnimationName);
        }
        classifyRandomActions(skeletonData);
        logAnimationInfo(
                skeletonData,
                nextConfig.idleAnimationName,
                idleAnimationName,
                nextConfig,
                pokeAnimationName,
                moveAnimationName,
                randomActionAnimations
        );
        if (!idleAnimationName.isBlank()) {
            nextAnimationState.setAnimation(0, idleAnimationName, true);
            currentLoopAnimationName = idleAnimationName;
        }

        TextureAtlas previousAtlas = atlas;
        atlas = nextAtlas;
        skeleton = nextSkeleton;
        animationState = nextAnimationState;
        activeConfig = nextConfig;
        randomMoveActive = false;
        roamSpeed = 0f;
        loopBeforeMove = "";
        restTimeRemaining = 0f;
        randomActionElapsedSeconds = 0f;
        randomMoveElapsedSeconds = 0f;
        nextRandomActionAfterSeconds = randomBetween(14f, 30f);
        nextRandomMoveAfterSeconds = randomBetween(30f, 65f);
        spineAssetsLastModified = getSpineAssetsLastModified(nextConfig);
        meshRenderer.setPremultipliedAlpha(nextConfig.premultipliedAlpha);
        cacheBaseBounds();

        if (previousAtlas != null) {
            previousAtlas.dispose();
        }
    }

    private void checkProfileHotReload() {
        if (hotReloadFrames++ < 30) {
            return;
        }
        hotReloadFrames = 0;

        long modified = getProfilesLastModified();
        long assetsModified = getSpineAssetsLastModified(activeConfig);
        boolean profileChanged = modified != 0L && modified != profilesLastModified;
        boolean assetsChanged = assetsModified != 0L && assetsModified != spineAssetsLastModified;
        if (!profileChanged && !assetsChanged) {
            return;
        }
        if (profileChanged) {
            profilesLastModified = modified;
            modelLibrary = loadModelLibrary();
            if (controlWindow != null) {
                controlWindow.updateModelLibrary(modelLibrary, activeProfileId);
            }
        }

        ProfileConfig nextConfig = ProfileConfig.fromProfilesFile(options, activeConfig, activeProfileId);
        if (assetsChanged || !activeConfig.equals(nextConfig)) {
            tryReloadSpine(nextConfig);
        }
    }

    private void tryReloadSpine(ProfileConfig nextConfig) {
        try {
            reloadSpine(nextConfig);
        } catch (RuntimeException failedReload) {
            System.err.println("Failed to hot reload Spine profile: " + failedReload.getMessage());
        }
    }

    private long getProfilesLastModified() {
        try {
            return Files.getLastModifiedTime(options.profilesPath).toMillis();
        } catch (IOException ignored) {
            return 0L;
        }
    }

    private List<PetModelOption> loadModelLibrary() {
        List<PetModelOption> models = new ArrayList<>();
        try {
            JsonArray profiles = JsonParser.parseString(Files.readString(options.profilesPath)).getAsJsonArray();
            for (JsonElement element : profiles) {
                if (!element.isJsonObject()) {
                    continue;
                }
                JsonObject profile = element.getAsJsonObject();
                String id = getString(profile, "id", "");
                if (id.isBlank()) {
                    continue;
                }
                String name = getString(profile, "name", id);
                JsonObject spine = profile.has("spine") && profile.get("spine").isJsonObject()
                        ? profile.getAsJsonObject("spine")
                        : null;
                String skeletonUrl = getString(spine, "skeleton_url", "");
                models.add(new PetModelOption(id, name, skeletonUrl));
            }
        } catch (RuntimeException | IOException error) {
            System.err.println("[pet-spine] failed to load model library: " + error.getMessage());
        }
        if (models.isEmpty()) {
            models.add(new PetModelOption("truth-default-build", "Truth Default", options.skeletonUrl));
        }
        return List.copyOf(models);
    }

    private String findProfileIdBySkeleton(String skeletonUrl) {
        for (PetModelOption option : modelLibrary) {
            if (skeletonUrl.equals(option.skeletonUrl())) {
                return option.id();
            }
        }
        return modelLibrary.isEmpty() ? "truth-default-build" : modelLibrary.get(0).id();
    }

    private long getSpineAssetsLastModified(ProfileConfig config) {
        return getFileLastModified(options.resolveAssetPath(config.skeletonUrl))
                + getFileLastModified(options.resolveAssetPath(config.atlasUrl));
    }

    private long getFileLastModified(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException ignored) {
            return 0L;
        }
    }

    private long resolveNativeWindowHandle() {
        if (glfwWindow == 0L) {
            return 0L;
        }
        try {
            return GLFWNativeWin32.glfwGetWin32Window(glfwWindow);
        } catch (Throwable ignored) {
            return 0L;
        }
    }

    private void configurePetWindow() {
        if (nativeWindowHandle != 0L) {
            nativeWindowController.configurePetWindow(nativeWindowHandle, true, true);
        } else {
            nativeWindowController.configurePetWindow(options.windowTitle, true, true);
        }
        nativeWindowController.configureCurrentProcessPetWindows(options.windowTitle, true, true);
    }

    private void keepWindowTopmost() {
        if (nativeWindowHandle != 0L) {
            nativeWindowController.keepTopmost(nativeWindowHandle);
        } else {
            nativeWindowController.configurePetWindow(options.windowTitle, true, true);
        }
        nativeWindowController.keepCurrentProcessPetWindowsTopmost(options.windowTitle);
    }

    private void updateClickThroughByPixel() {
        if (!nativeWindowController.isWindows()) {
            return;
        }
        if (dragging) {
            setClickThrough(false);
            return;
        }
        int[] cursorPosition = nativeWindowController.getCursorPosition();
        if (cursorPosition == null) {
            return;
        }
        int[] windowPosition = getWindowPosition();
        double localX = cursorPosition[0] - windowPosition[0];
        double localY = cursorPosition[1] - windowPosition[1];
        boolean overSolidPixel = isSolidPixelAtLocalPoint(localX, localY);
        setClickThrough(!overSolidPixel);
    }

    private boolean isSolidPixelAtLocalPoint(double localX, double localY) {
        if (hitPixelBuffer == null || localX < 0 || localY < 0) {
            return false;
        }
        int logicalWidth = Gdx.graphics.getWidth();
        int logicalHeight = Gdx.graphics.getHeight();
        if (logicalWidth <= 0 || logicalHeight <= 0 || localX >= logicalWidth || localY >= logicalHeight) {
            return false;
        }
        double localYBottomOrigin = logicalHeight - localY;
        if (!isPointInCurrentSkeletonBounds(localX, localYBottomOrigin)) {
            return false;
        }
        int backBufferWidth = Gdx.graphics.getBackBufferWidth();
        int backBufferHeight = Gdx.graphics.getBackBufferHeight();
        if (backBufferWidth <= 0 || backBufferHeight <= 0) {
            return true;
        }
        float scaleX = backBufferWidth / (float) logicalWidth;
        float scaleY = backBufferHeight / (float) logicalHeight;
        int pixelX = clamp((int) Math.floor(localX * scaleX), 0, backBufferWidth - 1);
        int pixelYFromTop = clamp((int) Math.floor(localY * scaleY), 0, backBufferHeight - 1);
        int pixelY = backBufferHeight - pixelYFromTop - 1;

        hitPixelBuffer.clear();
        Gdx.gl.glReadPixels(pixelX, pixelY, 1, 1, GL20.GL_RGBA, GL20.GL_UNSIGNED_BYTE, hitPixelBuffer);
        int alpha = hitPixelBuffer.get(3) & 0xFF;
        if (alpha > SOLID_PIXEL_ALPHA_THRESHOLD) {
            return true;
        }
        // Some GPU/driver paths report unreliable alpha on the default framebuffer.
        // Keep the model interactive when the cursor is inside runtime skeleton bounds.
        return true;
    }

    private boolean isPointInCurrentSkeletonBounds(double localX, double localY) {
        if (currentBoundsOffset == null || currentBoundsSize == null) {
            return false;
        }
        float pad = 8f;
        float left = currentBoundsOffset.x - pad;
        float bottom = currentBoundsOffset.y - pad;
        float right = currentBoundsOffset.x + currentBoundsSize.x + pad;
        float top = currentBoundsOffset.y + currentBoundsSize.y + pad;
        return localX >= left && localX <= right && localY >= bottom && localY <= top;
    }

    private void setClickThrough(boolean enabled) {
        if (enabled == clickThroughEnabled) {
            return;
        }
        if (glfwWindow != 0L) {
            GLFW.glfwSetWindowAttrib(glfwWindow, GLFW.GLFW_MOUSE_PASSTHROUGH, enabled ? 1 : 0);
        }
        if (nativeWindowHandle != 0L) {
            nativeWindowController.setClickThrough(nativeWindowHandle, enabled);
        } else {
            nativeWindowController.setClickThrough(options.windowTitle, enabled);
        }
        clickThroughEnabled = enabled;
    }

    private int[] getWindowPosition() {
        int[] nativePosition = nativeWindowController.getWindowTopLeft(nativeWindowHandle);
        if (nativePosition != null) {
            return nativePosition;
        }
        if (glfwWindow == 0L) {
            return new int[]{0, 0};
        }
        try (MemoryStack stack = MemoryStack.stackPush()) {
            IntBuffer x = stack.mallocInt(1);
            IntBuffer y = stack.mallocInt(1);
            GLFW.glfwGetWindowPos(glfwWindow, x, y);
            return new int[]{x.get(0), y.get(0)};
        }
    }

    private void syncControlWindow() {
        if (controlWindow == null) {
            return;
        }
        int[] position = getWindowPosition();
        controlWindow.syncToPet(position[0], position[1]);
    }

    private void toggleControlWindow() {
        if (controlWindow == null) {
            return;
        }
        int[] position = getWindowPosition();
        controlWindow.toggle(position[0], position[1]);
        keepWindowTopmost();
    }

    private void updateAutonomousBehavior(float delta) {
        if (animationState == null || skeleton == null || dragging) {
            return;
        }
        if (controlWindow != null && controlWindow.isShowing()) {
            if (randomMoveActive) stopRoaming();
            return;
        }
        if (!randomBehaviorEnabled) return;
        updateRandomMovement(delta);
        updateRandomAction(delta);
    }

    private Rectangle currentWorkArea() {
        int[] position = getWindowPosition();
        int centerX = position[0] + options.renderedWidth() / 2;
        int centerY = position[1] + options.renderedHeight() / 2;
        try {
            GraphicsConfiguration selected = null;
            double bestDistance = Double.MAX_VALUE;
            for (GraphicsDevice device : GraphicsEnvironment.getLocalGraphicsEnvironment().getScreenDevices()) {
                GraphicsConfiguration config = device.getDefaultConfiguration();
                Rectangle bounds = config.getBounds();
                double distance = bounds.contains(centerX, centerY) ? 0d
                        : Math.pow(bounds.getCenterX() - centerX, 2) + Math.pow(bounds.getCenterY() - centerY, 2);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    selected = config;
                }
            }
            if (selected != null) {
                Rectangle bounds = selected.getBounds();
                Insets insets = Toolkit.getDefaultToolkit().getScreenInsets(selected);
                return new Rectangle(bounds.x + insets.left, bounds.y + insets.top,
                        bounds.width - insets.left - insets.right,
                        bounds.height - insets.top - insets.bottom);
            }
        } catch (RuntimeException ignored) {
        }
        Dimension screen = Toolkit.getDefaultToolkit().getScreenSize();
        return new Rectangle(0, 0, screen.width, screen.height);
    }

    private void movePetWindowTo(int x, int y) {
        if (!nativeWindowController.moveWindowTo(nativeWindowHandle, x, y)) {
            GLFW.glfwSetWindowPos(glfwWindow, x, y);
        }
        if (controlWindow != null) controlWindow.syncToPet(x, y);
    }

    private void updateRandomAction(float delta) {
        if (randomMoveActive) {
            return;
        }
        if (restTimeRemaining > 0f) {
            restTimeRemaining -= delta;
            if (restTimeRemaining <= 0f) {
                playIdleLoop();
                nextRandomActionAfterSeconds = randomBetween(12f, 25f);
            }
            return;
        }
        AnimationState.TrackEntry current = animationState.getCurrent(0);
        if (current != null && !current.getLoop()) {
            return;
        }
        randomActionElapsedSeconds += delta;
        if (randomActionElapsedSeconds < nextRandomActionAfterSeconds) {
            return;
        }
        randomActionElapsedSeconds = 0f;
        nextRandomActionAfterSeconds = randomBetween(16f, 32f);
        triggerRandomDecision();
    }

    private void updateRandomMovement(float delta) {
        AnimationState.TrackEntry current = animationState.getCurrent(0);
        if (current != null && !current.getLoop()) {
            return;
        }

        if (randomMoveActive) {
            moveWindowTowardRandomTarget(delta);
            return;
        }
        if (restTimeRemaining > 0f || isRestingAnimationName(currentLoopAnimationName)) {
            return;
        }
        randomMoveElapsedSeconds += delta;
        if (randomMoveElapsedSeconds >= nextRandomMoveAfterSeconds) {
            randomMoveElapsedSeconds = 0f;
            nextRandomMoveAfterSeconds = randomBetween(35f, 75f);
            startRandomMove();
        }
    }

    private void startRandomMove() {
        if (glfwWindow == 0L) {
            return;
        }
        int[] currentPosition = getWindowPosition();
        int currentX = currentPosition[0];
        int currentY = currentPosition[1];

        Rectangle area = currentWorkArea();
        int minimumX = area.x + 12;
        int maximumX = Math.max(minimumX, area.x + area.width - options.renderedWidth() - 12);
        randomMoveTargetX = PetMotion.roamingTarget(random, currentX, minimumX, maximumX);
        if (Math.abs(randomMoveTargetX - currentX) < 12) {
            return;
        }
        randomMoveActive = true;
        roamSpeed = 0f;
        roamCruiseSpeed = randomBetween(135f, 205f);
        loopBeforeMove = currentLoopAnimationName;
        System.out.println("[pet-random] move target x=" + randomMoveTargetX);
        skeleton.setFlipX(randomMoveTargetX < currentX);
        if (!moveAnimationName.isBlank()) {
            animationState.setAnimation(0, moveAnimationName, true);
        }
    }

    private void moveWindowTowardRandomTarget(float delta) {
        if (glfwWindow == 0L) {
            randomMoveActive = false;
            return;
        }
        int[] position = getWindowPosition();
        int currentX = position[0];
        int currentY = position[1];
        double dx = randomMoveTargetX - currentX;
        double distance = Math.abs(dx);

        if (distance < 2.0) {
            movePetWindowTo(randomMoveTargetX, currentY);
            stopRoaming();
            return;
        }

        roamSpeed = Math.min(roamCruiseSpeed, roamSpeed + 320f * delta);
        double brakingSpeed = Math.sqrt(2d * 320d * distance);
        double step = Math.min(distance, Math.max(55d, Math.min(roamSpeed, brakingSpeed)) * delta);
        int nextX = currentX + (int) Math.round(Math.copySign(step, dx));
        if (nextX == currentX) nextX += dx > 0 ? 1 : -1;
        movePetWindowTo(nextX, currentY);
        if (Math.abs(randomMoveTargetX - nextX) <= 1) stopRoaming();
    }

    private void stopRoaming() {
        if (!randomMoveActive) return;
        randomMoveActive = false;
        roamSpeed = 0f;
        skeleton.setFlipX(false);
        if (loopBeforeMove != null && !loopBeforeMove.isBlank() && !loopBeforeMove.equals(moveAnimationName)) {
            switchLoopAction(loopBeforeMove);
        } else {
            playIdleLoop();
        }
        loopBeforeMove = "";
        randomActionElapsedSeconds = 0f;
    }

    private void triggerRandomDecision() {
        float roll = random.nextFloat();
        if (roll < 0.24f && !sitAnimationName.isBlank()) {
            playRestingPose(sitAnimationName, randomBetween(8f, 18f));
        } else if (roll < 0.34f && !sleepAnimationName.isBlank()) {
            playRestingPose(sleepAnimationName, randomBetween(10f, 24f));
        } else {
            String action = specialAnimationName.isBlank() || random.nextFloat() < 0.68f
                    ? pokeAnimationName : specialAnimationName;
            if (!action.isBlank()) {
                System.out.println("[pet-random] action=" + action);
                playOneShotThenResume(action, idleAnimationName);
            }
        }
    }

    private void resetInteractionTiming() {
        stopRoaming();
        restTimeRemaining = 0f;
        randomActionElapsedSeconds = 0f;
        randomMoveElapsedSeconds = 0f;
        nextRandomActionAfterSeconds = randomBetween(16f, 30f);
        nextRandomMoveAfterSeconds = randomBetween(35f, 75f);
    }

    private void triggerPokeAction(boolean doubleClick) {
        resetInteractionTiming();
        String action = doubleClick && !specialAnimationName.isBlank() ? specialAnimationName : pokeAnimationName;
        if (action.isBlank()) return;
        currentLoopAnimationName = idleAnimationName;
        System.out.println("[pet-interact] click=" + action);
        playOneShotThenResume(action, idleAnimationName);
    }

    private static long nowMillis() {
        return System.nanoTime() / 1_000_000L;
    }

    private void dispatchClickAction(PetClickSequence.Action action) {
        if (action == PetClickSequence.Action.SINGLE) triggerPokeAction(false);
        if (action == PetClickSequence.Action.DOUBLE) triggerPokeAction(true);
    }

    private void playRestingPose(String animationName, float seconds) {
        if (animationName == null || animationName.isBlank()) return;
        animationState.setAnimation(0, animationName, true);
        currentLoopAnimationName = animationName;
        restTimeRemaining = seconds;
        System.out.println("[pet-interact] rest=" + animationName);
    }

    private void playInteraction(String action) {
        clickSequence.cancel();
        resetInteractionTiming();
        switch (action) {
            case "sit" -> playRestingPose(sitAnimationName, randomBetween(10f, 20f));
            case "sleep" -> playRestingPose(sleepAnimationName, randomBetween(12f, 28f));
            case "special" -> triggerPokeAction(true);
            case "wake" -> playIdleLoop();
            default -> triggerPokeAction(false);
        }
    }

    private String chooseDifferentAnimation(List<String> candidates, String current) {
        if (candidates == null || candidates.isEmpty()) {
            return "";
        }
        if (candidates.size() == 1) {
            return candidates.get(0);
        }
        List<String> filtered = new ArrayList<>();
        for (String animationName : candidates) {
            if (animationName != null && !animationName.isBlank() && !animationName.equals(current)) {
                filtered.add(animationName);
            }
        }
        if (filtered.isEmpty()) {
            filtered = new ArrayList<>(candidates);
        }
        return filtered.get(random.nextInt(filtered.size()));
    }

    private void switchLoopAction(String animationName) {
        if (animationName == null || animationName.isBlank() || animationState == null) {
            return;
        }
        animationState.setAnimation(0, animationName, true);
        currentLoopAnimationName = animationName;
    }

    private void playOneShotThenResumeLoop(String animationName) {
        if (animationName == null || animationName.isBlank() || animationState == null) {
            return;
        }
        String resumeLoop = currentLoopAnimationName == null || currentLoopAnimationName.isBlank()
                ? idleAnimationName
                : currentLoopAnimationName;
        playOneShotThenResume(animationName, resumeLoop);
    }

    private void playOneShotThenResume(String animationName, String resumeLoop) {
        if (animationName == null || animationName.isBlank() || animationState == null) {
            return;
        }
        animationState.setAnimation(0, animationName, false);
        if (resumeLoop != null && !resumeLoop.isBlank()) {
            animationState.addAnimation(0, resumeLoop, true, 0f);
        }
    }

    private void playIdleLoop() {
        if (animationState == null || idleAnimationName.isBlank()) {
            return;
        }
        AnimationState.TrackEntry current = animationState.getCurrent(0);
        if (current != null && current.getLoop() && idleAnimationName.equals(current.getAnimation().getName())) {
            return;
        }
        animationState.setAnimation(0, idleAnimationName, true);
        currentLoopAnimationName = idleAnimationName;
    }

    private void classifyRandomActions(SkeletonData skeletonData) {
        Set<String> loopSet = new LinkedHashSet<>();
        Set<String> burstSet = new LinkedHashSet<>();
        for (String animationName : randomActionAnimations) {
            if (animationName == null || animationName.isBlank() || animationName.equals(idleAnimationName)) {
                continue;
            }
            if (isRestingAnimationName(animationName)) {
                loopSet.add(animationName);
            } else {
                burstSet.add(animationName);
            }
        }
        if (burstSet.isEmpty() && pokeAnimationName != null && !pokeAnimationName.isBlank()) {
            burstSet.add(pokeAnimationName);
        }
        loopActionAnimations = loopSet.isEmpty() ? List.of() : List.copyOf(loopSet);
        burstActionAnimations = burstSet.isEmpty() ? List.of() : List.copyOf(burstSet);
    }

    private boolean isRestingAnimationName(String animationName) {
        if (animationName == null || animationName.isBlank()) {
            return false;
        }
        String lower = animationName.toLowerCase();
        return lower.contains("sleep") || lower.contains("sit") || lower.contains("rest");
    }

    private String safeAnimationName(String animationName) {
        return animationName == null ? "" : animationName;
    }

    private String exactAnimationName(SkeletonData data, String name) {
        if (name == null || name.isBlank()) return "";
        Animation animation = data.findAnimation(name);
        return animation != null && animation.getDuration() > 0.05f ? name : "";
    }

    private List<String> resolveAnimationNames(SkeletonData skeletonData, List<String> rawNames) {
        if (rawNames == null || rawNames.isEmpty()) {
            return List.of();
        }
        Set<String> resolved = new LinkedHashSet<>();
        for (String raw : rawNames) {
            String matched = resolveAnimationName(skeletonData, raw);
            if (matched != null && !matched.isBlank()) {
                resolved.add(matched);
            }
        }
        return resolved.isEmpty() ? List.of() : List.copyOf(resolved);
    }

    private String resolveAnimationName(SkeletonData skeletonData, String preferred) {
        if (preferred == null || preferred.isBlank()) {
            return null;
        }
        Animation preferredAnimation = skeletonData.findAnimation(preferred);
        if (preferredAnimation != null && preferredAnimation.getDuration() > 0.05f) {
            return preferred;
        }
        String dynamicCandidate = null;
        float maxDuration = 0f;
        for (Animation animation : skeletonData.getAnimations()) {
            float duration = animation.getDuration();
            if (duration > 0.05f && (dynamicCandidate == null || duration > maxDuration)) {
                dynamicCandidate = animation.getName();
                maxDuration = duration;
            }
        }
        if (dynamicCandidate != null) {
            return dynamicCandidate;
        }
        if (preferredAnimation != null) {
            return preferred;
        }
        if (!skeletonData.getAnimations().isEmpty()) {
            return skeletonData.getAnimations().get(0).getName();
        }
        return null;
    }

    private void logAnimationInfo(
            SkeletonData skeletonData,
            String preferred,
            String selected,
            ProfileConfig config,
            String poke,
            String move,
            List<String> randomAnimations
    ) {
        StringBuilder builder = new StringBuilder();
        int count = 0;
        for (Animation animation : skeletonData.getAnimations()) {
            if (count > 0) {
                builder.append(", ");
            }
            builder.append(animation.getName())
                    .append('(')
                    .append(String.format("%.3fs", animation.getDuration()))
                    .append(')');
            count += 1;
            if (count >= 20) {
                builder.append(", ...");
                break;
            }
        }
        System.out.println(
                "[pet-spine] profile=" + activeProfileId
                        + " skeleton=" + config.skeletonUrl
                        + " preferred=" + preferred
                        + " selected=" + selected
                        + " poke=" + poke
                        + " move=" + move
                        + " randomSet=" + randomAnimations
                        + " randomLoopSet=" + loopActionAnimations
                        + " randomBurstSet=" + burstActionAnimations
                        + " animationCount=" + skeletonData.getAnimations().size
                        + " animations=[" + builder + "]"
        );
    }

    private float randomBetween(float min, float max) {
        return min + random.nextFloat() * (max - min);
    }

    private int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private static String getString(JsonObject object, String key, String fallback) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return fallback;
        }
        return object.get(key).getAsString();
    }

    private final class DragAndActionInput extends InputAdapter {
        @Override
        public boolean touchDown(int screenX, int screenY, int pointer, int button) {
            if (button == Input.Buttons.LEFT) {
                PetClickSequence.Action previousClick = clickSequence.press(nowMillis());
                stopRoaming();
                if (restTimeRemaining > 0f) {
                    restTimeRemaining = 0f;
                    playIdleLoop();
                }
                randomActionElapsedSeconds = 0f;
                nextRandomActionAfterSeconds = randomBetween(16f, 30f);
                randomMoveElapsedSeconds = 0f;
                nextRandomMoveAfterSeconds = randomBetween(35f, 75f);
                dragging = true;
                leftPointerDownAtMs = nowMillis();
                leftPointerMoved = false;
                setClickThrough(false);
                captureDragStart();
                dispatchClickAction(previousClick);
                return true;
            }
            if (button == Input.Buttons.RIGHT) {
                clickSequence.cancel();
                toggleControlWindow();
                return true;
            }
            return false;
        }

        @Override
        public boolean touchDragged(int screenX, int screenY, int pointer) {
            if (!dragging || glfwWindow == 0L) {
                return false;
            }
            if (nativeDragCoordinates) {
                int[] cursor = nativeWindowController.getCursorPosition();
                if (cursor != null) {
                    double dx = cursor[0] - dragStartMouseX;
                    double dy = cursor[1] - dragStartMouseY;
                    if (Math.hypot(dx, dy) >= 7.0) {
                        leftPointerMoved = true;
                    }
                    if (nativeWindowController.moveWindowTo(nativeWindowHandle,
                            (int) Math.round(dragStartWindowX + dx),
                            (int) Math.round(dragStartWindowY + dy))) {
                        if (controlWindow != null) {
                            int[] position = getWindowPosition();
                            controlWindow.syncToPet(position[0], position[1]);
                        }
                        keepWindowTopmost();
                    }
                }
                return true;
            }
            try (MemoryStack stack = MemoryStack.stackPush()) {
                DoubleBuffer cursorX = stack.mallocDouble(1);
                DoubleBuffer cursorY = stack.mallocDouble(1);
                IntBuffer windowX = stack.mallocInt(1);
                IntBuffer windowY = stack.mallocInt(1);
                GLFW.glfwGetCursorPos(glfwWindow, cursorX, cursorY);
                GLFW.glfwGetWindowPos(glfwWindow, windowX, windowY);

                double currentMouseX = windowX.get(0) + cursorX.get(0);
                double currentMouseY = windowY.get(0) + cursorY.get(0);
                if (Math.hypot(currentMouseX - dragStartMouseX, currentMouseY - dragStartMouseY) >= 7.0) {
                    leftPointerMoved = true;
                }
                int nextWindowX = (int) Math.round(dragStartWindowX + currentMouseX - dragStartMouseX);
                int nextWindowY = (int) Math.round(dragStartWindowY + currentMouseY - dragStartMouseY);
                GLFW.glfwSetWindowPos(
                        glfwWindow,
                        nextWindowX,
                        nextWindowY
                );
                if (controlWindow != null) {
                    int[] position = getWindowPosition();
                    controlWindow.syncToPet(position[0], position[1]);
                }
                keepWindowTopmost();
            }
            return true;
        }

        @Override
        public boolean touchUp(int screenX, int screenY, int pointer, int button) {
            if (button == Input.Buttons.LEFT) {
                dragging = false;
                nativeDragCoordinates = false;
                long now = nowMillis();
                long pressDurationMs = now - leftPointerDownAtMs;
                if (leftPointerMoved) {
                    clickSequence.cancel();
                } else if (pressDurationMs <= 320L) {
                    dispatchClickAction(clickSequence.shortRelease(now));
                } else if (pressDurationMs >= 580L) {
                    playInteraction("sit");
                } else {
                    clickSequence.cancel();
                }
                return true;
            }
            return false;
        }

        private void captureDragStart() {
            int[] nativeWindow = nativeWindowController.getWindowTopLeft(nativeWindowHandle);
            int[] nativeCursor = nativeWindowController.getCursorPosition();
            nativeDragCoordinates = nativeWindow != null && nativeCursor != null;
            if (nativeDragCoordinates) {
                dragStartWindowX = nativeWindow[0];
                dragStartWindowY = nativeWindow[1];
                dragStartMouseX = nativeCursor[0];
                dragStartMouseY = nativeCursor[1];
                return;
            }
            try (MemoryStack stack = MemoryStack.stackPush()) {
                DoubleBuffer cursorX = stack.mallocDouble(1);
                DoubleBuffer cursorY = stack.mallocDouble(1);
                IntBuffer windowX = stack.mallocInt(1);
                IntBuffer windowY = stack.mallocInt(1);
                GLFW.glfwGetCursorPos(glfwWindow, cursorX, cursorY);
                GLFW.glfwGetWindowPos(glfwWindow, windowX, windowY);

                dragStartWindowX = windowX.get(0);
                dragStartWindowY = windowY.get(0);
                dragStartMouseX = dragStartWindowX + cursorX.get(0);
                dragStartMouseY = dragStartWindowY + cursorY.get(0);
            }
        }
    }

    private final class PetMenuActions implements PetControlActions {
        @Override
        public List<PetModelOption> listModels() {
            return modelLibrary;
        }

        @Override
        public String getActiveModelId() {
            return activeProfileId;
        }

        @Override
        public void switchModel(String profileId) {
            switchModelById(profileId);
        }

        @Override
        public boolean isRandomBehaviorEnabled() {
            return randomBehaviorEnabled;
        }

        @Override
        public void setRandomBehaviorEnabled(boolean enabled) {
            Gdx.app.postRunnable(() -> {
                randomBehaviorEnabled = enabled;
                stopRoaming();
                randomActionElapsedSeconds = 0f;
                randomMoveElapsedSeconds = 0f;
                nextRandomActionAfterSeconds = randomBetween(16f, 30f);
                nextRandomMoveAfterSeconds = randomBetween(35f, 75f);
                System.out.println("[pet-random] enabled=" + enabled);
                if (!enabled) {
                    restTimeRemaining = 0f;
                    playIdleLoop();
                }
            });
        }

        @Override
        public void playInteraction(String action) {
            Gdx.app.postRunnable(() -> SpinePetGdxApp.this.playInteraction(action));
        }

        @Override
        public boolean hasInteraction(String action) {
            return !"special".equals(action) || !specialAnimationName.isBlank();
        }

        @Override
        public void reloadModel() {
            Gdx.app.postRunnable(() -> tryReloadSpine(ProfileConfig.fromProfilesFile(options, activeConfig, activeProfileId)));
        }

        @Override
        public void increaseScale() {
            Gdx.app.postRunnable(() -> tryReloadSpine(activeConfig.withScale(activeConfig.skeletonScale + 0.04f)));
        }

        @Override
        public void decreaseScale() {
            Gdx.app.postRunnable(() -> tryReloadSpine(activeConfig.withScale(Math.max(0.08f, activeConfig.skeletonScale - 0.04f))));
        }

        @Override
        public void raiseModel() {
            Gdx.app.postRunnable(() -> activeConfig = activeConfig.withFloorOffset(activeConfig.floorOffset + 8f));
        }

        @Override
        public void lowerModel() {
            Gdx.app.postRunnable(() -> activeConfig = activeConfig.withFloorOffset(activeConfig.floorOffset - 8f));
        }

        @Override
        public void shutdownDesktopPet() {
            Gdx.app.postRunnable(() -> {
                if (controlWindow != null) {
                    controlWindow.dispose();
                }
                Gdx.app.exit();
            });
        }

        private void switchModelById(String profileId) {
            Gdx.app.postRunnable(() -> {
                if (profileId == null || profileId.isBlank()) {
                    return;
                }
                ProfileConfig nextConfig = ProfileConfig.fromProfilesFile(options, activeConfig, profileId);
                if (nextConfig.equals(activeConfig) && profileId.equals(activeProfileId)) {
                    return;
                }
                tryReloadSpine(nextConfig);
                if (nextConfig.equals(activeConfig)) {
                    activeProfileId = profileId;
                    writeActiveProfileState(profileId);
                    if (controlWindow != null) {
                        controlWindow.updateModelLibrary(modelLibrary, activeProfileId);
                    }
                }
            });
        }
    }

    private void writeActiveProfileState(String profileId) {
        try {
            JsonObject state = new JsonObject();
            state.addProperty("active_profile_id", profileId);
            state.addProperty("animation", "idle");
            state.addProperty("mood", "idle");
            state.addProperty("panel_open", true);
            state.addProperty("manual_mode", false);
            state.addProperty("transparent_mode", true);
            state.addProperty("updated_at", Instant.now().toString());
            Files.createDirectories(options.statePath.getParent());
            Files.writeString(options.statePath, state.toString());
        } catch (IOException failedWrite) {
            System.err.println("Failed to write pet state: " + failedWrite.getMessage());
        }
    }
}

final class SpineOptions {
    final String projectRoot;
    final String profileId;
    final String skeletonUrl;
    final String atlasUrl;
    final String animationName;
    final String panelUrl;
    final String chatUrl;
    final String windowTitle;
    final int width;
    final int height;
    final int boundaryPaddingX;
    final int boundaryPaddingY;
    final float skeletonScale;
    final float stateScale;
    final float xOffset;
    final float floorOffset;
    final Path skeletonPath;
    final Path atlasPath;
    final Path profilesPath;
    final Path statePath;

    private SpineOptions(
            String projectRoot,
            String profileId,
            String skeletonUrl,
            String atlasUrl,
            String animationName,
            String panelUrl,
            String chatUrl,
            String windowTitle,
            int width,
            int height,
            int boundaryPaddingX,
            int boundaryPaddingY,
            float skeletonScale,
            float stateScale,
            float xOffset,
            float floorOffset
    ) {
        this.projectRoot = projectRoot;
        this.profileId = profileId;
        this.skeletonUrl = skeletonUrl;
        this.atlasUrl = atlasUrl;
        this.animationName = animationName;
        this.panelUrl = panelUrl;
        this.chatUrl = chatUrl;
        this.windowTitle = windowTitle;
        this.width = width;
        this.height = height;
        this.boundaryPaddingX = Math.max(0, boundaryPaddingX);
        this.boundaryPaddingY = Math.max(0, boundaryPaddingY);
        this.skeletonScale = skeletonScale;
        this.stateScale = stateScale;
        this.xOffset = xOffset;
        this.floorOffset = floorOffset;
        this.skeletonPath = resolveAssetPath(skeletonUrl);
        this.atlasPath = resolveAssetPath(atlasUrl);
        this.profilesPath = Path.of(projectRoot, "data", "pet", "profiles.json").normalize();
        this.statePath = Path.of(projectRoot, "data", "pet", "state.json").normalize();
    }

    static SpineOptions parse(String[] rawArgs) {
        String cwd = System.getProperty("user.dir");
        String projectRoot = cwd.endsWith("desktop-pet-java")
                ? Path.of(cwd).getParent().toString()
                : cwd;

        String skeletonUrl = "/desktop-pet/assets/truth/default/build/build_char_195_glassb.skel";
        String atlasUrl = "/desktop-pet/assets/truth/default/build/build_char_195_glassb.atlas";
        String profileId = "";
        String animationName = "Relax";
        String panelUrl = "http://127.0.0.1:8000/desktop-pet/?mode=panel";
        String chatUrl = "http://127.0.0.1:8000/desktop-pet/chat.html";
        String windowTitle = "理事所 · 真理";
        int width = 360;
        int height = 520;
        int boundaryPaddingX = 120;
        int boundaryPaddingY = 44;
        float skeletonScale = 0.52f;
        float stateScale = 1.0f;
        float xOffset = 0f;
        float floorOffset = 24f;

        for (String arg : rawArgs) {
            if (arg.startsWith("--project-root=")) {
                projectRoot = arg.substring("--project-root=".length());
            } else if (arg.startsWith("--profile-id=")) {
                profileId = arg.substring("--profile-id=".length());
            } else if (arg.startsWith("--skeleton-url=")) {
                skeletonUrl = arg.substring("--skeleton-url=".length());
            } else if (arg.startsWith("--atlas-url=")) {
                atlasUrl = arg.substring("--atlas-url=".length());
            } else if (arg.startsWith("--animation=")) {
                animationName = arg.substring("--animation=".length());
            } else if (arg.startsWith("--panel-url=")) {
                panelUrl = arg.substring("--panel-url=".length());
            } else if (arg.startsWith("--chat-url=")) {
                chatUrl = arg.substring("--chat-url=".length());
            } else if (arg.startsWith("--title=")) {
                windowTitle = arg.substring("--title=".length());
            } else if (arg.startsWith("--width=")) {
                width = parseIntOrDefault(arg.substring("--width=".length()), width);
            } else if (arg.startsWith("--height=")) {
                height = parseIntOrDefault(arg.substring("--height=".length()), height);
            } else if (arg.startsWith("--boundary-padding-x=")) {
                boundaryPaddingX = parseIntOrDefault(arg.substring("--boundary-padding-x=".length()), boundaryPaddingX);
            } else if (arg.startsWith("--boundary-padding-y=")) {
                boundaryPaddingY = parseIntOrDefault(arg.substring("--boundary-padding-y=".length()), boundaryPaddingY);
            } else if (arg.startsWith("--skeleton-scale=")) {
                skeletonScale = parseFloatOrDefault(arg.substring("--skeleton-scale=".length()), skeletonScale);
            } else if (arg.startsWith("--scale=")) {
                stateScale = parseFloatOrDefault(arg.substring("--scale=".length()), stateScale);
            } else if (arg.startsWith("--x-offset=")) {
                xOffset = parseFloatOrDefault(arg.substring("--x-offset=".length()), xOffset);
            } else if (arg.startsWith("--floor-offset=")) {
                floorOffset = parseFloatOrDefault(arg.substring("--floor-offset=".length()), floorOffset);
            }
        }

        return new SpineOptions(
                projectRoot,
                profileId,
                skeletonUrl,
                atlasUrl,
                animationName,
                panelUrl,
                chatUrl,
                windowTitle,
                width,
                height,
                boundaryPaddingX,
                boundaryPaddingY,
                skeletonScale,
                stateScale,
                xOffset,
                floorOffset
        );
    }

    Path resolveAssetPath(String desktopPetUrl) {
        String relative = desktopPetUrl;
        if (relative.startsWith("/desktop-pet/")) {
            relative = relative.substring("/desktop-pet/".length());
        }
        relative = relative.replace("/", java.io.File.separator);
        return Path.of(projectRoot, "app", "web", "pet", relative).normalize();
    }

    private static int parseIntOrDefault(String raw, int fallback) {
        try {
            return Integer.parseInt(raw);
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    private static float parseFloatOrDefault(String raw, float fallback) {
        try {
            return Float.parseFloat(raw);
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    int renderedWidth() {
        return width + boundaryPaddingX * 2;
    }

    int renderedHeight() {
        return height + boundaryPaddingY * 2;
    }

}

final class ProfileConfig {
    final String skeletonUrl;
    final String atlasUrl;
    final String idleAnimationName;
    final String pokeAnimationName;
    final String moveAnimationName;
    final String sitAnimationName;
    final String sleepAnimationName;
    final String specialAnimationName;
    final List<String> randomAnimationNames;
    final float skeletonScale;
    final float xOffset;
    final float floorOffset;
    final boolean premultipliedAlpha;

    private ProfileConfig(
            String skeletonUrl,
            String atlasUrl,
            String idleAnimationName,
            String pokeAnimationName,
            String moveAnimationName,
            String sitAnimationName,
            String sleepAnimationName,
            String specialAnimationName,
            List<String> randomAnimationNames,
            float skeletonScale,
            float xOffset,
            float floorOffset,
            boolean premultipliedAlpha
    ) {
        this.skeletonUrl = skeletonUrl;
        this.atlasUrl = atlasUrl;
        this.idleAnimationName = idleAnimationName;
        this.pokeAnimationName = pokeAnimationName;
        this.moveAnimationName = moveAnimationName;
        this.sitAnimationName = sitAnimationName;
        this.sleepAnimationName = sleepAnimationName;
        this.specialAnimationName = specialAnimationName;
        this.randomAnimationNames = randomAnimationNames == null ? List.of() : List.copyOf(randomAnimationNames);
        this.skeletonScale = skeletonScale;
        this.xOffset = xOffset;
        this.floorOffset = floorOffset;
        this.premultipliedAlpha = premultipliedAlpha;
    }

    static ProfileConfig fromOptions(SpineOptions options) {
        return new ProfileConfig(
                options.skeletonUrl,
                options.atlasUrl,
                options.animationName,
                options.animationName,
                options.animationName,
                "Sit",
                "Sleep",
                "",
                List.of(options.animationName),
                options.skeletonScale,
                options.xOffset,
                options.floorOffset,
                false
        );
    }

    static ProfileConfig fromProfilesFile(SpineOptions options, ProfileConfig fallback) {
        return fromProfilesFile(options, fallback, options.profileId);
    }

    static ProfileConfig fromProfilesFile(SpineOptions options, ProfileConfig fallback, String profileId) {
        try {
            JsonArray profiles = JsonParser.parseString(Files.readString(options.profilesPath)).getAsJsonArray();
            JsonObject profile = findProfile(profiles, profileId, fallback.skeletonUrl);
            if (profile == null) {
                return fallback;
            }

            JsonObject spine = profile.getAsJsonObject("spine");
            String skeletonUrl = getString(spine, "skeleton_url", fallback.skeletonUrl);
            String atlasUrl = getString(spine, "atlas_url", fallback.atlasUrl);
            String defaultAnimationKey = getString(profile, "default_animation", "idle");
            JsonObject animationMap = spine.has("animation_map") && spine.get("animation_map").isJsonObject()
                    ? spine.getAsJsonObject("animation_map")
                    : null;

            String idleAnimationName = resolveAnimation(animationMap, defaultAnimationKey, fallback.idleAnimationName);
            String pokeAnimationName = resolveAnimation(
                    animationMap,
                    "poke",
                    resolveAnimation(animationMap, "wave", fallback.pokeAnimationName)
            );
            String moveAnimationName = resolveAnimation(animationMap, "move", fallback.moveAnimationName);
            String sitAnimationName = resolveAnimation(animationMap, "sit", fallback.sitAnimationName);
            String sleepAnimationName = resolveAnimation(animationMap, "sleep", fallback.sleepAnimationName);
            String specialAnimationName = resolveAnimation(animationMap, "special", fallback.specialAnimationName);
            List<String> randomAnimationNames = resolveRandomAnimations(animationMap, fallback);

            return new ProfileConfig(
                    skeletonUrl,
                    atlasUrl,
                    idleAnimationName,
                    pokeAnimationName,
                    moveAnimationName,
                    sitAnimationName,
                    sleepAnimationName,
                    specialAnimationName,
                    randomAnimationNames,
                    getFloat(spine, "skeleton_scale", fallback.skeletonScale),
                    getFloat(spine, "x_offset", fallback.xOffset),
                    getFloat(spine, "floor_offset", fallback.floorOffset),
                    getBoolean(spine, "premultiplied_alpha", fallback.premultipliedAlpha)
            );
        } catch (RuntimeException | IOException ignored) {
            return fallback;
        }
    }

    ProfileConfig withScale(float scale) {
        return new ProfileConfig(
                skeletonUrl,
                atlasUrl,
                idleAnimationName,
                pokeAnimationName,
                moveAnimationName,
                sitAnimationName,
                sleepAnimationName,
                specialAnimationName,
                randomAnimationNames,
                scale,
                xOffset,
                floorOffset,
                premultipliedAlpha
        );
    }

    ProfileConfig withFloorOffset(float offset) {
        return new ProfileConfig(
                skeletonUrl,
                atlasUrl,
                idleAnimationName,
                pokeAnimationName,
                moveAnimationName,
                sitAnimationName,
                sleepAnimationName,
                specialAnimationName,
                randomAnimationNames,
                skeletonScale,
                xOffset,
                offset,
                premultipliedAlpha
        );
    }

    private static JsonObject findProfile(JsonArray profiles, String profileId, String skeletonUrl) {
        JsonObject skeletonMatch = null;
        for (JsonElement element : profiles) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject profile = element.getAsJsonObject();
            if (!profile.has("spine") || !profile.get("spine").isJsonObject()) {
                continue;
            }
            if (profileId != null && !profileId.isEmpty() && profileId.equals(getString(profile, "id", ""))) {
                return profile;
            }
            JsonObject spine = profile.getAsJsonObject("spine");
            if (skeletonUrl.equals(getString(spine, "skeleton_url", ""))) {
                skeletonMatch = profile;
            }
        }
        return skeletonMatch;
    }

    private static String resolveAnimation(JsonObject animationMap, String key, String fallback) {
        if (animationMap == null || key == null || key.isBlank()) {
            return fallback;
        }
        return getString(animationMap, key, fallback);
    }

    private static List<String> resolveRandomAnimations(JsonObject animationMap, ProfileConfig fallback) {
        if (animationMap == null) {
            return fallback.randomAnimationNames;
        }
        Set<String> names = new LinkedHashSet<>();
        addIfPresent(names, resolveAnimation(animationMap, "wave", ""));
        addIfPresent(names, resolveAnimation(animationMap, "poke", ""));
        addIfPresent(names, resolveAnimation(animationMap, "special", ""));
        addIfPresent(names, resolveAnimation(animationMap, "sit", ""));
        addIfPresent(names, resolveAnimation(animationMap, "sleep", ""));
        if (names.isEmpty()) {
            return fallback.randomAnimationNames;
        }
        return List.copyOf(names);
    }

    private static void addIfPresent(Set<String> target, String value) {
        if (value != null && !value.isBlank()) {
            target.add(value);
        }
    }

    private static String getString(JsonObject object, String key, String fallback) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return fallback;
        }
        return object.get(key).getAsString();
    }

    private static float getFloat(JsonObject object, String key, float fallback) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return fallback;
        }
        return object.get(key).getAsFloat();
    }

    private static boolean getBoolean(JsonObject object, String key, boolean fallback) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return fallback;
        }
        return object.get(key).getAsBoolean();
    }

    @Override
    public boolean equals(Object other) {
        if (!(other instanceof ProfileConfig config)) {
            return false;
        }
        return Objects.equals(skeletonUrl, config.skeletonUrl)
                && Objects.equals(atlasUrl, config.atlasUrl)
                && Objects.equals(idleAnimationName, config.idleAnimationName)
                && Objects.equals(pokeAnimationName, config.pokeAnimationName)
                && Objects.equals(moveAnimationName, config.moveAnimationName)
                && Objects.equals(sitAnimationName, config.sitAnimationName)
                && Objects.equals(sleepAnimationName, config.sleepAnimationName)
                && Objects.equals(specialAnimationName, config.specialAnimationName)
                && Objects.equals(randomAnimationNames, config.randomAnimationNames)
                && Float.compare(skeletonScale, config.skeletonScale) == 0
                && Float.compare(xOffset, config.xOffset) == 0
                && Float.compare(floorOffset, config.floorOffset) == 0
                && premultipliedAlpha == config.premultipliedAlpha;
    }

    @Override
    public int hashCode() {
        return Objects.hash(
                skeletonUrl,
                atlasUrl,
                idleAnimationName,
                pokeAnimationName,
                moveAnimationName,
                sitAnimationName,
                sleepAnimationName,
                specialAnimationName,
                randomAnimationNames,
                skeletonScale,
                xOffset,
                floorOffset,
                premultipliedAlpha
        );
    }
}
