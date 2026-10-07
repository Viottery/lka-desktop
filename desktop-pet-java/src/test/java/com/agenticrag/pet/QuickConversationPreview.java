package com.agenticrag.pet;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import javafx.application.Platform;
import javafx.event.Event;
import javafx.embed.swing.SwingFXUtils;
import javafx.geometry.Bounds;
import javafx.scene.Node;
import javafx.scene.Parent;
import javafx.scene.Scene;
import javafx.scene.control.ButtonBase;
import javafx.scene.control.MenuButton;
import javafx.scene.control.TextArea;
import javafx.scene.control.Tooltip;
import javafx.scene.image.WritableImage;
import javafx.scene.input.MouseButton;
import javafx.scene.input.MouseEvent;
import javafx.scene.web.WebView;
import javafx.stage.Stage;

import javax.imageio.ImageIO;
import java.io.IOException;
import java.lang.reflect.Field;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** JavaFX WebView layout preview with synthetic messages and local-only static assets. */
public final class QuickConversationPreview {
    private static WebView webView;

    public static void main(String[] args) throws Exception {
        if (args.length != 1) throw new IllegalArgumentException("Usage: previewQuickConversation <app/web/pet path>");
        Path frontend = Path.of(args[0]).toRealPath();
        if (!Files.isRegularFile(frontend.resolve("chat.css"))) throw new IllegalArgumentException("Missing chat.css: " + frontend);
        Path output = frontend.getParent().getParent().getParent().resolve(".runtime/quick-chat-preview");
        Files.createDirectories(output);

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/desktop-pet/", exchange -> serve(exchange, frontend));
        server.start();
        PetControlActions actions = new PetControlActions() {
            public List<PetModelOption> listModels() { return List.of(); }
            public String getActiveModelId() { return ""; }
            public void switchModel(String id) {}
            public boolean isRandomBehaviorEnabled() { return false; }
            public void setRandomBehaviorEnabled(boolean enabled) {}
            public void playInteraction(String action) {}
            public boolean hasInteraction(String action) { return false; }
            public void reloadModel() {}
            public void increaseScale() {}
            public void decreaseScale() {}
            public void raiseModel() {}
            public void lowerModel() {}
            public void shutdownDesktopPet() {}
        };
        String url = "http://127.0.0.1:" + server.getAddress().getPort()
                + "/desktop-pet/chat.html?backend=http%3A%2F%2F127.0.0.1%3A1";
        PetControlWindow window = new PetControlWindow(actions, url, ".", List.of());
        try {
            window.toggle(100, 100);
            Field viewField = PetControlWindow.class.getDeclaredField("webView");
            viewField.setAccessible(true);
            waitFor(() -> {
                webView = fx(() -> (WebView) viewField.get(window));
                return webView != null && Boolean.TRUE.equals(fx(() -> webView.getEngine().executeScript(
                        "Boolean(window.petBridge && window.PetMarkdown && window.PetMarkdown.available)")));
            }, "WebView bridge and Markdown renderer");

            JsonObject nativeChrome = inspectNativeChrome(window);
            fx(() -> {
                webView.getEngine().executeScript("window.__workbenchRequested=false; window.__petChatOpenWorkbench=function(){window.__workbenchRequested=true;}");
                java.lang.reflect.Method opener = PetControlWindow.class.getDeclaredMethod("openWorkbench");
                opener.setAccessible(true);
                opener.invoke(window);
                if (!Boolean.TRUE.equals(webView.getEngine().executeScript("window.__workbenchRequested")))
                    throw new AssertionError("Native workbench button bypassed the current-session hook");
                if (!getStage(window).isShowing())
                    throw new AssertionError("Quick window hid before the browser launch callback succeeded");
                return null;
            });

            JsonObject report = new JsonObject();
            report.add("nativeChrome", nativeChrome);
            report.add("emptyInputCaret", inspectEmptyInputCaret(window, output));
            report.add("short", preview(window, "short", output.resolve("native-short.png")));
            report.add("markdown", preview(window, "markdown", output.resolve("native-markdown.png")));
            requestHeight(440);
            double[] expandedSize = stageSize(window);
            if (expandedSize[1] <= 250 || expandedSize[1] > 730) throw new AssertionError("Expected expanded auto size: " + expandedSize[1]);
            report.addProperty("expandedWidth", expandedSize[0]);
            report.addProperty("expandedHeight", expandedSize[1]);
            capture(window, output.resolve("native-expanded.png"));

            requestHeight(10000);
            double[] cappedSize = stageSize(window);
            if (cappedSize[1] > 730) throw new AssertionError("Automatic height exceeded 730: " + cappedSize[1]);
            report.addProperty("autoCapHeight", cappedSize[1]);

            dragSouthEdge(window, 36, -48);
            dragSouthEdge(window, 0, -10000);
            dragRightEdge(window, 36);
            double[] manualSize = stageSize(window);
            if (manualSize[1] < 280) throw new AssertionError("Expanded window lost its minimum transcript area: " + manualSize[1]);
            requestHeight(120);
            requestHeight(600);
            double[] afterStreaming = stageSize(window);
            boolean autoUpdatesPreservedManualSize = close(manualSize[0], afterStreaming[0])
                    && close(manualSize[1], afterStreaming[1]);
            if (!autoUpdatesPreservedManualSize) throw new AssertionError("Auto height overwrote the manual size");
            requestHeight(0);
            double[] collapsed = stageSize(window);
            if (!close(collapsed[0], 390) || !close(collapsed[1], 118)) throw new AssertionError("Fresh task did not return to compact size");
            requestHeight(440);
            double[] restored = stageSize(window);
            boolean manualSizeRestored = close(manualSize[0], restored[0]) && close(manualSize[1], restored[1]);
            if (!manualSizeRestored) throw new AssertionError("Manual size was not restored after empty state");
            JsonObject resizeReport = new JsonObject();
            resizeReport.addProperty("manualWidth", manualSize[0]);
            resizeReport.addProperty("manualHeight", manualSize[1]);
            resizeReport.addProperty("autoUpdatesPreservedManualSize", autoUpdatesPreservedManualSize);
            resizeReport.addProperty("collapsedToCompact", close(collapsed[0], 390) && close(collapsed[1], 118));
            resizeReport.addProperty("manualSizeRestored", manualSizeRestored);
            report.add("resize", resizeReport);
            capture(window, output.resolve("native-resized.png"));
            Files.writeString(output.resolve("native-layout-report.json"),
                    new GsonBuilder().setPrettyPrinting().create().toJson(report), StandardCharsets.UTF_8);
            System.out.println(new GsonBuilder().setPrettyPrinting().create().toJson(report));
            System.out.println("Synthetic screenshots saved under " + output);
        } finally {
            window.dispose();
            fx(() -> null);
            server.stop(0);
            Platform.exit();
        }
    }

