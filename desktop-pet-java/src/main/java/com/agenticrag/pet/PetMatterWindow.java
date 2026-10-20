package com.agenticrag.pet;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import javafx.concurrent.Worker;
import javafx.geometry.Insets;
import javafx.geometry.Pos;
import javafx.geometry.Rectangle2D;
import javafx.scene.Cursor;
import javafx.scene.Node;
import javafx.scene.Scene;
import javafx.scene.control.Button;
import javafx.scene.control.Label;
import javafx.scene.control.Tooltip;
import javafx.scene.input.MouseButton;
import javafx.scene.input.MouseEvent;
import javafx.scene.layout.BorderPane;
import javafx.scene.layout.HBox;
import javafx.scene.layout.Priority;
import javafx.scene.layout.Region;
import javafx.scene.layout.StackPane;
import javafx.scene.paint.Color;
import javafx.scene.shape.Rectangle;
import javafx.scene.shape.SVGPath;
import javafx.scene.web.WebView;
import javafx.stage.Screen;
import javafx.stage.Stage;
import javafx.stage.StageStyle;
import netscape.javascript.JSObject;

import java.util.function.BiConsumer;

/** A reusable independent work surface, with quiet chrome matching the matter workspace. */
final class PetMatterWindow {
    private static final double TITLE_HEIGHT = 36, RESIZE_MARGIN = 7;
    private static final int LEFT = 1, RIGHT = 2, TOP = 4, BOTTOM = 8;
    private final Stage stage = new Stage(StageStyle.TRANSPARENT);
    private final WebView webView = new WebView();
    private final BorderPane frame = new BorderPane();
    private final HBox titlebar = new HBox(9);
    private final Rectangle frameClip = new Rectangle();
    private final StackPane content = new StackPane(webView);
    private Button maximizeButton;
    private boolean maximized;
    private Rectangle2D restoreBounds;
    private int resizeEdge;
    private boolean dragging;
    private double pressX, pressY, startX, startY, startWidth, startHeight;
    private double dragRatio;
    private final String pageUrl;
    // Keep a strong reference: WebKit's Java object wrapper does not own the bridge.
    private final MatterBridge bridge;
    private boolean ready;
    private boolean disposed;
    private String pendingOptions = "{}";

    PetMatterWindow(String pageUrl, BiConsumer<String, WebView> requestHandler) {
        this.pageUrl = pageUrl;
        bridge = new MatterBridge(payload -> {
            if (!disposed && ready && pageUrl.equals(webView.getEngine().getLocation())) {
                requestHandler.accept(payload, webView);
            }
        });
        stage.setTitle("待办与项目规划 · 理事所");
        frame.setId("matterWindowFrame");
        frame.setTop(buildTitlebar());
        frame.setCenter(content);
        frameClip.widthProperty().bind(frame.widthProperty());
        frameClip.heightProperty().bind(frame.heightProperty());
        frame.setClip(frameClip);
        Scene scene = new Scene(new StackPane(frame), 980, 700, Color.TRANSPARENT);
        stage.setScene(scene);
        updateChrome();
        installResize(scene);
        Rectangle2D bounds = Screen.getPrimary().getVisualBounds();
        stage.setMinWidth(Math.min(480, bounds.getWidth()));
        stage.setMinHeight(Math.min(500, bounds.getHeight()));
        stage.setWidth(Math.min(980, bounds.getWidth()));
        stage.setHeight(Math.min(700, bounds.getHeight()));
        webView.setMinWidth(0);
        webView.setMinHeight(0);
        webView.setContextMenuEnabled(false);
        stage.setOnCloseRequest(event -> {
            event.consume();
            stage.hide();
        });
        webView.getEngine().getLoadWorker().stateProperty().addListener((observable, oldState, state) -> {
            if (state == Worker.State.SCHEDULED) ready = false;
            if (state != Worker.State.SUCCEEDED || disposed
                    || !pageUrl.equals(webView.getEngine().getLocation())) return;
            JSObject window = (JSObject) webView.getEngine().executeScript("window");
            window.setMember("petBridge", bridge);
            ready = true;
            webView.getEngine().executeScript("window.__petMatterBridgeReady && window.__petMatterBridgeReady();");
            applyOptions();
        });
        webView.getEngine().load(pageUrl);
    }

