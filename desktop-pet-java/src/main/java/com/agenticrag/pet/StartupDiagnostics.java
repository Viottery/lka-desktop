package com.agenticrag.pet;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class StartupDiagnostics {
    private static final String TAG = "[pet-diag]";
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(8);
    private static final Duration FAST_REQUEST_TIMEOUT = Duration.ofSeconds(12);
    private static final Duration CHAT_REQUEST_TIMEOUT = Duration.ofSeconds(150);
    private static final int HEALTH_RETRIES = 12;
    private static final long HEALTH_RETRY_DELAY_MS = 700L;
    private static final Pattern SCRIPT_PATTERN = Pattern.compile("<script[^>]+src=[\"']([^\"']*chat\\.js[^\"']*)[\"']", Pattern.CASE_INSENSITIVE);

    private StartupDiagnostics() {
    }

    static void runAsync(SpineOptions options) {
        Thread thread = new Thread(() -> run(options), "pet-startup-diagnostics");
        thread.setDaemon(true);
        thread.start();
    }

    static void run(SpineOptions options) {
        long started = System.nanoTime();
        HttpClient client = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(CONNECT_TIMEOUT)
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
        URI chatPageUri = normalizeUri(options.chatUrl);
        URI baseUri = resolveBaseUri(chatPageUri);

        log("START time=" + Instant.now() + " base=" + baseUri + " chatPage=" + chatPageUri);

        boolean ok = true;
        ok &= checkHealth(client, baseUri);
        PageCheck pageCheck = checkChatPage(client, chatPageUri);
        ok &= pageCheck.ok();
        ok &= checkChatScript(client, chatPageUri, pageCheck.scriptSrc());
        log("chat-api SKIP reason=chat.html owns /agent/turn calls through configured backend URL");

        long elapsedMs = (System.nanoTime() - started) / 1_000_000L;
        log("DONE ok=" + ok + " elapsedMs=" + elapsedMs);
    }

    private static boolean checkHealth(HttpClient client, URI baseUri) {
        URI healthUri = baseUri.resolve("/health");
        for (int attempt = 1; attempt <= HEALTH_RETRIES; attempt++) {
            try {
                HttpResponse<String> response = client.send(
                        get(healthUri, FAST_REQUEST_TIMEOUT),
                        HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)
                );
                if (isSuccess(response.statusCode())) {
                    log("health OK status=" + response.statusCode() + " attempt=" + attempt + " body=" + compact(response.body(), 240));
                    return true;
                }
                log("health WAIT status=" + response.statusCode() + " attempt=" + attempt + " body=" + compact(response.body(), 240));
            } catch (Exception error) {
                log("health WAIT attempt=" + attempt + " error=" + safeMessage(error));
            }
            sleep(HEALTH_RETRY_DELAY_MS);
        }
        log("FAIL step=health uri=" + healthUri);
        return false;
    }

    private static PageCheck checkChatPage(HttpClient client, URI chatPageUri) {
        URI uri = cacheBusted(chatPageUri, "diagPageTs");
        try {
            HttpResponse<String> response = client.send(
                    get(uri, FAST_REQUEST_TIMEOUT),
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)
            );
            if (!isSuccess(response.statusCode())) {
                log("FAIL step=chat-page status=" + response.statusCode() + " body=" + compact(response.body(), 300));
                return new PageCheck(false, "");
            }

            String html = response.body();
            String scriptSrc = findChatScript(html);
            boolean hasInput = html.contains("questionInput");
            boolean hasSendButton = html.contains("sendButton");
            boolean hasScript = !scriptSrc.isBlank();
            boolean ok = hasInput && hasSendButton && hasScript;
            log("chat-page " + (ok ? "OK" : "FAIL")
                    + " status=" + response.statusCode()
                    + " hasInput=" + hasInput
                    + " hasSendButton=" + hasSendButton
                    + " script=" + (hasScript ? scriptSrc : "<missing>"));
            return new PageCheck(ok, scriptSrc);
        } catch (Exception error) {
            log("FAIL step=chat-page uri=" + uri + " error=" + safeMessage(error));
            return new PageCheck(false, "");
        }
    }

    private static boolean checkChatScript(HttpClient client, URI chatPageUri, String scriptSrc) {
        if (scriptSrc == null || scriptSrc.isBlank()) {
            log("FAIL step=chat-js reason=missing-script-src");
            return false;
        }

        URI scriptUri = cacheBusted(resolveRelative(chatPageUri, scriptSrc), "diagScriptTs");
        try {
            HttpResponse<String> response = client.send(
                    get(scriptUri, FAST_REQUEST_TIMEOUT),
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)
            );
            if (!isSuccess(response.statusCode())) {
                log("FAIL step=chat-js status=" + response.statusCode() + " uri=" + scriptUri + " body=" + compact(response.body(), 300));
                return false;
            }

            String js = response.body();
            boolean hasReceiver = js.contains("__petChatReceive");
            boolean hasFetch = js.contains("fetch(") || js.contains("fetch (");
            boolean hasXhr = js.contains("XMLHttpRequest");
            boolean ok = hasReceiver && hasFetch && !hasXhr;
            log("chat-js " + (ok ? "OK" : "FAIL")
                    + " status=" + response.statusCode()
                    + " hasReceiver=" + hasReceiver
                    + " hasFetch=" + hasFetch
                    + " hasXhr=" + hasXhr
                    + " bytes=" + js.length());
            return ok;
        } catch (Exception error) {
            log("FAIL step=chat-js uri=" + scriptUri + " error=" + safeMessage(error));
            return false;
        }
    }

    private static boolean checkChatApi(HttpClient client, URI baseUri) {
        URI chatUri = baseUri.resolve("/chat");
        String conversationId = "java-startup-smoke-" + System.currentTimeMillis();
        String requestJson = jsonObject(
                "question", "Java desktop pet startup connectivity test. Reply briefly.",
                "mode", "wait",
                "conversation_id", conversationId
        );

        try {
                HttpRequest request = HttpRequest.newBuilder()
                        .uri(chatUri)
                        .version(HttpClient.Version.HTTP_1_1)
                        .timeout(CHAT_REQUEST_TIMEOUT)
                        .header("Content-Type", "application/json; charset=utf-8")
                        .header("Accept", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(requestJson, StandardCharsets.UTF_8))
                    .build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (!isSuccess(response.statusCode())) {
                log("FAIL step=chat-api status=" + response.statusCode() + " body=" + compact(response.body(), 900));
                return false;
            }

            JsonObject body = JsonParser.parseString(response.body()).getAsJsonObject();
            String error = getString(body, "error", "");
            String status = getString(body, "status", "");
            String answer = getString(body, "answer", "");
            boolean hasAnswer = !answer.isBlank();
            boolean ok = error.isBlank() && hasAnswer;
            log("chat-api " + (ok ? "OK" : "FAIL")
                    + " statusCode=" + response.statusCode()
                    + " responseStatus=" + status
                    + " conversationId=" + getString(body, "conversation_id", conversationId)
                    + " hasAnswer=" + hasAnswer
                    + " error=" + (error.isBlank() ? "<empty>" : compact(error, 260))
                    + " answerPreview=" + compact(answer, 260));
            return ok;
        } catch (Exception error) {
            log("FAIL step=chat-api uri=" + chatUri + " error=" + safeMessage(error));
            return false;
        }
    }

    private static HttpRequest get(URI uri, Duration timeout) {
        return HttpRequest.newBuilder()
                .uri(uri)
                .version(HttpClient.Version.HTTP_1_1)
                .timeout(timeout)
                .header("Accept", "text/html,application/json,text/javascript,*/*")
                .GET()
                .build();
    }

    private static void log(String message) {
        System.out.println(TAG + " " + message);
    }

    private static URI normalizeUri(String rawUrl) {
        try {
            return URI.create(rawUrl);
        } catch (RuntimeException ignored) {
            return URI.create("http://127.0.0.1:8000/desktop-pet/chat.html");
        }
    }

    private static URI resolveBaseUri(URI uri) {
        String scheme = uri.getScheme() == null ? "http" : uri.getScheme();
        String host = uri.getHost() == null ? "127.0.0.1" : uri.getHost();
        int port = uri.getPort();
        String authority = port >= 0 ? host + ":" + port : host;
        return URI.create(scheme + "://" + authority + "/");
    }

    private static URI resolveRelative(URI base, String rawSrc) {
        String decoded = URLDecoder.decode(rawSrc, StandardCharsets.UTF_8);
        return base.resolve(decoded);
    }

    private static URI cacheBusted(URI uri, String key) {
        String raw = uri.toString();
        String separator = raw.contains("?") ? "&" : "?";
        return URI.create(raw + separator + key + "=" + URLEncoder.encode(String.valueOf(System.currentTimeMillis()), StandardCharsets.UTF_8));
    }

    private static String findChatScript(String html) {
        Matcher matcher = SCRIPT_PATTERN.matcher(html);
        if (matcher.find()) {
            return matcher.group(1);
        }
        return "";
    }

    private static boolean isSuccess(int statusCode) {
        return statusCode >= 200 && statusCode < 300;
    }

    private static String getString(JsonObject object, String key, String fallback) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return fallback;
        }
        try {
            return object.get(key).getAsString();
        } catch (RuntimeException ignored) {
            return fallback;
        }
    }

    private static String jsonString(String raw) {
        if (raw == null) {
            return "\"\"";
        }
        StringBuilder builder = new StringBuilder("\"");
        for (int i = 0; i < raw.length(); i++) {
            char ch = raw.charAt(i);
            switch (ch) {
                case '\\' -> builder.append("\\\\");
                case '"' -> builder.append("\\\"");
                case '\n' -> builder.append("\\n");
                case '\r' -> builder.append("\\r");
                case '\t' -> builder.append("\\t");
                default -> {
                    if (ch < 0x20) {
                        builder.append(String.format("\\u%04x", (int) ch));
                    } else {
                        builder.append(ch);
                    }
                }
            }
        }
        return builder.append('"').toString();
    }

    private static String jsonObject(String... pairs) {
        StringBuilder builder = new StringBuilder("{");
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            if (i > 0) {
                builder.append(',');
            }
            builder.append(jsonString(pairs[i])).append(':').append(jsonString(pairs[i + 1]));
        }
        return builder.append('}').toString();
    }

    private static String compact(String raw, int maxChars) {
        if (raw == null) {
            return "";
        }
        String compacted = raw.replace('\r', ' ').replace('\n', ' ').replaceAll("\\s+", " ").trim();
        if (compacted.length() <= maxChars) {
            return compacted;
        }
        return compacted.substring(0, Math.max(0, maxChars - 3)) + "...";
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        if (message == null || message.isBlank()) {
            message = error.toString();
        }
        return compact(message, 500);
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private record PageCheck(boolean ok, String scriptSrc) {
    }
}