    private static JsonObject preview(PetControlWindow window, String scenario, Path imagePath) throws Exception {
        fx(() -> webView.getEngine().executeScript("window.makePreview('" + scenario + "')"));
        waitFor(() -> Boolean.TRUE.equals(fx(() -> webView.getEngine().executeScript("Boolean(window.previewReady)"))), scenario + " layout");
        fx(() -> null);
        Thread.sleep(120);
        JsonObject result = JsonParser.parseString((String) fx(() -> webView.getEngine().executeScript("window.previewReport"))).getAsJsonObject();
        double[] stageSize = fx(() -> new double[]{getStage(window).getWidth(), getStage(window).getHeight()});
        result.addProperty("stageWidth", stageSize[0]);
        result.addProperty("stageHeight", stageSize[1]);
        boolean flexMessages = "flex".equals(result.get("messagesDisplay").getAsString());
        if (flexMessages && result.get("computedGap").getAsDouble() <= 0) throw new AssertionError("Quick flex gap missing");
        if (result.get("markdownMinWidth").getAsDouble() != 0) throw new AssertionError("Markdown min-width:0 missing");
        if (result.get("markdownFont").getAsString().isBlank()) throw new AssertionError("Markdown font is empty");
        if (!"none".equals(result.get("rememberDisplay").getAsString())) throw new AssertionError("Message action is crowding quick text");
        if (!"none".equals(result.get("roleLabelDisplay").getAsString())) throw new AssertionError("Repeated role label remains");
        if (!"none".equals(result.get("assistantDetailsDisplay").getAsString())) throw new AssertionError("Runtime details remain in quick view");
        if (!"13px".equals(result.get("markdownFontSize").getAsString())) throw new AssertionError("Reply font must be 13px");
        if (result.get("assistantBubbleWidth").getAsDouble() < result.get("messagesWidth").getAsDouble() - 20) throw new AssertionError("Assistant reading column is narrow");
        result.addProperty("flexGapRelevant", flexMessages);
        result.addProperty("flexGapMatchesLayout", !flexMessages
                || Math.abs(result.get("computedGap").getAsDouble() - result.get("observedGap").getAsDouble()) < 2.5);
        capture(window, imagePath);
        return result;
    }