    private HBox buildTitlebar() {
        titlebar.setId("matterWindowTitlebar");
        titlebar.setAlignment(Pos.CENTER_LEFT);
        titlebar.setMinHeight(TITLE_HEIGHT);
        titlebar.setPrefHeight(TITLE_HEIGHT);
        titlebar.setMaxHeight(TITLE_HEIGHT);
        titlebar.setPadding(new Insets(0, 0, 0, 12));
        titlebar.setStyle("-fx-background-color:#f7f9fa;-fx-border-color:transparent transparent #e4ebed transparent;-fx-border-width:0 0 1 0;");
        Label mark = new Label("理");
        mark.setAlignment(Pos.CENTER);
        mark.setMinSize(20, 20);
        mark.setStyle("-fx-background-color:#237b80;-fx-background-radius:5;-fx-text-fill:white;-fx-font-family:'Microsoft YaHei UI';-fx-font-size:12;");
        Label title = new Label("待办与项目规划");
        title.setStyle("-fx-text-fill:#22363b;-fx-font-family:'Microsoft YaHei UI';-fx-font-size:12;");
        Region spacer = new Region();
        HBox.setHgrow(spacer, Priority.ALWAYS);
        Button minimize = chromeButton("matterWindowMinimize", "最小化窗口", "M3 8h10", () -> stage.setIconified(true), false);
        maximizeButton = chromeButton("matterWindowMaximize", "最大化窗口", "M3 3h10v10H3z", this::toggleMaximize, false);
        Button close = chromeButton("matterWindowClose", "关闭窗口", "M3 3l10 10 M13 3L3 13", stage::hide, true);
        HBox controls = new HBox(minimize, maximizeButton, close);
        controls.setAlignment(Pos.CENTER);
        titlebar.getChildren().addAll(mark, title, spacer, controls);
        titlebar.addEventHandler(MouseEvent.MOUSE_PRESSED, event -> {
            if (event.getButton() != MouseButton.PRIMARY || isWindowControl(event.getTarget()) || resizeEdge != 0) return;
            dragging = event.getClickCount() == 1;
            rememberPress(event);
            dragRatio = (event.getScreenX() - stage.getX()) / stage.getWidth();
            event.consume();
        });
        titlebar.addEventHandler(MouseEvent.MOUSE_DRAGGED, event -> {
            if (!dragging || resizeEdge != 0 || !event.isPrimaryButtonDown()) return;
            if (maximized) {
                toggleMaximize();
                stage.setX(event.getScreenX() - stage.getWidth() * dragRatio);
                stage.setY(event.getScreenY() - TITLE_HEIGHT / 2);
                rememberPress(event);
            } else {
                stage.setX(startX + event.getScreenX() - pressX);
                stage.setY(startY + event.getScreenY() - pressY);
            }
            clampToScreen();
            event.consume();
        });
        titlebar.addEventHandler(MouseEvent.MOUSE_RELEASED, event -> dragging = false);
        titlebar.addEventHandler(MouseEvent.MOUSE_CLICKED, event -> {
            if (event.getButton() == MouseButton.PRIMARY && event.getClickCount() == 2 && !isWindowControl(event.getTarget()) && edgeAt(event) == 0) {
                dragging = false;
                toggleMaximize();
                event.consume();
            }
        });
        return titlebar;
    }

    private Button chromeButton(String id, String label, String path, Runnable action, boolean close) {
        Button button = new Button();
        button.setId(id);
        button.setAccessibleText(label);
        button.setTooltip(new Tooltip(label));
        button.setMinSize(44, TITLE_HEIGHT - 2);
        button.setPrefSize(44, TITLE_HEIGHT - 2);
        button.setMaxSize(44, TITLE_HEIGHT - 2);
        button.setGraphic(icon(path));
        Runnable paint = () -> {
            String background = button.isHover() ? close ? "#f9e7e5" : "#e8eff1" : "transparent";
            button.setStyle("-fx-background-color:" + background + ";-fx-background-radius:0;-fx-padding:0;-fx-border-radius:0;-fx-border-width:1;-fx-border-color:" + (button.isFocused() ? "#237b80" : "transparent") + ";");
        };
        button.hoverProperty().addListener((observable, oldValue, newValue) -> paint.run());
        button.focusedProperty().addListener((observable, oldValue, newValue) -> paint.run());
        paint.run();
        button.setOnAction(event -> action.run());
        return button;
    }

