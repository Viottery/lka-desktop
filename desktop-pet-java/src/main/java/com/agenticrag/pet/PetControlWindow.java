package com.agenticrag.pet;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import javafx.application.Platform;
import javafx.concurrent.Worker;
import javafx.geometry.Rectangle2D;
import javafx.scene.Scene;
import javafx.scene.control.Button;
import javafx.scene.control.CheckMenuItem;
import javafx.scene.control.ComboBox;
import javafx.scene.control.CustomMenuItem;
import javafx.scene.control.Label;
import javafx.scene.control.MenuButton;
import javafx.scene.control.MenuItem;
import javafx.scene.control.SeparatorMenuItem;
import javafx.scene.control.TextArea;
import javafx.scene.input.InputMethodEvent;
import javafx.scene.layout.BorderPane;
import javafx.scene.layout.HBox;
import javafx.scene.layout.Priority;
import javafx.scene.layout.StackPane;
import javafx.scene.layout.VBox;
import javafx.scene.input.KeyCode;
import javafx.scene.input.KeyEvent;
import javafx.scene.paint.Color;
import javafx.scene.web.WebView;
import javafx.stage.Screen;
import javafx.stage.Stage;
import javafx.stage.StageStyle;
import netscape.javascript.JSObject;

import java.io.IOException;
import java.awt.Desktop;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import java.util.function.BiFunction;

final class PetControlWindow {
    private static final int WIDTH = 430;
    private static final int HEIGHT = 680;
    private static final AtomicBoolean FX_STARTED = new AtomicBoolean(false);

    private final PetControlActions actions;
    private final String chatUrl;
    private final String backendBaseUrl;
    private final Path projectRoot;
    private final HttpClient httpClient;
    private final AtomicBoolean visible = new AtomicBoolean(false);
    private final AtomicBoolean backendStartInProgress = new AtomicBoolean(false);
    private final AtomicBoolean shutdownInProgress = new AtomicBoolean(false);
    private Stage stage;
    private WebView webView;
    private PetChatBridge chatBridge;
    private TextArea nativeInput;
    private Button nativeSendButton;
    private boolean nativeImeComposing;
    private MenuButton settingsMenuButton;
    private ComboBox<PetModelOption> modelCombo;
    private CheckMenuItem randomBehaviorItem;
    private MenuItem specialInteractionItem;
    private List<PetModelOption> modelLibrary;
    private boolean syncingModelSelection;
    private boolean syncingRandomToggle;
    private double relativeX = 300;
    private double relativeY = 32;
    private double dragStartMouseX;
    private double dragStartMouseY;
    private double dragStartRelativeX;
    private double dragStartRelativeY;
    private int lastPetX;
    private int lastPetY;
    private boolean initialPositionInitialized;

    PetControlWindow(PetControlActions actions, String chatUrl, String projectRoot, List<PetModelOption> initialModelLibrary) {
        this.actions = actions;
        this.chatUrl = chatUrl;
        this.modelLibrary = new ArrayList<>(initialModelLibrary == null ? List.of() : initialModelLibrary);
        this.backendBaseUrl = resolveBackendBaseUrl(chatUrl);
        this.projectRoot = Path.of(projectRoot == null || projectRoot.isBlank() ? "." : projectRoot).normalize();
        this.httpClient = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
        startJavaFxToolkit();
    }

    void toggle(int petX, int petY) {
        Platform.runLater(() -> {
            ensureStage();
            if (stage.isShowing()) {
                syncToPetNow(petX, petY);
                stage.hide();
            } else {
                refreshSettingsState();
                if (!initialPositionInitialized) {
                    ensureInitialPositionNearPet(petX, petY);
                    stage.setX(petX + relativeX);
                    stage.setY(petY + relativeY);
                    lastPetX = petX;
                    lastPetY = petY;
                } else {
                    syncToPetNow(petX, petY);
                }
                stage.show();
                stage.toFront();
                if (webView != null) {
                    try {
                        webView.getEngine().executeScript(
                                "window.__petChatOpenFreshTask && window.__petChatOpenFreshTask()");
                    } catch (RuntimeException error) {
                        System.err.println("[pet-chat] fresh task open failed: " + error.getMessage());
                    }
                }
                focusChatInput();
            }
        });
    }

    void syncToPet(int petX, int petY) {
        Platform.runLater(() -> {
            if (stage == null) {
                return;
            }
            syncToPetNow(petX, petY);
        });
    }

    void updateModelLibrary(List<PetModelOption> latestLibrary, String activeProfileId) {
        Platform.runLater(() -> {
            if (latestLibrary != null && !latestLibrary.isEmpty()) {
                modelLibrary = new ArrayList<>(latestLibrary);
            }
            refreshModelSelection(activeProfileId);
        });
    }

    boolean isShowing() {
        return visible.get();
    }

    void dispose() {
        Platform.runLater(() -> {
            if (stage != null) {
                stage.close();
                stage = null;
                webView = null;
                nativeInput = null;
                nativeSendButton = null;
            }
            visible.set(false);
        });
    }

    private static void startJavaFxToolkit() {
        if (!FX_STARTED.compareAndSet(false, true)) {
            return;
        }
        try {
            Platform.startup(() -> Platform.setImplicitExit(false));
        } catch (IllegalStateException alreadyStarted) {
            Platform.setImplicitExit(false);
        }
    }

    private void ensureStage() {
        if (stage != null) {
            return;
        }

        stage = new Stage(StageStyle.TRANSPARENT);
        stage.setAlwaysOnTop(true);
        stage.setTitle("理事所 · 快速任务");
        stage.setWidth(WIDTH);
        stage.setHeight(HEIGHT);
        stage.setMinWidth(380);
        stage.setMinHeight(560);
        stage.setOnShown(event -> visible.set(true));
        stage.setOnHidden(event -> visible.set(false));

        Scene scene = new Scene(buildContent(), WIDTH, HEIGHT);
        scene.setFill(Color.TRANSPARENT);
        scene.getStylesheets().add(Objects.requireNonNull(
                getClass().getResource("/pet-control.css")).toExternalForm());
        stage.setScene(scene);
    }

    private BorderPane buildContent() {
        BorderPane root = new BorderPane();
        root.setStyle("""
                -fx-background-color: #f5f8f8;
                -fx-background-radius: 17;
                -fx-border-color: #cbdfe0;
                -fx-border-radius: 17;
                -fx-border-width: 1;
                -fx-padding: 10;
                """);

        root.setTop(buildHeader());
        root.setCenter(buildWebView());
        root.setBottom(buildTools());
        return root;
    }

    private HBox buildHeader() {
        VBox titleBlock = new VBox(1);
        titleBlock.setPickOnBounds(true);
        titleBlock.setOnMousePressed(this::startDrag);
        titleBlock.setOnMouseDragged(this::dragPanel);

        Label title = new Label("理事所 · 快速任务");
        title.setStyle("-fx-text-fill: #19313a; -fx-font-family: 'Microsoft YaHei UI'; -fx-font-size: 15; -fx-font-weight: bold;");
        titleBlock.getChildren().add(title);

        HBox buttons = new HBox(6, smallButton("工作台", this::openWorkbench), smallButton("刷新", this::reloadChat), smallButton("收起", () -> stage.hide()));
        HBox header = new HBox(8, titleBlock, buttons);
        header.setStyle("-fx-padding: 0 2 8 2;");
        header.setOnMousePressed(this::startDrag);
        header.setOnMouseDragged(this::dragPanel);
        HBox.setHgrow(titleBlock, Priority.ALWAYS);
        return header;
    }

