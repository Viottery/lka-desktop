package com.agenticrag.pet;

import com.sun.net.httpserver.HttpServer;
import javafx.application.Platform;
import javafx.event.Event;
import javafx.scene.control.Button;
import javafx.scene.Node;
import javafx.scene.input.MouseButton;
import javafx.scene.input.MouseEvent;
import javafx.scene.input.PickResult;
import javafx.stage.StageStyle;
import javafx.scene.shape.Rectangle;
import javafx.scene.control.TextArea;
import javafx.scene.web.WebView;
import javafx.stage.Screen;
import javafx.stage.Stage;
import javafx.stage.WindowEvent;

import java.lang.reflect.Field;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Real JavaFX windows and isolated HTTP fixtures, without the pet or daily backend. */
public final class PetMatterWindowCheck {
    public static void main(String[] args) throws Exception {
        check(PetControlWindow.allowedMemoryRequest("GET", "/matters/sync?after=0&limit=20"), "sync allowed");
        check(!PetControlWindow.allowedMemoryRequest("PATCH", "/matters/sync"), "sync is read-only");
        check(!PetControlWindow.allowedMemoryRequest("GET", "/matters/sync?token=secret"), "sync query allowlist");
        AtomicReference<String> auth = new AtomicReference<>();
        AtomicReference<String> requested = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            String body;
            if (path.equals("/matters/sync")) {
                requested.set(exchange.getRequestURI().toString());
                auth.set(exchange.getRequestHeaders().getFirst("Authorization"));
                body = "{\"items\":[],\"label\":\"中文事项\"}";
            } else if (path.equals("/desktop-pet/matters.html")) {
                body = """
                    <!doctype html><html><body><textarea id="draft" style="height:180px">事项草稿</textarea><script>
                    window.readyCount=0; window.openCount=0;
                    window.LkaMatters={open:function(options){window.openCount++;window.lastOptions=options;}};
                    window.__lkaMemoryBridgeReceive=function(id,status,text){window.memoryResult=id+'|'+status+'|'+JSON.parse(text).label;};
                    window.__petMatterBridgeReady=function(){window.readyCount++;petBridge.requestMemory(JSON.stringify({id:'memory-mattertest-1',method:'GET',path:'/matters/sync?after=0&limit=20',token:'isolated-test-token'}));};
                    </script></body></html>
                    """;
            } else {
                body = "<!doctype html><html><body><script>window.__lkaMemoryBridgeReceive=function(){window.wrongCallback=true;};</script></body></html>";
            }
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", path.equals("/matters/sync") ? "application/json; charset=utf-8" : "text/html; charset=utf-8");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
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
        PetControlWindow control = new PetControlWindow(actions, base + "/desktop-pet/chat.html?backend=" + base, ".", List.of());
        try {
            control.toggle(100, 100);
            waitFor(() -> {
                WebView quick = (WebView) field(control, "webView");
                return quick != null && Boolean.TRUE.equals(quick.getEngine().executeScript("Boolean(window.petBridge)"));
            });
            WebView quick = (WebView) fx(() -> field(control, "webView"));
            Stage quickStage = (Stage) fx(() -> field(control, "stage"));
            double[] quickBounds = (double[]) fx(() -> {
                ((TextArea) field(control, "nativeInput")).setText("快速提问草稿");
                quick.getEngine().executeScript("petBridge.setQuickPanelHeight(0)");
                return new double[]{quickStage.getX(), quickStage.getY(), quickStage.getWidth(), quickStage.getHeight()};
            });
            check(quickBounds[3] < 150, "start with compact empty quick window");
            fx(() -> {
                Button todo = quickStage.getScene().getRoot().lookupAll(".button").stream()
                        .filter(node -> node instanceof Button b && b.getTooltip() != null && b.getTooltip().getText().equals("待办与规划"))
                        .map(node -> (Button) node).findFirst().orElseThrow();
                todo.fire();
                return null;
            });
            waitFor(() -> {
                Object matter = field(control, "matterWindow");
                return matter != null && Boolean.TRUE.equals(((WebView) field(matter, "webView")).getEngine().executeScript("Boolean(window.memoryResult)"));
            });
            Object matter = fx(() -> field(control, "matterWindow"));
            Stage matterStage = (Stage) fx(() -> field(matter, "stage"));
            WebView matterView = (WebView) fx(() -> field(matter, "webView"));
            fx(() -> {
                check(matterStage != quickStage && matterView != quick, "independent Stage and WebView");
                check(matterStage.isShowing() && matterStage.getScene().getHeight() >= 450, "usable matter content height");
                check(matterStage.isResizable() && matterStage.getModality() == javafx.stage.Modality.NONE, "nonmodal resizable surface");
                check(quickStage.isShowing(), "opening matters preserves quick visibility");
                assertQuickUnchanged(control, quickStage, quickBounds);
                check("memory-mattertest-1|200|中文事项".equals(matterView.getEngine().executeScript("window.memoryResult")), "actual async callback reaches originating matter page");
                check(Boolean.FALSE.equals(quick.getEngine().executeScript("Boolean(window.wrongCallback)")), "callback never reaches quick page");
                check(!matterView.getEngine().getLocation().contains("isolated-test-token"), "credential absent from page URL");
                check(Boolean.TRUE.equals(matterView.getEngine().executeScript("new URLSearchParams(location.search).get('native')==='1'")), "native handshake mode");
                matterView.getEngine().executeScript("document.getElementById('draft').value='保留编辑';window.localMarker=42");
                matterStage.setWidth(620); matterStage.setHeight(550);
                return null;
            });
            // Let the native window manager commit the resize before simulating the next click.
            waitFor(() -> Math.abs(matterStage.getWidth() - 620) < 1 && Math.abs(matterStage.getHeight() - 550) < 1);
            Thread.sleep(150);
            checkWindowChrome(matter, matterStage);
            fx(() -> {
                quick.getEngine().executeScript("petBridge.openMatters(JSON.stringify({projectId:'p1'}))");
                check(field(control, "matterWindow") == matter, "repeated open reuses window");
                check(matterStage.isShowing(), "repeated open shows reusable window");
                check("p1".equals(matterView.getEngine().executeScript("window.lastOptions.projectId")), "options routed to standalone page");
                Event.fireEvent(matterStage, new WindowEvent(matterStage, WindowEvent.WINDOW_CLOSE_REQUEST));
                check(!matterStage.isShowing(), "close hides independent window");
                quickStage.hide();
                quick.getEngine().executeScript("petBridge.openMatters('{}')");
                check(!quickStage.isShowing() && matterStage.isShowing(), "reopen does not show quick");
                check(matterStage.getWidth() == 620 && matterStage.getHeight() == 550, "retain resized bounds: " + matterStage.getWidth() + "x" + matterStage.getHeight());
                check("保留编辑".equals(matterView.getEngine().executeScript("document.getElementById('draft').value")), "close/reopen retains edit draft");
                check(((Number) matterView.getEngine().executeScript("window.readyCount")).intValue() == 1, "close/reopen retains loaded page");
                assertQuickUnchanged(control, quickStage, quickBounds);
                check(Screen.getScreens().stream().anyMatch(screen -> {
                    var bounds = screen.getVisualBounds();
                    return matterStage.getX() >= bounds.getMinX() - 1 && matterStage.getY() >= bounds.getMinY() - 1
                            && matterStage.getX() + matterStage.getWidth() <= bounds.getMaxX() + 1
                            && matterStage.getY() + matterStage.getHeight() <= bounds.getMaxY() + 1;
                }), "matter window fits screen");
                return null;
            });
            check("/matters/sync?after=0&limit=20".equals(requested.get()), "bounded backend route");
            check("Bearer isolated-test-token".equals(auth.get()), "credential transported only as header");
            control.dispose();
            fx(() -> { check(!matterStage.isShowing(), "pet disposal closes matter child"); return null; });
            System.out.println("PASS: independent reusable matter Stage; compact quick bounds/draft preserved; resize/reopen/options; real async WebView callback origin and credential transport");
        } finally {
            control.dispose(); server.stop(0); Platform.exit();
        }
    }

