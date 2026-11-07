// src/components/wall/useWallCameraPan.ts

import { animate } from 'framer-motion';
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';

// Centres the viewport on a world rect without routing per-frame movement through React state.

export type LatticeCamera = { x: number; y: number; scale: number };

type WallRect = { x: number; y: number; width: number; height: number };

type WallCameraPanOptions = {
    cameraRef: MutableRefObject<LatticeCamera>;
    viewportRef: MutableRefObject<{ width: number; height: number }>;
    reducedMotion: boolean | null;
    applyCamera: (camera: LatticeCamera, updateBounds?: boolean) => void;
    /**
     * Publishes cull bounds covering where the camera is headed. Called once when a pan starts,
     * never per frame: an interrupted pan never reaches onComplete, so waiting for the animation
     * to settle before re-culling loses the race against held arrow keys.
     */
    reserveBounds: (camera: LatticeCamera) => void;
};

export const useWallCameraPan = ({
    cameraRef,
    viewportRef,
    reducedMotion,
    applyCamera,
    reserveBounds,
}: WallCameraPanOptions) => {
    const animationRef = useRef<{ stop: () => void } | null>(null);

    const stopPan = useCallback(() => {
        animationRef.current?.stop();
        animationRef.current = null;
    }, []);

    // `instant` skips the flight: entering the wall centres on the playing song before the first
    // paint, where a 0.4s pan from the default camera would only look like a stray drift.
    // `scale` is the scale the flight ends at (defaults to the current one): the expanded card on
    // a phone does not fit the viewport at the breakpoint scale, so its pan zooms out just enough
    // to fit and the pan back restores.
    const panTo = useCallback((rect: WallRect, instant = false, scale?: number) => {
        animationRef.current?.stop();
        const from = cameraRef.current;
        const viewport = viewportRef.current;
        const toScale = scale !== undefined && scale > 0 ? scale : from.scale;
        const target = {
            x: viewport.width / 2 - (rect.x + rect.width / 2) * toScale,
            y: viewport.height / 2 - (rect.y + rect.height / 2) * toScale,
            scale: toScale,
        };
        reserveBounds(target);
        if (reducedMotion || instant) {
            animationRef.current = null;
            applyCamera(target, true);
            return;
        }
        animationRef.current = animate(0, 1, {
            duration: 0.42,
            ease: [0.22, 1, 0.36, 1],
            onUpdate: progress => applyCamera({
                x: from.x + (target.x - from.x) * progress,
                y: from.y + (target.y - from.y) * progress,
                scale: from.scale + (toScale - from.scale) * progress,
            }),
            onComplete: () => {
                animationRef.current = null;
                applyCamera(target, true);
            },
        });
    }, [applyCamera, cameraRef, reducedMotion, reserveBounds, viewportRef]);

    useEffect(() => () => animationRef.current?.stop(), []);

    return { panTo, stopPan, animationRef };
};