    private StackPane buildWebView() {
        webView = new WebView();
        webView.setContextMenuEnabled(false);
        webView.addEventFilter(KeyEvent.KEY_PRESSED, event -> {
            if (event.getCode() == KeyCode.ENTER && !event.isShiftDown()
                    && !event.isControlDown() && !event.isAltDown() && !event.isMetaDown()
                    && isChatPageLocation(webView.getEngine().getLocation())) {
                try {
                    Object inComposer = webView.getEngine().executeScript(
                            "document.activeElement && document.activeElement.id === 'questionInput'");
                    if (Boolean.TRUE.equals(inComposer)) {
                        webView.getEngine().executeScript(
                                "window.__petChatSubmitCurrentInput && window.__petChatSubmitCurrentInput()");
                        event.consume();
                    }
                } catch (RuntimeException error) {
                    System.err.println("[pet-chat] Enter submit failed: " + error.getMessage());
                }
            }
        });
        webView.getEngine().getLoadWorker().stateProperty().addListener((observable, oldState, newState) -> {
            if (newState == Worker.State.SUCCEEDED) {
                installChatBridge();
                if (isChatPageLocation(webView.getEngine().getLocation())) {
                    focusChatInput();
                }
                return;
            }
            if (newState == Worker.State.FAILED) {
                showChatUnavailableFallback(webView.getEngine().getLoadWorker().getException());
            }
        });
        loadChatPage();

        StackPane holder = new StackPane(webView);
        holder.setStyle("""
                -fx-border-color: #cbdfe0;
                -fx-border-width: 1;
                -fx-background-color: rgba(255,255,255,0.03);
                """);
        return holder;
    }

    private VBox buildTools() {
        nativeInput = new TextArea();
        nativeInput.setPromptText("告诉真理你想完成什么…");
        nativeInput.setWrapText(true);
        nativeInput.setPrefRowCount(2);
        nativeInput.getStyleClass().add("pet-native-input");
        nativeInput.textProperty().addListener((observable, oldText, newText) -> {
            if (webView == null || !isChatPageLocation(webView.getEngine().getLocation())) return;
            try {
                webView.getEngine().executeScript("window.__petChatNativeDraftChanged && "
                        + "window.__petChatNativeDraftChanged(" + jsonString(newText) + ")");
            } catch (RuntimeException error) {
                System.err.println("[pet-chat] native draft sync failed: " + error.getMessage());
            }
        });
        nativeInput.addEventFilter(InputMethodEvent.INPUT_METHOD_TEXT_CHANGED,
                event -> nativeImeComposing = !event.getComposed().isEmpty());
        nativeInput.addEventFilter(KeyEvent.KEY_PRESSED, event -> {
            if (event.getCode() == KeyCode.ENTER && !event.isShiftDown()
                    && !event.isControlDown() && !event.isAltDown() && !event.isMetaDown()
                    && !nativeImeComposing) {
                event.consume();
                submitNativeInput();
            }
        });
        nativeSendButton = new Button("发送 ↗");
        nativeSendButton.getStyleClass().add("pet-native-send");
        nativeSendButton.setDisable(true);
        nativeSendButton.setOnAction(event -> submitNativeInput());
        HBox composer = new HBox(8, nativeInput, nativeSendButton);
        composer.getStyleClass().add("pet-native-composer");
        HBox.setHgrow(nativeInput, Priority.ALWAYS);

        settingsMenuButton = buildSettingsMenu();
        HBox row = new HBox(settingsMenuButton);
        HBox.setHgrow(settingsMenuButton, Priority.ALWAYS);
        row.setStyle("-fx-padding: 8 0 0 0;");
        return new VBox(7, composer, row);
    }

    private void submitNativeInput() {
        if (nativeInput == null || nativeSendButton == null || nativeSendButton.isDisabled()
                || webView == null) return;
        String text = nativeInput.getText();
        if (text == null || text.isBlank()) return;
        try {
            Object accepted = webView.getEngine().executeScript(
                    "window.__petChatSubmitText && window.__petChatSubmitText(" + jsonString(text) + ")");
            if (Boolean.TRUE.equals(accepted)) nativeInput.clear();
        } catch (RuntimeException error) {
            System.err.println("[pet-chat] native input submit failed: " + error.getMessage());
        }
        nativeInput.requestFocus();
    }

    private void setNativeComposerBusy(boolean busy) {
        Platform.runLater(() -> {
            if (nativeSendButton != null) nativeSendButton.setDisable(busy);
        });
    }

    private void setNativeComposerDraft(String draft) {
        Platform.runLater(() -> {
            if (nativeInput == null) return;
            nativeInput.setText(draft == null ? "" : draft);
            nativeInput.positionCaret(nativeInput.getLength());
            nativeInput.requestFocus();
        });
    }

    private void focusNativeComposer() {
        Platform.runLater(() -> {
            if (stage != null && stage.isShowing() && nativeInput != null) nativeInput.requestFocus();
        });
    }

    private MenuButton buildSettingsMenu() {
        MenuButton menuButton = new MenuButton("桌宠设置 · 形态与行为");
        menuButton.getStyleClass().add("pet-settings-button");
        styleMenuButton(menuButton);

        Label libraryLabel = new Label("当前形态");
        libraryLabel.setStyle("-fx-text-fill: #19313a; -fx-font-size: 11; -fx-font-weight: bold;");

        modelCombo = new ComboBox<>();
        modelCombo.getStyleClass().add("pet-model-combo");
        modelCombo.setMaxWidth(Double.MAX_VALUE);
        modelCombo.setPrefWidth(250);
        modelCombo.valueProperty().addListener((observable, oldValue, newValue) -> {
            if (syncingModelSelection || newValue == null || oldValue == newValue) {
                return;
            }
            actions.switchModel(newValue.id());
        });

        VBox modelBox = new VBox(6, libraryLabel, modelCombo);
        modelBox.setStyle("-fx-padding: 4 6 4 6;");
        CustomMenuItem modelItem = new CustomMenuItem(modelBox, false);

        randomBehaviorItem = new CheckMenuItem("自动动作与移动");
        randomBehaviorItem.selectedProperty().addListener((observable, oldValue, newValue) -> {
            if (syncingRandomToggle) {
                return;
            }
            actions.setRandomBehaviorEnabled(newValue);
        });

        MenuItem greetItem = new MenuItem("打招呼");
        greetItem.setOnAction(event -> actions.playInteraction("greet"));
        specialInteractionItem = new MenuItem("礼仪舞步");
        specialInteractionItem.setOnAction(event -> actions.playInteraction("special"));
        MenuItem sitItem = new MenuItem("坐一会儿");
        sitItem.setOnAction(event -> actions.playInteraction("sit"));
        MenuItem sleepItem = new MenuItem("休息一下");
        sleepItem.setOnAction(event -> actions.playInteraction("sleep"));
        MenuItem wakeItem = new MenuItem("恢复站立");
        wakeItem.setOnAction(event -> actions.playInteraction("wake"));

        MenuItem reloadItem = new MenuItem("重新加载当前形态");
        reloadItem.setOnAction(event -> actions.reloadModel());
        MenuItem scalePlusItem = new MenuItem("放大形态");
        scalePlusItem.setOnAction(event -> actions.increaseScale());
        MenuItem scaleMinusItem = new MenuItem("缩小形态");
        scaleMinusItem.setOnAction(event -> actions.decreaseScale());
        MenuItem raiseItem = new MenuItem("形态上移");
        raiseItem.setOnAction(event -> actions.raiseModel());
        MenuItem lowerItem = new MenuItem("形态下移");
        lowerItem.setOnAction(event -> actions.lowerModel());
        MenuItem shutdownAllItem = new MenuItem("退出桌宠与后端");
        shutdownAllItem.getStyleClass().add("danger-menu-item");
        shutdownAllItem.setOnAction(event -> shutdownDesktopAndBackend());

        menuButton.getItems().addAll(
                modelItem,
                new SeparatorMenuItem(),
                randomBehaviorItem,
                new SeparatorMenuItem(),
                greetItem,
                specialInteractionItem,
                sitItem,
                sleepItem,
                wakeItem,
                new SeparatorMenuItem(),
                reloadItem,
                scalePlusItem,
                scaleMinusItem,
                raiseItem,
                lowerItem,
                new SeparatorMenuItem(),
                shutdownAllItem
        );
        menuButton.setOnShowing(event -> refreshSettingsState());

        refreshSettingsState();
        return menuButton;
    }

    private void styleMenuButton(MenuButton button) {
        button.setMaxWidth(Double.MAX_VALUE);
        button.setFocusTraversable(false);
    }

