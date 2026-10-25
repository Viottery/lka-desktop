package com.agenticrag.pet;

import com.google.gson.JsonObject;

/** Pure transport-contract checks; no JavaFX startup or backend/model calls. */
public final class PetTurnTransportCheck {
    public static void main(String[] args) {
        var interrupted = new PetControlWindow.TurnStreamState();
        interrupted.accept("run_started", "{\"run_id\":\"root\"}");
        interrupted.accept("final_answer", "{\"run_id\":\"root\"}");
        check(!interrupted.terminal, "answer is not an authoritative terminal event");
        check("root".equals(interrupted.runId), "interrupted stream retains run identity");
        interrupted.accept("run_completed", "{\"run_id\":\"child\",\"parent_run_id\":\"root\"}");
        check(!interrupted.terminal, "child completion cannot terminate the root stream");
        interrupted.accept("run_completed", "{\"run_id\":\"other\"}");
        check(!interrupted.terminal, "unrelated completion cannot terminate the root stream");
        for (String event : new String[]{"run_completed", "run_failed", "run_cancelled", "run_timed_out", "run_paused"}) {
            var state = new PetControlWindow.TurnStreamState();
            state.accept(event, "{\"run_id\":\"root\"}");
            check(state.terminal, "authoritative terminal remains accepted: " + event);
        }
        JsonObject uncertain = PetControlWindow.turnTransportFailure("interrupted", "session", "subscription", "turn", "root", true);
        check(uncertain.get("transport_uncertain").getAsBoolean(), "transport interruption stays uncertain");
        check("turn".equals(uncertain.get("client_request_id").getAsString()), "turn correlation retained");
        check("subscription".equals(uncertain.get("request_id").getAsString()), "callback subscription retained");
        check("root".equals(uncertain.get("run_id").getAsString()), "known run retained");
        check(!uncertain.has("status") && !uncertain.has("type"), "transport cannot fabricate backend run failure");
        JsonObject rejected = PetControlWindow.turnTransportFailure("HTTP 401", "session", "subscription", "turn", "", false);
        check(!rejected.has("transport_uncertain"), "definitive HTTP rejection stays definitive");
        JsonObject legacy = PetControlWindow.turnTransportFailure("interrupted", null, "", "", "", true);
        check(!legacy.has("client_request_id") && !legacy.has("run_id"), "legacy callers need no new identifiers");
        System.out.println("Pet turn transport checks passed");
    }

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
}