    private static void capture(PetControlWindow window, Path path) throws Exception {
        Thread.sleep(100);
        fx(() -> {
            Scene scene = getStage(window).getScene();
            int width = Math.max(1, (int) Math.ceil(scene.getWidth()));
            int height = Math.max(1, (int) Math.ceil(scene.getHeight()));
            WritableImage image = scene.snapshot(new WritableImage(width, height));
            if (!ImageIO.write(SwingFXUtils.fromFXImage(image, null), "png", path.toFile())) throw new IOException("No PNG encoder");
            return null;
        });
    }

    private static JsonObject inspectNativeChrome(PetControlWindow window) throws Exception {
        return fx(() -> {
            Stage stage = getStage(window);
            Scene scene = stage.getScene();
            scene.getRoot().applyCss();
            scene.getRoot().layout();
            double chromeHeight = stage.getHeight() - webView.getHeight();
            Field settingsField = PetControlWindow.class.getDeclaredField("settingsMenuButton");
            settingsField.setAccessible(true);
            MenuButton settings = (MenuButton) settingsField.get(window);
            Field inputField = PetControlWindow.class.getDeclaredField("nativeInput");
            inputField.setAccessible(true);
            TextArea nativeInput = (TextArea) inputField.get(window);
            Tooltip tooltip = settings.getTooltip();
            String inputFontFamily = nativeInput.getFont().getFamily();
            String inputFontStyle = nativeInput.getFont().getStyle();
            String tooltipFontFamily = tooltip.getFont().getFamily();
            String tooltipFontStyle = tooltip.getFont().getStyle();
            if (!"Noto Sans SC".equalsIgnoreCase(inputFontFamily)
                    || !"Noto Sans SC".equalsIgnoreCase(tooltipFontFamily)) {
                throw new AssertionError("Native font did not resolve to Noto Sans SC: input="
                        + inputFontFamily + ", tooltip=" + tooltipFontFamily);
            }
            if (!"Regular".equalsIgnoreCase(inputFontStyle)
                    || !"Regular".equalsIgnoreCase(tooltipFontStyle)) {
                throw new AssertionError("Native input/tooltip should be regular weight: input="
                        + inputFontStyle + ", tooltip=" + tooltipFontStyle);
            }
            Node graphic = settings.getGraphic();
            Bounds buttonBounds = settings.localToScene(settings.getBoundsInLocal());
            Bounds graphicBounds = graphic.localToScene(graphic.getBoundsInLocal());
            double centerDx = Math.abs((buttonBounds.getMinX() + buttonBounds.getMaxX()) / 2
                    - (graphicBounds.getMinX() + graphicBounds.getMaxX()) / 2);
            double centerDy = Math.abs((buttonBounds.getMinY() + buttonBounds.getMaxY()) / 2
                    - (graphicBounds.getMinY() + graphicBounds.getMaxY()) / 2);
            if (centerDx > 0.8 || centerDy > 0.8) {
                throw new AssertionError("Settings icon is offset from its hit target: " + centerDx + ", " + centerDy);
            }
            if (settings.getTooltip() == null || settings.getAccessibleText() == null) {
                throw new AssertionError("Settings menu lacks tooltip/accessibility text");
            }
            int accessibleButtons = assertButtonAccessibility(scene.getRoot());
            JsonObject result = new JsonObject();
            result.addProperty("settingsButtonCenterDx", centerDx);
            result.addProperty("settingsButtonCenterDy", centerDy);
            result.addProperty("settingsTooltip", settings.getTooltip().getText());
            result.addProperty("accessibleQuickButtons", accessibleButtons);
            result.addProperty("nativeChromeHeight", chromeHeight);
            result.addProperty("nativeInputFontFamily", inputFontFamily);
            result.addProperty("nativeInputFontStyle", inputFontStyle);
            result.addProperty("nativeTooltipFontFamily", tooltipFontFamily);
            result.addProperty("nativeTooltipFontStyle", tooltipFontStyle);
            return result;
        });
    }

