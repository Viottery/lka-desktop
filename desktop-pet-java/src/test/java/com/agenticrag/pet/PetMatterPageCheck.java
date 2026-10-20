package com.agenticrag.pet;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpServer;
import javafx.application.Platform;
import javafx.scene.web.WebView;
import javafx.stage.Stage;

import java.lang.reflect.Field;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Loads the real matter HTML/JS/CSS in JavaFX, against an isolated fixture backend. */
public final class PetMatterPageCheck {
    private static WebView view;
    public static void main(String[] args) throws Exception {
        String configured = System.getProperty("lka.matter.frontendRoot", System.getenv("LKA_FRONTEND_ROOT"));
        if (configured == null || configured.isBlank()) throw new IllegalArgumentException("Set -Dlka.matter.frontendRoot=<app/web/pet>");
        Path frontend = Path.of(configured).toAbsolutePath().normalize();
        check(Files.isRegularFile(frontend.resolve("matters.html")), "actual matter HTML exists");
        JsonObject task = record("synthetic-task", "task", "中文合成任务");
        task.addProperty("scheduled_on", LocalDate.now().toString());
        JsonObject plan = record("synthetic-plan", "plan", "中文合成规划");
        AtomicReference<JsonObject> savedBody = new AtomicReference<>();
        AtomicInteger syncCalls = new AtomicInteger(), staticAssets = new AtomicInteger();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath(), body, contentType = "application/json; charset=utf-8";
            int status = 200;
            if (path.equals("/matters/sync")) {
                syncCalls.incrementAndGet();
                JsonArray changes = new JsonArray();
                for (JsonObject row : List.of(task, plan)) {
                    JsonObject change = new JsonObject(); change.addProperty("sequence", changes.size() + 1); change.add("matter", row.deepCopy()); changes.add(change);
                }
                JsonObject page = new JsonObject(); page.add("changes", changes); page.addProperty("cursor", 2); page.addProperty("has_more", false); body = page.toString();
            } else if (path.equals("/matters/synthetic-task") && exchange.getRequestMethod().equals("PATCH")) {
                JsonObject patch = JsonParser.parseString(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
                savedBody.set(patch);
                patch.entrySet().forEach(entry -> { if (!entry.getKey().equals("expected_revision")) task.add(entry.getKey(), entry.getValue()); });
                task.addProperty("revision", 2); body = task.toString();
            } else if (path.equals("/projects")) {
                body = "{\"projects\":[],\"next_offset\":null}";
            } else if (path.startsWith("/desktop-pet/")) {
                Path asset = frontend.resolve(path.substring("/desktop-pet/".length())).normalize();
                if (!asset.startsWith(frontend) || !Files.isRegularFile(asset)) { status = 404; body = "missing fixture asset"; }
                else {
                    staticAssets.incrementAndGet(); body = Files.readString(asset);
                    if (path.endsWith(".html")) {
                        contentType = "text/html; charset=utf-8";
                        // Telemetry only: the workspace markup and all production scripts/styles remain real.
                        body = body.replace("<head>", "<head><script>window.fixtureErrors=[];window.addEventListener('error',function(e){window.fixtureErrors.push(e.message||'asset load failed');});window.addEventListener('unhandledrejection',function(e){window.fixtureErrors.push(String(e.reason));});</script>");
                    } else contentType = path.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
                }
            } else { status = 404; body = "{}"; }
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", contentType);
            exchange.sendResponseHeaders(status, bytes.length); exchange.getResponseBody().write(bytes); exchange.close();
        });
        server.start();
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        PetControlWindow control = new PetControlWindow(null, base + "/desktop-pet/chat.html?backend=" + base, ".", List.of());
        try {
            control.openMatters("{}");
            waitFor(() -> {
                Object matter = field(control, "matterWindow");
                if (matter == null) return false;
                view = (WebView) field(matter, "webView");
                return Boolean.TRUE.equals(view.getEngine().executeScript("Boolean(document.getElementById('matterCacheState') && document.getElementById('matterCacheState').textContent.indexOf('已同步')>=0)"));
            });
            // WebKit paints asynchronously after its JS-visible DOM updates.
            if (System.getProperty("lka.matter.screenshot") != null) Thread.sleep(250);
            fx(() -> {
                Stage stage = (Stage) field(field(control, "matterWindow"), "stage");
                check(stage.isShowing() && stage.getScene().getHeight() >= 450, "actual native matter window has usable height");
                check(Boolean.TRUE.equals(script("(function(){var r=document.getElementById('matterWorkspace').getBoundingClientRect();return r.width>=470&&r.height>=450;})()")), "actual workspace CSS has usable dimensions");
                check(Boolean.TRUE.equals(script("document.getElementById('matterList').textContent.indexOf('中文合成任务')>=0")), "real native bridge sync renders Chinese task");
                String screenshot = System.getProperty("lka.matter.screenshot");
                if (screenshot != null && !screenshot.isBlank()) {
                    javax.imageio.ImageIO.write(javafx.embed.swing.SwingFXUtils.fromFXImage(stage.getScene().snapshot(null), null), "png", Path.of(screenshot).toFile());
                }
                script("document.querySelector('[data-matter-view=calendar]').click()");
                check(((Number) script("document.querySelectorAll('#matterCalendar .mc-day').length")).intValue() == 7, "real calendar renders seven week columns");
                check(((Number) script("document.querySelectorAll('#matterCalendar .mc-hour').length")).intValue() == 168, "real calendar renders hourly controls");
                script("document.querySelector('[data-matter-view=all]').click();document.querySelector('[data-matter-open=synthetic-task]').click()");
                check(Boolean.TRUE.equals(script("!document.getElementById('matterEditor').hidden")), "actual editor opens");
                script("var t=document.getElementById('matterEditTitle');t.value='中文任务已修改';t.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('matterSave').click()");
                return null;
            });
            waitFor(() -> savedBody.get() != null && Boolean.TRUE.equals(script("document.getElementById('matterList').textContent.indexOf('中文任务已修改')>=0")));
            JsonObject patch = savedBody.get();
            check(patch.get("expected_revision").getAsInt() == 1 && patch.get("title").getAsString().equals("中文任务已修改"), "actual editor saves optimistic revision and Chinese title");
            check(patch.size() == 2, "actual editor sends only changed title and expected revision");
            check(syncCalls.get() == 1, "warm native workspace mutation does not refetch entire feed");
            check(staticAssets.get() >= 7, "actual HTML, styles and all four scripts were served");
            String errors = String.valueOf(fx(() -> script("JSON.stringify(window.fixtureErrors)")));
            check("[]".equals(errors), "no WebKit page errors: " + errors);
            System.out.println("PASS: actual matters.html/JS/CSS in JavaFX WebView; native handshake and sync; usable layout; Chinese task; seven-day calendar; editor CAS save; no runtime errors");
        } finally { control.dispose(); server.stop(0); Platform.exit(); }
    }
    private static JsonObject record(String id, String kind, String title) {
        JsonObject row = new JsonObject(); row.addProperty("matter_id", id); row.addProperty("kind", kind); row.addProperty("title", title);
        row.addProperty("summary", "本地合成验证，无真实数据"); row.addProperty("status", "open"); row.addProperty("priority", "normal");
        row.addProperty("revision", 1); row.addProperty("inbox", true); row.addProperty("section", ""); row.addProperty("sort_order", 0);
        row.addProperty("created_at", "2026-10-19T00:00:00Z"); row.addProperty("updated_at", "2026-10-19T00:00:00Z");
        for (String key : List.of("due_at", "scheduled_on", "scheduled_start", "scheduled_end", "parent_matter_id", "project_id")) row.add(key, com.google.gson.JsonNull.INSTANCE);
        for (String key : List.of("sections", "source_links", "tags")) row.add(key, new JsonArray());
        row.add("metadata", new JsonObject()); return row;
    }
    private static Object script(String code) { return view.getEngine().executeScript(code); }
    private static Object field(Object object, String name) throws Exception { Field f = object.getClass().getDeclaredField(name); f.setAccessible(true); return f.get(object); }
    private static void waitFor(java.util.concurrent.Callable<Boolean> condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) { if (Boolean.TRUE.equals(fx(condition))) return; Thread.sleep(50); }
        String diagnostics = String.valueOf(fx(() -> view == null ? "no WebView" : script("JSON.stringify({errors:window.fixtureErrors,status:document.getElementById('matterStatus')&&document.getElementById('matterStatus').textContent,cache:document.getElementById('matterCacheState')&&document.getElementById('matterCacheState').textContent})")));
        throw new AssertionError("Timed out waiting for actual matter page: " + diagnostics);
    }
    private static Object fx(java.util.concurrent.Callable<?> action) throws Exception {
        CompletableFuture<Object> result = new CompletableFuture<>();
        Platform.runLater(() -> { try { result.complete(action.call()); } catch (Throwable error) { result.completeExceptionally(error); } });
        return result.get(8, TimeUnit.SECONDS);
    }
    private static void check(boolean condition, String label) { if (!condition) throw new AssertionError(label); }
}
