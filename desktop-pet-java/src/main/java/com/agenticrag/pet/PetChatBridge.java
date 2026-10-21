package com.agenticrag.pet;

import java.util.function.Consumer;
import java.util.function.BiFunction;
import java.util.function.BiConsumer;
import java.util.function.Function;
import java.util.function.Supplier;

public final class PetChatBridge {
    private Consumer<String> memoryRequestHandler;
    private Consumer<String> openMattersHandler;
    private Consumer<String> qqReaderStatusRequestHandler;
    private Consumer<String> savedRunStreamRequestHandler;
    private Consumer<String> savedRunStreamCancelHandler;
    private Consumer<Double> quickPanelHeightHandler;
    private Consumer<String> quickContextLabelHandler;
    private Consumer<String> quickSettingsStateHandler;
    private final Consumer<String> payloadConsumer;
    private final Consumer<String> streamPayloadConsumer;
    private final BiFunction<String, String, String> safetyDecisionConsumer;
    private final BiFunction<String, String, String> workspaceConsumer;
    private final BiFunction<String, String, String> workspaceCreator;
    private BiFunction<String, String, String> workspaceReserver;
    private Function<String, String> workspaceMaterializer;
    private final Function<String, String> defaultsSaver;
    private final Function<String, String> sessionCreator;
    private final Function<String, String> sessionDeleter;
    private final Function<String, String> sessionRestorer;
    private final BiFunction<String, String, String> sessionRenamer;
    private final BiConsumer<String, String> workbenchSessionOpener;
    private final Supplier<String> startBackendHandler;
    private final Supplier<String> shutdownAllHandler;
    private final Consumer<Boolean> composerBusyHandler;
    private final Consumer<String> composerDraftHandler;
    private Consumer<String> composerActionHandler;
    private final Runnable composerFocusHandler;
    private final Consumer<String> externalUrlHandler;

    PetChatBridge(
            Consumer<String> payloadConsumer,
            Consumer<String> streamPayloadConsumer,
            BiFunction<String, String, String> safetyDecisionConsumer,
            BiFunction<String, String, String> workspaceConsumer,
            BiFunction<String, String, String> workspaceCreator,
            Function<String, String> defaultsSaver,
            Function<String, String> sessionCreator,
            Function<String, String> sessionDeleter,
            Function<String, String> sessionRestorer,
            BiFunction<String, String, String> sessionRenamer,
            BiConsumer<String, String> workbenchSessionOpener,
            Supplier<String> startBackendHandler,
            Supplier<String> shutdownAllHandler,
            Consumer<Boolean> composerBusyHandler,
            Consumer<String> composerDraftHandler,
            Runnable composerFocusHandler,
            Consumer<String> externalUrlHandler
    ) {
        this.payloadConsumer = payloadConsumer;
        this.streamPayloadConsumer = streamPayloadConsumer;
        this.safetyDecisionConsumer = safetyDecisionConsumer;
        this.workspaceConsumer = workspaceConsumer;
        this.workspaceCreator = workspaceCreator;
        this.defaultsSaver = defaultsSaver;
        this.sessionCreator = sessionCreator;
        this.sessionDeleter = sessionDeleter;
        this.sessionRestorer = sessionRestorer;
        this.sessionRenamer = sessionRenamer;
        this.workbenchSessionOpener = workbenchSessionOpener;
        this.startBackendHandler = startBackendHandler;
        this.shutdownAllHandler = shutdownAllHandler;
        this.composerBusyHandler = composerBusyHandler;
        this.composerDraftHandler = composerDraftHandler;
        this.composerFocusHandler = composerFocusHandler;
        this.externalUrlHandler = externalUrlHandler;
    }

    public void setComposerBusy(boolean busy) {
        if (composerBusyHandler != null) composerBusyHandler.accept(busy);
    }

    public void setComposerAction(String action) {
        if (composerActionHandler != null) composerActionHandler.accept(action);
    }

    public void setQuickPanelHeight(double contentHeight) {
        if (quickPanelHeightHandler != null) quickPanelHeightHandler.accept(contentHeight);
    }

    public void setQuickSettingsState(String json) {
        if (quickSettingsStateHandler != null) quickSettingsStateHandler.accept(json);
    }

    void setQuickSettingsStateHandler(Consumer<String> handler) {
        quickSettingsStateHandler = handler;
    }

    public void setQuickContextLabel(String label) {
        if (quickContextLabelHandler != null) quickContextLabelHandler.accept(label);
    }

    void setWorkspaceReserveHandlers(BiFunction<String, String, String> reserver, Function<String, String> materializer) {
        workspaceReserver = reserver;
        workspaceMaterializer = materializer;
    }

    /** Bind a session to its default folder by path only; the backend creates it on first write. */
    public String reserveSessionWorkspace(String sessionId, String path) {
        if (workspaceReserver == null) return "{\"error\":\"workspace handler unavailable\"}";
        return workspaceReserver.apply(sessionId, path);
    }