    private static SVGPath icon(String path) {
        SVGPath graphic = new SVGPath();
        graphic.setContent(path);
        graphic.setFill(Color.TRANSPARENT);
        graphic.setStroke(Color.web("#536b73"));
        graphic.setStrokeWidth(1.15);
        return graphic;
    }

    private static boolean isWindowControl(Object target) {
        for (Node node = target instanceof Node ? (Node) target : null; node != null; node = node.getParent()) {
            if (node instanceof Button) return true;
        }
        return false;
    }

    private void rememberPress(MouseEvent event) {
        pressX = event.getScreenX(); pressY = event.getScreenY();
        startX = stage.getX(); startY = stage.getY(); startWidth = stage.getWidth(); startHeight = stage.getHeight();
    }

    private int edgeAt(MouseEvent event) {
        if (maximized) return 0;
        double x = event.getSceneX(), y = event.getSceneY();
        int edge = x <= RESIZE_MARGIN ? LEFT : x >= stage.getScene().getWidth() - RESIZE_MARGIN ? RIGHT : 0;
        return edge | (y <= RESIZE_MARGIN ? TOP : y >= stage.getScene().getHeight() - RESIZE_MARGIN ? BOTTOM : 0);
    }

    private static Cursor cursorFor(int edge) {
        return switch (edge) {
            case LEFT -> Cursor.W_RESIZE;
            case RIGHT -> Cursor.E_RESIZE;
            case TOP -> Cursor.N_RESIZE;
            case BOTTOM -> Cursor.S_RESIZE;
            case LEFT | TOP -> Cursor.NW_RESIZE;
            case RIGHT | TOP -> Cursor.NE_RESIZE;
            case LEFT | BOTTOM -> Cursor.SW_RESIZE;
            case RIGHT | BOTTOM -> Cursor.SE_RESIZE;
            default -> Cursor.DEFAULT;
        };
    }

    private void installResize(Scene scene) {
        scene.addEventFilter(MouseEvent.MOUSE_MOVED, event -> scene.setCursor(cursorFor(edgeAt(event))));
        scene.addEventFilter(MouseEvent.MOUSE_EXITED, event -> { if (resizeEdge == 0) scene.setCursor(Cursor.DEFAULT); });
        scene.addEventFilter(MouseEvent.MOUSE_PRESSED, event -> {
            if (event.getButton() != MouseButton.PRIMARY) return;
            resizeEdge = edgeAt(event);
            if (resizeEdge != 0) { dragging = false; rememberPress(event); event.consume(); }
        });
        scene.addEventFilter(MouseEvent.MOUSE_DRAGGED, event -> {
            if (resizeEdge == 0 || !event.isPrimaryButtonDown()) return;
            Rectangle2D bounds = screenBounds(startX, startY, startWidth, startHeight);
            double left = startX, right = startX + startWidth, top = startY, bottom = startY + startHeight;
            double dx = event.getScreenX() - pressX, dy = event.getScreenY() - pressY;
            if ((resizeEdge & LEFT) != 0) left = clamp(startX + dx, bounds.getMinX(), right - stage.getMinWidth());
            if ((resizeEdge & RIGHT) != 0) right = clamp(right + dx, left + stage.getMinWidth(), bounds.getMaxX());
            if ((resizeEdge & TOP) != 0) top = clamp(startY + dy, bounds.getMinY(), bottom - stage.getMinHeight());
            if ((resizeEdge & BOTTOM) != 0) bottom = clamp(bottom + dy, top + stage.getMinHeight(), bounds.getMaxY());
            stage.setX(left); stage.setY(top); stage.setWidth(right - left); stage.setHeight(bottom - top);
            event.consume();
        });
        scene.addEventFilter(MouseEvent.MOUSE_RELEASED, event -> {
            if (resizeEdge != 0) { resizeEdge = 0; scene.setCursor(Cursor.DEFAULT); event.consume(); }
        });
    }