    private static JsonObject inspectEmptyInputCaret(PetControlWindow window, Path output) throws Exception {
        TextArea input = fx(() -> {
            Field field = PetControlWindow.class.getDeclaredField("nativeInput");
            field.setAccessible(true);
            return (TextArea) field.get(window);
        });
        fx(() -> {
            input.clear();
            webView.requestFocus();
            return null;
        });
        Thread.sleep(100);
        fx(() -> {
            javafx.geometry.Point2D point = input.localToScreen(25, 20);
            javafx.scene.robot.Robot robot = new javafx.scene.robot.Robot();
            robot.mouseMove(point);
            robot.mouseClick(MouseButton.PRIMARY);
            return null;
        });
        Thread.sleep(100);
        JsonObject result = fx(() -> {
            if (!input.isFocused() || !getStage(window).isFocused())
                throw new AssertionError("Clicking the empty composer did not focus it");
            JsonObject state = new JsonObject();
            state.addProperty("focused", input.isFocused());
            state.addProperty("empty", input.getText().isEmpty());
            javafx.scene.shape.Path caret = caretPath(input);
            state.addProperty("caretOpacityAfterClick", caret.getOpacity());
            state.addProperty("caretHeight", caret.getBoundsInLocal().getHeight());
            state.addProperty("caretVisible", caret.isVisible());
            if (!caret.isVisible() || caret.getOpacity() < 0.99)
                throw new AssertionError("Empty input should show its native caret immediately after click");
            return state;
        });
        capture(window, output.resolve("native-empty-caret.png"));
        for (double x : new double[]{40, 170, 280}) {
            fx(() -> {
                javafx.geometry.Point2D point = input.localToScreen(x, 20);
                javafx.scene.robot.Robot robot = new javafx.scene.robot.Robot();
                robot.mouseMove(point);
                robot.mouseClick(MouseButton.PRIMARY);
                return null;
            });
            Thread.sleep(100);
            double opacity = fx(() -> caretPath(input).getOpacity());
            if (opacity < 0.99) throw new AssertionError("Repeated empty input click hid the caret at x=" + x);
            Thread.sleep(520);
            double laterOpacity = fx(() -> caretPath(input).getOpacity());
            if (laterOpacity > 0.01) throw new AssertionError("Native caret should retain its normal blink cycle");
        }
        fx(() -> { webView.requestFocus(); return null; });
        Thread.sleep(100);
        if (fx(() -> caretPath(input).getOpacity()) > 0.01)
            throw new AssertionError("Input caret remained visible after focus moved to the transcript");
        fx(() -> {
            input.setText("draft");
            input.selectRange(1, 4);
            input.requestFocus();
            return null;
        });
        Thread.sleep(100);
        fx(() -> {
            if (input.getAnchor() != 1 || input.getCaretPosition() != 4)
                throw new AssertionError("Caret refresh changed the existing selection");
            input.clear();
            return null;
        });
        result.addProperty("repeatedBlankClicksVisible", true);
        result.addProperty("normalBlinkPreserved", true);
        result.addProperty("blurHidesCaret", true);
        result.addProperty("selectionPreserved", true);
        return result;
    }