    /** Create a reserved session folder on explicit user request (upload, file panel). */
    public String materializeSessionWorkspace(String sessionId) {
        if (workspaceMaterializer == null) return "{\"error\":\"workspace handler unavailable\"}";
        return workspaceMaterializer.apply(sessionId);
    }

    void setQuickPanelHeightHandler(Consumer<Double> handler) {
        quickPanelHeightHandler = handler;
    }

    void setQuickContextLabelHandler(Consumer<String> handler) {
        quickContextLabelHandler = handler;
    }

    void setMemoryRequestHandler(Consumer<String> handler) {
        memoryRequestHandler = handler;
    }

    void setOpenMattersHandler(Consumer<String> handler) {
        openMattersHandler = handler;
    }

    public void openMatters(String optionsJson) {
        if (openMattersHandler != null) openMattersHandler.accept(optionsJson);
    }

    public void requestMemory(String payloadJson) {
        if (memoryRequestHandler != null) memoryRequestHandler.accept(payloadJson);
    }

    void setQQReaderStatusRequestHandler(Consumer<String> handler) {
        qqReaderStatusRequestHandler = handler;
    }

    public void requestQQReaderStatus(String id) {
        if (qqReaderStatusRequestHandler != null) qqReaderStatusRequestHandler.accept(id);
    }

    public void setComposerDraft(String draft) {
        if (composerDraftHandler != null) composerDraftHandler.accept(draft);
    }

    public void focusComposer() {
        if (composerFocusHandler != null) composerFocusHandler.run();
    }

    public void openExternalUrl(String url) {
        if (externalUrlHandler != null) externalUrlHandler.accept(url);
    }

    public void send(String payloadJson) {
        payloadConsumer.accept(payloadJson);
    }

    public void stream(String payloadJson) {
        if (streamPayloadConsumer != null) {
            streamPayloadConsumer.accept(payloadJson);
        }
    }

    void setSavedRunStreamRequestHandler(Consumer<String> handler) {
        savedRunStreamRequestHandler = handler;
    }

    void setSavedRunStreamCancelHandler(Consumer<String> handler) {
        savedRunStreamCancelHandler = handler;
    }

    void setComposerActionHandler(Consumer<String> handler) {
        composerActionHandler = handler;
    }

    public void streamSavedRun(String payloadJson) {
        if (savedRunStreamRequestHandler != null) savedRunStreamRequestHandler.accept(payloadJson);
    }

    public void cancelSavedRunStream(String requestId) {
        if (savedRunStreamCancelHandler != null) savedRunStreamCancelHandler.accept(requestId);
    }

    public String decideSafetyReview(String reviewId, String decision) {
        if (safetyDecisionConsumer == null) return "{\"error\":\"safety decision handler unavailable\"}";
        return safetyDecisionConsumer.apply(reviewId, decision);
    }

    public String setSessionWorkspace(String sessionId, String path) {
        if (workspaceConsumer == null) return "{\"error\":\"workspace handler unavailable\"}";
        return workspaceConsumer.apply(sessionId, path);
    }

    public String createSessionWorkspace(String sessionId, String basePath) {
        if (workspaceCreator == null) return "{\"error\":\"workspace creator unavailable\"}";
        return workspaceCreator.apply(sessionId, basePath);
    }

    public String saveUiDefaults(String payloadJson) {
        if (defaultsSaver == null) return "{\"error\":\"settings handler unavailable\"}";
        return defaultsSaver.apply(payloadJson);
    }

    public String createSession(String title) {
        if (sessionCreator == null) return "{\"error\":\"session creator unavailable\"}";
        return sessionCreator.apply(title);
    }

    public String deleteSession(String sessionId) {
        if (sessionDeleter == null) return "{\"error\":\"session deletion handler unavailable\"}";
        return sessionDeleter.apply(sessionId);
    }

    public String restoreSession(String sessionId) {
        if (sessionRestorer == null) return "{\"error\":\"session restoration handler unavailable\"}";
        return sessionRestorer.apply(sessionId);
    }

    public String renameSession(String sessionId, String title) {
        if (sessionRenamer == null) return "{\"error\":\"session rename handler unavailable\"}";
        return sessionRenamer.apply(sessionId, title);
    }

    public void openWorkbenchSession(String sessionId, String runId) {
        if (workbenchSessionOpener != null) workbenchSessionOpener.accept(sessionId, runId);
    }

    public String startBackendService() {
        if (startBackendHandler == null) {
            return "{\"ok\":false,\"message\":\"start handler unavailable\"}";
        }
        return startBackendHandler.get();
    }

    public String shutdownDesktopAndBackend() {
        if (shutdownAllHandler == null) {
            return "{\"ok\":false,\"message\":\"shutdown handler unavailable\"}";
        }
        return shutdownAllHandler.get();
    }
}
