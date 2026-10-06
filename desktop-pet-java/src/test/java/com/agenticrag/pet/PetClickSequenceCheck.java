package com.agenticrag.pet;

/** Checks that a double click replaces, rather than follows, a single click. */
public final class PetClickSequenceCheck {
    public static void main(String[] args) {
        PetClickSequence clicks = new PetClickSequence();
        require(clicks.press(100) == PetClickSequence.Action.NONE, "first press");
        require(clicks.shortRelease(140) == PetClickSequence.Action.NONE, "single click waits");
        require(clicks.flush(300, false) == PetClickSequence.Action.NONE, "no early single action");
        require(clicks.press(360) == PetClickSequence.Action.NONE, "second press cancels pending single");
        require(clicks.flush(370, true) == PetClickSequence.Action.NONE, "no action while pressed");
        require(clicks.shortRelease(380) == PetClickSequence.Action.DOUBLE, "double action only");
        require(clicks.flush(900, false) == PetClickSequence.Action.NONE, "no delayed single after double");

        clicks.press(1000);
        clicks.shortRelease(1020);
        require(clicks.flush(1280, false) == PetClickSequence.Action.NONE, "full double-click interval");
        require(clicks.flush(1281, false) == PetClickSequence.Action.SINGLE, "single action after interval");
        require(clicks.flush(1500, false) == PetClickSequence.Action.NONE, "single action once");

        clicks.press(2000);
        clicks.shortRelease(2020);
        require(clicks.press(2500) == PetClickSequence.Action.SINGLE, "expired click before next press");
        clicks.cancel();
        require(clicks.flush(3000, false) == PetClickSequence.Action.NONE, "drag or menu cancels click");
        System.out.println("Pet click sequence checks passed");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