    private Button smallButton(String text, Runnable action) {
        Button button = new Button(text);
        button.setPrefWidth(74);
        button.setFocusTraversable(false);
        button.setStyle("""
                -fx-background-color: #e9f4f3;
                -fx-border-color: #bdd5d5;
                -fx-border-width: 1;
                -fx-border-radius: 7;
                -fx-background-radius: 7;
                -fx-text-fill: #195e64;
                -fx-font-size: 11;
                -fx-padding: 6 5 6 5;
                """);
        button.setOnAction(event -> action.run());
        return button;
    }

    private void refreshSettingsState() {
        List<PetModelOption> latestModels = actions.listModels();
        if (latestModels != null && !latestModels.isEmpty()) {
            modelLibrary = new ArrayList<>(latestModels);
        }
        refreshModelSelection(actions.getActiveModelId());
        if (randomBehaviorItem != null) {
            syncingRandomToggle = true;
            randomBehaviorItem.setSelected(actions.isRandomBehaviorEnabled());
            syncingRandomToggle = false;
        }
        if (specialInteractionItem != null) {
            specialInteractionItem.setDisable(!actions.hasInteraction("special"));
        }
    }

    private void refreshModelSelection(String activeProfileId) {
        if (modelCombo == null) {
            return;
        }
        syncingModelSelection = true;
        modelCombo.getItems().setAll(modelLibrary);
        PetModelOption selected = findModelById(activeProfileId);
        if (selected == null && !modelLibrary.isEmpty()) {
            selected = modelLibrary.get(0);
        }
        modelCombo.getSelectionModel().select(selected);
        syncingModelSelection = false;
    }

    private PetModelOption findModelById(String profileId) {
        if (profileId == null || profileId.isBlank()) {
            return null;
        }
        for (PetModelOption option : modelLibrary) {
            if (profileId.equals(option.id())) {
                return option;
            }
        }
        return null;
    }

    private void openExternalUrl(String rawUrl) {
        try {
            URI uri = URI.create(rawUrl == null ? "" : rawUrl);
            String scheme = uri.getScheme();
            if (scheme == null || !(scheme.equalsIgnoreCase("https")
                    || scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("mailto"))) return;
            Desktop.getDesktop().browse(uri);
        } catch (Exception error) {
            System.err.println("[pet-chat] cannot open Markdown link: " + error.getMessage());
        }
    }

    private void openWorkbench() {
        openWorkbenchSession("", "");
    }

    private void openWorkbenchSession(String sessionId, String runId) {
        try {
            String page = chatUrl.split("\\?", 2)[0] + "?mode=work&backend="
                    + URLEncoder.encode(backendBaseUrl, StandardCharsets.UTF_8);
            if (sessionId != null && !sessionId.isBlank()) {
                page += "&session_id=" + URLEncoder.encode(sessionId, StandardCharsets.UTF_8);
            }
            if (runId != null && !runId.isBlank()) {
                page += "&run_id=" + URLEncoder.encode(runId, StandardCharsets.UTF_8);
            }
            Desktop.getDesktop().browse(URI.create(page));
        } catch (Exception error) {
            System.err.println("[pet-chat] cannot open workbench: " + error.getMessage());
        }
    }

    private void reloadChat() {
        if (webView == null) {
            return;
        }
        loadChatPage();
        focusChatInput();
    }

    private void focusChatInput() {
        if (stage == null || !stage.isShowing() || webView == null) {
            return;
        }
        stage.toFront();
        if (nativeInput != null) {
            nativeInput.requestFocus();
        } else {
            webView.requestFocus();
        }
    }

    private void installChatBridge() {
        if (webView == null) {
            return;
        }
        try {
            if (chatBridge == null) {
                chatBridge = new PetChatBridge(
                        this::handleBridgePayload,
                        this::handleBridgeStreamPayload,
                        this::decideSafetyReview,
                        this::setSessionWorkspace,
                        this::createSessionWorkspace,
                        this::saveUiDefaults,
                        this::createSession,
                        this::deleteSession,
                        this::restoreSession,
                        this::renameSession,
                        this::openWorkbenchSession,
                        this::startBackendService,
                        this::shutdownDesktopAndBackendFromBridge,
                        this::setNativeComposerBusy,
                        this::setNativeComposerDraft,
                        this::focusNativeComposer,
                        this::openExternalUrl
                );
                chatBridge.setMemoryRequestHandler(this::handleMemoryRequest);
                chatBridge.setQQReaderStatusRequestHandler(this::handleQQReaderStatusRequest);
            }
            JSObject window = (JSObject) webView.getEngine().executeScript("window");
            window.setMember("petBridge", chatBridge);
            webView.getEngine().executeScript("window.__petChatBridgeReady && window.__petChatBridgeReady();");
            Object markdownReady = webView.getEngine().executeScript(
                    "Boolean(window.PetMarkdown && window.PetMarkdown.available)");
            System.out.println("[pet-chat] bridge installed; markdown renderer ready=" + markdownReady);
        } catch (RuntimeException error) {
            System.err.println("[pet-chat] bridge install failed: " + error.getMessage());
        }
    }

    private void syncToPetNow(int petX, int petY) {
        int deltaX = petX - lastPetX;
        int deltaY = petY - lastPetY;
        if (deltaX != 0 || deltaY != 0) {
            double centerX = stage.getX() + stage.getWidth() / 2.0;
            double centerY = stage.getY() + stage.getHeight() / 2.0;
            List<Screen> screens = Screen.getScreensForRectangle(centerX, centerY, 1, 1);
            Screen screen = screens.isEmpty() ? Screen.getPrimary() : screens.get(0);
            double scaleX = screen.getOutputScaleX() > 0 ? screen.getOutputScaleX() : 1.0;
            double scaleY = screen.getOutputScaleY() > 0 ? screen.getOutputScaleY() : 1.0;
            stage.setX(stage.getX() + deltaX / scaleX);
            stage.setY(stage.getY() + deltaY / scaleY);
            relativeX = stage.getX() - petX;
            relativeY = stage.getY() - petY;
        }
        lastPetX = petX;
        lastPetY = petY;
    }

    private void startDrag(javafx.scene.input.MouseEvent event) {
        dragStartMouseX = event.getScreenX();
        dragStartMouseY = event.getScreenY();
        dragStartRelativeX = relativeX;
        dragStartRelativeY = relativeY;
    }

    private void dragPanel(javafx.scene.input.MouseEvent event) {
        relativeX = dragStartRelativeX + event.getScreenX() - dragStartMouseX;
        relativeY = dragStartRelativeY + event.getScreenY() - dragStartMouseY;
        initialPositionInitialized = true;
        stage.setX(lastPetX + relativeX);
        stage.setY(lastPetY + relativeY);
    }

    private void ensureInitialPositionNearPet(int petX, int petY) {
        if (initialPositionInitialized) {
            return;
        }
        List<Screen> hitScreens = Screen.getScreensForRectangle(petX, petY, 1, 1);
        Screen targetScreen = hitScreens.isEmpty() ? Screen.getPrimary() : hitScreens.get(0);
        Rectangle2D bounds = targetScreen.getVisualBounds();
        double margin = 12.0;

        double targetX = petX + 24.0;
        double targetY = petY + 24.0;
        if (targetX + WIDTH > bounds.getMaxX() - margin) {
            targetX = petX - WIDTH + 84.0;
        }
        if (targetX < bounds.getMinX() + margin) {
            targetX = bounds.getMinX() + margin;
        }
        if (targetY + HEIGHT > bounds.getMaxY() - margin) {
            targetY = bounds.getMaxY() - HEIGHT - margin;
        }
        if (targetY < bounds.getMinY() + margin) {
            targetY = bounds.getMinY() + margin;
        }

        relativeX = (int) Math.round(targetX - petX);
        relativeY = (int) Math.round(targetY - petY);
        initialPositionInitialized = true;
        System.out.println("[pet-chat] initial panel position relativeX=" + relativeX + " relativeY=" + relativeY);
    }