    private static void checkWindowChrome(Object matter, Stage stage) throws Exception {
        Node title = (Node) fx(() -> stage.getScene().lookup("#matterWindowTitlebar"));
        Node root = (Node) fx(() -> stage.getScene().getRoot());
        Button maximize = (Button) fx(() -> stage.getScene().lookup("#matterWindowMaximize"));
        double[] normal = (double[]) fx(() -> new double[]{stage.getX(), stage.getY(), stage.getWidth(), stage.getHeight()});
        fx(() -> {
            check(stage.getStyle() == StageStyle.TRANSPARENT, "custom chrome replaces system window frame");
            check(title != null && Math.abs(title.getBoundsInParent().getHeight() - 36) < 1, "compact 36px titlebar");
            check(stage.getScene().lookup("#matterWindowMinimize") != null && maximize != null && stage.getScene().lookup("#matterWindowClose") != null, "native chrome has three window controls");
            check(((Rectangle) field(matter, "frameClip")).getArcWidth() == 20, "normal frame clips WebView to 10px rounded corners");
            mouse(title, MouseEvent.MOUSE_PRESSED, 100, 18, normal[0] + 100, normal[1] + 18, 1, true);
            mouse(title, MouseEvent.MOUSE_DRAGGED, 120, 33, normal[0] + 120, normal[1] + 33, 1, true);
            mouse(title, MouseEvent.MOUSE_RELEASED, 120, 33, normal[0] + 120, normal[1] + 33, 1, false);
            return null;
        });
        waitFor(() -> Math.abs(stage.getX() - normal[0] - 20) < 1 && Math.abs(stage.getY() - normal[1] - 15) < 1);
        fx(() -> {
            double x = stage.getX(), y = stage.getY(), w = stage.getWidth(), h = stage.getHeight();
            mouse(root, MouseEvent.MOUSE_PRESSED, w - 2, h - 2, x + w - 2, y + h - 2, 1, true);
            mouse(root, MouseEvent.MOUSE_DRAGGED, w + 38, h + 18, x + w + 38, y + h + 18, 1, true);
            mouse(root, MouseEvent.MOUSE_RELEASED, w + 38, h + 18, x + w + 38, y + h + 18, 1, false);
            return null;
        });
        waitFor(() -> Math.abs(stage.getWidth() - normal[2] - 40) < 1 && Math.abs(stage.getHeight() - normal[3] - 20) < 1);
        fx(() -> {
            double x = stage.getX(), y = stage.getY();
            mouse(root, MouseEvent.MOUSE_PRESSED, 2, 2, x + 2, y + 2, 1, true);
            mouse(root, MouseEvent.MOUSE_DRAGGED, 2002, 2002, x + 2002, y + 2002, 1, true);
            mouse(root, MouseEvent.MOUSE_RELEASED, 2002, 2002, x + 2002, y + 2002, 1, false);
            return null;
        });
        waitFor(() -> Math.abs(stage.getWidth() - stage.getMinWidth()) < 1 && Math.abs(stage.getHeight() - stage.getMinHeight()) < 1);
        fx(() -> { stage.setX(normal[0]); stage.setY(normal[1]); stage.setWidth(normal[2]); stage.setHeight(normal[3]); return null; });
        waitFor(() -> Math.abs(stage.getWidth() - normal[2]) < 1 && Math.abs(stage.getHeight() - normal[3]) < 1);
        Thread.sleep(150);
        fx(() -> { maximize.fire(); return null; });
        waitFor(() -> Boolean.TRUE.equals(field(matter, "maximized")) && Screen.getScreens().stream().anyMatch(screen -> {
            var bounds = screen.getVisualBounds(); return Math.abs(stage.getX() - bounds.getMinX()) < 1 && Math.abs(stage.getY() - bounds.getMinY()) < 1
                    && Math.abs(stage.getWidth() - bounds.getWidth()) < 1 && Math.abs(stage.getHeight() - bounds.getHeight()) < 1;
        }));
        fx(() -> {
            check(((Rectangle) field(matter, "frameClip")).getArcWidth() == 0, "maximized frame removes corner rounding");
            check(maximize.getAccessibleText().equals("还原窗口"), "maximize control communicates restore state");
            mouse(title, MouseEvent.MOUSE_CLICKED, 100, 18, stage.getX() + 100, stage.getY() + 18, 2, false);
            return null;
        });
        waitFor(() -> Boolean.FALSE.equals(field(matter, "maximized")) && Math.abs(stage.getWidth() - normal[2]) < 1 && Math.abs(stage.getHeight() - normal[3]) < 1);
        Thread.sleep(150);
        fx(() -> { ((Button) stage.getScene().lookup("#matterWindowMinimize")).fire(); return null; });
        waitFor(stage::isIconified);
        fx(() -> { ((PetMatterWindow) matter).open("{}"); return null; });
        waitFor(() -> stage.isShowing() && !stage.isIconified());
        fx(() -> {
            ((Button) stage.getScene().lookup("#matterWindowClose")).fire();
            check(!stage.isShowing(), "custom close hides reusable window");
            ((PetMatterWindow) matter).open("{}");
            return null;
        });
        waitFor(() -> stage.isShowing() && Math.abs(stage.getWidth() - normal[2]) < 1 && Math.abs(stage.getHeight() - normal[3]) < 1);
        System.out.println("PASS: native titlebar drag; southeast and northwest edge resize/minimum; maximize/restore; minimize; custom close/reopen");
    }

