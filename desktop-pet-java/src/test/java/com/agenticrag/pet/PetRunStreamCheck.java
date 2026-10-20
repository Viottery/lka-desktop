package com.agenticrag.pet;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import javafx.application.Platform;
import javafx.scene.web.WebView;

import java.lang.reflect.Field;
import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Local-only JavaFX bridge check for saved Agent run SSE subscriptions. */
public final class PetRunStreamCheck {
    private static WebView view;

    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        CopyOnWriteArrayList<String> backendRequests = new CopyOnWriteArrayList<>();
        AtomicReference<String> firstProtocol = new AtomicReference<>();
        AtomicReference<String> firstAuthorization = new AtomicReference<>();
        CountDownLatch cancelRequestStarted = new CountDownLatch(1);
        CountDownLatch cancelRequestDisconnected = new CountDownLatch(1);
        server.createContext("/", exchange -> serve(exchange, backendRequests, firstProtocol,
                firstAuthorization, cancelRequestStarted, cancelRequestDisconnected));
        server.start();

        String origin = "http://127.0.0.1:" + server.getAddress().getPort();
        String configuredBackend = origin + "/workbench";
        String pageScript = "<html><body><script>"
                + "window.savedEvents=[];window.savedClosed=[];"
                + "window.__petChatReceiveSavedRunStream=(r,n,d,i)=>window.savedEvents.push([r,n,d,i]);"
                + "window.__petChatSavedRunStreamClosed=(r,e)=>window.savedClosed.push([r,e]);"
                + "</script></body></html>";
        server.createContext("/desktop-pet/chat.html", exchange -> respond(exchange, 200, "text/html", pageScript));