    private void toggleMaximize() {
        if (maximized) {
            maximized = false;
            if (restoreBounds != null) setBounds(restoreBounds);
            clampToScreen();
        } else {
            restoreBounds = new Rectangle2D(stage.getX(), stage.getY(), stage.getWidth(), stage.getHeight());
            maximized = true;
            setBounds(screenBounds(stage.getX(), stage.getY(), stage.getWidth(), stage.getHeight()));
        }
        updateChrome();
    }

    private void updateChrome() {
        double radius = maximized ? 0 : 10;
        frameClip.setArcWidth(radius * 2); frameClip.setArcHeight(radius * 2);
        frame.setStyle("-fx-background-color:white;-fx-background-radius:" + radius + ";-fx-border-color:#dce5e7;-fx-border-radius:" + radius + ";-fx-border-width:" + (maximized ? 0 : 1) + ";");
        content.setPadding(maximized ? Insets.EMPTY : new Insets(0, 1, 1, 1));
        if (maximizeButton != null) {
            String label = maximized ? "还原窗口" : "最大化窗口";
            maximizeButton.setAccessibleText(label); maximizeButton.getTooltip().setText(label);
            maximizeButton.setGraphic(icon(maximized ? "M5 3h8v8 M3 5h8v8H3z" : "M3 3h10v10H3z"));
        }
    }

    private void setBounds(Rectangle2D bounds) {
        stage.setX(bounds.getMinX()); stage.setY(bounds.getMinY());
        stage.setWidth(bounds.getWidth()); stage.setHeight(bounds.getHeight());
    }

    private static Rectangle2D screenBounds(double x, double y, double width, double height) {
        var screens = Screen.getScreensForRectangle(x, y, width, height);
        return (screens.isEmpty() ? Screen.getPrimary() : screens.get(0)).getVisualBounds();
    }

    private static double clamp(double value, double minimum, double maximum) { return Math.max(minimum, Math.min(value, maximum)); }

    void open(String optionsJson) {
        if (disposed) return;
        try {
            JsonObject options = JsonParser.parseString(optionsJson == null ? "{}" : optionsJson).getAsJsonObject();
            pendingOptions = options.toString();
        } catch (RuntimeException ignored) { pendingOptions = "{}"; }
        clampToScreen();
        stage.setIconified(false);
        stage.show(); stage.toFront(); stage.requestFocus();
        webView.requestFocus();
        applyOptions();
    }

    private void applyOptions() {
        if (!ready || pendingOptions == null) return;
        webView.getEngine().executeScript("window.LkaMatters && window.LkaMatters.open(" + pendingOptions + ");");
        pendingOptions = null;
    }

    private void clampToScreen() {
        Rectangle2D bounds = screenBounds(stage.getX(), stage.getY(), stage.getWidth(), stage.getHeight());
        stage.setMinWidth(Math.min(480, bounds.getWidth())); stage.setMinHeight(Math.min(500, bounds.getHeight()));
        if (maximized) { setBounds(bounds); return; }
        stage.setWidth(Math.min(stage.getWidth(), bounds.getWidth())); stage.setHeight(Math.min(stage.getHeight(), bounds.getHeight()));
        double x = Double.isFinite(stage.getX()) ? stage.getX() : bounds.getMinX() + (bounds.getWidth() - stage.getWidth()) / 2;
        double y = Double.isFinite(stage.getY()) ? stage.getY() : bounds.getMinY() + (bounds.getHeight() - stage.getHeight()) / 2;
        stage.setX(clamp(x, bounds.getMinX(), bounds.getMaxX() - stage.getWidth()));
        stage.setY(clamp(y, bounds.getMinY(), bounds.getMaxY() - stage.getHeight()));
    }

    void dispose() {
        disposed = true; ready = false;
        stage.setOnCloseRequest(null); stage.close(); webView.getEngine().load(null);
    }

    /** Only the existing bounded JSON request protocol is exposed to this WebView. */
    public static final class MatterBridge {
        private final java.util.function.Consumer<String> handler;
        MatterBridge(java.util.function.Consumer<String> handler) { this.handler = handler; }
        public void requestMemory(String payloadJson) { handler.accept(payloadJson); }
    }
}
