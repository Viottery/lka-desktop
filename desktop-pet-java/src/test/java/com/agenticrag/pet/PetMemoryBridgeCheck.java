package com.agenticrag.pet;

import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpHandler;
import javafx.application.Platform;
import javafx.scene.web.WebView;
import javafx.scene.control.TextArea;
import javafx.scene.control.Button;
import javafx.stage.Screen;
import javafx.stage.Stage;
import java.lang.reflect.Field;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Isolated WebView -> Java -> HTTP/1.1 -> WebView check; never uses the user's backend. */
public final class PetMemoryBridgeCheck {
    private static WebView view;
    public static void main(String[] args) throws Exception {
        check(PetControlWindow.allowedMemoryRequest("PATCH", "/memories/m1?workspace_path=D%3A%5CWork"), "valid edit");
        check(PetControlWindow.allowedMemoryRequest("GET", "/sessions/s1/context-status"), "valid context");
        check(PetControlWindow.allowedMemoryRequest("GET", "/projects/p1/sessions?limit=50&offset=0&q=%E4%B8%AD%E6%96%87"), "project sessions query");
        check(PetControlWindow.allowedMemoryRequest("GET", "/matters?kind=task&status=active&offset=0&unscheduled=true"), "matter list");
        check(PetControlWindow.allowedMemoryRequest("GET", "/matters/m1"), "matter detail");
        check(PetControlWindow.allowedMemoryRequest("POST", "/matters"), "create matter");
        check(PetControlWindow.allowedMemoryRequest("PATCH", "/matters/m1"), "update matter");
        check(!PetControlWindow.allowedMemoryRequest("DELETE", "/matters/m1"), "reject matter delete");
        check(!PetControlWindow.allowedMemoryRequest("GET", "/matters?token=secret"), "reject matter query token");
        check(!PetControlWindow.allowedMemoryRequest("PATCH", "/matters/m1?kind=plan"), "reject mutation query");
        check(PetControlWindow.allowedMemoryRequest("POST", "/projects"), "register project");
        check(PetControlWindow.allowedMemoryRequest("PATCH", "/projects/p1"), "rename project");
        check(PetControlWindow.allowedMemoryRequest("POST", "/sessions"), "create project session");
        check(PetControlWindow.allowedMemoryRequest("POST", "/managers/default"), "default manager");
        check(PetControlWindow.allowedMemoryRequest("PATCH", "/managers/s1"), "manager controller");
        check(!PetControlWindow.allowedMemoryRequest("POST", "/managers"), "reject extra manager create");
        check(PetControlWindow.allowedMemoryRequest("GET", "/managers/s1/goals?limit=20&offset=40"), "manager goals pagination");
        for (String feed : List.of("events", "executions", "deliveries")) {
            check(PetControlWindow.allowedMemoryRequest("GET", "/managers/s1/" + feed + "?after=7&limit=20"), "manager feed pagination");
            check(!PetControlWindow.allowedMemoryRequest("GET", "/managers/s1/" + feed + "?offset=1"), "reject wrong feed cursor");
            check(!PetControlWindow.allowedMemoryRequest("POST", "/managers/s1/" + feed), "reject feed write");
        }
        check(PetControlWindow.allowedMemoryRequest("GET", "/sessions/s1/runs?limit=20&offset=40"), "session runs pagination");
        check(PetControlWindow.allowedMemoryRequest("GET", "/sessions/s1/inputs"), "manager input receipts");
        check(PetControlWindow.allowedMemoryRequest("POST", "/sessions/s1/inputs"), "enqueue manager input");
        check(PetControlWindow.allowedMemoryRequest("POST", "/sessions/s1/inputs/resume"), "resume manager input queue");
        check(!PetControlWindow.allowedMemoryRequest("GET", "/sessions/s1/inputs?token=secret"), "reject queue query");
        check(!PetControlWindow.allowedMemoryRequest("GET", "/sessions/s1/inputs/resume"), "reject resume read");
        check(!PetControlWindow.allowedMemoryRequest("DELETE", "/sessions/s1/inputs"), "reject queue delete");
        check(!PetControlWindow.allowedMemoryRequest("POST", "/sessions/s1/inputs/unknown"), "reject unknown queue mutation");
        for (String path : List.of("/managers/s1/goals?after=1", "/managers/s1/goals/g1", "/managers/s1/unknown", "/sessions/s1/runs?after=1", "/sessions/s1/runs?expected_revision=1")) {
            check(!PetControlWindow.allowedMemoryRequest("GET", path), "reject unrequested manager route/query");
        }
        check(!PetControlWindow.allowedMemoryRequest("PATCH", "/managers/s1?expected_revision=1"), "controller revision belongs in body");
        check(!PetControlWindow.allowedMemoryRequest("PATCH", "/sessions/s1/runs"), "session runs is read-only");
        String globalPage = PetControlWindow.workbenchPageUrl("http://127.0.0.1:8780/desktop-pet/chat.html?mode=quick&backend=old", "http://127.0.0.1:8765", "ordinary-session", "ordinary-run", true);
        check(globalPage.equals("http://127.0.0.1:8780/desktop-pet/chat.html?mode=work&backend=http%3A%2F%2F127.0.0.1%3A8765&assistant=global"), "global assistant uses existing backend without ordinary session identity");
        check(PetControlWindow.workbenchPageUrl("http://127.0.0.1:8780/desktop-pet/chat.html?mode=quick", "http://127.0.0.1:8765", "session one", "run-one", false).endsWith("&session_id=session+one&run_id=run-one"), "ordinary workbench keeps session and run handoff");
        check(!PetControlWindow.allowedMemoryRequest("POST", "/managers/default?token=secret"), "reject manager query");
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
        CountDownLatch streamPair = new CountDownLatch(2), releaseManagerStream = new CountDownLatch(1);
        List<JsonObject> streamRequests = new CopyOnWriteArrayList<>();
        ExecutorService backendWorkers = Executors.newCachedThreadPool(task -> { Thread worker = new Thread(task, "synthetic-native-http"); worker.setDaemon(true); return worker; });
        backendServer.setExecutor(backendWorkers);
        HttpHandler handler = exchange -> {
            if ("/agent/turn/stream".equals(exchange.getRequestURI().getPath())) {
                JsonObject body = JsonParser.parseString(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
                streamRequests.add(body);
                String sessionId = body.get("session_id").getAsString();
                if (sessionId.equals("stream-break")) { exchange.close(); return; }
                if (sessionId.equals("stream-error")) {
                    byte[] failure = "{\"detail\":{\"code\":\"session_busy\",\"session_id\":\"stream-error\",\"run_id\":\"existing-run\"}}".getBytes(StandardCharsets.UTF_8);
                    exchange.sendResponseHeaders(409, failure.length); exchange.getResponseBody().write(failure); exchange.close(); return;
                }
                if (sessionId.equals("stream-manager") || sessionId.equals("stream-ordinary")) { streamPair.countDown(); awaitFixtureLatch(streamPair); }
                exchange.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8"); exchange.sendResponseHeaders(200, 0);
                String started = "event: run_started\ndata: {\"session_id\":\"" + sessionId + "\"}\n\n";
                exchange.getResponseBody().write(started.getBytes(StandardCharsets.UTF_8)); exchange.getResponseBody().flush();
                if (sessionId.equals("stream-manager")) awaitFixtureLatch(releaseManagerStream);
                String completed = "event: run_completed\ndata: {\"session_id\":\"" + sessionId + "\"}\n\n";
                exchange.getResponseBody().write(completed.getBytes(StandardCharsets.UTF_8)); exchange.close(); return;
            }
            boolean memory = List.of("/memories", "/projects/p1", "/sessions", "/managers/s1", "/managers/s1/goals", "/managers/s1/events", "/managers/s1/executions", "/managers/s1/deliveries", "/sessions/s1/runs").contains(exchange.getRequestURI().getPath());
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
            checkConcurrentStreamCallbacks(streamRequests, releaseManagerStream);
            checkQuickPanelSizingAndDraft(window);
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
            String[] managerPaths = {"/managers/s1/goals?limit=20&offset=0", "/managers/s1/events?after=7&limit=20", "/managers/s1/executions?after=7&limit=20", "/managers/s1/deliveries?after=7&limit=20", "/sessions/s1/runs?limit=20&offset=0"};
            for (int i = 0; i < managerPaths.length; i++) {
                String id = "memory-managerprobe-" + (10 + i), path = managerPaths[i];
                fx(() -> view.getEngine().executeScript("window.memoryResult='';petBridge.requestMemory(JSON.stringify({id:'" + id + "',method:'GET',path:'" + path + "',token:'isolated-test-token'}))"));
                waitForScript("Boolean(window.memoryResult)");
                check(String.valueOf(fx(() -> view.getEngine().executeScript("window.memoryResult"))).startsWith(id + "|200|"), "manager data async callback");
                check("Bearer isolated-test-token".equals(auth.get()), "manager credential stays in header");
            }
            fx(() -> view.getEngine().executeScript("window.memoryResult='';petBridge.requestMemory(JSON.stringify({id:'memory-managerprobe-20',method:'PATCH',path:'/managers/s1',body:JSON.stringify({expected_revision:7,status:'paused'}),token:'isolated-test-token'}))"));
            waitForScript("Boolean(window.memoryResult)");
            check(received.get().contains("expected_revision") && received.get().contains("paused"), "manager controller CAS body preserved");
            System.out.println("PASS: route constraints and JavaFX memory plus QQ status bridges; status, reading proxy, automatic group name and synthetic QQ send origin/method/path/auth/intent/HTTP1.1/callback verified");
        } finally { window.dispose(); server.stop(0); backendServer.stop(0); backendWorkers.shutdownNow(); Platform.exit(); }
    }
    private static void awaitFixtureLatch(CountDownLatch latch) throws java.io.IOException {
        try { if (!latch.await(8, TimeUnit.SECONDS)) throw new java.io.IOException("Synthetic stream rendezvous timed out"); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new java.io.IOException(error); }
    }
    private static void checkConcurrentStreamCallbacks(List<JsonObject> requests, CountDownLatch releaseManager) throws Exception {
        fx(() -> view.getEngine().executeScript("window.streamEvents=[];window.streamFailures=[];window.__petChatReceiveStream=function(event,data,id){streamEvents.push({event:event,session:data.session_id,id:id,args:arguments.length});};window.__petChatReceive=function(value){streamFailures.push(value);};petBridge.stream(JSON.stringify({question:'manager fixture',conversation_id:'stream-manager',request_id:'native.manager.1'}));petBridge.stream(JSON.stringify({question:'ordinary fixture',conversation_id:'stream-ordinary',request_id:'native.ordinary.2'}));"));
        waitForScript("streamEvents.some(function(e){return e.event==='run_completed'&&e.id==='native.ordinary.2';})&&streamEvents.some(function(e){return e.event==='run_started'&&e.id==='native.manager.1';})");
        check(Boolean.TRUE.equals(fx(() -> view.getEngine().executeScript("!streamEvents.some(function(e){return e.event==='run_completed'&&e.id==='native.manager.1';})"))), "manager stream remains active while ordinary completes");
        releaseManager.countDown();
        waitForScript("streamEvents.some(function(e){return e.event==='run_completed'&&e.id==='native.manager.1';})");
        check(Boolean.TRUE.equals(fx(() -> view.getEngine().executeScript("streamEvents.every(function(e){return e.args===3&&e.id===(e.session==='stream-manager'?'native.manager.1':'native.ordinary.2');})"))), "interleaved native streams retain independent request identities");
        fx(() -> view.getEngine().executeScript("petBridge.stream(JSON.stringify({question:'legacy fixture',conversation_id:'stream-legacy'}));"));
        waitForScript("streamEvents.some(function(e){return e.event==='run_completed'&&e.session==='stream-legacy'&&e.args===2;})");
        fx(() -> view.getEngine().executeScript("petBridge.stream(JSON.stringify({question:'HTTP failure fixture',conversation_id:'stream-error',request_id:'native.error.3'}));petBridge.stream(JSON.stringify({question:'transport failure fixture',conversation_id:'stream-break',request_id:'native.break.4'}));petBridge.stream(JSON.stringify({question:'parse failure fixture',conversation_id:'stream-invalid',request_id:'native.invalid.5',llm_response_mode:'invalid'}));"));
        waitForScript("streamFailures.length===3");
        check(Boolean.TRUE.equals(fx(() -> view.getEngine().executeScript("streamFailures.some(function(e){return e.session_id==='stream-error'&&e.request_id==='native.error.3'&&e.error.indexOf('HTTP 409')>=0;})&&streamFailures.some(function(e){return e.session_id==='stream-break'&&e.request_id==='native.break.4'&&e.error.indexOf('Desktop stream bridge failed')>=0;})&&streamFailures.some(function(e){return e.session_id==='stream-invalid'&&e.request_id==='native.invalid.5'&&e.error.indexOf('parse failed')>=0;})"))), "HTTP, transport and parse failures retain original session and request identity");
        check(requests.stream().noneMatch(body -> body.has("request_id")), "native callback request_id never reaches backend Agent payload");
        check(requests.stream().noneMatch(body -> body.get("session_id").getAsString().equals("stream-invalid")), "invalid stream settings rejected before HTTP");
        System.out.println("PASS: concurrent native stream routing, legacy callback arity and scoped failure identities");
    }
    private static void waitForScript(String expression) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            if (Boolean.TRUE.equals(fx(() -> view.getEngine().executeScript(expression)))) return;
            Thread.sleep(50);
        }
        throw new AssertionError("Timed out waiting for WebView callback");
    }
    private static void checkQuickPanelSizingAndDraft(PetControlWindow window) throws Exception {
        Field stageField = PetControlWindow.class.getDeclaredField("stage"); stageField.setAccessible(true);
        Field inputField = PetControlWindow.class.getDeclaredField("nativeInput"); inputField.setAccessible(true);
        TextArea input = (TextArea) fx(() -> inputField.get(window));
        fx(() -> {
            Stage current = (Stage) stageField.get(window);
            Button global = (Button) current.getScene().lookup("#quickGlobalAssistantButton");
            check(global != null && global.getText().isEmpty() && global.getGraphic() != null
                    && "打开真理".equals(global.getAccessibleText()) && global.getTooltip() != null
                    && "打开真理".equals(global.getTooltip().getText()), "quick window has accessible global assistant icon");
            check(global.getOnAction() != null && Math.abs(global.getWidth() - 24) < 1 && global.isVisible(), "global assistant entry is visible and actionable");
            check(global.localToScene(global.getBoundsInLocal()).getMaxX() <= current.getWidth(), "global assistant entry fits compact quick window");
            return null;
        });
        String draft = "保留这段原生输入草稿";
        fx(() -> { input.setText(draft); return null; });
        for (double contentHeight : new double[]{0, 310, 10000, 0}) {
            fx(() -> view.getEngine().executeScript("petBridge.setQuickPanelHeight(" + contentHeight + ")"));
            double actualHeight = (double) fx(() -> ((Stage) stageField.get(window)).getHeight());
            check(actualHeight >= 118 && actualHeight <= 730, "quick panel height capped for content " + contentHeight);
            if (contentHeight == 0) check(Math.abs(actualHeight - 118) < 2, "quick panel compact height");
            if (contentHeight == 310) check(Math.abs(actualHeight - 422) < 2, "quick panel expands to requested content");
            if (contentHeight == 10000) {
                double expectedHeight = (double) fx(() -> {
                    Stage current = (Stage) stageField.get(window);
                    var screens = Screen.getScreensForRectangle(current.getX(), current.getY(), current.getWidth(), current.getHeight());
                    Screen screen = screens.isEmpty() ? Screen.getPrimary() : screens.get(0);
                    return Math.min(730.0, screen.getVisualBounds().getHeight() - 24);
                });
                check(Math.abs(actualHeight - expectedHeight) < 2, "quick panel clamps oversized content to screen");
            }
            Stage stage = (Stage) fx(() -> stageField.get(window));
            boolean onScreen = Screen.getScreens().stream().anyMatch(screen -> {
                var bounds = screen.getVisualBounds();
                return stage.getX() >= bounds.getMinX() - 1 && stage.getY() >= bounds.getMinY() - 1
                        && stage.getX() + stage.getWidth() <= bounds.getMaxX() + 1
                        && stage.getY() + stage.getHeight() <= bounds.getMaxY() + 1;
            });
            check(onScreen, "quick panel remains within screen bounds");
            check(draft.equals(fx(() -> input.getText())), "quick panel resize preserves native draft");
        }
    }
    private static Object fx(java.util.concurrent.Callable<Object> action) throws Exception {
        CompletableFuture<Object> result = new CompletableFuture<>();
        Platform.runLater(() -> { try { result.complete(action.call()); } catch (Throwable error) { result.completeExceptionally(error); } });
        return result.get(5, TimeUnit.SECONDS);
    }
    private static void check(boolean value, String label) { if (!value) throw new AssertionError(label); }
}
