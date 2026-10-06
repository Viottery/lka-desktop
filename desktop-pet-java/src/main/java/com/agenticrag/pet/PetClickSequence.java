package com.agenticrag.pet;

/** Defers a single click until a second click can no longer replace it. */
final class PetClickSequence {
    static final long DOUBLE_CLICK_WINDOW_MS = 260L;

    enum Action { NONE, SINGLE, DOUBLE }

    private long pendingReleaseAtMs = -1L;
    private boolean secondPress;

    Action press(long nowMs) {
        secondPress = false;
        if (pendingReleaseAtMs < 0L) return Action.NONE;
        long elapsed = nowMs - pendingReleaseAtMs;
        pendingReleaseAtMs = -1L;
        if (elapsed >= 0L && elapsed <= DOUBLE_CLICK_WINDOW_MS) {
            secondPress = true;
            return Action.NONE;
        }
        return Action.SINGLE;
    }

    Action shortRelease(long nowMs) {
        if (secondPress) {
            secondPress = false;
            return Action.DOUBLE;
        }
        pendingReleaseAtMs = nowMs;
        return Action.NONE;
    }

    Action flush(long nowMs, boolean pointerDown) {
        if (pointerDown || pendingReleaseAtMs < 0L
                || nowMs - pendingReleaseAtMs <= DOUBLE_CLICK_WINDOW_MS) {
            return Action.NONE;
        }
        pendingReleaseAtMs = -1L;
        return Action.SINGLE;
    }

    void cancel() {
        pendingReleaseAtMs = -1L;
        secondPress = false;
    }
}