    private static javafx.scene.shape.Path caretPath(TextArea input) {
        return input.lookupAll("*").stream()
                .filter(node -> node instanceof javafx.scene.shape.Path)
                .map(node -> (javafx.scene.shape.Path) node)
                .filter(path -> path.getBoundsInLocal().getWidth() <= 3
                        && path.getBoundsInLocal().getHeight() > 10)
                .findFirst().orElseThrow(() -> new AssertionError("Native insertion caret has no geometry"));
    }

    private static int assertButtonAccessibility(Node node) {
        int checked = 0;
        if (node instanceof ButtonBase button
                && (button.getStyleClass().contains("pet-quick-footer-button")
                || button.getStyleClass().contains("pet-quick-native-send"))) {
            if (button.getTooltip() == null || button.getAccessibleText() == null
                    || button.getAccessibleText().isBlank()) {
                throw new AssertionError("Quick control missing tooltip/accessibility text: " + button);
            }
            checked++;
        }
        if (node instanceof Parent parent) {
            for (Node child : parent.getChildrenUnmodifiable()) checked += assertButtonAccessibility(child);
        }
        return checked;
    }

    private static void requestHeight(double height) throws Exception {
        fx(() -> webView.getEngine().executeScript("petBridge.setQuickPanelHeight(" + height + ")"));
        fx(() -> null);
        Thread.sleep(80);
    }

    private static double[] stageSize(PetControlWindow window) throws Exception {
        return fx(() -> new double[]{getStage(window).getWidth(), getStage(window).getHeight()});
    }

    private static void dragSouthEdge(PetControlWindow window, double dx, double dy) throws Exception {
        fx(() -> {
            Stage stage = getStage(window);
            Scene scene = stage.getScene();
            double width = scene.getWidth();
            double height = scene.getHeight();
            double x = width / 2;
            double y = height - 2;
            double startScreenX = stage.getX() + x;
            double startScreenY = stage.getY() + y;
            Event.fireEvent(scene, mouse(MouseEvent.MOUSE_PRESSED, x, y, startScreenX, startScreenY,
                    MouseButton.PRIMARY, true));
            Event.fireEvent(scene, mouse(MouseEvent.MOUSE_DRAGGED, x + dx, y + dy,
                    startScreenX + dx, startScreenY + dy, MouseButton.NONE, true));
            Stage resized = getStage(window);
            Scene resizedScene = resized.getScene();
            Event.fireEvent(resizedScene, mouse(MouseEvent.MOUSE_RELEASED,
                    resizedScene.getWidth() / 2, resizedScene.getHeight() - 2,
                    resized.getX() + resizedScene.getWidth() / 2,
                    resized.getY() + resizedScene.getHeight() - 2, MouseButton.PRIMARY, false));
            return null;
        });
    }

