package com.agenticrag.pet;

import java.util.Random;

/** Chooses roaming destinations independently of the render and window APIs. */
final class PetMotion {
    private PetMotion() {}

    static int roamingTarget(Random random, int currentX, int minimumX, int maximumX) {
        if (maximumX <= minimumX) return minimumX;
        int span = maximumX - minimumX;
        int minimumTravel = Math.min(220, Math.max(70, span / 4));
        for (int attempt = 0; attempt < 12; attempt++) {
            int candidate = minimumX + random.nextInt(span + 1);
            if (Math.abs(candidate - currentX) >= minimumTravel) return candidate;
        }
        return Math.abs(currentX - minimumX) > Math.abs(currentX - maximumX) ? minimumX : maximumX;
    }
}
