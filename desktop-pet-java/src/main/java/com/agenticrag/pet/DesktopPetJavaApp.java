package com.agenticrag.pet;

import javafx.animation.Animation;
import javafx.animation.KeyFrame;
import javafx.animation.Timeline;
import javafx.application.Application;
import javafx.application.Platform;
import javafx.concurrent.Worker;
import javafx.geometry.Point2D;
import javafx.geometry.Rectangle2D;
import javafx.scene.Scene;
import javafx.scene.canvas.Canvas;
import javafx.scene.canvas.GraphicsContext;
import javafx.scene.input.MouseButton;
import javafx.scene.input.MouseEvent;
import javafx.scene.layout.StackPane;
import javafx.scene.paint.Color;
import javafx.scene.web.WebView;
import javafx.scene.web.WebEngine;
import javafx.stage.Screen;
import javafx.stage.Stage;
import javafx.stage.StageStyle;
import javafx.util.Duration;

import java.awt.Desktop;
import java.awt.MouseInfo;
import java.awt.PointerInfo;
import java.net.URI;
import java.util.List;

public class DesktopPetJavaApp extends Application {
    private Stage stage;
    private NativeWindowController nativeWindow;
    private String stageTitle;
    private boolean leftDown;
    private boolean clickThroughEnabled;
    private Timeline clickThroughLoop;
    private double dragOffsetX;
    private double dragOffsetY;
    private Timeline webLayerProbeLoop;

    @Override
    public void start(Stage primaryStage) {
        AppOptions options = AppOptions.parse(getParameters().getRaw());

        this.stage = primaryStage;
        this.nativeWindow = new NativeWindowController();
        this.stageTitle = "理事所 · 真理 " + System.nanoTime();

        StackPane root = new StackPane();
        root.setStyle("-fx-background-color: transparent;");

        if (options.staticMode) {
            Canvas canvas = new Canvas(options.width, options.height);
            root.getChildren().add(canvas);
            startStaticRenderer(canvas);
        } else {
            WebView webView = createWebLayer(options);
            root.getChildren().add(webView);
        }

        Scene scene = new Scene(root, options.width, options.height, Color.TRANSPARENT);
        scene.setFill(Color.TRANSPARENT);

        stage.initStyle(StageStyle.TRANSPARENT);
        stage.setScene(scene);
        stage.setResizable(false);
        stage.setAlwaysOnTop(true);
        stage.setTitle(stageTitle);

        installDragHandlers(scene);
        installPanelOpenHandler(scene, options.panelUrl());

        Rectangle2D screen = Screen.getPrimary().getVisualBounds();
        stage.setX(screen.getMaxX() - options.width - 80);
        stage.setY(screen.getMaxY() - options.height - 60);

        stage.show();
        nativeWindow.configurePetWindow(stageTitle, true, true);

        setClickThrough(false);
        if (options.enableClickThrough) {
            clickThroughLoop = new Timeline(new KeyFrame(Duration.millis(60), event -> updateClickThrough(options)));
            clickThroughLoop.setCycleCount(Timeline.INDEFINITE);
            clickThroughLoop.play();
        }

        stage.setOnCloseRequest(event -> {
            if (clickThroughLoop != null) {
                clickThroughLoop.stop();
            }
            if (webLayerProbeLoop != null) {
                webLayerProbeLoop.stop();
            }
            Platform.exit();
        });
    }

    private WebView createWebLayer(AppOptions options) {
        WebView webView = new WebView();
        webView.setContextMenuEnabled(false);
        webView.setStyle("-fx-background-color: rgba(0,0,0,0);");
        WebEngine engine = webView.getEngine();
        engine.load(options.layerUrl());
        engine.getLoadWorker().stateProperty().addListener((obs, oldState, newState) -> {
            if (newState == Worker.State.SUCCEEDED) {
                try {
                    engine.executeScript(
                            "document.documentElement.style.background='transparent';" +
                                    "document.body.style.background='transparent';"
                    );
                } catch (Exception ignored) {
                }
                startWebLayerProbe(engine);
            }
        });
        return webView;
    }