    private String resolveBackendBaseUrl(String rawUrl) {
        try {
            URI uri = URI.create(rawUrl);
            String configuredBackend = queryParam(uri, "backend");
            if (!configuredBackend.isBlank()) {
                return configuredBackend.replaceAll("/+$", "");
            }
            int port = uri.getPort();
            String authority = port >= 0 ? uri.getHost() + ":" + port : uri.getHost();
            return uri.getScheme() + "://" + authority;
        } catch (RuntimeException ignored) {
            return "http://127.0.0.1:8000";
        }
    }

    private String queryParam(URI uri, String key) {
        String query = uri.getRawQuery();
        if (query == null || query.isBlank()) {
            return "";
        }
        for (String pair : query.split("&")) {
            int equalsAt = pair.indexOf('=');
            String rawKey = equalsAt >= 0 ? pair.substring(0, equalsAt) : pair;
            String rawValue = equalsAt >= 0 ? pair.substring(equalsAt + 1) : "";
            try {
                String decodedKey = URLDecoder.decode(rawKey, StandardCharsets.UTF_8);
                if (key.equals(decodedKey)) {
                    return URLDecoder.decode(rawValue, StandardCharsets.UTF_8).trim();
                }
            } catch (RuntimeException ignored) {
            }
        }
        return "";
    }

    private String cacheBustedUrl(String rawUrl) {
        String separator = rawUrl.contains("?") ? "&" : "?";
        return rawUrl + separator + "desktopTs=" + System.currentTimeMillis();
    }

    private void loadChatPage() {
        if (webView == null) {
            return;
        }
        String targetUrl = cacheBustedUrl(chatUrl);
        System.out.println("[pet-chat] loading chat page url=" + targetUrl);
        webView.getEngine().load(targetUrl);
    }

    private boolean isChatPageLocation(String location) {
        if (location == null || location.isBlank()) {
            return false;
        }
        return location.contains("/desktop-pet/chat.html");
    }