    private static void dragRightEdge(PetControlWindow window, double dx) throws Exception {
        fx(() -> {
            Stage stage = getStage(window);
            Scene scene = stage.getScene();
            double x = scene.getWidth() - 2;
            double y = scene.getHeight() / 2;
            double startScreenX = stage.getX() + x;
            double startScreenY = stage.getY() + y;
            Event.fireEvent(scene, mouse(MouseEvent.MOUSE_PRESSED, x, y, startScreenX, startScreenY,
                    MouseButton.PRIMARY, true));
            Event.fireEvent(scene, mouse(MouseEvent.MOUSE_DRAGGED, x + dx, y,
                    startScreenX + dx, startScreenY, MouseButton.NONE, true));
            Stage resized = getStage(window);
            Scene resizedScene = resized.getScene();
            Event.fireEvent(resizedScene, mouse(MouseEvent.MOUSE_RELEASED,
                    resizedScene.getWidth() - 2, resizedScene.getHeight() / 2,
                    resized.getX() + resizedScene.getWidth() - 2,
                    resized.getY() + resizedScene.getHeight() / 2, MouseButton.PRIMARY, false));
            return null;
        });
    }

    private static MouseEvent mouse(javafx.event.EventType<MouseEvent> type, double x, double y,
                                    double screenX, double screenY, MouseButton button, boolean primaryDown) {
        return new MouseEvent(type, x, y, screenX, screenY, button, 1,
                false, false, false, false, primaryDown, false, false,
                false, false, true, null);
    }

    private static boolean close(double left, double right) { return Math.abs(left - right) < 1.5; }

    private static Stage getStage(PetControlWindow window) throws Exception {
        Field field = PetControlWindow.class.getDeclaredField("stage");
        field.setAccessible(true);
        return (Stage) field.get(window);
    }

