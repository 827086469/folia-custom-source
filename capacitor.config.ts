// capacitor.config.ts
//
// The Android shell around the web build. Folia is already a PWA, so the shell is thin: it must not
// add a second app, only give the WebView what a browser refuses to give it - a network stack without
// cross-origin rules, and a filesystem to keep music and custom source scripts on.
//
// `webDir` is Vite's output. `base` in vite.config.ts stays '/', which is what Capacitor serves from
// (https://localhost on Android), so nothing there needs a mobile branch.

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.folia.music',
  appName: 'Folia',
  webDir: 'dist',
  android: {
    // The lyric view is a full-screen canvas with its own scrolling; the WebView's overscroll glow
    // and bounce would fight it.
    allowMixedContent: true,
    backgroundColor: '#000000',
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    CapacitorHttp: {
      // Patches window.fetch and XMLHttpRequest onto the native stack. This is what makes a web
      // build usable on a phone at all: the music APIs answer every browser request with a CORS
      // failure, and there is no server in the app to relay them. It also keeps the audio element's
      // range requests off the WebView's own network code.
      enabled: true,
    },
  },
};

export default config;