    private void showChatUnavailableFallback(Throwable error) {
        if (webView == null) {
            return;
        }
        String reason = error == null
                ? "Unknown load error"
                : error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage());
        System.err.println("[pet-chat] chat page load failed: " + compact(reason, 260));
        String retryUrl = cacheBustedUrl(chatUrl);
        String fallbackHtml = buildChatUnavailableHtml(compact(reason, 180), retryUrl);
        webView.getEngine().loadContent(fallbackHtml, "text/html");
    }

    private String buildChatUnavailableHtml(String reason, String retryUrl) {
        String safeBaseUrl = htmlEscape(backendBaseUrl);
        String safeReason = htmlEscape(reason == null || reason.isBlank() ? "No extra details." : reason);
        String retryJsLiteral = jsonString(retryUrl);
        String template = """
                <!doctype html>
                <html lang="en">
                <head>
                  <meta charset="utf-8">
                  <meta name="viewport" content="width=device-width, initial-scale=1">
                  <title>Chat unavailable</title>
                  <style>
                    html, body {
                      margin: 0;
                      height: 100%;
                      font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
                      color: #ecf6f4;
                      background: linear-gradient(145deg, #0d1b1d, #142c2f 58%, #102528);
                    }
                    body {
                      display: flex;
                      align-items: center;
                      justify-content: center;
                      padding: 18px;
                      box-sizing: border-box;
                    }
                    .card {
                      width: 100%;
                      max-width: 330px;
                      border-radius: 14px;
                      border: 1px solid rgba(152, 210, 205, 0.35);
                      background: rgba(9, 24, 27, 0.8);
                      padding: 16px 14px;
                      box-sizing: border-box;
                    }
                    h2 {
                      margin: 0 0 8px 0;
                      font-size: 17px;
                    }
                    p {
                      margin: 0 0 8px 0;
                      line-height: 1.45;
                      font-size: 13px;
                    }
                    .muted {
                      color: #b2c2c3;
                      font-size: 12px;
                    }
                    .error {
                      color: #ffd7d2;
                    }
                    .actions {
                      display: flex;
                      align-items: center;
                      gap: 10px;
                      margin-top: 12px;
                    }
                    button {
                      border: 1px solid rgba(202, 231, 226, 0.36);
                      border-radius: 10px;
                      padding: 7px 11px;
                      background: linear-gradient(145deg, #47757c, #2c5559);
                      color: #f5fffc;
                      cursor: pointer;
                    }
                  </style>
                </head>
                <body>
                  <main class="card">
                    <h2>Chat service is unavailable</h2>
                    <p class="muted">Cannot reach backend: <code>__BASE_URL__</code></p>
                    <p class="error">Last error: __ERROR_REASON__</p>
                    <p class="muted" id="statusHint">You can start backend service from here.</p>
                    <div class="actions">
                      <button type="button" onclick="startBackend()">Start backend</button>
                      <button type="button" onclick="retryNow()">Retry now</button>
                      <span class="muted" id="retryHint">Auto retry in 3s...</span>
                    </div>
                  </main>
                  <script>
                    const targetUrl = __RETRY_URL__;
                    let retrySeconds = 3;
                    function retryNow() {
                      window.location = targetUrl;
                    }
                    function updateStatus(message, isError) {
                      const hint = document.getElementById("statusHint");
                      if (!hint) {
                        return;
                      }
                      hint.textContent = message;
                      hint.className = isError ? "error" : "muted";
                    }
                    function parseResult(raw) {
                      if (raw && typeof raw === "object") {
                        return raw;
                      }
                      if (typeof raw !== "string") {
                        return {};
                      }
                      try {
                        return JSON.parse(raw);
                      } catch (ignored) {
                        return { ok: false, message: raw };
                      }
                    }
                    function startBackend() {
                      if (!window.petBridge || typeof window.petBridge.startBackendService !== "function") {
                        updateStatus("Desktop bridge is unavailable.", true);
                        return;
                      }
                      updateStatus("Starting backend service...", false);
                      let result = {};
                      try {
                        result = parseResult(window.petBridge.startBackendService());
                      } catch (error) {
                        updateStatus("Failed to start backend: " + String(error), true);
                        return;
                      }
                      if (result.ok === false) {
                        updateStatus(result.message || "Failed to start backend.", true);
                        return;
                      }
                      updateStatus(result.message || "Backend start command sent.", false);
                      retrySeconds = 2;
                    }
                    setInterval(function () {
                      retrySeconds -= 1;
                      if (retrySeconds <= 0) {
                        retryNow();
                        return;
                      }
                      const hint = document.getElementById("retryHint");
                      if (hint) {
                        hint.textContent = "Auto retry in " + retrySeconds + "s...";
                      }
                    }, 1000);
                  </script>
                </body>
                </html>
                """;
        return template
                .replace("__BASE_URL__", safeBaseUrl)
                .replace("__ERROR_REASON__", safeReason)
                .replace("__RETRY_URL__", retryJsLiteral);
    }

    private String htmlEscape(String raw) {
        if (raw == null) {
            return "";
        }
        StringBuilder escaped = new StringBuilder(raw.length() + 16);
        for (int i = 0; i < raw.length(); i++) {
            char ch = raw.charAt(i);
            switch (ch) {
                case '&' -> escaped.append("&amp;");
                case '<' -> escaped.append("&lt;");
                case '>' -> escaped.append("&gt;");
                case '"' -> escaped.append("&quot;");
                case '\'' -> escaped.append("&#39;");
                default -> escaped.append(ch);
            }
        }
        return escaped.toString();
    }

    private String jsonString(String raw) {
        if (raw == null) {
            return "\"\"";
        }
        StringBuilder builder = new StringBuilder("\"");
        for (int i = 0; i < raw.length(); i++) {
            char ch = raw.charAt(i);
            switch (ch) {
                case '\\' -> builder.append("\\\\");
                case '"' -> builder.append("\\\"");
                case '\n' -> builder.append("\\n");
                case '\r' -> builder.append("\\r");
                case '\t' -> builder.append("\\t");
                default -> {
                    if (ch < 0x20) {
                        builder.append(String.format("\\u%04x", (int) ch));
                    } else {
                        builder.append(ch);
                    }
                }
            }
        }
        return builder.append('"').toString();
    }

    private String jsonObject(String... pairs) {
        StringBuilder builder = new StringBuilder("{");
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            if (i > 0) {
                builder.append(',');
            }
            builder.append(jsonString(pairs[i])).append(':').append(jsonString(pairs[i + 1]));
        }
        return builder.append('}').toString();
    }

    private String jsonResult(boolean ok, String message) {
        return "{\"ok\":" + ok + ",\"message\":" + jsonString(message == null ? "" : message) + "}";
    }

    private String startBackendService() {
        Path launcherScript = projectRoot.resolve("run-native-local.ps1");
        if (!Files.exists(launcherScript)) {
            String message = "Backend launcher not found: " + launcherScript;
            System.err.println("[pet-chat] " + message);
            return jsonResult(false, message);
        }
        if (!backendStartInProgress.compareAndSet(false, true)) {
            return jsonResult(true, "Backend start is already in progress.");
        }

        Thread worker = new Thread(() -> {
            try {
                boolean started = runPowerShellScript(launcherScript, 35L);
                if (!started) {
                    System.err.println("[pet-chat] backend start script failed.");
                    return;
                }
                boolean ready = waitForBackendReady(13_000L);
                if (!ready) {
                    System.err.println("[pet-chat] backend did not become ready in time.");
                    return;
                }
                Platform.runLater(this::loadChatPage);
            } finally {
                backendStartInProgress.set(false);
            }
        }, "pet-backend-start");
        worker.setDaemon(true);
        worker.start();
        return jsonResult(true, "Backend start requested. Retrying soon.");
    }

    private String shutdownDesktopAndBackendFromBridge() {
        shutdownDesktopAndBackend();
        return jsonResult(true, "Shutting down desktop pet and backend.");
    }

    private void shutdownDesktopAndBackend() {
        if (!shutdownInProgress.compareAndSet(false, true)) {
            return;
        }
        Thread worker = new Thread(() -> {
            try {
                stopBackendService();
            } finally {
                actions.shutdownDesktopPet();
            }
        }, "pet-backend-shutdown");
        worker.setDaemon(true);
        worker.start();
    }

    private boolean stopBackendService() {
        Path stopScript = projectRoot.resolve("scripts").resolve("stop-native-local.ps1");
        if (Files.exists(stopScript) && runPowerShellScript(stopScript, 25L)) {
            return true;
        }
        Path pidFile = projectRoot.resolve(".runtime").resolve("native-app.pid");
        if (!Files.exists(pidFile)) {
            return false;
        }
        try {
            String pidText = Files.readString(pidFile, StandardCharsets.UTF_8).trim();
            if (pidText.isBlank()) {
                return false;
            }
            Process killProcess = new ProcessBuilder("taskkill", "/PID", pidText, "/T", "/F")
                    .directory(projectRoot.toFile())
                    .redirectErrorStream(true)
                    .start();
            boolean finished = killProcess.waitFor(10, TimeUnit.SECONDS);
            return finished && killProcess.exitValue() == 0;
        } catch (Exception error) {
            System.err.println("[pet-chat] failed to stop backend by pid: " + error.getMessage());
            return false;
        }
    }

    private boolean runPowerShellScript(Path scriptPath, long timeoutSeconds) {
        try {
            Process process = new ProcessBuilder(
                    "powershell.exe",
                    "-NoProfile",
                    "-WindowStyle",
                    "Hidden",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    scriptPath.toString()
            )
                    .directory(projectRoot.toFile())
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start();
            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return false;
            }
            return process.exitValue() == 0;
        } catch (IOException | InterruptedException error) {
            if (error instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            System.err.println("[pet-chat] script run failed: " + error.getMessage());
            return false;
        }
    }

    private boolean waitForBackendReady(long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            try {
                HttpResponse<String> response = httpClient.send(
                        HttpRequest.newBuilder()
                                .uri(URI.create(backendBaseUrl + "/health"))
                                .version(HttpClient.Version.HTTP_1_1)
                                .timeout(Duration.ofSeconds(4))
                                .GET()
                                .build(),
                        HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)
                );
                if (response.statusCode() >= 200 && response.statusCode() < 300) {
                    return true;
                }
            } catch (Exception ignored) {
            }
            try {
                Thread.sleep(550L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return false;
    }

    private void handleBridgePayload(String payloadJson) {
        try {
            System.out.println("[pet-chat] bridge payload raw=" + compact(payloadJson, 600));
            JsonObject payload = JsonParser.parseString(payloadJson).getAsJsonObject();
            String question = payload.has("question") ? payload.get("question").getAsString() : "";
            String conversationId = payload.has("conversation_id") ? payload.get("conversation_id").getAsString() : "";
            String mode = payload.has("mode") ? payload.get("mode").getAsString() : "wait";
            String safetyMode = payload.has("safety_review_mode") ? payload.get("safety_review_mode").getAsString() : "";
            System.out.println("[pet-chat] bridge parsed questionLength=" + question.length() + " conversationId=" + conversationId + " mode=" + mode);
            String model = payload.has("llm_model") ? payload.get("llm_model").getAsString() : "";
            String client = payload.has("llm_client") ? payload.get("llm_client").getAsString() : "";
            sendChatRequest(question, conversationId, mode, safetyMode, client, model);
        } catch (RuntimeException error) {
            System.err.println("[pet-chat] bridge parse failed: " + error.getMessage());
            deliverChatResponse(jsonObject("error", "Desktop bridge parse failed: " + error.getMessage()));
        }
    }

    private void handleBridgeStreamPayload(String payloadJson) {
        try {
            JsonObject payload = JsonParser.parseString(payloadJson).getAsJsonObject();
            String question = payload.has("question") ? payload.get("question").getAsString() : "";
            String conversationId = payload.has("conversation_id") ? payload.get("conversation_id").getAsString() : "";
            String model = payload.has("llm_model") ? payload.get("llm_model").getAsString() : "";
            String client = payload.has("llm_client") ? payload.get("llm_client").getAsString() : "";
            String safetyMode = payload.has("safety_review_mode") ? payload.get("safety_review_mode").getAsString() : "";
            Thread worker = new Thread(() -> sendChatStreamRequest(question, conversationId, client, model, safetyMode), "pet-chat-stream");
            worker.setDaemon(true);
            worker.start();
        } catch (RuntimeException error) {
            deliverChatResponse(jsonObject("error", "Desktop stream bridge parse failed: " + error.getMessage()));
        }
    }

    private void sendChatStreamRequest(String question, String conversationId, String client, String model, String safetyMode) {
        String requestJson = "{\"session_id\":" + jsonString(conversationId == null ? "" : conversationId)
                + ",\"user_input\":" + jsonString(question == null ? "" : question)
                + ",\"llm\":{\"response_mode\":\"stream\""
                + (client == null || client.isBlank() ? "" : ",\"client_name\":" + jsonString(client))
                + (model == null || model.isBlank() ? "" : ",\"model\":" + jsonString(model)) + "}"
                + (safetyMode == null || safetyMode.isBlank() ? "" : ",\"safety_review_mode\":" + jsonString(safetyMode)) + "}";
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(backendBaseUrl + "/agent/turn/stream"))
                    .version(HttpClient.Version.HTTP_1_1)
                    .timeout(Duration.ofMinutes(10))
                    .header("Content-Type", "application/json; charset=utf-8")
                    .header("Accept", "text/event-stream")
                    .POST(HttpRequest.BodyPublishers.ofString(requestJson, StandardCharsets.UTF_8))
                    .build();
            HttpResponse<Stream<String>> response = httpClient.send(request, HttpResponse.BodyHandlers.ofLines());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                String error = response.body().reduce("", (a, b) -> a + b);
                deliverChatResponse(jsonObject("error", "HTTP " + response.statusCode() + ": " + error));
                return;
            }
            String eventName = "message";
            StringBuilder data = new StringBuilder();
            try (Stream<String> lines = response.body()) {
                for (String line : (Iterable<String>) lines::iterator) {
                    if (line.startsWith("event:")) eventName = line.substring(6).trim();
                    else if (line.startsWith("data:")) { if (data.length() > 0) data.append('\n'); data.append(line.substring(5).trim()); }
                    else if (line.isBlank() && data.length() > 0) {
                        deliverChatStreamEvent(eventName, data.toString());
                        eventName = "message"; data.setLength(0);
                    }
                }
            }
            if (data.length() > 0) deliverChatStreamEvent(eventName, data.toString());
        } catch (Exception error) {
            deliverChatResponse(jsonObject("error", "Desktop stream bridge failed: " + error.getMessage()));
        }
    }

    private String decideSafetyReview(String reviewId, String decision) {
        try {
            String body = "{\"decision\":" + jsonString(decision) + ",\"reason\":\"用户通过桌宠前端决定\",\"decided_by\":\"user\"}";
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(backendBaseUrl + "/agent/safety-reviews/" + URI.create("http://localhost/" + reviewId).getPath().substring(1) + "/decision"))
                    .timeout(Duration.ofSeconds(20))
                    .header("Content-Type", "application/json; charset=utf-8")
                    .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) return jsonObject("error", "HTTP " + response.statusCode() + ": " + response.body());
            return response.body();
        } catch (Exception error) {
            return jsonObject("error", "Safety decision failed: " + error.getMessage());
        }
    }

    private String setSessionWorkspace(String sessionId, String path) {
        try {
            String body = "{\"path\":" + jsonString(path) + ",\"platform\":" + jsonString(path.startsWith("/") ? "linux" : "windows") + "}";
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(backendBaseUrl + "/sessions/" + sessionId + "/workspace"))
                    .version(HttpClient.Version.HTTP_1_1)
                    .timeout(Duration.ofSeconds(20))
                    .header("Content-Type", "application/json; charset=utf-8")
                    .PUT(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) return jsonObject("error", "HTTP " + response.statusCode() + ": " + response.body());
            return response.body();
        } catch (Exception error) {
            return jsonObject("error", "Workspace binding failed: " + error.getMessage());
        }
    }

    private String createSessionWorkspace(String sessionId, String basePath) {
        try {
            String body = "{\"session_id\":" + jsonString(sessionId == null ? "" : sessionId)
                    + ",\"base_path\":" + jsonString(basePath == null ? "" : basePath) + "}";
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(chatUrl).resolve("/pet/session-workspace"))
                    .version(HttpClient.Version.HTTP_1_1)
                    .timeout(Duration.ofSeconds(20))
                    .header("Content-Type", "application/json; charset=utf-8")
                    .header("Accept", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                return jsonObject("error", "HTTP " + response.statusCode() + ": " + response.body());
            }
            return response.body();
        } catch (Exception error) {
            return jsonObject("error", "Workspace creation failed: " + error.getMessage());
        }
    }

    private String saveUiDefaults(String payloadJson) {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(backendBaseUrl + "/agent/ui-defaults"))
                    .version(HttpClient.Version.HTTP_1_1)
                    .timeout(Duration.ofSeconds(20))
                    .header("Content-Type", "application/json; charset=utf-8")
                    .PUT(HttpRequest.BodyPublishers.ofString(payloadJson, StandardCharsets.UTF_8))
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) return jsonObject("error", "HTTP " + response.statusCode() + ": " + response.body());
            return response.body();
        } catch (Exception error) {
            return jsonObject("error", "Settings save failed: " + error.getMessage());
        }
    }

    private String createSession(String title) {
        try {
            String body = "{\"title\":" + jsonString(title == null || title.isBlank() ? "New Chat" : title) + ",\"metadata\":{\"source_frontend\":\"windows-pet\"}}";
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(backendBaseUrl + "/sessions"))
                    .timeout(Duration.ofSeconds(20))
                    .header("Content-Type", "application/json; charset=utf-8")
                    .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) return jsonObject("error", "HTTP " + response.statusCode() + ": " + response.body());
            return response.body();
        } catch (Exception error) {
            return jsonObject("error", "Session creation failed: " + error.getMessage());
        }
    }

    private String deleteSession(String sessionId) {
        try {
            String encodedId = URLEncoder.encode(sessionId == null ? "" : sessionId, StandardCharsets.UTF_8)
                    .replace("+", "%20");
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(backendBaseUrl + "/sessions/" + encodedId))
                    .version(HttpClient.Version.HTTP_1_1)
                    .timeout(Duration.ofSeconds(8))
                    .DELETE()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() == 204) return "{\"ok\":true,\"backend_deleted\":true}";
            if (response.statusCode() == 404) return "{\"ok\":true,\"backend_deleted\":false}";
            return jsonObject("error", "HTTP " + response.statusCode() + ": " + response.body());
        } catch (Exception error) {
            return jsonObject("error", "Session deletion failed: " + error.getMessage());
        }
    }

    private String restoreSession(String sessionId) {
        try {
            String encodedId = URLEncoder.encode(sessionId == null ? "" : sessionId, StandardCharsets.UTF_8)
                    .replace("+", "%20");
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(backendBaseUrl + "/sessions/" + encodedId + "/restore"))
                    .version(HttpClient.Version.HTTP_1_1)
                    .timeout(Duration.ofSeconds(8))
                    .POST(HttpRequest.BodyPublishers.noBody())
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() == 404) return "{\"not_found\":true}";
            if (response.statusCode() >= 200 && response.statusCode() < 300) return response.body();
            return jsonObject("error", "HTTP " + response.statusCode() + ": " + response.body());
        } catch (Exception error) {
            return jsonObject("error", "Session restoration failed: " + error.getMessage());
        }
    }

    private String renameSession(String sessionId, String title) {
        try {
            String encodedId = URLEncoder.encode(sessionId == null ? "" : sessionId, StandardCharsets.UTF_8)
                    .replace("+", "%20");
            String body = jsonObject("title", title == null ? "" : title);
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(backendBaseUrl + "/sessions/" + encodedId))
                    .version(HttpClient.Version.HTTP_1_1)
                    .timeout(Duration.ofSeconds(8))
                    .header("Content-Type", "application/json; charset=utf-8")
                    .method("PATCH", HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() == 404) return "{\"not_found\":true}";
            if (response.statusCode() >= 200 && response.statusCode() < 300) return response.body();
            return jsonObject("error", "HTTP " + response.statusCode() + ": " + response.body());
        } catch (Exception error) {
            return jsonObject("error", "Session rename failed: " + error.getMessage());
        }
    }

    static boolean allowedMemoryRequest(String method, String path) {
        try {
            URI uri = URI.create(path);
            if (uri.isAbsolute() || uri.getRawAuthority() != null || uri.getFragment() != null
                    || !path.startsWith("/")) return false;
            for (String part : uri.getPath().split("/")) {
                if (part.equals(".") || part.equals("..")) return false;
            }
            String route = uri.getPath();
            String segment = "[A-Za-z0-9_:%-]+";
            if (route.startsWith("/plugins/qq-ui/")) {
                if (!path.startsWith("/plugins/qq-ui/")) return false;
                String qqPath = route.substring("/plugins/qq-ui/".length());
                List<String> queryNames = List.of();
                boolean permitted = false;
                if (method.equals("GET")) {
                    permitted = List.of("status", "capabilities", "messages", "stickers").contains(qqPath)
                            || qqPath.matches("groups/[0-9]{1,20}")
                            || qqPath.matches("sends/[A-Za-z0-9_-]{8,128}")
                            || qqPath.matches("conversations/(?:private|group)/[0-9]{1,20}");
                    if (qqPath.equals("messages")) queryNames = List.of("conversation_type", "conversation_id", "after", "limit");
                    if (qqPath.equals("stickers")) queryNames = List.of("limit");
                    if (qqPath.matches("groups/[0-9]{1,20}")) queryNames = List.of("account_id");
                } else if (method.equals("PUT")) {
                    permitted = qqPath.matches("conversations/(?:private|group)/[0-9]{1,20}");
                } else if (method.equals("POST")) {
                    permitted = qqPath.equals("messages/send")
                            || qqPath.matches("messages/[1-9][0-9]*/media/(?:0|[1-9][0-9]*)/cache");
                }
                if (!permitted) return false;
                if (uri.getRawQuery() != null) {
                    for (String part : uri.getRawQuery().split("&", -1)) {
                        if (!queryNames.contains(part.split("=", 2)[0])) return false;
                    }
                }
                return true;
            }
            if (route.startsWith("/plugins/message-reading/")) {
                if (!path.startsWith("/plugins/message-reading/")) return false;
                String readingPath = route.substring("/plugins/message-reading/".length());
                String[][] routes = {
                    {"GET", "messages/policies"},
                    {"PUT", "messages/policies"},
                    {"GET", "messages/conversations", "limit", "offset"},
                    {"GET", "messages/conversations/resolve", "query"},
                    {"GET", "messages/conversations/[A-Za-z0-9_-]{1,160}/metadata"},
                    {"GET", "messages/conversations/[A-Za-z0-9_-]{1,160}/history", "before_seq", "limit"},
                    {"GET", "messages/conversations/[A-Za-z0-9_-]{1,160}/summary"},
                    {"GET", "messages/conversations/[A-Za-z0-9_-]{1,160}/coverage"},
                    {"GET", "messages/conversations/[A-Za-z0-9_-]{1,160}/facts", "limit", "offset"},
                    {"GET", "messages/conversations/[A-Za-z0-9_-]{1,160}/digest"},
                    {"PATCH", "messages/conversations/[A-Za-z0-9_-]{1,160}/metadata"},
                    {"POST", "messages/conversations/[A-Za-z0-9_-]{1,160}/analyze"},
                    {"POST", "messages/conversations/[A-Za-z0-9_-]{1,160}/retry"},
                    {"GET", "messages/search", "query", "conversation_key", "sender", "sender_id", "since", "until", "limit", "offset"},
                    {"GET", "messages/recent", "conversation_key", "since", "limit", "offset"},
                    {"GET", "messages/records/[A-Za-z0-9_-]{1,160}"},
                    {"GET", "messages/records/[A-Za-z0-9_-]{1,160}/context", "before", "after"},
                    {"GET", "messages/attachments", "conversation_key", "kind", "query", "limit", "offset"},
                    {"GET", "messages/attachments/[A-Za-z0-9_-]{1,160}"},
                    {"GET", "messages/reading/participants", "conversation_key", "limit", "cursor"},
                    {"GET", "messages/reading/participants/[A-Za-z0-9_-]{1,160}/[^/\\\\\\x00-\\x20\\x7f%?#]{1,160}"},
                    {"GET", "messages/reading/participants/[A-Za-z0-9_-]{1,160}/[^/\\\\\\x00-\\x20\\x7f%?#]{1,160}/sources", "limit", "cursor"},
                    {"POST", "messages/reading/participants/[A-Za-z0-9_-]{1,160}/[^/\\\\\\x00-\\x20\\x7f%?#]{1,160}/control"},
                    {"GET", "messages/reading/dossiers", "conversation_key", "limit", "offset"},
                    {"GET", "messages/reading/dossiers/[A-Za-z0-9_-]{1,160}/[^/\\\\\\x00-\\x20\\x7f%?#]{1,160}", "limit", "offset"},
                    {"GET", "messages/reading/dossiers/[A-Za-z0-9_-]{1,160}/[^/\\\\\\x00-\\x20\\x7f%?#]{1,160}/sources", "limit", "offset"},
                    {"GET", "messages/reading/focus/[A-Za-z0-9_-]{1,160}"},
                    {"PUT", "messages/reading/focus/[A-Za-z0-9_-]{1,160}"},
                    {"GET", "messages/reading/overview", "conversation_key"},
                    {"GET", "messages/reading/topics", "conversation_key", "limit", "cursor", "since", "until"},
                    {"GET", "messages/reading/topics/[A-Za-z0-9_-]{1,160}"},
                    {"GET", "messages/reading/topics/[A-Za-z0-9_-]{1,160}/sources", "limit", "cursor"},
                    {"GET", "messages/reading/insights", "conversation_key", "limit", "cursor", "since", "until", "importance", "unseen", "kind"},
                    {"GET", "messages/reading/insights/[A-Za-z0-9_-]{1,160}"},
                    {"GET", "messages/reading/insights/[A-Za-z0-9_-]{1,160}/sources", "limit", "cursor"},
                    {"POST", "messages/reading/insights/[A-Za-z0-9_-]{1,160}/attention"},
                    {"GET", "messages/reading/profile", "scope"},
                    {"PUT", "messages/reading/profile", "scope"},
                    {"GET", "messages/matter-proposals", "conversation_key", "limit", "cursor", "state", "since", "until"},
                    {"GET", "messages/matter-proposals/[A-Za-z0-9_-]{1,160}"},
                    {"POST", "messages/matter-proposals/[A-Za-z0-9_-]{1,160}/decision"},
                    {"POST", "messages/matter-proposals/[A-Za-z0-9_-]{1,160}/revalidate"},
                    {"GET", "messages/reading/evaluation/badcases", "limit", "cursor"},
                    {"GET", "messages/reading/evaluation/badcases/[A-Za-z0-9_-]{1,160}"},
                    {"POST", "messages/reading/evaluation/badcases"},
                    {"POST", "messages/reading/evaluation/badcases/preview"},
                    {"GET", "background/services/message-reading"},
                    {"POST", "background/services/message-reading/pause"},
                    {"POST", "background/services/message-reading/resume"},
                    {"GET", "background/config"},
                    {"GET", "background/config/schema"},
                    {"PATCH", "background/config"},
                    {"GET", "agent/models"},
                };
                for (String[] rule : routes) {
                    if (!method.equals(rule[0]) || !readingPath.matches(rule[1])) continue;
                    if (uri.getRawQuery() != null) {
                        for (String part : uri.getRawQuery().split("&", -1)) {
                            String name = part.split("=", 2)[0];
                            boolean found = false;
                            for (int index = 2; index < rule.length; index++) {
                                if (rule[index].equals(name)) found = true;
                            }
                            if (!found) return false;
                        }
                    }
                    return true;
                }
                return false;
            }
            if (uri.getRawQuery() != null) {
                for (String part : uri.getRawQuery().split("&")) {
                    String name = part.split("=", 2)[0];
                    if (!List.of("scope", "workspace_path", "include_candidates", "limit", "offset",
                            "expected_version", "expected_revision", "scope_id", "status", "refresh", "q", "project_id", "before_seq").contains(name)) return false;
                }
            }
            return switch (method) {
                case "GET" -> route.matches("/memories(?:/(?:export|learning|file(?:/preview)?|" + segment + "(?:/sources)?))?")
                        || route.matches("/background/(?:health|jobs(?:/" + segment + ")?|config(?:/schema)?)")
                        || route.equals("/agent/models")
                        || route.matches("/projects(?:/" + segment + "(?:/sessions)?)?")
                        || route.matches("/sessions/" + segment)
                        || route.matches("/sessions/" + segment + "/context-status")
                        || route.equals("/messages/policies")
                        || route.matches("/messages/conversations(?:/" + segment + "(?:/(?:history|summary|facts))?)?");
                case "POST" -> route.equals("/memories")
                        || route.equals("/projects") || route.equals("/sessions")
                        || route.matches("/memories/file/(?:generate|import)")
                        || route.matches("/memories/projects/" + segment + "/relocate")
                        || route.matches("/background/jobs/" + segment + "/(?:retry|cancel)")
                        || route.matches("/messages/conversations/" + segment + "/(?:analyze|retry)");
                case "PUT" -> route.equals("/memories/learning") || route.equals("/messages/policies");
                case "PATCH" -> route.equals("/background/config") || route.matches("/memories/" + segment) || route.matches("/projects/" + segment);
                case "DELETE" -> route.equals("/background/config") || route.matches("/memories/" + segment);
                default -> false;
            };
        } catch (RuntimeException error) {
            return false;
        }
    }

    private void handleMemoryRequest(String payloadJson) {
        String requestId = "";
        try {
            JsonObject payload = JsonParser.parseString(payloadJson).getAsJsonObject();
            requestId = payload.get("id").getAsString();
            if (!requestId.matches("memory-[a-z0-9]+-[0-9]+")) return;
            String method = payload.get("method").getAsString();
            String path = payload.get("path").getAsString();
            if (!allowedMemoryRequest(method, path)) {
                deliverMemoryResponse(requestId, 403, jsonObject("detail", "unsupported memory request"));
                return;
            }
            String body = payload.has("body") ? payload.get("body").getAsString() : "";
            String token = payload.has("token") ? payload.get("token").getAsString() : "";
            boolean readingProxy = path.startsWith("/plugins/message-reading/");
            boolean qqProxy = path.startsWith("/plugins/qq-ui/");
            boolean frontendProxy = readingProxy || qqProxy;
            boolean qqWrite = qqProxy && !method.equals("GET");
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(frontendProxy ? URI.create(chatUrl).resolve(path) : URI.create(backendBaseUrl + path))
                    .version(HttpClient.Version.HTTP_1_1)
                    .timeout(Duration.ofSeconds(qqWrite && method.equals("POST") ? 90 : 25))
                    .header("Accept", "application/json");
            if (!frontendProxy && !token.isBlank()) builder.header("Authorization", "Bearer " + token);
            if (qqWrite) builder.header("X-LKA-UI-Intent", "1");
            if (!body.isBlank()) builder.header("Content-Type", "application/json; charset=utf-8");
            builder.method(method, body.isBlank() ? HttpRequest.BodyPublishers.noBody()
                    : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
            String callbackId = requestId;
            httpClient.sendAsync(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
                    .whenComplete((response, error) -> {
                        if (error != null) deliverMemoryResponse(callbackId, 0, "{}");
                        else deliverMemoryResponse(callbackId, response.statusCode(), response.body());
                    });
        } catch (RuntimeException error) {
            if (requestId.matches("memory-[a-z0-9]+-[0-9]+")) deliverMemoryResponse(requestId, 0, "{}");
        }
    }

    private void deliverMemoryResponse(String requestId, int status, String body) {
        String script = "window.__lkaMemoryBridgeReceive && window.__lkaMemoryBridgeReceive("
                + jsonString(requestId) + "," + status + "," + jsonString(body) + ");";
        Platform.runLater(() -> {
            try { if (webView != null) webView.getEngine().executeScript(script); }
            catch (RuntimeException ignored) { /* A closed or reloaded page drops its own pending requests. */ }
        });
    }

    private void handleQQReaderStatusRequest(String requestId) {
        if (requestId == null || !requestId.matches("qq-status-[a-z0-9]+-[0-9]+")) return;
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(chatUrl).resolve("/plugins/qq-reader/status"))
                    .version(HttpClient.Version.HTTP_1_1)
                    .timeout(Duration.ofSeconds(8))
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
                    .whenComplete((response, error) -> {
                        if (error != null) deliverQQReaderStatusResponse(requestId, 0, "{}");
                        else deliverQQReaderStatusResponse(requestId, response.statusCode(), response.body());
                    });
        } catch (RuntimeException error) {
            deliverQQReaderStatusResponse(requestId, 0, "{}");
        }
    }

    private void deliverQQReaderStatusResponse(String requestId, int status, String body) {
        String script = "window.__lkaQQStatusReceive && window.__lkaQQStatusReceive("
                + jsonString(requestId) + "," + status + "," + jsonString(body) + ");";
        Platform.runLater(() -> {
            try { if (webView != null) webView.getEngine().executeScript(script); }
            catch (RuntimeException ignored) { /* A closed or reloaded page drops its pending request. */ }
        });
    }

    private void deliverChatStreamEvent(String eventName, String dataJson) {
        String script = "window.__petChatReceiveStream && window.__petChatReceiveStream(" + jsonString(eventName) + "," + dataJson + ");";
        Platform.runLater(() -> {
            try { webView.getEngine().executeScript(script); }
            catch (RuntimeException error) {
                System.err.println("[pet-chat] stream event " + eventName + " delivery failed: " + error.getMessage());
            }
        });
    }

    private void sendChatRequest(String question, String conversationId, String mode, String safetyMode, String client, String model) {
        Thread worker = new Thread(() -> {
            String responseJson;
            try {
                JsonObject requestBody = new JsonObject();
                requestBody.addProperty("session_id", conversationId == null ? "" : conversationId);
                requestBody.addProperty("user_input", question == null ? "" : question);
                if (safetyMode != null && !safetyMode.isBlank()) requestBody.addProperty("safety_review_mode", safetyMode);
                if ((client != null && !client.isBlank()) || (model != null && !model.isBlank())) {
                    JsonObject llm = new JsonObject();
                    if (client != null && !client.isBlank()) llm.addProperty("client_name", client);
                    if (model != null && !model.isBlank()) llm.addProperty("model", model);
                    requestBody.add("llm", llm);
                }
                String requestJson = requestBody.toString();
                String targetUrl = backendBaseUrl + "/agent/turn";
                System.out.println("[pet-chat] http request url=" + targetUrl + " body=" + compact(requestJson, 600));
                HttpRequest request = HttpRequest.newBuilder()
                        .uri(URI.create(targetUrl))
                        .version(HttpClient.Version.HTTP_1_1)
                        .timeout(Duration.ofSeconds(130))
                        .header("Content-Type", "application/json; charset=utf-8")
                        .header("Accept", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(requestJson, StandardCharsets.UTF_8))
                        .build();
                HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
                if (response.statusCode() >= 200 && response.statusCode() < 300) {
                    responseJson = response.body();
                    System.out.println("[pet-chat] chat-api OK status=" + response.statusCode() + " body=" + compact(responseJson, 700));
                } else {
                    responseJson = jsonObject("error", "HTTP " + response.statusCode() + ": " + response.body());
                    System.err.println("[pet-chat] chat-api FAIL status=" + response.statusCode() + " body=" + response.body());
                }
            } catch (Exception error) {
                responseJson = jsonObject("error", error.getMessage() == null ? error.toString() : error.getMessage());
                System.err.println("[pet-chat] chat-api ERROR " + responseJson);
            }
            deliverChatResponse(responseJson);
        }, "pet-chat-http");
        worker.setDaemon(true);
        worker.start();
    }

    private void deliverChatResponse(String responseJson) {
        String script = "window.__petChatReceive && window.__petChatReceive(" + responseJson + ");";
        Platform.runLater(() -> {
            try {
                webView.getEngine().executeScript(script);
            } catch (RuntimeException ignored) {
            }
        });
    }

    private String compact(String raw, int maxChars) {
        if (raw == null) {
            return "";
        }
        String compacted = raw.replace('\r', ' ').replace('\n', ' ').replaceAll("\\s+", " ").trim();
        if (compacted.length() <= maxChars) {
            return compacted;
        }
        return compacted.substring(0, Math.max(0, maxChars - 3)) + "...";
    }
}

interface PetControlActions {
    List<PetModelOption> listModels();

    String getActiveModelId();

    void switchModel(String profileId);

    boolean isRandomBehaviorEnabled();

    void setRandomBehaviorEnabled(boolean enabled);

    void playInteraction(String action);

    boolean hasInteraction(String action);

    void reloadModel();

    void increaseScale();

    void decreaseScale();

    void raiseModel();

    void lowerModel();

    void shutdownDesktopPet();
}

final class PetModelOption {
    private final String id;
    private final String name;
    private final String skeletonUrl;

    PetModelOption(String id, String name, String skeletonUrl) {
        this.id = id == null ? "" : id;
        this.name = name == null || name.isBlank() ? this.id : name;
        this.skeletonUrl = skeletonUrl == null ? "" : skeletonUrl;
    }

    String id() {
        return id;
    }

    String name() {
        return name;
    }

    String skeletonUrl() {
        return skeletonUrl;
    }

    @Override
    public boolean equals(Object other) {
        if (!(other instanceof PetModelOption option)) {
            return false;
        }
        return Objects.equals(id, option.id);
    }

    @Override
    public int hashCode() {
        return Objects.hash(id);
    }

    @Override
    public String toString() {
        return name;
    }
}