    private static void serve(HttpExchange exchange, Path frontend) throws IOException {
        String relative = exchange.getRequestURI().getPath().substring("/desktop-pet/".length());
        if (relative.equals("chat.html")) {
            send(exchange, "text/html; charset=utf-8", previewHtml());
            return;
        }
        Path file = frontend.resolve(relative).normalize();
        if (!file.startsWith(frontend) || !Files.isRegularFile(file)) {
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
            return;
        }
        String type = relative.endsWith(".css") ? "text/css; charset=utf-8"
                : relative.endsWith(".js") ? "application/javascript; charset=utf-8" : "application/octet-stream";
        exchange.getResponseHeaders().set("Content-Type", type);
        byte[] bytes = Files.readAllBytes(file);
        exchange.sendResponseHeaders(200, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private static void send(HttpExchange exchange, String type, String text) throws IOException {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", type);
        exchange.sendResponseHeaders(200, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private static String previewHtml() {
        return """
                <!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <link rel="stylesheet" href="/desktop-pet/chat.css"><link rel="stylesheet" href="/desktop-pet/markdown.css">
                <script src="/desktop-pet/vendor/markdown-it-15.0.2.umd.min.js"></script><script src="/desktop-pet/markdown.js"></script>

                </head><body class="quick-mode native-composer"><div class="chat-shell"><main class="chat-main"><section id="messages" class="messages"></section></main></div>
                <script>
                (function(){var messages=document.getElementById('messages');window.previewReady=false;window.previewReport='';
                function add(role,text,markdown,detailsOn){var article=document.createElement('article');article.className='message '+role;var bubble=document.createElement('div');bubble.className='bubble';var label=document.createElement('strong');label.textContent=role==='user'?'你':'真理';bubble.appendChild(label);var body=document.createElement(markdown?'div':'p');body.className='message-content'+(markdown?' markdown-body':'');if(markdown)window.PetMarkdown.render(body,text);else body.textContent=text;bubble.appendChild(body);if(detailsOn){var details=document.createElement('details');details.className='agent-run-details';var summary=document.createElement('summary');summary.textContent='运行过程';details.appendChild(summary);var meta=document.createElement('p');meta.className='agent-run-meta';meta.textContent='trace=synthetic-preview · 已用=workspace';details.appendChild(meta);bubble.appendChild(details);}article.appendChild(bubble);if(role==='user'){var remember=document.createElement('button');remember.type='button';remember.className='memory-message-action';remember.textContent='记住这条';article.appendChild(remember);}messages.appendChild(article);}
                function report(){var s=getComputedStyle(messages),u=messages.querySelector('.message.user'),a=messages.querySelector('.message.assistant'),b=u&&u.querySelector('.bubble'),r=u&&u.querySelector('.memory-message-action'),m=messages.querySelector('.markdown-body'),t=messages.querySelector('.markdown-table-scroll'),d=a&&a.querySelector('.agent-run-details'),x=messages.children[0].getBoundingClientRect(),y=messages.children[1].getBoundingClientRect();return{viewportWidth:document.documentElement.clientWidth,messagesWidth:messages.clientWidth,messagesDisplay:s.display,computedGap:parseFloat(s.rowGap||s.gap)||0,observedGap:y.top-x.bottom,userDisplay:getComputedStyle(u).display,userFlexDirection:getComputedStyle(u).flexDirection,userWidth:u.getBoundingClientRect().width,userBubbleWidth:b.getBoundingClientRect().width,rememberWidth:r.getBoundingClientRect().width,rememberDisplay:getComputedStyle(r).display,roleLabelDisplay:getComputedStyle(b.querySelector('strong')).display,userChildrenWidth:b.getBoundingClientRect().width+r.getBoundingClientRect().width,assistantBubbleWidth:a.querySelector('.bubble').getBoundingClientRect().width,assistantDetailsDisplay:d?getComputedStyle(d).display:'none',markdownMinWidth:parseFloat(getComputedStyle(m).minWidth)||0,markdownFont:getComputedStyle(m).fontFamily,markdownFontSize:getComputedStyle(m).fontSize,markdownWidth:m.getBoundingClientRect().width,tableViewport:t?t.clientWidth:0,tableContent:t?t.scrollWidth:0,messageCount:messages.children.length,scrollHeight:messages.scrollHeight};}
                window.makePreview=function(which){if(window.petBridge)window.petBridge.setComposerBusy(false);messages.replaceChildren();window.previewReady=false;if(which==='short'){add('user','帮我把今天的重点整理成三条。',false,false);add('assistant','今天优先处理：完成项目提案、回复林老师的邮件，再为周会整理数据。',true,false);}else{add('user','请归纳本周的项目进度，给出下一步安排，并附一个简短的状态表。',false,false);add('assistant','本周完成了资料整理和接口联调，接下来集中处理评审反馈。\\n\\n### 下一步\\n\\n- 周二前确认验收口径\\n- 周三完成回归\\n- 周五整理发布说明\\n\\n```python\\ndef ready(items):\\n    return all(item.status == "done" for item in items)\\n```\\n\\n| 工作 | 状态 | 负责人 |\\n| --- | --- | --- |\\n| 接口联调 | 已完成 | 林老师 |\\n| 评审反馈 | 处理中 | 真理 |\\n| 回归检查 | 待开始 | 开发组 |\\n\\n所有条目都保留在当前任务中，后续可以继续补充依据和细节。',true,true);}requestAnimationFrame(function(){requestAnimationFrame(function(){var r=report();window.previewReport=JSON.stringify(r);if(window.petBridge)window.petBridge.setQuickPanelHeight(Math.min(600,Math.max(440,r.scrollHeight)));window.previewReady=true;});});};}());
                </script></body></html>
                """;
    }

    private static void waitFor(Check condition, String label) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < end) { if (condition.ok()) return; Thread.sleep(60); }
        throw new AssertionError("Timed out waiting for " + label);
    }

    private static <T> T fx(Callable<T> action) throws Exception {
        CompletableFuture<T> result = new CompletableFuture<>();
        Platform.runLater(() -> { try { result.complete(action.call()); } catch (Throwable error) { result.completeExceptionally(error); } });
        return result.get(10, TimeUnit.SECONDS);
    }

    @FunctionalInterface private interface Callable<T> { T call() throws Exception; }
    @FunctionalInterface private interface Check { boolean ok() throws Exception; }
}