    private static void mouse(Node target, javafx.event.EventType<MouseEvent> type, double x, double y, double screenX, double screenY, int count, boolean down) {
        Event.fireEvent(target, new MouseEvent(type, x, y, screenX, screenY, MouseButton.PRIMARY, count,
                false, false, false, false, down, false, false, false, false, true, new PickResult(target, x, y)));
    }

    private static void assertQuickUnchanged(PetControlWindow control, Stage stage, double[] before) throws Exception {
        check(stage.getX() == before[0] && stage.getY() == before[1] && stage.getWidth() == before[2] && stage.getHeight() == before[3], "quick bounds unchanged");
        check("快速提问草稿".equals(((TextArea) field(control, "nativeInput")).getText()), "quick draft unchanged");
    }
    private static Object field(Object object, String name) throws Exception {
        Field field = object.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(object);
    }
    private static void waitFor(java.util.concurrent.Callable<Boolean> condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < deadline) {
            if (Boolean.TRUE.equals(fx(condition))) return;
            Thread.sleep(50);
        }
        throw new AssertionError("Timed out waiting for native matter WebView");
    }
    private static Object fx(java.util.concurrent.Callable<?> action) throws Exception {
        CompletableFuture<Object> result = new CompletableFuture<>();
        Platform.runLater(() -> { try { result.complete(action.call()); } catch (Throwable error) { result.completeExceptionally(error); } });
        return result.get(8, TimeUnit.SECONDS);
    }
    private static void check(boolean condition, String label) { if (!condition) throw new AssertionError(label); }
}