    private void startWebLayerProbe(WebEngine engine) {
        final int[] probes = {0};
        webLayerProbeLoop = new Timeline(new KeyFrame(Duration.millis(1200), event -> {
            probes[0] += 1;
            try {
                Object snapshot = engine.executeScript(
                        "(function(){\n" +
                                "  var hasWebGL = false;\n" +
                                "  try {\n" +
                                "    var c = document.createElement('canvas');\n" +
                                "    hasWebGL = !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));\n" +
                                "  } catch (e) {}\n" +
                                "  var debug = window.__petRenderDebug || null;\n" +
                                "  var hasApp = !!window.__petApp;\n" +
                                "  var bodyClass = document.body ? document.body.className : '';\n" +
                                "  return JSON.stringify({hasWebGL: hasWebGL, hasApp: hasApp, bodyClass: bodyClass, debug: debug});\n" +
                                "})()"
                );
                System.out.println("[DesktopPetJavaApp] web-layer probe #" + probes[0] + " " + snapshot);
            } catch (Exception probeError) {
                System.out.println("[DesktopPetJavaApp] web-layer probe error: " + probeError.getMessage());
            }
            if (probes[0] >= 6) {
                webLayerProbeLoop.stop();
            }
        }));
        webLayerProbeLoop.setCycleCount(Timeline.INDEFINITE);
        webLayerProbeLoop.play();
    }

    private void startStaticRenderer(Canvas canvas) {
        GraphicsContext gc = canvas.getGraphicsContext2D();
        Timeline renderer = new Timeline(new KeyFrame(Duration.millis(33), event -> drawStatic(gc, canvas)));
        renderer.setCycleCount(Animation.INDEFINITE);
        renderer.play();
    }

    private void drawStatic(GraphicsContext gc, Canvas canvas) {
        double w = canvas.getWidth();
        double h = canvas.getHeight();
        double t = System.currentTimeMillis() / 1000.0;
        double bob = Math.sin(t * 2.2) * 4.0;

        gc.clearRect(0, 0, w, h);

        double cx = w / 2.0;
        double bodyY = h * 0.58 + bob;

        gc.setFill(Color.rgb(19, 33, 29, 0.16));
        gc.fillOval(cx - 74, h - 56, 148, 26);

        gc.setFill(Color.rgb(247, 251, 250));
        gc.fillRoundRect(cx - 56, bodyY - 78, 112, 140, 28, 28);
        gc.setStroke(Color.rgb(36, 59, 68));
        gc.setLineWidth(3);
        gc.strokeRoundRect(cx - 56, bodyY - 78, 112, 140, 28, 28);

        gc.setFill(Color.rgb(255, 248, 239));
        gc.fillRoundRect(cx - 66, bodyY - 152, 132, 96, 34, 34);
        gc.strokeRoundRect(cx - 66, bodyY - 152, 132, 96, 34, 34);

        gc.setFill(Color.rgb(38, 50, 56));
        gc.fillOval(cx - 32, bodyY - 116, 10, 10);
        gc.fillOval(cx + 22, bodyY - 116, 10, 10);

        gc.setStroke(Color.rgb(38, 50, 56));
        gc.setLineWidth(3);
        gc.strokeArc(cx - 18, bodyY - 108, 36, 22, 200, 140, javafx.scene.shape.ArcType.OPEN);

        gc.setFill(Color.rgb(82, 127, 149));
        gc.fillRoundRect(cx - 30, bodyY - 52, 60, 80, 14, 14);

        gc.setStroke(Color.rgb(255, 248, 239));
        gc.setLineWidth(16);
        gc.strokeLine(cx - 52, bodyY - 10, cx - 88, bodyY + 28);
        gc.strokeLine(cx + 52, bodyY - 10, cx + 88, bodyY + 28);
    }

