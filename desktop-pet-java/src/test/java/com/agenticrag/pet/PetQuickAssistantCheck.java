package com.agenticrag.pet;

import com.sun.net.httpserver.HttpServer;
import javafx.application.Platform;
import javafx.scene.control.Button;
import javafx.scene.control.TextArea;
import javafx.scene.web.WebView;
import javafx.stage.Stage;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** Isolated native quick assistant lifecycle/actions; never opens a browser or a real backend. */
public final class PetQuickAssistantCheck {
    private static WebView view;
    private static double collapsedSettingsHeight;
    public static void main(String[] args) throws Exception {
        String page = "http://127.0.0.1:8780/desktop-pet/chat.html";
        check(PetControlWindow.quickAssistantPageUrl(page).equals(page + "?assistant=quick"), "default native quick URL selects assistant");
        check(PetControlWindow.quickAssistantPageUrl(page + "?mode=quick&backend=encoded").endsWith("&assistant=quick"), "default quick URL keeps existing query");
        for (String query : List.of("session_id=ordinary-1", "run_id=ordinary-run", "assistant=global", "mode=work")) {
            check(PetControlWindow.quickAssistantPageUrl(page + "?" + query).equals(page + "?" + query), "explicit session/run/assistant/work entry retained");
        }
        check(PetControlWindow.workbenchPageUrl(page + "?assistant=quick", "http://127.0.0.1:8765", "ordinary-session", "ordinary-run", true)
                .equals(page + "?mode=work&backend=http%3A%2F%2F127.0.0.1%3A8765&assistant=global"), "global workbench URL has no inherited ordinary identity or quick mode");
        String html = """
            <!doctype html><html><body><button id="newQuickSessionButton" onclick="window.newTasks++;window.fixtureKind='ordinary'">新任务</button><script>
            window.assistantOpens=0;window.freshOpens=0;window.newTasks=0;window.workbenchOpens=0;window.fixtureKind='ordinary';
            window.localManagerDraft='保留助手草稿';
            window.__petChatOpenAssistant=function(){window.assistantOpens++;window.fixtureKind='manager';return Promise.resolve(true);};
            window.__petChatOpenFreshTask=function(){window.freshOpens++;window.localManagerDraft='不应清除';};
            window.__petChatOpenWorkbench=function(){window.workbenchOpens++;};
            window.settingsRefreshes=[];window.settingsUpdates=[];window.settingsPreviews=[];
            window.fixtureSettings={sessionId:'manager-one',kind:'manager',scopeLabel:'真理模型',modelValue:'default',answerModelValue:'',models:[{value:'default',label:'跟随后端默认模型'},{value:'alternate',label:'合成服务商 / 模型 B'}],safetyMode:'backend',stream:true,reasoningLevel:'low',reasoningLevels:[{value:'off',label:'关闭',available:true},{value:'low',label:'低',available:true},{value:'high',label:'高',available:true},{value:'max',label:'最高',available:true}],reasoningHint:'模型支持推理强度设置。',reasoningAvailable:true,reasoningValid:true,ready:true,loading:false,busy:false,error:'',notice:''};
            window.publishFixture=function(){petBridge.setQuickSettingsState(JSON.stringify(window.fixtureSettings));};
            window.LkaChatContext={get:function(){return {kind:window.fixtureKind};},
              quickSettings:function(){return window.fixtureSettings;},
              previewQuickSettings:function(draft){window.settingsPreviews.push(draft);var supported=draft.modelValue==='default'?['low']:['off','low','high','max'];var valid=supported.indexOf(draft.reasoningLevel)>=0;Object.assign(window.fixtureSettings,{reasoningValid:valid,reasoningAvailable:true,reasoningHint:valid?'当前模型支持此推理档位':'当前模型不支持此推理档位',reasoningLevels:[{value:'off',label:'关闭',available:supported.includes('off')},{value:'low',label:'低',available:supported.includes('low')},{value:'high',label:'高',available:supported.includes('high')},{value:'max',label:'最高',available:supported.includes('max')}]});window.publishFixture();return window.fixtureSettings;},
              refreshQuickSettings:function(force){window.settingsRefreshes.push(!!force);window.publishFixture();return Promise.resolve(window.fixtureSettings);},
              updateQuickSettings:function(draft){window.settingsUpdates.push(draft);Object.assign(window.fixtureSettings,draft,{busy:true});window.publishFixture();return new Promise(function(resolve){setTimeout(function(){Object.assign(window.fixtureSettings,{busy:false,notice:'已保存，下次新运行生效'});window.publishFixture();resolve(window.fixtureSettings);},50);});}};

            if(new URLSearchParams(location.search).get('assistant')==='quick')window.__petChatOpenAssistant();
            </script></body></html>
            """;
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            byte[] bytes = html.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
            exchange.sendResponseHeaders(200, bytes.length); exchange.getResponseBody().write(bytes); exchange.close();
        });
        server.start();
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        java.util.concurrent.atomic.AtomicInteger petCloses = new java.util.concurrent.atomic.AtomicInteger();
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
            public void shutdownDesktopPet() { petCloses.incrementAndGet(); }
        };
        PetControlWindow control = new PetControlWindow(actions, base + "/desktop-pet/chat.html?mode=quick&backend=" + base, ".", List.of());
        try {
            control.toggle(100, 100);
            waitFor(() -> {
                view = (WebView) field(control, "webView");
                return view != null && Boolean.TRUE.equals(view.getEngine().executeScript("Boolean(window.petBridge && window.__petChatOpenAssistant)"));
            });
            Stage stage = (Stage) fx(() -> field(control, "stage"));
            TextArea composer = (TextArea) fx(() -> field(control, "nativeInput"));
            int before = ((Number) fx(() -> script("window.assistantOpens"))).intValue();
            check(before >= 1, "initial default URL bootstraps assistant");
            fx(() -> {
                check(view.getEngine().getLocation().contains("assistant=quick"), "actual native WebView URL selects quick assistant");
                check(!view.getEngine().getLocation().contains("session_id="), "default native URL does not inherit ordinary session");
                composer.setText("保留原生输入草稿");
                script("window.localManagerDraft='保留助手草稿';window.managerRoot='same-root'");
                return null;
            });
            control.toggle(100, 100);
            waitFor(() -> !stage.isShowing());
            control.toggle(100, 100);
            waitFor(() -> stage.isShowing() && ((Number) script("window.assistantOpens")).intValue() == before + 1);
            fx(() -> {
                check(field(control, "webView") == view && field(control, "nativeInput") == composer, "reopen reuses main WebView and native composer");
                check("保留原生输入草稿".equals(composer.getText()), "reopen preserves native composer draft");
                check("保留助手草稿".equals(script("window.localManagerDraft")) && "same-root".equals(script("window.managerRoot")), "reopen preserves existing manager draft/root");
                check(((Number) script("window.freshOpens")).intValue() == 0, "show/reopen never opens fresh task");
                stage.setWidth(340);
                return null;
            });
            waitFor(() -> Math.abs(stage.getWidth() - 340) < 1);
            fx(() -> {
                stage.getScene().getRoot().applyCss(); stage.getScene().getRoot().layout();
                Button assistant = (Button) stage.getScene().lookup("#quickGlobalAssistantButton");
                Button task = (Button) stage.getScene().lookup("#quickNewTaskButton");
                check(assistant != null && assistant.getText().isEmpty() && assistant.getGraphic() != null && "打开真理".equals(assistant.getAccessibleText()), "accessible assistant icon entry");
                check(task != null && task.getText().isEmpty() && task.getGraphic() != null && "新任务".equals(task.getAccessibleText()), "accessible independent task icon entry");
                check(task.localToScene(task.getBoundsInLocal()).getMaxX() <= stage.getWidth(), "new task text fits minimum quick width");
                check(assistant.localToScene(assistant.getBoundsInLocal()).getMaxX() <= stage.getWidth(), "assistant text fits minimum quick width");
                task.fire();
                check(((Number) script("window.newTasks")).intValue() == 1, "native new task invokes existing page button");
                check("ordinary".equals(script("window.fixtureKind")), "new task stays independent from manager");
                assistant.fire();
                check(((Number) script("window.assistantOpens")).intValue() == before + 2 && stage.isShowing(), "assistant action dispatches into same visible window");
                Method manager = PetControlWindow.class.getDeclaredMethod("isManagerSession"); manager.setAccessible(true);
                check(Boolean.TRUE.equals(manager.invoke(control)), "workbench dispatch recognizes active manager context");
                script("window.fixtureKind='ordinary'");
                check(Boolean.FALSE.equals(manager.invoke(control)), "ordinary context retains normal workbench dispatch");
                Button workbench = stage.getScene().getRoot().lookupAll(".button").stream()
                        .filter(node -> node instanceof Button b && b.getTooltip() != null && b.getTooltip().getText().equals("打开工作台"))
                        .map(node -> (Button) node).findFirst().orElseThrow();
                workbench.fire();
                check(((Number) script("window.workbenchOpens")).intValue() == 1, "ordinary workbench still follows existing JS session handoff");
                check(((Number) script("document.querySelectorAll('iframe').length")).intValue() == 0, "composer remains in main WebView");
                return null;
            });
            testWorkbenchFailures(control, stage);
            testPetOnlyClose(control, petCloses);
            testImePosition(control, stage, composer);
            testQuickSettings(control, stage);
            System.out.println("PASS: default quick assistant URL; reusable manager draft/root and native composer; visible assistant/new-task actions at 340px; manager/ordinary workbench dispatch");
        } finally { control.dispose(); server.stop(0); Platform.exit(); }
    }
    private static void testWorkbenchFailures(PetControlWindow control, Stage stage) throws Exception {
        fx(() -> script("window.fixtureWorkbenchCallback=window.__petChatOpenWorkbench"));
        for (String callback : List.of("undefined", "function(){throw new Error('fixture failure');}",
                "function(){return Promise.resolve(false);}", "function(){return Promise.reject(new Error('fixture failure'));}")) {
            fx(() -> {
                script("window.fixtureKind='ordinary';window.__petChatOpenWorkbench=" + callback);
                var status = (javafx.scene.control.Label) field(control, "nativeImageStatus");
                status.setText("");
                Method open = PetControlWindow.class.getDeclaredMethod("openWorkbench");
                open.setAccessible(true); open.invoke(control);
                return null;
            });
            waitFor(() -> {
                var status = (javafx.scene.control.Label) field(control, "nativeImageStatus");
                return status.isVisible() && !status.getText().isBlank();
            });
            check((boolean) fx(stage::isShowing), "failed workbench handoff keeps quick window visible");
        }
        fx(() -> script("window.__petChatOpenWorkbench=window.fixtureWorkbenchCallback"));
    }

    private static void testPetOnlyClose(PetControlWindow control, java.util.concurrent.atomic.AtomicInteger closes) throws Exception {
        fx(() -> {
            var menu = (javafx.scene.control.MenuButton) field(control, "settingsMenuButton");
            var close = menu.getItems().stream()
                    .filter(item -> "仅关闭桌宠（保留服务）".equals(item.getText()))
                    .findFirst().orElseThrow();
            close.fire();
            check(closes.get() == 1, "pet-only menu directly invokes pet lifecycle action");
            check(!((java.util.concurrent.atomic.AtomicBoolean) field(control, "shutdownInProgress")).get(),
                    "pet-only menu never enters service shutdown path");
            return null;
        });
    }

    private static void testImePosition(PetControlWindow control, Stage stage, TextArea composer) throws Exception {
        boolean original = (boolean) fx(() -> field(control, "bubbleMode"));
        String originalDraft = (String) fx(composer::getText);
        double[] originalBounds = (double[]) fx(() -> new double[]{stage.getX(), stage.getY(), stage.getWidth(), stage.getHeight()});
        try {
            for (boolean bubble : new boolean[]{false, true}) {
                fx(() -> {
                    Field mode = PetControlWindow.class.getDeclaredField("bubbleMode"); mode.setAccessible(true); mode.set(control, bubble);
                    Method layout = PetControlWindow.class.getDeclaredMethod("applyQuickLayout"); layout.setAccessible(true); layout.invoke(control);
                    stage.setWidth(450); stage.setHeight(420); stage.setX(180); stage.setY(160);
                    stage.toFront(); stage.requestFocus(); composer.requestFocus();
                    return null;
                });
                waitFor(() -> stage.isFocused() && composer.isFocused());
                for (String text : List.of("", "Hello Doctor", "one\ntwo\nthree\nfour\nfive\nsix")) {
                    fx(() -> { composer.setText(text); composer.positionCaret(text.length()); return null; });
                    Thread.sleep(150);
                    fx(() -> {
                        stage.getScene().getRoot().applyCss(); stage.getScene().getRoot().layout();
                        var caret = composer.lookupAll("*").stream().filter(n -> n instanceof javafx.scene.shape.Path)
                            .filter(n -> n.getBoundsInLocal().getWidth() <= 3 && n.getBoundsInLocal().getHeight() > 10)
                            .findFirst().orElseThrow();
                        var bounds = caret.localToScreen(caret.getBoundsInLocal());
                        var ime = composer.getInputMethodRequests().getTextLocation(0);
                        check(Math.abs(ime.getX() - bounds.getMinX()) < 8 && Math.abs(ime.getY() - bounds.getMaxY()) < 28,
                            "IME anchor follows the actual insertion caret in " + (bubble ? "bubble" : "card") + " mode");
                        if (System.getProperty("os.name", "").startsWith("Windows")) {
                            // Query Glass's actual handoff, then compare with the independent Win32 window origin.
                            var helper = Class.forName("com.sun.javafx.scene.SceneHelper");
                            var peer = helper.getMethod("getPeer", javafx.scene.Scene.class).invoke(null, stage.getScene());
                            var getView = peer.getClass().getDeclaredMethod("getPlatformView"); getView.setAccessible(true);
                            var glassView = getView.invoke(peer);
                            var glassWindow = glassView.getClass().getMethod("getWindow").invoke(glassView);
                            long handle = (long) glassWindow.getClass().getMethod("getNativeWindow").invoke(glassWindow);
                            var hwnd = new com.sun.jna.platform.win32.WinDef.HWND(new com.sun.jna.Pointer(handle));
                            var origin = new com.sun.jna.platform.win32.WinDef.RECT();
                            check(com.sun.jna.platform.win32.User32.INSTANCE.GetWindowRect(hwnd, origin), "native transparent window origin available");
                            var handler = glassView.getClass().getMethod("getEventHandler").invoke(glassView);
                            var getPosition = handler.getClass().getMethod("getInputMethodCandidatePos", int.class); getPosition.setAccessible(true);
                            double[] physical = (double[]) getPosition.invoke(handler, 0);
                            double expectedX = origin.left + (ime.getX() - stage.getX()) * stage.getOutputScaleX();
                            double expectedY = origin.top + (ime.getY() - stage.getY()) * stage.getOutputScaleY();
                            check(Math.abs(physical[0] - expectedX) <= 2 && Math.abs(physical[1] - expectedY) <= 2,
                                "Windows IME handoff uses physical pixels at " + stage.getOutputScaleX() + "x: got "
                                    + physical[0] + "," + physical[1] + " expected " + expectedX + "," + expectedY);
                        }
                        return null;
                    });
                }
            }
            System.out.println("PASS: card/bubble IME anchor and Windows physical-pixel handoff for empty, typed and multiline input");
        } finally {
            fx(() -> {
                Field mode = PetControlWindow.class.getDeclaredField("bubbleMode"); mode.setAccessible(true); mode.set(control, original);
                Method layout = PetControlWindow.class.getDeclaredMethod("applyQuickLayout"); layout.setAccessible(true); layout.invoke(control);
                stage.setX(originalBounds[0]); stage.setY(originalBounds[1]);
                stage.setWidth(originalBounds[2]); stage.setHeight(originalBounds[3]);
                composer.setText(originalDraft); return null;
            });
        }
    }
    private static void testQuickSettings(PetControlWindow control, Stage stage) throws Exception {
        fx(() -> {
            javafx.scene.control.MenuButton menu = (javafx.scene.control.MenuButton) field(control, "settingsMenuButton");
            check(menu.getItems().size() == 3 && menu.getItems().getFirst() instanceof javafx.scene.control.CustomMenuItem item && !item.isHideOnClick(), "persistent settings sheet and direct pet-only close menu");
            menu.show();
            return null;
        });
        waitFor(() -> ((Number) script("window.settingsRefreshes.length")).intValue() == 1);
        fx(() -> {
            check(Boolean.FALSE.equals(script("window.settingsRefreshes[0]")), "opening refreshes scope without forcing model discovery");
            var model = (javafx.scene.control.ComboBox<?>) field(control, "quickSettingsModel");
            var answerModel = (javafx.scene.control.ComboBox<?>) field(control, "quickSettingsAnswerModel");
            var safety = (javafx.scene.control.ComboBox<?>) field(control, "quickSettingsSafety");
            var apply = (Button) field(control, "quickSettingsApply");
            var refresh = (Button) field(control, "quickSettingsRefresh");
            var stream = (javafx.scene.control.CheckBox) field(control, "quickSettingsStream");
            var reasoning = (javafx.scene.control.Slider) field(control, "quickSettingsReasoning");
            check(!apply.isDisabled() && model.getItems().size() == 2, "validated model snapshot enables apply");
            var menu = (javafx.scene.control.MenuButton) field(control, "settingsMenuButton");
            var scroll = (javafx.scene.control.ScrollPane) ((javafx.scene.control.CustomMenuItem) menu.getItems().getFirst()).getContent();
            var pet = (javafx.scene.control.TitledPane) scroll.getContent().lookup("#quickSettingsPetSection");
            check(pet != null && !pet.isExpanded(), "pet controls collapsed by default");
            check(scroll.getHbarPolicy() == javafx.scene.control.ScrollPane.ScrollBarPolicy.NEVER, "sheet fits narrow quick window");
            check(scroll.getWidth() <= 320, "settings sheet stays within 340px window width");
            check(answerModel.getItems().size() == 3 && answerModel.getSelectionModel().getSelectedIndex() == 0, "answer model initially follows inference");
            answerModel.getSelectionModel().select(1);
            model.getSelectionModel().select(1);
            safety.getSelectionModel().select(2);
            stream.setSelected(false);
            reasoning.setValue(3);
            script("window.publishFixture()");
            check(answerModel.getSelectionModel().getSelectedIndex() == 1, "unsaved answer model survives same-session snapshot");
            check(model.getSelectionModel().getSelectedIndex() == 1 && safety.getSelectionModel().getSelectedIndex() == 2 && !stream.isSelected(), "unsaved selection survives incoming same-session snapshot");
            apply.fire();
            check(apply.isDisabled(), "save disables apply while busy");
            check("default".equals(script("window.settingsUpdates[0].answerModelValue")), "native settings applies independent answer model through JS");
            check("alternate".equals(script("window.settingsUpdates[0].modelValue")) && "manual".equals(script("window.settingsUpdates[0].safetyMode")) && Boolean.FALSE.equals(script("window.settingsUpdates[0].stream")) && "max".equals(script("window.settingsUpdates[0].reasoningLevel")), "apply delegates complete draft to JS without native HTTP");
            return null;
        });
        waitFor(() -> !((Button) field(control, "quickSettingsApply")).isDisabled());
        fx(() -> {
            check(((javafx.scene.control.Label) field(control, "quickSettingsStatus")).getText().contains("下次新运行生效"), "save acknowledgement shown");
            ((Button) field(control, "quickSettingsRefresh")).fire();
            check(Boolean.TRUE.equals(script("window.settingsRefreshes[1]")), "model refresh requests forced discovery");
            script("Object.assign(window.fixtureSettings,{error:'设置已变化，请重新应用',modelValue:'alternate'});window.publishFixture()");
            var model = (javafx.scene.control.ComboBox<?>) field(control, "quickSettingsModel");
            check(model.getSelectionModel().getSelectedIndex() == 1, "error preserves submitted model");
            script("Object.assign(window.fixtureSettings,{reasoningAvailable:false,reasoningValid:false,reasoningHint:'当前模型不支持此推理档位'});window.publishFixture()");
            check(((javafx.scene.control.Slider) field(control, "quickSettingsReasoning")).isDisabled(), "unsupported reasoning capability disables slider per JS state");
            check(((Button) field(control, "quickSettingsApply")).isDisabled(), "invalid reasoning state disables apply per JS state");
            script("Object.assign(window.fixtureSettings,{reasoningAvailable:true,reasoningValid:true,reasoningHint:'档位已按当前模型调整'});window.publishFixture()");
            var reasoning = (javafx.scene.control.Slider) field(control, "quickSettingsReasoning");
            reasoning.setValue(1);
            reasoning.requestFocus();
            reasoning.fireEvent(new javafx.scene.input.KeyEvent(javafx.scene.input.KeyEvent.KEY_PRESSED, "", "", javafx.scene.input.KeyCode.RIGHT, false, false, false, false));
            check(Math.abs(reasoning.getValue() - 2) < 0.01, "reasoning slider keyboard arrow advances exactly one level");
            reasoning.setValue(3);
            model.getSelectionModel().select(0);
            check(((Button) field(control, "quickSettingsApply")).isDisabled(), "model preview disables apply for unsupported draft without saving");
            reasoning.setValue(1);
            check(!((Button) field(control, "quickSettingsApply")).isDisabled(), "choosing supported low level previews valid state and re-enables apply");
            check(((Number) script("window.settingsUpdates.length")).intValue() == 1, "preview calls do not save settings");
            reasoning.setValue(3);
            check(((Button) field(control, "quickSettingsApply")).isDisabled(), "choosing unsupported level immediately disables apply");
            check(((Number) script("window.settingsUpdates.length")).intValue() == 1, "unsupported preview sends no settings update");
            script("window.fixtureSettings.ready=false;window.publishFixture()");
            check(((Button) field(control, "quickSettingsApply")).isDisabled(), "unready manager cannot apply");
            script("Object.assign(window.fixtureSettings,{sessionId:'ordinary-two',kind:'ordinary',scopeLabel:'独立任务默认模型',modelValue:'default',answerModelValue:'',ready:true,error:''});window.publishFixture()");
            check(model.getSelectionModel().getSelectedIndex() == 0, "new session resets prior scope selection");
            check(((javafx.scene.control.ComboBox<?>) field(control, "quickSettingsAnswerModel")).getSelectionModel().getSelectedIndex() == 0, "new session clears prior answer-model draft");
            check("独立任务默认模型".equals(((javafx.scene.control.Label) field(control, "quickSettingsScope")).getText()), "scope changes with selected session");
            var menu = (javafx.scene.control.MenuButton) field(control, "settingsMenuButton");
            var scroll = (javafx.scene.control.ScrollPane) ((javafx.scene.control.CustomMenuItem) menu.getItems().getFirst()).getContent();
            var pet = (javafx.scene.control.TitledPane) scroll.getContent().lookup("#quickSettingsPetSection");
            pet.setExpanded(true);
            check(pet.getContent().lookupAll(".button").size() == 11, "legacy actions retained in expandable section");
            pet.setExpanded(false);
            String output = System.getProperty("lka.quickSettingsShots", "");
            if (!output.isBlank()) {
                java.nio.file.Path directory = java.nio.file.Path.of(output);
                java.nio.file.Files.createDirectories(directory);
                javafx.stage.Window popup = javafx.stage.Window.getWindows().stream().filter(w -> w.isShowing() && w != stage && w.getScene() != null && w.getScene().getRoot().lookup("#quickSettingsPanel") != null).findFirst().orElseThrow();
                popup.getScene().getRoot().applyCss(); popup.getScene().getRoot().layout();
                javax.imageio.ImageIO.write(javafx.embed.swing.SwingFXUtils.fromFXImage(popup.getScene().snapshot(null), null), "png", directory.resolve("quick-settings-340.png").toFile());
            }
            collapsedSettingsHeight = scroll.getHeight();
            pet.setExpanded(true);
            return null;
        });
        waitFor(() -> ((javafx.scene.control.TitledPane) ((javafx.scene.control.ScrollPane) ((javafx.scene.control.CustomMenuItem)
                ((javafx.scene.control.MenuButton) field(control, "settingsMenuButton")).getItems().getFirst()).getContent()).getContent().lookup("#quickSettingsPetSection")).isExpanded());
        fx(() -> {
            var menu = (javafx.scene.control.MenuButton) field(control, "settingsMenuButton");
            var scroll = (javafx.scene.control.ScrollPane) ((javafx.scene.control.CustomMenuItem) menu.getItems().getFirst()).getContent();
            check(scroll.getHeight() <= 540, "expanded pet actions stay bounded and scroll");
            check(scroll.getContent().getBoundsInLocal().getHeight() > scroll.getViewportBounds().getHeight(), "expanded content remains accessible through vertical scroll");
            String output = System.getProperty("lka.quickSettingsShots", "");
            if (!output.isBlank()) {
                javafx.stage.Window popup = javafx.stage.Window.getWindows().stream().filter(w -> w.isShowing() && w != stage && w.getScene() != null && w.getScene().getRoot().lookup("#quickSettingsPanel") != null).findFirst().orElseThrow();
                javax.imageio.ImageIO.write(javafx.embed.swing.SwingFXUtils.fromFXImage(popup.getScene().snapshot(null), null), "png", java.nio.file.Path.of(output).resolve("quick-settings-expanded-340.png").toFile());
            }
            ((javafx.scene.control.TitledPane) scroll.getContent().lookup("#quickSettingsPetSection")).setExpanded(false);
            return null;
        });
        waitFor(() -> {
            var menu = (javafx.scene.control.MenuButton) field(control, "settingsMenuButton");
            var scroll = (javafx.scene.control.ScrollPane) ((javafx.scene.control.CustomMenuItem) menu.getItems().getFirst()).getContent();
            return Math.abs(scroll.getHeight() - collapsedSettingsHeight) < 2;
        });
        fx(() -> {
            var menu = (javafx.scene.control.MenuButton) field(control, "settingsMenuButton");
            var scroll = (javafx.scene.control.ScrollPane) ((javafx.scene.control.CustomMenuItem) menu.getItems().getFirst()).getContent();
            Button workbench = (Button) scroll.getContent().lookup("#quickSettingsWorkbench");
            check(workbench != null && workbench.isVisible() && workbench.isManaged(), "workbench entry is available in the main settings sheet");
            boolean bubble = (boolean) field(control, "bubbleMode");
            int opens = ((Number) script("window.workbenchOpens")).intValue();
            workbench.fire();
            check(((Number) script("window.workbenchOpens")).intValue() == opens + 1, "settings uses the current conversation workbench handoff");
            check((boolean) field(control, "bubbleMode") == bubble, "opening workbench keeps the current bubble/card mode");
            check(!menu.isShowing(), "workbench action dismisses settings");
            return null;
        });
        System.out.println("PASS: native settings sheet, JS bridge snapshots, explicit apply, refresh modes, dirty selection, ready/busy guards, scope switch, collapsed pet actions");
    }
    private static Object script(String code) { return view.getEngine().executeScript(code); }
    private static Object field(Object object, String name) throws Exception { Field f = object.getClass().getDeclaredField(name); f.setAccessible(true); return f.get(object); }
    private static void waitFor(java.util.concurrent.Callable<Boolean> condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < deadline) { if (Boolean.TRUE.equals(fx(condition))) return; Thread.sleep(50); }
        throw new AssertionError("Timed out waiting for quick assistant fixture");
    }
    private static Object fx(java.util.concurrent.Callable<?> action) throws Exception {
        CompletableFuture<Object> result = new CompletableFuture<>();
        Platform.runLater(() -> { try { result.complete(action.call()); } catch (Throwable error) { result.completeExceptionally(error); } });
        return result.get(8, TimeUnit.SECONDS);
    }
    private static void check(boolean condition, String label) { if (!condition) throw new AssertionError(label); }
}
