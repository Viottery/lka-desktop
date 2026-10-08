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
import javafx.scene.input.Clipboard;
import javafx.scene.input.ClipboardContent;
import javafx.scene.input.KeyCode;
import javafx.scene.robot.Robot;
import javafx.scene.input.MouseButton;
import javafx.scene.input.MouseEvent;
import javafx.scene.web.WebView;
import javafx.stage.Stage;
import javafx.beans.value.ChangeListener;

import javax.imageio.ImageIO;
import java.io.IOException;
import java.lang.reflect.Field;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;

/** JavaFX WebView layout preview with synthetic messages and local-only static assets. */
public final class QuickConversationPreview {
    private static WebView webView;
    private static boolean resizeOnlyMode;
    private record Upload(byte[] bytes, String filename, String mediaType) {}
    private static final java.util.Map<String, Upload> uploads = new java.util.concurrent.ConcurrentHashMap<>();

    public static void main(String[] args) throws Exception {
        if (args.length < 1 || args.length > 2) throw new IllegalArgumentException("Usage: previewQuickConversation <app/web/pet path> [--binary-upload-only]");
        Path frontend = Path.of(args[0]).toRealPath();
        if (!Files.isRegularFile(frontend.resolve("chat.css"))) throw new IllegalArgumentException("Missing chat.css: " + frontend);
        resizeOnlyMode = args.length == 2 && "--resize-only".equals(args[1]);
        Path output = frontend.getParent().getParent().getParent().resolve(".runtime/quick-chat-preview");
        Files.createDirectories(output);

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/desktop-pet/", exchange -> serve(exchange, frontend));
        server.createContext("/knowledge/file-types", exchange -> send(exchange, "application/json",
                "{\"file_types\":[{\"extensions\":[\".txt\"],\"index_supported\":true}]}"));
        server.createContext("/sessions/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            if ("POST".equals(exchange.getRequestMethod()) && path.endsWith("/attachments")) {
                byte[] bytes = exchange.getRequestBody().readAllBytes();
                String name = java.net.URLDecoder.decode(exchange.getRequestHeaders().getFirst("X-Filename"), StandardCharsets.UTF_8);
                String type = exchange.getRequestHeaders().getFirst("Content-Type");
                String id = "att_" + String.format("%032x", uploads.size() + 1);
                uploads.put(id, new Upload(bytes, name, type));
                JsonObject metadata = new JsonObject();
                metadata.addProperty("attachment_id", id);
                metadata.addProperty("kind", type.startsWith("image/") ? "image" : "document");
                metadata.addProperty("filename", name);
                metadata.addProperty("media_type", type);
                metadata.addProperty("size_bytes", bytes.length);
                send(exchange, "application/json", metadata.toString());
                return;
            }
            String id = path.replaceAll(".*/attachments/", "").replace("/raw", "");
            Upload upload = uploads.get(id);
            if (upload != null && path.endsWith("/raw")) {
                exchange.getResponseHeaders().set("Content-Type", upload.mediaType());
                exchange.sendResponseHeaders(200, upload.bytes().length);
                exchange.getResponseBody().write(upload.bytes());
                exchange.close();
                return;
            }
            exchange.sendResponseHeaders(404, -1);
            exchange.close();
        });
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
        String pageOrigin = "http://127.0.0.1:" + server.getAddress().getPort();
        String strictOrigin = System.getProperty("lka.preview.uploadBackend", "");
        if (!strictOrigin.isEmpty()) {
            var uri = java.net.URI.create(strictOrigin);
            if (!"127.0.0.1".equals(uri.getHost()) || uri.getPort() < 1 || uri.getPort() == 8765 || uri.getPort() == 8780)
                throw new IllegalArgumentException("ASGI checks require a disposable loopback server");
            var response = java.net.http.HttpClient.newBuilder().version(java.net.http.HttpClient.Version.HTTP_1_1).build().send(
                    java.net.http.HttpRequest.newBuilder(java.net.URI.create(strictOrigin + "/_test/static-source"))
                            .header("Content-Type", "application/json")
                            .POST(java.net.http.HttpRequest.BodyPublishers.ofString("{\"origin\":\"" + pageOrigin + "\"}")).build(),
                    java.net.http.HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) throw new AssertionError("ASGI preview routing failed");
            pageOrigin = strictOrigin;
        }
        String url = pageOrigin + "/desktop-pet/chat.html?backend=http%3A%2F%2F127.0.0.1%3A1";
        PetControlWindow window = new PetControlWindow(actions, url, ".", List.of());
        try {
            window.toggle(100, 100);
            Field viewField = PetControlWindow.class.getDeclaredField("webView");
            viewField.setAccessible(true);
            boolean resizeOnly = args.length == 2 && "--resize-only".equals(args[1]);
            waitFor(() -> {
                webView = fx(() -> (WebView) viewField.get(window));
                return webView != null && Boolean.TRUE.equals(fx(() -> webView.getEngine().executeScript(
                        resizeOnly
                                ? "Boolean(window.petBridge && window.PetMarkdown && window.PetMarkdown.available && window.__petResizePreviewReady)"
                                : "Boolean(window.petBridge && window.PetMarkdown && window.PetMarkdown.available)")));
            }, resizeOnly ? "real quick-chat sizing preview" : "WebView bridge and Markdown renderer");

            if (resizeOnly) {
                JsonObject result = runResizeRegression(window, output);
                Files.writeString(output.resolve("native-resize-feedback-report.json"),
                        new GsonBuilder().setPrettyPrinting().create().toJson(result), StandardCharsets.UTF_8);
                System.out.println(new GsonBuilder().setPrettyPrinting().create().toJson(result));
                if (result.get("nonConvergingScenarios").getAsString().length() > 0)
                    throw new AssertionError("Native window did not converge: " + result.get("nonConvergingScenarios"));
                return;
            }

            if (args.length == 2 && "--binary-upload-only".equals(args[1])) {
                JsonObject result = checkRealBinaryUpload();
                Files.writeString(output.resolve("native-binary-upload-report.json"), result.toString(), StandardCharsets.UTF_8);
                System.out.println(result);
                return;
            }
            JsonObject nativeChrome = inspectNativeChrome(window);
            JsonObject nativeImageCheck = checkNativeImageClipboardAndSubmit(window);
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
            report.add("nativeImageClipboard", nativeImageCheck);
            report.add("nativeBinaryUpload", checkRealBinaryUpload());
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

    private static JsonObject checkNativeImageClipboardAndSubmit(PetControlWindow window) throws Exception {
        fx(() -> {
            webView.getEngine().executeScript("window.__nativeOriginalGlobals={"
                    + "imageOwn:Object.prototype.hasOwnProperty.call(window,'LkaImageComposer'),image:window.LkaImageComposer,"
                    + "contextOwn:Object.prototype.hasOwnProperty.call(window,'LkaChatContext'),context:window.LkaChatContext,"
                    + "submitOwn:Object.prototype.hasOwnProperty.call(window,'__petChatSubmitText'),submit:window.__petChatSubmitText};");
            return null;
        });
        try {
            return checkNativeImageClipboardAndSubmitWithMocks(window);
        } finally {
            fx(() -> {
                webView.getEngine().executeScript("(function(){var old=window.__nativeOriginalGlobals;if(!old)return;"
                        + "if(old.imageOwn)window.LkaImageComposer=old.image;else delete window.LkaImageComposer;"
                        + "if(old.contextOwn)window.LkaChatContext=old.context;else delete window.LkaChatContext;"
                        + "if(old.submitOwn)window.__petChatSubmitText=old.submit;else delete window.__petChatSubmitText;"
                        + "if(window.__nativeOriginalFetch){window.fetch=window.__nativeOriginalFetch;delete window.__nativeOriginalFetch;}"
                        + "delete window.__nativeOriginalGlobals;})()");
                return null;
            });
        }
    }

    private static JsonObject checkNativeImageClipboardAndSubmitWithMocks(PetControlWindow window) throws Exception {
        Field inputField = PetControlWindow.class.getDeclaredField("nativeInput");
        inputField.setAccessible(true);
        TextArea input = fx(() -> (TextArea) inputField.get(window));
        fx(() -> {
            webView.getEngine().executeScript("window.nativeTestSession='session-origin';"
                    + "window.nativeContextReads=0;"
                    + "window.nativeImageCalls=[];window.nativeSubmitCalls=[];"
                    + "window.LkaChatContext={get:function(){window.nativeContextReads++;return {sessionId:window.nativeTestSession}}};"
                    + "window.LkaImageComposer={errorText:function(message){window.nativeImageError=message},"
                    + "addNativeFile:function(name,type,encoded,sessionId){"
                    + "window.nativeImageCalls.push({name:name,type:type,encoded:encoded,sessionId:sessionId});"
                    + "return Promise.resolve(true)},addNativeImage:function(name,type,encoded,sessionId){"
                    + "return this.addNativeFile(name,type,encoded,sessionId)}};"
                    + "window.__petChatSubmitText=function(text){window.nativeSubmitCalls.push(text);return true};"
                    + "petBridge.setComposerBusy(false)");
            return null;
        });
        fx(() -> null);

        Clipboard clipboard = fx(Clipboard::getSystemClipboard);
        ClipboardContent text = new ClipboardContent();
        text.putString("ordinary paste");
        fx(() -> {
            if (!clipboard.setContent(text)) throw new AssertionError("Could not set text clipboard content");
            input.clear();
            input.requestFocus();
            robotPaste();
            return null;
        });
        waitFor(() -> "ordinary paste".equals(fx(input::getText)), "normal native text paste");

        WritableImage pixels = new WritableImage(2, 2);
        pixels.getPixelWriter().setArgb(0, 0, 0xffff0000);
        pixels.getPixelWriter().setArgb(1, 0, 0xff00ff00);
        pixels.getPixelWriter().setArgb(0, 1, 0xff0000ff);
        pixels.getPixelWriter().setArgb(1, 1, 0xffffffff);
        ClipboardContent image = new ClipboardContent();
        image.putImage(pixels);
        Field workerField = PetControlWindow.class.getDeclaredField("IMAGE_WORKER");
        workerField.setAccessible(true);
        ExecutorService imageWorker = (ExecutorService) workerField.get(null);
        CountDownLatch workerEntered = new CountDownLatch(1), releaseWorker = new CountDownLatch(1);
        imageWorker.execute(() -> {
            workerEntered.countDown();
            try { releaseWorker.await(); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); }
        });
        if (!workerEntered.await(5, TimeUnit.SECONDS)) throw new AssertionError("Image worker did not enter test gate");
        try {
            fx(() -> {
                if (!clipboard.setContent(image)) throw new AssertionError("Could not set image clipboard content");
                if (!clipboard.hasImage()) throw new AssertionError("JavaFX system clipboard did not expose the written image; formats=" + clipboard.getContentTypes());
                input.clear();
                input.requestFocus();
                robotPaste();
                return null;
            });
            waitFor(() -> ((Number) fx(() -> webView.getEngine().executeScript("window.nativeContextReads"))).intValue() > 0,
                    "native image paste context capture");
            fx(() -> {
                // The clipboard key event captured session-origin. Change selection while image processing is gated.
                webView.getEngine().executeScript("window.nativeTestSession='session-after-switch'");
                return null;
            });
        } finally {
            releaseWorker.countDown();
        }
        waitFor(() -> Boolean.TRUE.equals(fx(() -> webView.getEngine().executeScript(
                "Boolean(window.nativeImageCalls && window.nativeImageCalls.length===1)"))), "native image JS dispatch");
        if (!fx(input::getText).isEmpty()) throw new AssertionError("Image clipboard paste inserted text into native input");
        JsonObject captured = JsonParser.parseString((String) fx(() -> webView.getEngine().executeScript(
                "JSON.stringify(window.nativeImageCalls[0])"))).getAsJsonObject();
        String encoded = captured.get("encoded").getAsString();
        byte[] png = java.util.Base64.getDecoder().decode(encoded);
        var decoded = ImageIO.read(new java.io.ByteArrayInputStream(png));
        if (decoded == null || decoded.getWidth() != 2 || decoded.getHeight() != 2
                || (decoded.getRGB(0, 0) & 0x00ffffff) != 0x00ff0000)
            throw new AssertionError("Clipboard PNG bytes did not preserve source pixels");
        if (!"session-origin".equals(captured.get("sessionId").getAsString()))
            throw new AssertionError("Image was routed to a later session instead of its originating session");
        if (!"image/png".equals(captured.get("type").getAsString()))
            throw new AssertionError("Clipboard image did not dispatch as PNG");

        Path textFile = Files.createTempFile("lka-native-mixed-", ".txt");
        Path pdfFile = Files.createTempFile("lka-native-mixed-", ".pdf");
        Path unsupportedFile = Files.createTempFile("lka-native-mixed-", ".bin");
        byte[] textBytes = "native text attachment".getBytes(StandardCharsets.UTF_8);
        byte[] pdfBytes = new byte[] { '%', 'P', 'D', 'F', '-', '1', '.', '7' };
        Files.write(textFile, textBytes);
        Files.write(pdfFile, pdfBytes);
        ClipboardContent mixedFiles = new ClipboardContent();
        mixedFiles.putFiles(List.of(textFile.toFile(), pdfFile.toFile(), unsupportedFile.toFile()));
        fx(() -> {
            webView.getEngine().executeScript("window.nativeTestSession='session-file-origin'");
            return null;
        });
        CountDownLatch filesWorkerEntered = new CountDownLatch(1), releaseFilesWorker = new CountDownLatch(1);
        imageWorker.execute(() -> {
            filesWorkerEntered.countDown();
            try { releaseFilesWorker.await(); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); }
        });
        if (!filesWorkerEntered.await(5, TimeUnit.SECONDS)) throw new AssertionError("Attachment worker did not enter test gate");
        try {
            fx(() -> {
                if (!clipboard.setContent(mixedFiles)) throw new AssertionError("Could not set mixed file clipboard content");
                var paste = PetControlWindow.class.getDeclaredMethod("pasteClipboardImages");
                paste.setAccessible(true);
                if (!Boolean.TRUE.equals(paste.invoke(window))) throw new AssertionError("Mixed file clipboard was not consumed");
                return null;
            });
            waitFor(() -> ((Number) fx(() -> webView.getEngine().executeScript("window.nativeContextReads"))).intValue() > 1,
                    "native mixed file paste context capture");
            fx(() -> {
                webView.getEngine().executeScript("window.nativeTestSession='session-after-file-switch'");
                return null;
            });
        } finally {
            releaseFilesWorker.countDown();
        }
        waitFor(() -> Boolean.TRUE.equals(fx(() -> webView.getEngine().executeScript(
                "Boolean(window.nativeImageCalls && window.nativeImageCalls.length===3)"))), "mixed file JS dispatch");
        JsonObject capturedText = JsonParser.parseString((String) fx(() -> webView.getEngine().executeScript(
                "JSON.stringify(window.nativeImageCalls[1])"))).getAsJsonObject();
        JsonObject capturedPdf = JsonParser.parseString((String) fx(() -> webView.getEngine().executeScript(
                "JSON.stringify(window.nativeImageCalls[2])"))).getAsJsonObject();
        if (!"application/octet-stream".equals(capturedText.get("type").getAsString())
                || !"application/octet-stream".equals(capturedPdf.get("type").getAsString()))
            throw new AssertionError("Native documents did not use application/octet-stream");
        if (!textFile.getFileName().toString().equals(capturedText.get("name").getAsString())
                || !java.util.Arrays.equals(textBytes, java.util.Base64.getDecoder().decode(capturedText.get("encoded").getAsString()))
                || !pdfFile.getFileName().toString().equals(capturedPdf.get("name").getAsString())
                || !java.util.Arrays.equals(pdfBytes, java.util.Base64.getDecoder().decode(capturedPdf.get("encoded").getAsString())))
            throw new AssertionError("Mixed native document clipboard payloads were not preserved");
        if (!"session-file-origin".equals(capturedText.get("sessionId").getAsString())
                || !"session-file-origin".equals(capturedPdf.get("sessionId").getAsString()))
            throw new AssertionError("Native documents were routed to a later session instead of their originating session");
        if (!"已跳过不支持的文件".equals(fx(() -> webView.getEngine().executeScript("window.nativeImageError"))))
            throw new AssertionError("Unsupported clipboard file did not produce concise feedback");
        Files.deleteIfExists(textFile);
        Files.deleteIfExists(pdfFile);
        Files.deleteIfExists(unsupportedFile);

        fx(() -> {
            input.clear();
            var method = PetControlWindow.class.getDeclaredMethod("submitNativeInput");
            method.setAccessible(true);
            method.invoke(window);
            return null;
        });
        waitFor(() -> Boolean.TRUE.equals(fx(() -> webView.getEngine().executeScript(
                "Boolean(window.nativeSubmitCalls && window.nativeSubmitCalls.length===1)"))), "image-only native submit");
        String submitted = (String) fx(() -> webView.getEngine().executeScript(
                "window.nativeSubmitCalls[0]"));
        if (!submitted.isEmpty()) throw new AssertionError("Image-only native submit did not pass empty text to JS");

        Field statusField = PetControlWindow.class.getDeclaredField("nativeImageStatus");
        statusField.setAccessible(true);
        boolean fallbackStatusVisible = fx(() -> {
            javafx.scene.control.Label status = (javafx.scene.control.Label) statusField.get(window);
            return status.isVisible() || status.isManaged();
        });
        if (fallbackStatusVisible) throw new AssertionError("Successful native image paste left a fallback status row visible");

        // Restore the original page hooks before loading the real module. Its local decoder should
        // succeed, while attachment preparation rejects before any network request can be made.
        fx(() -> {
            webView.getEngine().executeScript("(function(){var old=window.__nativeOriginalGlobals;"
                    + "if(old.imageOwn)window.LkaImageComposer=old.image;else delete window.LkaImageComposer;"
                    + "if(old.contextOwn)window.LkaChatContext=old.context;else delete window.LkaChatContext;"
                    + "if(old.submitOwn)window.__petChatSubmitText=old.submit;else delete window.__petChatSubmitText;"
                    + "var ids=['composerAttachments','attachmentNotice','uploadAttachmentButton','attachmentMenu',"
                    + "'imageFileInput','cachedFileInput','chooseImageButton','chooseFileButton','questionInput'];"
                    + "ids.forEach(function(id){if(document.getElementById(id))return;var node=document.createElement(id==='questionInput'?'textarea':'div');node.id=id;document.body.appendChild(node);});"
                    + "window.realImageSession='session-real-module';window.realPrepareCalls=0;window.realFetchCalls=0;"
                    + "window.__nativeOriginalFetch=window.fetch;window.fetch=function(){window.realFetchCalls++;return Promise.reject(new Error('unexpected test fetch'));};"
                    + "window.LkaChatContext={get:function(){return {sessionId:window.realImageSession,backend:'http://127.0.0.1:1'}},"
                    + "prepareAttachments:function(){window.realPrepareCalls++;return Promise.reject(new Error('synthetic prepare rejection'));}};"
                    + "window.realModuleReady=false;var script=document.createElement('script');"
                    + "script.src='/desktop-pet/image-composer.js?native-check='+Date.now();"
                    + "script.onload=function(){window.realModuleReady=!!(window.LkaImageComposer&&window.LkaImageComposer.addNativeImage);};"
                    + "script.onerror=function(){window.realModuleError='module load failed';window.realModuleReady=true;};document.body.appendChild(script);})()");
            return null;
        });
        waitFor(() -> Boolean.TRUE.equals(fx(() -> webView.getEngine().executeScript("window.realModuleReady"))),
                "real image-composer module load");
        Object moduleError = fx(() -> webView.getEngine().executeScript("window.realModuleError || ''"));
        if (moduleError != null && !moduleError.toString().isEmpty())
            throw new AssertionError("Real image-composer module did not load: " + moduleError);
        fx(() -> {
            webView.getEngine().executeScript("window.LkaImageComposer.addNativeImage('native-check.png','image/png','"
                    + encoded + "','session-real-module').then(function(ok){window.realAddResult=ok;});");
            return null;
        });
        waitFor(() -> Boolean.TRUE.equals(fx(() -> webView.getEngine().executeScript(
                "typeof window.realAddResult==='boolean'"))), "real module addNativeImage result");
        if (!Boolean.TRUE.equals(fx(() -> webView.getEngine().executeScript("window.realAddResult"))))
            throw new AssertionError("Real image-composer rejected the synthetic PNG before local preview");
        waitFor(() -> Boolean.TRUE.equals(fx(() -> webView.getEngine().executeScript(
                "(function(){var panel=document.getElementById('composerAttachments'),image=panel&&panel.querySelector('img'),status=panel&&panel.querySelector('small');"
                        + "return !!(image&&image.naturalWidth===2&&image.naturalHeight===2&&status&&status.textContent.indexOf('上传失败')>=0"
                        + "&&window.realPrepareCalls===1&&window.LkaImageComposer.hasImages('session-real-module'));})()"))),
                "real File decode, thumbnail, and local upload failure state");
        int fetchCalls = ((Number) fx(() -> webView.getEngine().executeScript("window.realFetchCalls"))).intValue();
        if (fetchCalls != 0) throw new AssertionError("Synthetic attachment preparation unexpectedly reached fetch");
        fx(() -> {
            webView.getEngine().executeScript("window.fetch=window.__nativeOriginalFetch;delete window.__nativeOriginalFetch");
            return null;
        });

        JsonObject result = new JsonObject();
        result.addProperty("ordinaryTextPastePreserved", true);
        result.addProperty("imagePasteConsumed", true);
        result.addProperty("pixelsRoundTripped", true);
        result.addProperty("originatingSessionPreserved", true);
        result.addProperty("mixedDocumentClipboardRoundTripped", true);
        result.addProperty("documentOriginatingSessionPreserved", true);
        result.addProperty("unsupportedClipboardFileRejectedWithFeedback", true);
        result.addProperty("imageOnlySubmitPassedEmptyText", true);
        result.addProperty("successStatusHidden", true);
        result.addProperty("realWebKitFileDecodeAndThumbnail", true);
        result.addProperty("realModuleUploadFailureState", true);
        result.addProperty("noNetworkRequestMade", true);
        return result;
    }

    private static JsonObject checkRealBinaryUpload() throws Exception {
        String external = System.getProperty("lka.preview.uploadBackend", "");
        if (!external.isEmpty()) {
            var uri = java.net.URI.create(external);
            if (!"127.0.0.1".equals(uri.getHost()) || uri.getPort() < 1 || uri.getPort() == 8765 || uri.getPort() == 8780)
                throw new IllegalArgumentException("Binary upload checks require a disposable loopback server");
        }
        String backendScript = external.isEmpty() ? "location.origin" : new com.google.gson.JsonPrimitive(external).toString();
        fx(() -> {
            webView.getEngine().executeScript("window.binaryUploadBackend=" + backendScript + ";(function(){"
                    + "['composerAttachments','attachmentNotice','uploadAttachmentButton','attachmentMenu','imageFileInput','cachedFileInput','chooseImageButton','chooseFileButton','questionInput'].forEach(function(id){"
                    + "if(document.getElementById(id))return;var node=document.createElement(id==='questionInput'?'textarea':'div');node.id=id;document.body.appendChild(node);});"
                    + "window.LkaChatContext={get:function(){return {sessionId:'session-binary-upload',backend:window.binaryUploadBackend};},prepareAttachments:function(id){return Promise.resolve(id);}};"
                    + "window.realBinaryModuleReady=false;var script=document.createElement('script');script.src='/desktop-pet/image-composer.js?binary-check='+Date.now();"
                    + "script.onload=function(){window.realBinaryModuleReady=!!window.LkaImageComposer;};document.body.appendChild(script);})()");
            return null;
        });
        waitFor(() -> Boolean.TRUE.equals(fx(() -> webView.getEngine().executeScript("window.realBinaryModuleReady"))),
                "real binary upload module load");
        byte[] png = syntheticPng(2, 2);
        byte[] largePng = syntheticPng(1400, 1200);
        if (largePng.length < 4 * 1024 * 1024) throw new AssertionError("Large image fixture must exercise multi-megabyte uploads");
        byte[] text = "真实 WebView 合成文件上传".getBytes(StandardCharsets.UTF_8);
        fx(() -> {
            webView.getEngine().executeScript("window.realImageSession='session-binary-upload';"
                    + "window.LkaChatContext.get=function(){return {sessionId:window.realImageSession,backend:window.binaryUploadBackend};};"
                    + "window.LkaChatContext.prepareAttachments=function(id){return Promise.resolve(id);};"
                    + "window.realUploadDone=false;window.realUploadError='';"
                    + "window.LkaImageComposer.addNativeFile('截图.png','image/png','"
                    + java.util.Base64.getEncoder().encodeToString(png) + "','session-binary-upload');"
                    + "window.LkaImageComposer.addNativeFile('文档.txt','application/octet-stream','"
                    + java.util.Base64.getEncoder().encodeToString(text) + "','session-binary-upload');"
                    + "window.LkaImageComposer.addNativeFile('大图片.png','image/png','"
                    + java.util.Base64.getEncoder().encodeToString(largePng) + "','session-binary-upload');"
                    + "window.LkaImageComposer.prepare(window.LkaImageComposer.capture('session-binary-upload'),'session-binary-upload')"
                    + ".then(function(ids){window.realUploadIds=ids;window.realUploadDone=true;})"
                    + ".catch(function(error){window.realUploadError=error.message;window.realUploadDone=true;});");
            return null;
        });
        waitFor(() -> Boolean.TRUE.equals(fx(() -> webView.getEngine().executeScript("window.realUploadDone"))),
                "real WebView mixed binary POST");
        String error = (String) fx(() -> webView.getEngine().executeScript("window.realUploadError"));
        if (!error.isEmpty()) throw new AssertionError("Real binary upload failed: " + error);
        var ids = JsonParser.parseString((String) fx(() -> webView.getEngine().executeScript(
                "JSON.stringify(window.realUploadIds)"))).getAsJsonArray();
        if (ids.size() != 3 || external.isEmpty() && uploads.size() != 3) throw new AssertionError("Expected three real attachment uploads");
        Upload image = receivedUpload(external, ids.get(0).getAsString());
        Upload document = receivedUpload(external, ids.get(1).getAsString());
        Upload largeImage = receivedUpload(external, ids.get(2).getAsString());
        if (!java.util.Arrays.equals(largePng, largeImage.bytes()) || !"大图片.png".equals(largeImage.filename()))
            throw new AssertionError("Large image upload was truncated or changed");
        if (!java.util.Arrays.equals(png, image.bytes()) || !"截图.png".equals(image.filename())
                || !"image/png".equals(image.mediaType())) throw new AssertionError("Image bytes or headers changed");
        if (!java.util.Arrays.equals(text, document.bytes()) || !"文档.txt".equals(document.filename())
                || !"application/octet-stream".equals(document.mediaType())) throw new AssertionError("Document bytes or headers changed");
        JsonObject report = new JsonObject();
        report.addProperty("realWebViewImagePost", true);
        report.addProperty("realWebViewDocumentPost", true);
        report.addProperty("rawBytesAndUnicodeFilenamesPreserved", true);
        report.addProperty("mixedAttachmentIdsReadyForTurn", true);
        report.addProperty("largeImageBytes", largePng.length);
        report.addProperty("strictAsgiServer", !external.isEmpty());
        report.addProperty("noDailyBackendContacted", true);
        return report;
    }

    private static byte[] syntheticPng(int width, int height) throws IOException {
        var image = new java.awt.image.BufferedImage(width, height, java.awt.image.BufferedImage.TYPE_INT_RGB);
        var random = new java.util.Random(42);
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) image.setRGB(x, y, random.nextInt());
        var bytes = new java.io.ByteArrayOutputStream();
        if (!ImageIO.write(image, "png", bytes)) throw new AssertionError("PNG encoder missing");
        return bytes.toByteArray();
    }

    private static Upload receivedUpload(String external, String id) throws Exception {
        if (external.isEmpty()) return uploads.get(id);
        var client = java.net.http.HttpClient.newBuilder().version(java.net.http.HttpClient.Version.HTTP_1_1).build();
        String path = external + "/sessions/session-binary-upload/attachments/" + id;
        var metadataResponse = client.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(path)).GET().build(), java.net.http.HttpResponse.BodyHandlers.ofString());
        var rawResponse = client.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(path + "/raw")).GET().build(), java.net.http.HttpResponse.BodyHandlers.ofByteArray());
        if (metadataResponse.statusCode() != 200 || rawResponse.statusCode() != 200) throw new AssertionError("Could not verify captured synthetic upload");
        var metadata = JsonParser.parseString(metadataResponse.body()).getAsJsonObject();
        return new Upload(rawResponse.body(), metadata.get("filename").getAsString(), metadata.get("media_type").getAsString());
    }

    private static void robotPaste() {
        Robot robot = new Robot();
        robot.keyPress(KeyCode.CONTROL);
        robot.keyPress(KeyCode.V);
        robot.keyRelease(KeyCode.V);
        robot.keyRelease(KeyCode.CONTROL);
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
            send(exchange, "text/html; charset=utf-8", resizeOnlyMode ? resizePreviewHtml(frontend) : previewHtml());
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

    private static String resizePreviewHtml(Path frontend) throws IOException {
        String html = Files.readString(frontend.resolve("chat.html"), StandardCharsets.UTF_8);
        // Keep the real page and CSS, but omit app bootstrap and every script except
        // Markdown rendering and the production quick sizing code below.
        html = html.replaceAll("(?is)<script\\b[^>]*>.*?</script\\s*>", "");
        html = html.replaceFirst("(?i)<body(?:\\s[^>]*)?>", "<body class=\"quick-mode native-composer\">");
        String harness = """
                <script>
                window.__petResizePreviewErrors=[];
                window.addEventListener('error',function(){window.__petResizePreviewErrors.push('script-error');});
                window.LkaChatContext={get:function(){return {sessionId:'synthetic-resize-preview',busy:false};},startProjectDraft:function(){}};
                window.__petChatBridgeReady=function(){};
                window.__petChatOpenFreshTask=function(){};
                window.__petResizePreviewReady=false;
                </script>
                <script src=\"./vendor/markdown-it-15.0.2.umd.min.js\"></script>
                <script src=\"./markdown.js\"></script>
                <script src=\"./quick-chat.js\"></script>
                <script>
                (function(){
                  var messages=document.getElementById('messages'), status=document.getElementById('runStatus');
                  var png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p6sAAAAASUVORK5CYII=';
                  var formula='The normalized residual r = y - Xβ measures the part of the observation the model does not explain. Under ordinary least squares, Xᵀr = 0, so residuals are orthogonal to every fitted predictor. This gives a useful diagnostic: a visible pattern in r suggests missing structure, while large isolated values may indicate unusual observations. Standardizing by the estimated noise scale makes residual magnitudes comparable across features and helps distinguish model error from measurement noise.';
                  var mathAnswer='这是链式法则的题，把 f 看成经 x、y 绕了一层：\\n\\n∂f/∂s = ∂f/∂x · ∂x/∂s + ∂f/∂y · ∂y/∂s\\n\\nf = e^(xy)，所以 ∂f/∂x = y·e^(xy)，∂f/∂y = x·e^(xy)；而 x = s 对 s 求导是 1，y = cos t 里没有 s，∂y/∂s = 0。\\n\\n所以后面那一整项直接消掉，只剩 y·e^(xy)。把 x = s、y = cos t 代回去：\\n\\n∂f/∂s = cos t · e^(s·cos t)\\n\\n这题的关键在于 y 只跟 t 有关。';
                  function article(role,text,withImage){
                    var row=document.createElement('article');row.className='message '+role;
                    var bubble=document.createElement('div');bubble.className='bubble';
                    var label=document.createElement('strong');label.textContent=role==='user'?'你':'真理';bubble.appendChild(label);
                    var body=document.createElement(role==='assistant'?'div':'p');body.className='message-content'+(role==='assistant'?' markdown-body':'');
                    if(role==='assistant')window.PetMarkdown.render(body,text);else body.textContent=text;
                    bubble.appendChild(body);
                    if(withImage){var images=document.createElement('div');images.className='message-images';var link=document.createElement('a');link.className='message-image';link.href=png;var image=document.createElement('img');image.alt='合成的任务图片';image.dataset.syntheticImage='true';image.style.width='220px';image.style.height='110px';var caption=document.createElement('span');caption.textContent='test.png';link.appendChild(image);link.appendChild(caption);images.appendChild(link);bubble.appendChild(images);window.__pendingPreviewImage=image;window.__pendingPreviewCard=images;}
                    row.appendChild(bubble);messages.appendChild(row);return row;
                  }
                  window.__makeResizePreviewCase=function(kind){
                    messages.replaceChildren();status.hidden=true;status.classList.remove('error');
                    var ask=kind==='short'?'这题怎么做':kind==='medium'?'请结合图片详细说明模型误差的来源，并给出逐步检查建议。':'请结合图片解释这个估计结果，并说明残差诊断可以支持哪些判断。';
                    article('user',ask,true);
                    var answer=kind==='short'?'残差是观测值与模型预测值之间的差。':kind==='medium'?formula.slice(0,269):kind==='math'?mathAnswer:formula;
                    article('assistant',answer,false);
                    if(kind==='threshold'){
                      var target=messages.querySelector('.message.assistant .message-content');
                      var thresholdText=Array(2).fill(formula).join('\\n\\n');
                      window.PetMarkdown.render(target,thresholdText);
                    }
                    if(kind==='long'){
                      var extra='\\n\\n### 解释边界\\n\\n'+formula+'\\n\\n'+formula;
                      var target=messages.querySelector('.message.assistant .message-content');
                      window.PetMarkdown.render(target,answer+extra);
                    }
                    if(kind==='delayed-image'){window.__pendingPreviewCard.hidden=true;setTimeout(function(){
                      var image=window.__pendingPreviewImage;if(!image)return;
                      image.src=png;window.__pendingPreviewCard.hidden=false;
                    },450);}
                    else {var image=window.__pendingPreviewImage;image.src=png;}
                  };
                  window.__clearResizePreview=function(){messages.replaceChildren();};
                  window.__petResizePreviewReady=true;
                }());
                </script>
                </body>
                """;
        return html.replaceFirst("(?i)</body>", java.util.regex.Matcher.quoteReplacement(harness));
    }

    private record SizeSample(long millis, double width, double height, double x, double y) {}

    private static JsonObject runResizeRegression(PetControlWindow window, Path output) throws Exception {
        Stage stage = getStage(window);
        List<SizeSample> samples = new java.util.concurrent.CopyOnWriteArrayList<>();
        ChangeListener<Number> listener = (observable, oldValue, newValue) -> samples.add(new SizeSample(
                System.currentTimeMillis(), stage.getWidth(), stage.getHeight(), stage.getX(), stage.getY()));
        fx(() -> {
            stage.widthProperty().addListener(listener);
            stage.heightProperty().addListener(listener);
            stage.xProperty().addListener(listener);
            stage.yProperty().addListener(listener);
            return null;
        });

        JsonObject report = new JsonObject();
        List<String> nonConvergingScenarios = new java.util.ArrayList<>();
        for (String scenario : List.of("short", "medium", "delayed-image", "math", "threshold", "long")) {
            samples.clear();
            fx(() -> { webView.getEngine().executeScript("window.__makeResizePreviewCase('" + scenario + "')"); return null; });
            Thread.sleep(2200);
            JsonObject observation = inspectSettledSamples(samples);
            observation.add("layout", readResizeMetrics());
            double[] bounds = fx(() -> new double[]{stage.getWidth(), stage.getHeight(), stage.getX(), stage.getY()});
            observation.addProperty("stageWidth", bounds[0]);
            observation.addProperty("stageHeight", bounds[1]);
            observation.addProperty("stageX", bounds[2]);
            observation.addProperty("stageY", bounds[3]);
            observation.addProperty("scenario", scenario);
            report.add(scenario, observation);
            if (observation.get("lateDimensionChanges").getAsInt() > 1
                    || observation.get("latePositionChanges").getAsInt() > 1
                    || observation.get("lateHeightRange").getAsDouble() > 1.5
                    || observation.get("lateXRange").getAsDouble() > 1.5
                    || observation.get("lateYRange").getAsDouble() > 1.5) {
                nonConvergingScenarios.add(scenario);
            }
        }

        samples.clear();
        dragSouthEdge(window, 0, 70);
        double[] manual = stageSize(window);
        fx(() -> { webView.getEngine().executeScript("window.__makeResizePreviewCase('long')"); return null; });
        Thread.sleep(1800);
        double[] afterLong = stageSize(window);
        boolean manualPreserved = close(manual[0], afterLong[0]) && close(manual[1], afterLong[1]);
        if (!manualPreserved) nonConvergingScenarios.add("manual-resize");

        fx(() -> { webView.getEngine().executeScript("window.__clearResizePreview()"); return null; });
        waitFor(() -> {
            double[] size = stageSize(window);
            return close(size[0], 390) && close(size[1], 118);
        }, "compact reset after clearing synthetic transcript");
        JsonObject transitions = new JsonObject();
        transitions.addProperty("manualResizeHeight", manual[1]);
        transitions.addProperty("manualResizePreserved", manualPreserved);
        transitions.addProperty("compactReset", true);
        report.add("manualAndReset", transitions);
        report.addProperty("bootstrapErrorCount", fx(() -> ((Number) webView.getEngine()
                .executeScript("window.__petResizePreviewErrors.length")).intValue()));
        report.addProperty("usesProductionQuickChat", true);
        report.addProperty("usesActualCss", true);
        if (report.get("bootstrapErrorCount").getAsInt() != 0) nonConvergingScenarios.add("bootstrap-error");
        report.addProperty("nonConvergingScenarios", String.join(",", nonConvergingScenarios));
        fx(() -> {
            stage.widthProperty().removeListener(listener);
            stage.heightProperty().removeListener(listener);
            stage.xProperty().removeListener(listener);
            stage.yProperty().removeListener(listener);
            return null;
        });
        return report;
    }

    private static JsonObject inspectSettledSamples(List<SizeSample> samples) {
        long cutoff = System.currentTimeMillis() - 700;
        double minHeight = Double.POSITIVE_INFINITY, maxHeight = Double.NEGATIVE_INFINITY;
        double minX = Double.POSITIVE_INFINITY, maxX = Double.NEGATIVE_INFINITY;
        double minY = Double.POSITIVE_INFINITY, maxY = Double.NEGATIVE_INFINITY;
        int lateChanges = 0;
        int latePositionChanges = 0;
        SizeSample previous = null;
        for (SizeSample sample : samples) {
            if (sample.millis() < cutoff) continue;
            minHeight = Math.min(minHeight, sample.height());
            maxHeight = Math.max(maxHeight, sample.height());
            minX = Math.min(minX, sample.x()); maxX = Math.max(maxX, sample.x());
            minY = Math.min(minY, sample.y()); maxY = Math.max(maxY, sample.y());
            if (previous != null && (!close(previous.width(), sample.width()) || !close(previous.height(), sample.height()))) lateChanges++;
            if (previous != null && (!close(previous.x(), sample.x()) || !close(previous.y(), sample.y()))) latePositionChanges++;
            previous = sample;
        }
        if (!Double.isFinite(minHeight)) minHeight = maxHeight = 0;
        if (!Double.isFinite(minX)) minX = maxX = 0;
        if (!Double.isFinite(minY)) minY = maxY = 0;
        JsonObject result = new JsonObject();
        result.addProperty("resizeEvents", samples.size());
        result.addProperty("lateDimensionChanges", lateChanges);
        result.addProperty("latePositionChanges", latePositionChanges);
        result.addProperty("lateHeightRange", maxHeight - minHeight);
        result.addProperty("lateXRange", maxX - minX);
        result.addProperty("lateYRange", maxY - minY);
        return result;
    }

    private static JsonObject readResizeMetrics() throws Exception {
        String json = (String) fx(() -> webView.getEngine().executeScript("JSON.stringify((function(){"
                + "var m=document.getElementById('messages'),r=m.getBoundingClientRect();"
                + "var rows=Array.prototype.map.call(m.children,function(n){return Math.ceil(n.getBoundingClientRect().height);});"
                + "return {viewportWidth:document.documentElement.clientWidth,transcriptWidth:m.clientWidth,"
                + "transcriptNaturalHeight:m.scrollHeight,reportedHeight:document.body.getAttribute('data-quick-content-height'),"
                + "transcriptOverflow:getComputedStyle(m).overflowY,rowHeights:rows,rowCount:m.children.length};})())"));
        return JsonParser.parseString(json).getAsJsonObject();
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
