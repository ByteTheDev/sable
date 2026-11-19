package io.github.leonxlnx.sable.mobile;

import android.app.Activity;
import android.view.View;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import java.util.List;
import java.util.Locale;

/**
 * The keyboard without a jump. Capacitor's SystemBars pads the window by the keyboard's height the
 * moment it starts to slide, so the page shrank at once and its composer jumped up before the
 * keyboard arrived. Here the page keeps its size and never hears of the keyboard (it would shrink
 * its viewport and pan); instead it is told where the keyboard will end and how long the slide
 * takes, and lifts its own bottom along the same curve (`window.__sableIme(lift, ms, bottomBar)`,
 * in CSS px). Installed after the plugins load: it takes over the Keyboard plugin's listeners
 * (whose events the page does not use).
 */
final class ImeLift {
    private static final int BARS = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
    private static final int IME = WindowInsetsCompat.Type.ime();

    private static final class State {
        int lift;
        int bar;
        boolean animating;
    }

    private ImeLift() {}

    static void install(Activity activity, WebView webView) {
        if (webView == null) return;
        final View decor = activity.getWindow().getDecorView();
        final View content = decor.findViewById(android.R.id.content);
        if (content == null) return;
        final float density = activity.getResources().getDisplayMetrics().density;
        final State st = new State();

        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            WindowInsetsCompat raw = ViewCompat.getRootWindowInsets(decor);
            if (raw == null) raw = insets;
            Insets bars = raw.getInsets(BARS);
            int ime = raw.isVisible(IME) ? raw.getInsets(IME).bottom : 0;
            // SystemBars either padded the window for the bars (older WebViews) or passes the insets
            // through (WebView 140+, no padding but the keyboard's): only the keyboard's part goes.
            boolean padded = decor.getPaddingTop() > 0 || decor.getPaddingLeft() > 0 || decor.getPaddingRight() > 0;
            int bottom = padded ? bars.bottom : 0;
            if (decor.getPaddingBottom() != bottom) decor.setPadding(decor.getPaddingLeft(), decor.getPaddingTop(), decor.getPaddingRight(), bottom);
            st.lift = Math.max(0, ime - bottom);
            st.bar = padded ? 0 : bars.bottom;
            push(webView, st, density, false, 0);
            WindowInsetsCompat.Builder b = new WindowInsetsCompat.Builder(insets).setInsets(IME, Insets.NONE).setVisible(IME, false);
            if (!padded) {
                // The gesture bar keeps its inset while the keyboard is up (the page's bottom does not move twice).
                Insets cur = insets.getInsets(BARS);
                b.setInsets(BARS, Insets.of(cur.left, cur.top, cur.right, bars.bottom));
            }
            return b.build();
        });

        ViewCompat.setWindowInsetsAnimationCallback(
            decor,
            new WindowInsetsAnimationCompat.Callback(WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_STOP) {
                @Override
                public void onPrepare(@NonNull WindowInsetsAnimationCompat animation) {
                    if ((animation.getTypeMask() & IME) != 0) st.animating = true;
                }

                @NonNull
                @Override
                public WindowInsetsAnimationCompat.BoundsCompat onStart(
                    @NonNull WindowInsetsAnimationCompat animation,
                    @NonNull WindowInsetsAnimationCompat.BoundsCompat bounds
                ) {
                    if ((animation.getTypeMask() & IME) != 0) {
                        long ms = animation.getDurationMillis();
                        push(webView, st, density, true, ms <= 0 ? 280 : Math.min(500, Math.max(120, ms)));
                    }
                    return bounds;
                }

                @NonNull
                @Override
                public WindowInsetsCompat onProgress(@NonNull WindowInsetsCompat insets, @NonNull List<WindowInsetsAnimationCompat> running) {
                    return insets;
                }

                @Override
                public void onEnd(@NonNull WindowInsetsAnimationCompat animation) {
                    if ((animation.getTypeMask() & IME) != 0) {
                        st.animating = false;
                        push(webView, st, density, false, 0);
                    }
                }
            }
        );
        ViewCompat.requestApplyInsets(decor);
    }

    private static void push(WebView webView, State st, float density, boolean force, long ms) {
        // While the keyboard slides, its end was sent at the start; nothing in between.
        if (st.animating && !force) return;
        float lift = st.lift / density;
        float bar = st.bar / density;
        final String js = String.format(
            Locale.US,
            "window.__sableImeState=[%.1f,%d,%.1f];window.__sableIme&&window.__sableIme(%.1f,%d,%.1f)",
            lift, ms, bar, lift, ms, bar
        );
        webView.post(() -> webView.evaluateJavascript(js, null));
    }
}
