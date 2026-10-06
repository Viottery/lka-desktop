package com.agenticrag.pet;

import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpHandler;
import javafx.application.Platform;
import javafx.scene.web.WebView;
import java.lang.reflect.Field;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Isolated WebView -> Java -> HTTP/1.1 -> WebView check; never uses the user's backend. */
public final class PetMemoryBridgeCheck {
    private static WebView view;
    public static void main(String[] args) throws Exception {
        check(PetControlWindow.allowedMemoryRequest("PATCH", "/memories/m1?workspace_path=D%3A%5CWork"), "valid edit");
        check(PetControlWindow.allowedMemoryRequest("GET", "/sessions/s1/context-status"), "valid context");
        check(PetControlWindow.allowedMemoryRequest("GET", "/projects/p1/sessions?limit=50&offset=0&q=%E4%B8%AD%E6%96%87"), "project sessions query");
        check(PetControlWindow.allowedMemoryRequest("POST", "/projects"), "register project");
        check(PetControlWindow.allowedMemoryRequest("PATCH", "/projects/p1"), "rename project");
        check(PetControlWindow.allowedMemoryRequest("POST", "/sessions"), "create project session");
        for (String path : List.of("https://example.com/memories", "//example.com/memories", "/memories?token=secret", "/memories/%2e%2e/agent", "/agent/turn")) {
            check(!PetControlWindow.allowedMemoryRequest("POST", path), "reject unsupported route");
        }
        AtomicReference<String> received = new AtomicReference<>();
        AtomicReference<String> auth = new AtomicReference<>();
        AtomicReference<String> contentType = new AtomicReference<>();
        AtomicReference<String> protocol = new AtomicReference<>();
        AtomicReference<String> qqMethod = new AtomicReference<>();
        AtomicReference<String> qqPath = new AtomicReference<>();
        AtomicReference<String> qqAuth = new AtomicReference<>();
        AtomicReference<String> qqProtocol = new AtomicReference<>();
        AtomicReference<String> proxyMethod = new AtomicReference<>();
        AtomicReference<String> proxyPath = new AtomicReference<>();
        AtomicReference<String> proxyAuth = new AtomicReference<>();
        AtomicReference<String> proxyIntent = new AtomicReference<>();
        AtomicReference<String> proxyBody = new AtomicReference<>();
        AtomicReference<String> proxyProtocol = new AtomicReference<>();
        AtomicReference<Integer> proxyPort = new AtomicReference<>();
        HttpServer backendServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        HttpHandler handler = exchange -> {
            boolean memory = List.of("/memories", "/projects/p1", "/sessions").contains(exchange.getRequestURI().getPath());
            boolean qqStatus = "/plugins/qq-reader/status".equals(exchange.getRequestURI().getPath());
            boolean readingProxy = "/plugins/message-reading/messages/conversations".equals(exchange.getRequestURI().getPath());
            boolean sendProxy = "/plugins/qq-ui/messages/send".equals(exchange.getRequestURI().getPath());
            boolean groupProxy = "/plugins/qq-ui/groups/123".equals(exchange.getRequestURI().getPath());
            if (readingProxy || sendProxy || groupProxy) {
                proxyMethod.set(exchange.getRequestMethod());
                proxyPath.set(exchange.getRequestURI().toString());
                proxyAuth.set(exchange.getRequestHeaders().getFirst("Authorization"));
                proxyIntent.set(exchange.getRequestHeaders().getFirst("X-LKA-UI-Intent"));
                proxyBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                proxyProtocol.set(exchange.getProtocol());
                proxyPort.set(exchange.getLocalAddress().getPort());
            }
            if (memory) {
                received.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                auth.set(exchange.getRequestHeaders().getFirst("Authorization"));
                contentType.set(exchange.getRequestHeaders().getFirst("Content-Type"));
                protocol.set(exchange.getProtocol());
            }
            if (qqStatus) {
                qqMethod.set(exchange.getRequestMethod());
                qqPath.set(exchange.getRequestURI().toString());
                qqAuth.set(exchange.getRequestHeaders().getFirst("Authorization"));
                qqProtocol.set(exchange.getProtocol());
            }
            String result = memory ? "{\"content\":\"真理：保留中文与\\\"引号\\\"\",\"version\":1}"
                    : readingProxy ? "{\"content\":\"合成会话\",\"conversations\":[]}"
                    : sendProxy ? "{\"content\":\"合成发送回执\",\"state\":\"accepted\",\"message_id\":\"synthetic-only\"}"
                    : groupProxy ? "{\"content\":\"自动群名\",\"group_name\":\"自动群名\",\"group_id\":\"123\",\"account_id\":\"456\"}"
                    : qqStatus ? "{\"connected\":true,\"account\":\"test\"}"
                    : "<!doctype html><html><body><script>window.__lkaMemoryBridgeReceive=function(id,status,text){window.memoryResult=id+'|'+status+'|'+JSON.parse(text).content;};window.__lkaQQStatusReceive=function(id,status,text){window.qqStatusResult=id+'|'+status+'|'+text;};</script></body></html>";
            byte[] bytes = result.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", memory || qqStatus || readingProxy || sendProxy || groupProxy ? "application/json; charset=utf-8" : "text/html; charset=utf-8");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes); exchange.close();
        };
        server.createContext("/", handler);
        backendServer.createContext("/", handler);
        server.start();
        backendServer.start();
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
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
        PetControlWindow window = new PetControlWindow(actions, base + "/desktop-pet/chat.html?backend=http://127.0.0.1:" + backendServer.getAddress().getPort(), ".", List.of());
        try {
            window.toggle(100, 100);
            Field field = PetControlWindow.class.getDeclaredField("webView"); field.setAccessible(true);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
            while (System.nanoTime() < deadline) {
                Object ready = fx(() -> { view = (WebView) field.get(window); return view != null && Boolean.TRUE.equals(view.getEngine().executeScript("Boolean(window.petBridge && window.petBridge.requestMemory)")); });
                if (Boolean.TRUE.equals(ready)) break;
                Thread.sleep(100);
            }
            check(Boolean.TRUE.equals(fx(() -> view.getEngine().executeScript("Boolean(window.petBridge && window.petBridge.requestMemory)"))), "bridge ready");
            check(Boolean.TRUE.equals(fx(() -> view.getEngine().executeScript("Boolean(window.petBridge && window.petBridge.requestQQReaderStatus)"))), "QQ status bridge ready");
            fx(() -> view.getEngine().executeScript("petBridge.requestQQReaderStatus('qq-status-testnonce-1')"));
            while (System.nanoTime() < deadline && !Boolean.TRUE.equals(fx(() -> view.getEngine().executeScript("Boolean(window.qqStatusResult)")))) Thread.sleep(50);
            check(String.valueOf(fx(() -> view.getEngine().executeScript("window.qqStatusResult"))).equals("qq-status-testnonce-1|200|{\"connected\":true,\"account\":\"test\"}"), "QQ status callback payload");
            check("GET".equals(qqMethod.get()) && "/plugins/qq-reader/status".equals(qqPath.get()), "fixed QQ status endpoint and GET");
            check(qqAuth.get() == null, "QQ status request has no Authorization header");
            check("HTTP/1.1".equals(qqProtocol.get()), "QQ status HTTP/1.1 transport");
            fx(() -> view.getEngine().executeScript("petBridge.requestMemory(JSON.stringify({id:'memory-testnonce-1',method:'POST',path:'/memories',body:JSON.stringify({content:'使用中文',scope:'global',memory_type:'preference'}),token:'isolated-test-token'}))"));
            while (System.nanoTime() < deadline && !Boolean.TRUE.equals(fx(() -> view.getEngine().executeScript("Boolean(window.memoryResult)")))) Thread.sleep(50);
            String result = String.valueOf(fx(() -> view.getEngine().executeScript("window.memoryResult")));
            check(result.equals("memory-testnonce-1|200|真理：保留中文与\"引号\""), "callback UTF-8 and escaping");
            check(received.get() != null && received.get().contains("使用中文"), "JSON request body");
            check("Bearer isolated-test-token".equals(auth.get()), "Authorization header");
            check(contentType.get().startsWith("application/json"), "JSON content type");
            check("HTTP/1.1".equals(protocol.get()), "HTTP/1.1 transport");
            fx(() -> view.getEngine().executeScript("window.memoryResult='';petBridge.requestMemory(JSON.stringify({id:'memory-testnonce-2',method:'PATCH',path:'/projects/p1',body:JSON.stringify({name:'项目新名称',expected_revision:2}),token:'isolated-test-token'}))"));
            while (System.nanoTime() < deadline && !Boolean.TRUE.equals(fx(() -> view.getEngine().executeScript("Boolean(window.memoryResult)")))) Thread.sleep(50);
            check(String.valueOf(fx(() -> view.getEngine().executeScript("window.memoryResult"))).startsWith("memory-testnonce-2|200|"), "project PATCH callback");
            check(received.get().contains("项目新名称") && received.get().contains("expected_revision"), "project CAS JSON");
            fx(() -> view.getEngine().executeScript("window.memoryResult='';petBridge.requestMemory(JSON.stringify({id:'memory-testnonce-3',method:'POST',path:'/sessions',body:JSON.stringify({project_id:'p1',title:'新会话'}),token:'isolated-test-token'}))"));
            while (System.nanoTime() < deadline && !Boolean.TRUE.equals(fx(() -> view.getEngine().executeScript("Boolean(window.memoryResult)")))) Thread.sleep(50);
            check(String.valueOf(fx(() -> view.getEngine().executeScript("window.memoryResult"))).startsWith("memory-testnonce-3|200|"), "project session callback");
            check(received.get().contains("project_id"), "project session JSON");
            fx(() -> view.getEngine().executeScript("window.memoryResult='';petBridge.requestMemory(JSON.stringify({id:'memory-testnonce-4',method:'GET',path:'/plugins/message-reading/messages/conversations?limit=20&offset=0',token:'must-not-leak'}))"));
            waitForScript("Boolean(window.memoryResult)");
            check("memory-testnonce-4|200|合成会话".equals(String.valueOf(fx(() -> view.getEngine().executeScript("window.memoryResult")))), "reading proxy callback");
            check("GET".equals(proxyMethod.get()), "reading proxy GET method");
            check("/plugins/message-reading/messages/conversations?limit=20&offset=0".equals(proxyPath.get()), "reading proxy path and pagination");
            check(proxyPort.get() == server.getAddress().getPort(), "reading proxy uses frontend origin, not backend");
            check(proxyAuth.get() == null, "reading proxy does not forward JS token");
            check("HTTP/1.1".equals(proxyProtocol.get()), "reading proxy HTTP/1.1 transport");
            fx(() -> view.getEngine().executeScript("window.memoryResult='';petBridge.requestMemory(JSON.stringify({id:'memory-testnonce-5',method:'POST',path:'/plugins/qq-ui/messages/send',body:JSON.stringify({idempotency_key:'synthetic-send-key',conversation_type:'group',conversation_id:'123',segments:[{type:'text',text:'仅本地合成内容'}]}),token:'must-not-leak'}))"));
            waitForScript("Boolean(window.memoryResult)");
            check("memory-testnonce-5|200|合成发送回执".equals(String.valueOf(fx(() -> view.getEngine().executeScript("window.memoryResult")))), "QQ send proxy callback");
            check("POST".equals(proxyMethod.get()) && "/plugins/qq-ui/messages/send".equals(proxyPath.get()), "QQ send proxy POST and exact path");
            check(proxyPort.get() == server.getAddress().getPort(), "QQ send proxy uses frontend origin, not backend");
            check("1".equals(proxyIntent.get()), "QQ send proxy explicit UI intent");
            check(proxyAuth.get() == null && !proxyBody.get().contains("must-not-leak"), "QQ send proxy does not forward JS token");
            check(proxyBody.get().contains("synthetic-send-key") && proxyBody.get().contains("仅本地合成内容"), "QQ send JSON body and idempotency key preserved");
            check("HTTP/1.1".equals(proxyProtocol.get()), "QQ send proxy HTTP/1.1 transport");
            fx(() -> view.getEngine().executeScript("window.memoryResult='';petBridge.requestMemory(JSON.stringify({id:'memory-testnonce-6',method:'GET',path:'/plugins/qq-ui/groups/123?account_id=456',token:'must-not-leak'}))"));
            waitForScript("Boolean(window.memoryResult)");
            check("memory-testnonce-6|200|自动群名".equals(String.valueOf(fx(() -> view.getEngine().executeScript("window.memoryResult")))), "QQ group name callback");
            check("GET".equals(proxyMethod.get()) && "/plugins/qq-ui/groups/123?account_id=456".equals(proxyPath.get()), "QQ group name exact route and account query");
            check(proxyPort.get() == server.getAddress().getPort(), "QQ group name stays on frontend origin");
            check(proxyAuth.get() == null && proxyIntent.get() == null, "QQ group name read has no token or write intent");
            System.out.println("PASS: route constraints and JavaFX memory plus QQ status bridges; status, reading proxy, automatic group name and synthetic QQ send origin/method/path/auth/intent/HTTP1.1/callback verified");
        } finally { window.dispose(); server.stop(0); backendServer.stop(0); Platform.exit(); }
    }
    private static void waitForScript(String expression) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            if (Boolean.TRUE.equals(fx(() -> view.getEngine().executeScript(expression)))) return;
            Thread.sleep(50);
        }
        throw new AssertionError("Timed out waiting for WebView callback");
    }
    private static Object fx(java.util.concurrent.Callable<Object> action) throws Exception {
        CompletableFuture<Object> result = new CompletableFuture<>();
        Platform.runLater(() -> { try { result.complete(action.call()); } catch (Throwable error) { result.completeExceptionally(error); } });
        return result.get(5, TimeUnit.SECONDS);
    }
    private static void check(boolean value, String label) { if (!value) throw new AssertionError(label); }
}