    private void installDragHandlers(Scene scene) {
        scene.addEventFilter(MouseEvent.MOUSE_PRESSED, event -> {
            if (event.getButton() != MouseButton.PRIMARY) {
                return;
            }
            leftDown = true;
            setClickThrough(false);
            dragOffsetX = event.getSceneX();
            dragOffsetY = event.getSceneY();
        });

        scene.addEventFilter(MouseEvent.MOUSE_DRAGGED, event -> {
            if (!leftDown) {
                return;
            }
            stage.setX(event.getScreenX() - dragOffsetX);
            stage.setY(event.getScreenY() - dragOffsetY);
        });

        scene.addEventFilter(MouseEvent.MOUSE_RELEASED, event -> {
            if (event.getButton() == MouseButton.PRIMARY) {
                leftDown = false;
            }
        });
    }

    private void installPanelOpenHandler(Scene scene, String panelUrl) {
        scene.addEventFilter(MouseEvent.MOUSE_CLICKED, event -> {
            if (event.getButton() == MouseButton.PRIMARY && event.getClickCount() == 2) {
                try {
                    Desktop.getDesktop().browse(new URI(panelUrl));
                } catch (Exception ignored) {
                }
            }
        });
    }

    private void updateClickThrough(AppOptions options) {
        if (leftDown || !nativeWindow.isWindows()) {
            return;
        }

        PointerInfo pointer = MouseInfo.getPointerInfo();
        if (pointer == null) {
            return;
        }

        java.awt.Point pos = pointer.getLocation();
        Point2D local = new Point2D(pos.getX() - stage.getX(), pos.getY() - stage.getY());
        boolean interactive = isInteractivePoint(local, options.width, options.height);
        setClickThrough(!interactive);
    }

    private boolean isInteractivePoint(Point2D point, int width, int height) {
        if (point.getX() < 0 || point.getY() < 0 || point.getX() >= width || point.getY() >= height) {
            return false;
        }

        double centerX = width / 2.0;
        double centerY = height - Math.min(150, height * 0.28);
        double radiusX = width * 0.30;
        double radiusY = height * 0.30;
        double dx = (point.getX() - centerX) / radiusX;
        double dy = (point.getY() - centerY) / radiusY;
        return dx * dx + dy * dy <= 1.0;
    }

    private void setClickThrough(boolean enabled) {
        if (enabled == clickThroughEnabled) {
            return;
        }
        nativeWindow.setClickThrough(stageTitle, enabled);
        clickThroughEnabled = enabled;
    }

    public static void main(String[] args) {
        launch(args);
    }

    private static class AppOptions {
        final String baseUrl;
        final int width;
        final int height;
        final boolean enableClickThrough;
        final boolean staticMode;

        private AppOptions(String baseUrl, int width, int height, boolean enableClickThrough, boolean staticMode) {
            this.baseUrl = baseUrl;
            this.width = width;
            this.height = height;
            this.enableClickThrough = enableClickThrough;
            this.staticMode = staticMode;
        }

        static AppOptions parse(List<String> rawArgs) {
            String baseUrl = "http://127.0.0.1:8000";
            int width = 360;
            int height = 520;
            boolean enableClickThrough = false;
            boolean staticMode = true;

            for (String arg : rawArgs) {
                if (arg.startsWith("--base-url=")) {
                    baseUrl = arg.substring("--base-url=".length());
                } else if (arg.startsWith("--width=")) {
                    width = parseIntOrDefault(arg.substring("--width=".length()), width);
                } else if (arg.startsWith("--height=")) {
                    height = parseIntOrDefault(arg.substring("--height=".length()), height);
                } else if ("--enable-click-through".equals(arg)) {
                    enableClickThrough = true;
                } else if ("--web-layer".equals(arg)) {
                    staticMode = false;
                } else if ("--static".equals(arg)) {
                    staticMode = true;
                }
            }
            return new AppOptions(trimSlash(baseUrl), width, height, enableClickThrough, staticMode);
        }

        String layerUrl() {
            return baseUrl + "/desktop-pet/?layer=1&javafx=1";
        }

        String panelUrl() {
            return baseUrl + "/desktop-pet/?mode=panel";
        }

        private static int parseIntOrDefault(String raw, int fallback) {
            try {
                return Integer.parseInt(raw);
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }

        private static String trimSlash(String raw) {
            if (raw.endsWith("/")) {
                return raw.substring(0, raw.length() - 1);
            }
            return raw;
        }
    }
}