        PetControlActions actions = (PetControlActions) Proxy.newProxyInstance(
                PetControlActions.class.getClassLoader(), new Class<?>[]{PetControlActions.class},
                (proxy, method, methodArgs) -> {
                    return switch (method.getName()) {
                        case "listModels" -> List.of();
                        case "getActiveModelId" -> "";
                        case "isRandomBehaviorEnabled", "hasInteraction" -> false;
                        default -> null;
                    };
                });
        String chatUrl = origin + "/desktop-pet/chat.html?backend="
                + URLEncoder.encode(configuredBackend, StandardCharsets.UTF_8);
        PetControlWindow window = new PetControlWindow(actions, chatUrl, ".", List.of());
        try {
            window.toggle(100, 100);
            Field webViewField = PetControlWindow.class.getDeclaredField("webView");
            webViewField.setAccessible(true);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
            while (System.nanoTime() < deadline) {
                Object ready = fx(() -> {
                    view = (WebView) webViewField.get(window);
                    return view != null && Boolean.TRUE.equals(view.getEngine().executeScript(
                            "Boolean(window.petBridge && window.petBridge.streamSavedRun)"));
                });
                if (Boolean.TRUE.equals(ready)) break;
                Thread.sleep(75);
            }
            check(Boolean.TRUE.equals(fx(() -> view.getEngine().executeScript(
                    "Boolean(window.petBridge && window.petBridge.streamSavedRun)"))), "saved-run bridge ready");

            Field sendField = PetControlWindow.class.getDeclaredField("nativeSendButton");
            Field inputField = PetControlWindow.class.getDeclaredField("nativeInput");
            sendField.setAccessible(true); inputField.setAccessible(true);
            fx(() -> view.getEngine().executeScript("window.primaryCalls=[];window.acceptSend=false;"
                    + "window.__petChatSubmitText=t=>{window.primaryCalls.push(t);return window.acceptSend;};"
                    + "petBridge.setComposerAction('pause');petBridge.setComposerBusy(false);"));
            fx(() -> {
                var button = (javafx.scene.control.Button) sendField.get(window);
                check("暂停任务".equals(button.getAccessibleText()) && !button.isDisabled(), "native pause action is available");
                button.fire(); return null;
            });
            check("[\"\"]".equals(String.valueOf(fx(() -> view.getEngine().executeScript("JSON.stringify(window.primaryCalls)")))), "empty native input forwards pause action");
            fx(() -> view.getEngine().executeScript("petBridge.setComposerAction('resume');"));
            fx(() -> {
                var button = (javafx.scene.control.Button) sendField.get(window);
                check("继续任务".equals(button.getAccessibleText()), "native resume icon and label");
                button.fire(); return null;
            });
            fx(() -> view.getEngine().executeScript("petBridge.setComposerAction('send');petBridge.setComposerBusy(true);"));
            fx(() -> {
                var input = (javafx.scene.control.TextArea) inputField.get(window);
                input.setText("queued draft");
                var button = (javafx.scene.control.Button) sendField.get(window);
                check(button.isDisabled(), "running native draft displays a disabled send action");
                button.fire(); return null;
            });
            check("2".equals(String.valueOf(fx(() -> view.getEngine().executeScript("String(window.primaryCalls.length)")))), "disabled native draft never interrupts or sends");
            fx(() -> view.getEngine().executeScript("window.acceptSend=true;petBridge.setComposerBusy(false);"));
            fx(() -> {
                var button = (javafx.scene.control.Button) sendField.get(window);
                button.fire();
                check(((javafx.scene.control.TextArea) inputField.get(window)).getText().isEmpty(), "accepted paused draft clears native input");
                return null;
            });
            check("queued draft".equals(String.valueOf(fx(() -> view.getEngine().executeScript("window.primaryCalls[2]")))), "native paperplane forwards the new instruction");

            fx(() -> view.getEngine().executeScript("petBridge.streamSavedRun(JSON.stringify({"
                    + "run_id:'run_synthetic_1',after_sequence:17,request_id:'saved-check-1'}))"));
            waitForScript("window.savedClosed.length >= 1");
            JsonArray events = JsonParser.parseString(String.valueOf(fx(
                    () -> view.getEngine().executeScript("JSON.stringify(window.savedEvents)")))).getAsJsonArray();
            check(events.size() == 2, "normal and trailing SSE blocks forwarded");
            check("saved-check-1".equals(events.get(0).getAsJsonArray().get(0).getAsString()), "request id forwarded");
            check("run_progress".equals(events.get(0).getAsJsonArray().get(1).getAsString()), "named event forwarded");
            check("run_synthetic_1:17".equals(events.get(0).getAsJsonArray().get(3).getAsString()), "SSE ID forwarded");
            check("tail".equals(events.get(1).getAsJsonArray().get(1).getAsString()), "trailing named event forwarded at EOF");
            check("run_synthetic_1:18".equals(events.get(1).getAsJsonArray().get(3).getAsString()), "trailing SSE ID forwarded");
            JsonObject firstData = JsonParser.parseString(events.get(0).getAsJsonArray().get(2).getAsString()).getAsJsonObject();
            check("真理".equals(firstData.get("label").getAsString()), "UTF-8 event data forwarded");
            check("他说 \"继续\"".equals(firstData.get("quote").getAsString()), "escaped JSON event data forwarded");
            JsonObject trailingData = JsonParser.parseString(events.get(1).getAsJsonArray().get(2).getAsString()).getAsJsonObject();
            check("trailing".equals(trailingData.get("label").getAsString()), "trailing JSON event data forwarded at EOF");
            JsonArray closed = JsonParser.parseString(String.valueOf(fx(
                    () -> view.getEngine().executeScript("JSON.stringify(window.savedClosed)")))).getAsJsonArray();
            check("saved-check-1".equals(closed.get(0).getAsJsonArray().get(0).getAsString()), "EOF completion request id");
            check(closed.get(0).getAsJsonArray().get(1).getAsString().isEmpty(), "EOF completion has empty error");
            check("GET /workbench/agent/runs/run_synthetic_1/stream?after_sequence=17".equals(backendRequests.get(0)),
                    "configured backend path prefix and sequence preserved");
            check("HTTP/1.1".equals(firstProtocol.get()), "saved-run stream uses HTTP/1.1");
            check(firstAuthorization.get() == null, "saved-run stream has no Authorization header");

            int requestsBeforeInvalid = backendRequests.size();
            fx(() -> view.getEngine().executeScript("petBridge.streamSavedRun(JSON.stringify({"
                    + "run_id:'../not-a-run',after_sequence:19,request_id:'saved-check-invalid'}))"));
            waitForScript("window.savedClosed.length >= 2");
            check(backendRequests.size() == requestsBeforeInvalid, "invalid run id makes no network request");
            JsonArray invalidClosed = JsonParser.parseString(String.valueOf(fx(
                    () -> view.getEngine().executeScript("JSON.stringify(window.savedClosed[1])")))).getAsJsonArray();
            check("saved-check-invalid".equals(invalidClosed.get(0).getAsString()), "invalid request completion id");
            check(!invalidClosed.get(1).getAsString().isEmpty(), "invalid run id reports an error");

            fx(() -> view.getEngine().executeScript("petBridge.streamSavedRun(JSON.stringify({"
                    + "run_id:'run_synthetic_1',after_sequence:20,request_id:'saved-check-cancel'}))"));
            check(cancelRequestStarted.await(5, TimeUnit.SECONDS), "cancellable GET started");
            fx(() -> view.getEngine().executeScript("petBridge.cancelSavedRunStream('saved-check-cancel')"));
            waitForScript("window.savedClosed.length >= 3");
            check(cancelRequestDisconnected.await(5, TimeUnit.SECONDS), "cancel closes only the SSE connection");
            JsonArray cancelClosed = JsonParser.parseString(String.valueOf(fx(
                    () -> view.getEngine().executeScript("JSON.stringify(window.savedClosed[2])")))).getAsJsonArray();
            check("saved-check-cancel".equals(cancelClosed.get(0).getAsString()), "cancel completion request id");
            check("cancelled".equals(cancelClosed.get(1).getAsString()), "cancel completion reason");
            check(backendRequests.size() == requestsBeforeInvalid + 1, "cancel does not send another backend request");
            check(backendRequests.stream().allMatch(request -> request.startsWith("GET ")),
                    "saved-run transport never posts backend cancellation");
            check(backendRequests.stream().allMatch(request -> request.contains("/stream?after_sequence=")),
                    "saved-run transport never calls backend control endpoints");
            System.out.println("PASS: single native action/draft behavior; saved-run SSE prefix, sequence, named events, IDs, UTF-8/JSON, trailing EOF block, validation and subscription-only cancellation");
        } finally {
            window.dispose();
            server.stop(0);
            Platform.exit();
        }
    }

    private static void serve(HttpExchange exchange, List<String> requests,
                              AtomicReference<String> protocol, AtomicReference<String> authorization,
                              CountDownLatch cancelStarted, CountDownLatch cancelDisconnected) throws java.io.IOException {
        String path = exchange.getRequestURI().toString();
        if (!path.startsWith("/workbench/agent/runs/")) {
            respond(exchange, 404, "application/json", "{\"detail\":\"unexpected path\"}");
            return;
        }
        requests.add(exchange.getRequestMethod() + " " + path);
        if (path.endsWith("after_sequence=17")) {
            protocol.set(exchange.getProtocol());
            authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
            exchange.sendResponseHeaders(200, 0);
            try (var output = exchange.getResponseBody()) {
                output.write(("event: run_progress\n"
                        + "id: run_synthetic_1:17\n"
                        + "data: {\"run_id\":\"run_synthetic_1\",\"sequence\":17,\"label\":\"真理\",\"quote\":\"他说 \\\"继续\\\"\"}\n\n")
                        .getBytes(StandardCharsets.UTF_8));
                output.flush();
                output.write(("event: tail\n"
                        + "id: run_synthetic_1:18\n"
                        + "data: {\"run_id\":\"run_synthetic_1\",\"sequence\":18,\"label\":\"trailing\"}\n")
                        .getBytes(StandardCharsets.UTF_8));
            }
            return;
        }
        if (path.endsWith("after_sequence=20")) {
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
            exchange.sendResponseHeaders(200, 0);
            cancelStarted.countDown();
            try (var output = exchange.getResponseBody()) {
                output.write(": keep-alive\n\n".getBytes(StandardCharsets.UTF_8));
                output.flush();
                while (!Thread.currentThread().isInterrupted()) {
                    try {
                        Thread.sleep(100);
                        output.write(": keep-alive\n\n".getBytes(StandardCharsets.UTF_8));
                        output.flush();
                    }
                    catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
                }
            } catch (java.io.IOException disconnected) {
                cancelDisconnected.countDown();
            }
            return;
        }
        respond(exchange, 404, "application/json", "{\"detail\":\"unexpected sequence\"}");
    }

    private static void respond(HttpExchange exchange, int status, String type, String body) throws java.io.IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", type + "; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private static void waitForScript(String expression) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            if (Boolean.TRUE.equals(fx(() -> view.getEngine().executeScript(expression)))) return;
            Thread.sleep(50);
        }
        throw new AssertionError("Timed out waiting for WebView callback: " + expression);
    }

    private static Object fx(java.util.concurrent.Callable<Object> action) throws Exception {
        CompletableFuture<Object> result = new CompletableFuture<>();
        Platform.runLater(() -> {
            try { result.complete(action.call()); }
            catch (Throwable error) { result.completeExceptionally(error); }
        });
        return result.get(5, TimeUnit.SECONDS);
    }

    private static void check(boolean value, String label) {
        if (!value) throw new AssertionError(label);
    }
}
