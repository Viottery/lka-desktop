package com.agenticrag.pet;

import java.util.Random;

/** Deterministic checks for roaming targets; no desktop session is required. */
public final class PetMotionCheck {
    public static void main(String[] args) {
        Random random = new Random(42);
        for (int i = 0; i < 50; i++) {
            int target = PetMotion.roamingTarget(random, 500, 0, 1300);
            require(target >= 0 && target <= 1300, "roaming stays on screen");
            require(Math.abs(target - 500) >= 220, "roaming covers more than a short shuffle");
        }
        System.out.println("Pet motion checks passed");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
